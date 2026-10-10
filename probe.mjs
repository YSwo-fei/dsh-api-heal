// 快速探针：不走 DSH，直接验证三家 provider 的续期入口是否可达。
//
//   set DSH_HOME=E:\dsh-data\.dsh
//   set DSH_WEB_URL=http://127.0.0.1:19387
//   node probe.mjs
//
// 只想探某几家：node probe.mjs qoder our-free-model
//
// 注意：这个脚本会读你本机的 .credentials.yaml 并现铸一枚会话 cookie。
// 它只在 127.0.0.1 上用，密钥不会打印、不会落盘。

import { readSessionSecret, mintSessionCookie, runHeal, PROVIDER_TARGETS } from "./lib/heal.js";

const dshHome = process.env.DSH_HOME;
const base = process.env.DSH_WEB_URL ?? "http://127.0.0.1:19387";

if (!dshHome) {
  console.error("请先设置 DSH_HOME，例如：set DSH_HOME=E:\\dsh-data\\.dsh");
  process.exit(2);
}

const KNOWN = ["qoder", "workbuddy", "workbuddy-ai", "our-free-model"];
const DEFAULT = ["qoder", "workbuddy-ai", "our-free-model"];

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const unknown = requested.filter((r) => !KNOWN.includes(r));
if (unknown.length > 0) {
  console.error(`未知 provider：${unknown.join(", ")}（可选 ${KNOWN.join(" / ")}）`);
  process.exit(2);
}
const routes = requested.length > 0 ? requested : DEFAULT;

const secret = await readSessionSecret({ dshHome });
if (secret === undefined) {
  console.error(`在 ${dshHome}\\.credentials.yaml 里找不到 client-connection/browser-session 的 secret`);
  process.exit(2);
}
console.log(`DSH_HOME   = ${dshHome}`);
console.log(`web 基址   = ${base}`);
console.log(`会话密钥   = 已读取（${String(secret).length} 字符，不打印）`);

const authority = new URL(base).host;
const cookie = mintSessionCookie(secret, authority);
console.log(`会话 cookie = ${cookie.slice(0, 24)}…（${cookie.length} 字符）`);
console.log("");

let failed = 0;
for (const route of routes) {
  const targets = PROVIDER_TARGETS[route] ?? [route];
  const started = Date.now();
  const result = await runHeal(targets, { base, cookie, timeoutMs: 30_000 });
  const elapsed = `${String(Date.now() - started)}ms`.padStart(7);
  for (const step of result.steps) {
    if (!result.ok) failed += 1;
    console.log(`[${result.ok ? "OK  " : "FAIL"}] ${route.padEnd(16)} ${elapsed}  ${step}`);
  }
}

console.log("");
console.log(failed === 0 ? "全部链路可达 ✅" : `${String(failed)} 条链路未成功 ⚠️`);
process.exit(failed === 0 ? 0 : 1);
