/**
 * dsh-api-heal 自测:脱离 harness 直接跑 lib/heal.js 的全部链路。
 * 用法: node selftest.mjs
 */
import { createRequire } from "node:module";
import {
  looksLikeAuthFailure,
  mintSessionCookie,
  readSessionSecret,
  runHeal,
  targetsFor,
  PROVIDER_TARGETS,
} from "./lib/heal.js";

const BASE = process.env.DSH_WEB_URL ?? "http://127.0.0.1:19387";
let failures = 0;

function check(label, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`[${mark}] ${label}${detail.length > 0 ? ` — ${detail}` : ""}`);
}

console.log("=== 1. 纯函数 ===");
check("looksLikeAuthFailure({code:'AUTH'})", looksLikeAuthFailure({ code: "AUTH", message: "whatever" }) === true);
check(
  "looksLikeAuthFailure({message:'... answered 401'})",
  looksLikeAuthFailure({ code: "PI_AI_ERROR", message: "http://x/v1 answered 401" }) === true,
);
check("looksLikeAuthFailure({code:'QUOTA'})", looksLikeAuthFailure({ code: "QUOTA", message: "quota exceeded" }) === false);
check("looksLikeAuthFailure(undefined)", looksLikeAuthFailure(undefined) === false);
check("targetsFor('qoder')", JSON.stringify(targetsFor("qoder")) === '["qoder"]');
check("targetsFor(undefined) 覆盖三家", targetsFor(undefined).length === 3);
check("targetsFor('workbuddy') 含 CN 与 AI", JSON.stringify(targetsFor("workbuddy")) === '["workbuddy-cn","workbuddy-ai"]');
check("targetsFor('未知') 退回全量", targetsFor("no-such-provider").length === 3);
check("PROVIDER_TARGETS 有 our-free-model-region", Array.isArray(PROVIDER_TARGETS["our-free-model-region"]));

console.log("\n=== 2. 读 connection 会话密钥 ===");
const secret = await readSessionSecret({ dshHome: process.env.DSH_HOME });
check("readSessionSecret 拿到 secret", typeof secret === "string" && secret.length > 0, String(secret));
const cookie = mintSessionCookie(secret, new URL(BASE).host);
check("mintSessionCookie 产出 cookie", typeof cookie === "string" && cookie.includes("=v1."));
check("cookie 名以 dsh-auth- 开头", cookie?.startsWith("dsh-auth-") === true);

console.log("\n=== 3. 真实自愈(三家全跑) ===");
const result = await runHeal(targetsFor(undefined), { base: BASE, cookie, timeoutMs: 60_000 });
for (const step of result.steps) console.log(`   · ${step}`);
check("至少一条链路成功", result.ok === true);

console.log("\n=== 4. 逐 provider 单独跑 ===");
for (const provider of ["qoder", "workbuddy-ai", "our-free-model"]) {
  const one = await runHeal(targetsFor(provider), { base: BASE, cookie, timeoutMs: 60_000 });
  check(`单独修复 ${provider}`, one.ok === true, one.steps.join(" | "));
}

console.log("\n=== 5. 无 cookie 时应被围栏拒绝(负例) ===");
const denied = await runHeal(["our-free-model"], { base: BASE, cookie: undefined, timeoutMs: 30_000 });
check("缺 cookie 时 our-free-model 失败且给出围栏原因", denied.ok === false && denied.steps[0].includes("围栏"));

console.log(`\n${failures === 0 ? "全部通过 ✅" : `${String(failures)} 项失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
