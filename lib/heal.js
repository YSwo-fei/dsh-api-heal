/**
 * dsh-api-heal — 自愈内核(纯 Node,不依赖任何 @deepseek-ai/* 包)。
 *
 * 这里只做三件事:
 *   1. 从 `.credentials.yaml` / credentials 服务取出 connection 的签名密钥,
 *      按 `client-connection` 的算法伪造一枚浏览器会话 cookie —— 因为
 *      our-free-model 的 `/api/*` 路由挂在 connection 的准入围栏后面,
 *      没有这枚 cookie 就只会拿到 401。
 *   2. 调三条 provider 各自的"续期/刷新"HTTP 入口。
 *   3. 判断一个 failure 是不是"凭据类"失败(401/403/AUTH/...)。
 *
 * 拆成独立文件是为了能脱离 harness 直接 `node` 跑单测。
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** base64url,与 client-connection 内部实现逐字对齐。 */
export function b64u(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromB64u(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return undefined;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/") + padding, "base64");
}

/**
 * 取出 `client-connection/browser-session` 记录的 secret。
 * 优先走 credentials 服务;服务不可用时退化成手工解析 `.credentials.yaml`
 * (只认这一个字段,不做通用 YAML)。
 */
export async function readSessionSecret({ credentials, dshHome, credentialsFile } = {}) {
  if (credentials !== undefined && typeof credentials.readRecord === "function") {
    try {
      const record = await credentials.readRecord("client-connection/browser-session");
      const secret = record?.payload?.secret;
      if (typeof secret === "string" && secret.length > 0) return secret;
    } catch {
      /* 落到文件兜底 */
    }
  }
  const file = credentialsFile ?? (typeof dshHome === "string" && dshHome.length > 0 ? join(dshHome, ".credentials.yaml") : undefined);
  if (file === undefined) return undefined;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes("client-connection/browser-session")) continue;
    for (let j = i; j < Math.min(i + 12, lines.length); j += 1) {
      const match = /^\s*secret:\s*(\S+)\s*$/u.exec(lines[j]);
      if (match !== null) return match[1];
    }
  }
  return undefined;
}

/** 复刻 BrowserAuth 的 cookie:v1.<base64url(payload)>.<base64url(hmac)>。 */
export function mintSessionCookie(secret, authority, now = Date.now(), maxAgeMs = 7 * 24 * 3600 * 1000) {
  const key = fromB64u(secret);
  if (key === undefined || key.byteLength !== 32) return undefined;
  const name = "dsh-auth-" + b64u(createHash("sha256").update(authority).digest());
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + maxAgeMs };
  const body = b64u(JSON.stringify(payload));
  const signature = b64u(createHmac("sha256", key).update(body).digest());
  return `${name}=v1.${body}.${signature}`;
}

/** 带超时的 JSON 请求;永远 resolve,不抛。 */
export async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("dsh-api-heal: request timed out"));
  }, timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: response.ok, status: response.status, text, json };
  } catch (error) {
    return { ok: false, status: 0, text: String(error?.message ?? error), json: undefined };
  } finally {
    clearTimeout(timer);
  }
}

function brief(value, limit = 220) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/** qoder:先读 status 拿本轮进程的 probeKey,再 POST refresh。 */
export async function healQoder(base, { timeoutMs = 30000 } = {}) {
  const status = await httpJson(`${base}/plugins/dsh-qoder-connect/status`, { timeoutMs });
  const key = status.json?.probeKey;
  if (typeof key !== "string" || key.length === 0) {
    return { provider: "qoder", ok: false, step: `qoder status 不可读(HTTP ${String(status.status)}):${brief(status.text, 120)}` };
  }
  const state = status.json?.status;
  const result = await httpJson(`${base}/plugins/dsh-qoder-connect/probe`, {
    method: "POST",
    headers: { "x-qoder-probe-key": key, "content-type": "application/json" },
    body: JSON.stringify({ action: "refresh" }),
    timeoutMs,
  });
  return {
    provider: "qoder",
    ok: result.ok,
    step: result.ok
      ? `qoder 续期成功(${state ?? "?"} → ${brief(result.json ?? result.text, 120)})`
      : `qoder 续期失败 HTTP ${String(result.status)}:${brief(result.text, 160)}`,
  };
}

/**
 * workbuddy:有两个变体。`ai` 是 www.workbuddy.ai(当前默认模型走它),
 * `cn` 走 CodeBuddy 国内域。没登录的变体不要去点 refresh。
 */
