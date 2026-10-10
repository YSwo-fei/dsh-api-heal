/**
 * dsh-api-heal — 宿主半边。
 *
 * 解决什么:「API 密钥无效」这句话是 UI 把失败码 `AUTH` 硬翻译出来的,而
 * `AUTH` 的唯一生产点是 `classifyPiAiError` 里 `if (/\b(?:401|403)\b/.test(message)) return "AUTH"`。
 * 也就是说 key 过期 / token 被踢时,DSH 只会干巴巴报这一句,然后**什么都不做** ——
 * 而 qoder / workbuddy / our-free-model 三家其实各自都有现成的"续期"入口,
 * 只是没人去点。
 *
 * 这个插件做两件事:
 *   1. 自动:监听 `agent/request-error`,一旦失败看起来是凭据类(401/403/AUTH/...),
 *      就调用对应 provider 的刷新入口,成功后返回 `{ kind: "retry" }` 让 agent loop
 *      重发同一次请求 —— 用户感知不到中断。
 *   2. 手动:注册 `heal_api` 工具 + 一个 Web 状态路由,可以随时体检/强制修复。
 *
 * 三家 provider 的修复入口(全部实测 200):
 *   - qoder          : POST /plugins/dsh-qoder-connect/probe        (x-qoder-probe-key)
 *   - workbuddy-ai   : POST /plugins/dsh-workbuddy-connect/ai/probe (x-workbuddy-probe-key)
 *   - our-free-model : POST /api/our-free-model/refresh             (connection 会话 cookie)
 *
 * probeKey 每次进程重启都会重新随机生成,所以必须"先读 status 再点 probe"。
 * our-free-model 的路由挂在 connection 准入围栏后面,要用 `.credentials.yaml` 里
 * 的 browser-session 密钥自铸一枚 cookie —— 见 lib/heal.js。
 */

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  looksLikeAuthFailure,
  mintSessionCookie,
  readSessionSecret,
  runHeal,
  targetsFor,
} from "./heal.js";

const name = "dsh-api-heal";
const inject = ["tools", "credentials"];

const PLUGIN_VERSION = "0.1.0";

/** 同一个 provider 两次自愈之间的最小间隔,防止"修不好→重试→又失败"打转。 */
const DEFAULT_COOLDOWN_MS = 60_000;

const Config = z.object({
  enabled: z.boolean().default(true).description("是否启用自动自愈与 heal_api 工具"),
  autoHeal: z.boolean().default(true).description("失败码像凭据问题时是否自动续期并重试"),
  cooldownMs: z.number().default(DEFAULT_COOLDOWN_MS).description("同一 provider 两次自愈的最小间隔(毫秒)"),
  requestTimeoutMs: z.number().default(30_000).description("单次自愈 HTTP 请求超时(毫秒)"),
  webBaseUrl: z.string().default("").description("留空则自动取 webServer 的 host:port"),
  registerRoutes: z.boolean().default(true).description("是否注册 /plugins/dsh-api-heal/* 状态路由"),
});

/** 工具返回值的 schema。 */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true, description: "是否至少有一条修复链路成功" },
    summary: { type: "string", required: true, description: "一句话结论" },
    steps: { type: "array", required: true, items: { type: "string" }, description: "每一步的明细" },
  },
};

/** 从 webServer 服务/环境变量里推出本机基址。 */
function resolveBaseUrl(ctx, configured) {
  if (typeof configured === "string" && configured.trim().length > 0) return configured.trim().replace(/\/+$/u, "");
  const server = ctx.get("webServer");
  const port = server?.port;
  if (typeof port === "number" && port > 0) {
    const rawHost = typeof server.host === "string" ? server.host : "127.0.0.1";
    const host = rawHost === "0.0.0.0" || rawHost === "::" || rawHost === "" ? "127.0.0.1" : rawHost;
    return `http://${host}:${String(port)}`;
  }
  const fromEnv = process.env.DSH_WEB_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv.replace(/\/+$/u, "");
  return "http://127.0.0.1:19387";
}