export async function healWorkbuddy(base, variant = "ai", { timeoutMs = 30000 } = {}) {
  const prefix = variant === "cn" ? "" : "/ai";
  const label = variant === "cn" ? "workbuddy(CN)" : "workbuddy-ai";
  const status = await httpJson(`${base}/plugins/dsh-workbuddy-connect${prefix}/status`, { timeoutMs });
  const key = status.json?.probeKey;
  if (typeof key !== "string" || key.length === 0) {
    return { provider: label, ok: false, step: `${label} status 不可读(HTTP ${String(status.status)}):${brief(status.text, 120)}` };
  }
  if (status.json?.status !== "signed-in") {
    return { provider: label, ok: false, skipped: true, step: `${label} 未登录(${brief(status.json?.reasonCode ?? status.json?.status, 60)}),跳过` };
  }
  const result = await httpJson(`${base}/plugins/dsh-workbuddy-connect${prefix}/probe`, {
    method: "POST",
    headers: { "x-workbuddy-probe-key": key, "content-type": "application/json" },
    body: JSON.stringify({ action: "refresh" }),
    timeoutMs,
  });
  return {
    provider: label,
    ok: result.ok,
    step: result.ok
      ? `${label} 刷新成功(${brief(result.json ?? result.text, 120)})`
      : `${label} 刷新失败 HTTP ${String(result.status)}:${brief(result.text, 160)}`,
  };
}

/** our-free-model:必须带 connection 会话 cookie,否则固定 401。 */
export async function healOurFreeModel(base, cookie, { timeoutMs = 60000 } = {}) {
  const headers = cookie === undefined ? {} : { cookie };
  const result = await httpJson(`${base}/api/our-free-model/refresh`, { method: "POST", headers, timeoutMs });
  if (result.status === 401 || result.status === 403) {
    return {
      provider: "our-free-model",
      ok: false,
      step: `our-free-model 刷新被围栏拒绝 HTTP ${String(result.status)}(cookie ${cookie === undefined ? "缺失" : "无效"})`,
    };
  }
  return {
    provider: "our-free-model",
    ok: result.ok,
    step: result.ok
      ? `our-free-model 目录刷新成功(${Array.isArray(result.json?.catalog) ? String(result.json.catalog.length) + " 个模型" : brief(result.json ?? result.text, 100)})`
      : `our-free-model 刷新失败 HTTP ${String(result.status)}:${brief(result.text, 160)}`,
  };
}

/** provider 路由 id → 需要跑的修复步骤。 */
export const PROVIDER_TARGETS = {
  qoder: ["qoder"],
  workbuddy: ["workbuddy-cn", "workbuddy-ai"],
  "workbuddy-ai": ["workbuddy-ai"],
  "our-free-model": ["our-free-model"],
  "our-free-model-region": ["our-free-model"],
};

const ALL_TARGETS = ["qoder", "workbuddy-ai", "our-free-model"];

export function targetsFor(provider) {
  if (typeof provider !== "string" || provider.length === 0) return [...ALL_TARGETS];
  return PROVIDER_TARGETS[provider] ?? [...ALL_TARGETS];
}

/** 跑一组修复步骤。返回 `{ ok, steps[] }`。 */
export async function runHeal(targets, context) {
  const steps = [];
  let ok = false;
  for (const target of targets) {
    let outcome;
    if (target === "qoder") outcome = await healQoder(context.base, context);
    else if (target === "workbuddy-ai") outcome = await healWorkbuddy(context.base, "ai", context);
    else if (target === "workbuddy-cn") outcome = await healWorkbuddy(context.base, "cn", context);
    else if (target === "our-free-model") outcome = await healOurFreeModel(context.base, context.cookie, context);
    else outcome = { provider: target, ok: false, step: `未知的修复目标 "${target}"` };
    steps.push(outcome.step);
    if (outcome.ok) ok = true;
  }
  return { ok, steps };
}

const AUTH_CODES = new Set(["AUTH", "INVALID_CREDENTIAL", "MISSING_CREDENTIAL", "UNAUTHORIZED", "ACCOUNT_TOKEN_INVALID", "ACCOUNT_SIGN_IN_REQUIRED"]);

/** 这个 failure 像不像"凭据坏了"? */
export function looksLikeAuthFailure(failure) {
  if (failure === undefined || failure === null) return false;
  const code = typeof failure.code === "string" ? failure.code : "";
  if (AUTH_CODES.has(code)) return true;
  const message = typeof failure.message === "string" ? failure.message : "";
  if (/\b(?:401|403)\b/u.test(message)) return true;
  return /unauthoriz|forbidden|invalid[ _-]?api[ _-]?key|invalid[ _-]?credential|token (?:expired|invalid)/iu.test(message);
}