function apply(ctx, config) {
  const settings = Config(config ?? {});
  if (settings.enabled !== true) {
    ctx.logger.info("dsh-api-heal: 已禁用(enabled=false)");
    return;
  }

  /** 进程内状态,给状态路由和工具共用。 */
  const stats = {
    version: PLUGIN_VERSION,
    heals: 0,
    succeeded: 0,
    failed: 0,
    lastAt: 0,
    lastProvider: "",
    lastSteps: [],
  };
  /** provider → 上次自愈时间戳,冷却用。 */
  const lastHealAt = new Map();

  const baseUrl = () => resolveBaseUrl(ctx, settings.webBaseUrl);

  /** 取 connection 会话 cookie;取不到就返回 undefined(our-free-model 会 401)。 */
  async function sessionCookie() {
    const url = baseUrl();
    let authority;
    try {
      authority = new URL(url).host;
    } catch {
      return undefined;
    }
    const credentials = ctx.get("credentials");
    const secret = await readSessionSecret({
      credentials,
      dshHome: process.env.DSH_HOME,
    });
    if (secret === undefined) return undefined;
    return mintSessionCookie(secret, authority);
  }

  /**
   * 跑一轮修复。
   * @param provider 触发失败的 provider 路由 id;留空则三家全跑一遍。
   */
  async function heal(provider) {
    const targets = targetsFor(provider);
    const cookie = await sessionCookie();
    const result = await runHeal(targets, {
      base: baseUrl(),
      cookie,
      timeoutMs: settings.requestTimeoutMs,
    });
    stats.heals += 1;
    stats.lastAt = Date.now();
    stats.lastProvider = typeof provider === "string" ? provider : "(all)";
    stats.lastSteps = result.steps;
    if (result.ok) stats.succeeded += 1;
    else stats.failed += 1;
    for (const step of result.steps) ctx.logger.info(`dsh-api-heal: ${step}`);
    return result;
  }

  // ── 自动自愈 ────────────────────────────────────────────────────────────
  if (settings.autoHeal === true) {
    const lifetime = new AbortController();
    const active = new Set();
    function track(operation) {
      const tracked = operation.finally(() => active.delete(tracked));
      active.add(tracked);
      return tracked;
    }

    async function recover({ provider, failure, signal }, next) {
      if (lifetime.signal.aborted) return next();
      if (!looksLikeAuthFailure(failure)) return next();
      const key = typeof provider === "string" && provider.length > 0 ? provider : "(all)";
      const previous = lastHealAt.get(key) ?? 0;
      const now = Date.now();
      if (now - previous < settings.cooldownMs) {
        ctx.logger.info(
          `dsh-api-heal: "${key}" 在冷却期内(${String(Math.round((settings.cooldownMs - (now - previous)) / 1000))}s 后再试),不再自动续期`,
        );
        return next();
      }
      lastHealAt.set(key, now);
      ctx.logger.info(`dsh-api-heal: provider "${key}" 报出凭据类失败(${String(failure?.code ?? "?")}),尝试自动续期…`);
      let outcome;
      try {
        outcome = await heal(provider);
      } catch (error) {
        ctx.logger.warn(`dsh-api-heal: 自动续期抛错: ${String(error?.message ?? error)}`);
        return next();
      }
      if (signal?.aborted === true || lifetime.signal.aborted) return undefined;
      if (!outcome.ok) {
        ctx.logger.warn(`dsh-api-heal: 自动续期未成功,交回上游错误。${outcome.steps.join(" | ")}`);
        return next();
      }
      ctx.logger.info(`dsh-api-heal: 续期成功,重发请求。${outcome.steps.join(" | ")}`);
      return { kind: "retry" };
    }

    const disposeListener = ctx.on("agent/request-error", (payload, next) => {
      if (lifetime.signal.aborted) return Promise.resolve(void 0);
      return track(recover(payload, next));
    });

    ctx.effect(
      () => async () => {
        disposeListener();
        lifetime.abort(new Error("dsh-api-heal plugin disposed"));
        await Promise.allSettled([...active]);
      },
      "dsh-api-heal: abort and drain active heals",
    );
  }

  // ── heal_api 工具 ───────────────────────────────────────────────────────
  const tool = defineTool({
    name: "heal_api",
    description:
      "Repair the credentials behind an \"API key is invalid\" failure. " +
      "DSH renders any upstream 401/403 as the fixed string \"API 密钥无效\" (failure code AUTH), " +
      "so this tool is the way to find out what actually broke and fix it: it refreshes the qoder, " +
      "workbuddy-ai and our-free-model credential chains through each plugin's own renewal route and " +
      "returns one line per provider. Call it with no arguments to check and repair all three; pass " +
      "provider to touch only the route that failed.",
    parameters: {
      provider: {
        type: "string",
        description:
          "Optional provider route id to heal only that chain, e.g. \"qoder\", \"workbuddy-ai\", \"our-free-model\". Omit to heal all three.",
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        const head = value.ok ? "✅ 自愈成功" : "⚠️ 自愈未成功";
        return [{ type: "text", text: `${head}：${value.summary}\n${value.steps.map((s) => `- ${s}`).join("\n")}` }];
      },
    },
    async execute(args) {
      const provider = typeof args.provider === "string" && args.provider.trim().length > 0 ? args.provider.trim() : undefined;
      const result = await heal(provider);
      return {
        ok: result.ok,
        summary: result.ok
          ? `${String(result.steps.filter((s) => !s.includes("跳过")).length)} 条链路已刷新`
          : `三条链路都没能刷新（provider=${provider ?? "all"}）`,
        steps: result.steps,
      };
    },
    presentCall(args) {
      const provider = typeof args.provider === "string" && args.provider.trim().length > 0 ? args.provider.trim() : "all";
      return { card: "generic", title: `Heal API credentials: ${provider}`, kind: "other", rawInput: args };
    },
  });

  ctx.tools.register(tool);
  ctx.logger.info(`dsh-api-heal: 已注册 heal_api（基址 ${baseUrl()}）`);

  // ── Web 状态路由 ────────────────────────────────────────────────────────
  if (settings.registerRoutes === true) {
    ctx.inject(["webServer"], (webCtx) => {
      const send = (res, status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(text);
      };
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: "exact",
            path: "/plugins/dsh-api-heal/status",
            handler: async (req, res) => {
              if (req.method !== "GET") {
                res.writeHead(405);
                res.end("method not allowed");
                return;
              }
              send(res, 200, {
                plugin: name,
                version: PLUGIN_VERSION,
                autoHeal: settings.autoHeal === true,
                cooldownMs: settings.cooldownMs,
                baseUrl: baseUrl(),
                stats,
                lastHealAt: Object.fromEntries(lastHealAt),
              });
            },
          }),
        "dsh-api-heal: Web status route",
      );
    });
  }
}

export { Config, apply, inject, name };
