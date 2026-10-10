/**
 * 真·加载测试:用一个假 ctx 把 lib/index.js 跑起来,并**用真实的
 * @deepseek-ai/dsh-tools 与 @deepseek-ai/schemastery** 校验工具定义与 Config。
 *
 * 为什么要绕一圈:那两个包在 profile 外解析不到(那套 installation 拦截器只在
 * DSH 进程里存在),所以先把它们从 app.asar 抽到 `_realmods/node_modules`
 * (见 stage_deps.mjs),再把 lib/ 拷进去 —— 这样裸包名能自然解析,插件源码
 * 一个字都不用改。
 *
 * 覆盖:Config 真校验 → apply() 不抛 → defineTool 真接受定义 → 工具注册形状 →
 * agent/request-error 监听器真的返回 { kind: "retry" } → 冷却期 → 非认证错误
 * 放行 → 状态路由 GET/POST。
 *
 * 用法: node loadtest.mjs
 *   REAL_MODS  可选,真实依赖根目录,默认 E:\DSH CODE\_realmods
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const realMods = process.env.REAL_MODS ?? "E:\\DSH CODE\\_realmods";

// ── 0. 把 lib/ 拷到有 node_modules 的目录里 ───────────────────────────────
if (!existsSync(join(realMods, "node_modules", "@deepseek-ai", "dsh-tools"))) {
  console.error(`找不到真实依赖:${realMods}\\node_modules\\@deepseek-ai\\dsh-tools`);
  console.error("先跑:node stage_deps.mjs <realMods> @deepseek-ai/dsh-tools @deepseek-ai/schemastery");
  process.exit(2);
}
const stage = join(realMods, ".plug");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(here, "lib"), join(stage, "lib"), { recursive: true });

// ── 1. 假 ctx ─────────────────────────────────────────────────────────────
function makeCtx() {
  const registered = [];
  const listeners = new Map();
  const effects = [];
  const logs = [];
  const routes = [];
  const services = new Map();

  const webServer = {
    port: 19387,
    host: "127.0.0.1",
    register(route) {
      if (routes.some((r) => r.path === route.path)) throw new Error(`duplicate route ${route.path}`);
      routes.push(route);
      return () => {};
    },
  };

  const ctx = {
    logger: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
      error: (m) => logs.push(`error ${m}`),
      debug: () => {},
    },
    tools: { register: (t) => registered.push(t) },
    get: (name) => (name === "webServer" ? webServer : services.get(name)),
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {
        const arr = listeners.get(event) ?? [];
        const i = arr.indexOf(handler);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    effect(factory, label) {
      effects.push({ factory, label });
      return () => {};
    },
    inject(names, callback) {
      callback({
        logger: ctx.logger,
        tools: ctx.tools,
        on: ctx.on,
        get: ctx.get,
        webServer,
        effect: (factory, label) => {
          const dispose = factory();
          effects.push({ dispose, label });
          return dispose;
        },
      });
    },
    __registered: registered,
    __listeners: listeners,
    __effects: effects,
    __logs: logs,
    __routes: routes,
    __services: services,
    __webServer: webServer,
  };

  return ctx;
}

// ── 2. 断言小工具 ─────────────────────────────────────────────────────────
let failures = 0;
function check(label, condition, detail = "") {
  if (!condition) failures += 1;
  console.log(`[${condition ? "PASS" : "FAIL"}] ${label}${detail.length > 0 ? ` — ${detail}` : ""}`);
}

// ── 3. 开跑 ───────────────────────────────────────────────────────────────
process.env.DSH_HOME = process.env.DSH_HOME ?? "E:\\dsh-data\\.dsh";
process.env.DSH_WEB_URL = "http://127.0.0.1:19387";

const mod = await import(new URL("./lib/index.js", `file:///${stage.replaceAll("\\", "/")}/`).href);

console.log("=== 1. 模块形状 ===");
check("导出 name", mod.name === "dsh-api-heal");
check("导出 inject", Array.isArray(mod.inject) && mod.inject.includes("tools") && mod.inject.includes("credentials"));
check("导出 Config", typeof mod.Config === "function");
check("导出 apply", typeof mod.apply === "function");
check("导出面恰好 4 项", Object.keys(mod).sort().join(",") === "Config,apply,inject,name", Object.keys(mod).join(","));

console.log("\n=== 2. Config 真校验(真实 schemastery) ===");
const defaults = mod.Config({});
check("enabled 默认 true", defaults.enabled === true);
check("autoHeal 默认 true", defaults.autoHeal === true);
check("cooldownMs 默认 60000", defaults.cooldownMs === 60_000);
check("requestTimeoutMs 默认 30000", defaults.requestTimeoutMs === 30_000);
check("webBaseUrl 默认空串", defaults.webBaseUrl === "");
check("registerRoutes 默认 true", defaults.registerRoutes === true);
const overridden = mod.Config({ cooldownMs: 1234, autoHeal: false });
check("覆盖生效", overridden.cooldownMs === 1234 && overridden.autoHeal === false);
let typeRejected = false;
try { mod.Config({ cooldownMs: "abc" }); } catch { typeRejected = true; }
check("类型错误被拒", typeRejected);

console.log("\n=== 3. apply() 跑起来 ===");
const ctx = makeCtx();
ctx.__services.set("credentials", {
  // 故意返回 undefined → readSessionSecret 会回退到读 .credentials.yaml
  resolve: async () => undefined,
  readRecord: async () => undefined,
});
let applyThrew = null;
try {
  mod.apply(ctx, {});
} catch (error) {
  applyThrew = error;
}
check("apply 不抛", applyThrew === null, applyThrew ? String(applyThrew.message) : "");
check("注册了 1 个工具", ctx.__registered.length === 1);
check("注册了 agent/request-error 监听器", (ctx.__listeners.get("agent/request-error") ?? []).length === 1);
check("注册了 ctx.effect 清理", ctx.__effects.length >= 1);
check("注册了状态路由", ctx.__routes.length === 1, ctx.__routes.map((r) => r.path).join(","));
check("路由路径正确", ctx.__routes[0]?.path === "/plugins/dsh-api-heal/status");
check("路由 kind=exact", ctx.__routes[0]?.kind === "exact");

console.log("\n=== 4. 工具形状(真实 defineTool 编译结果) ===");
const tool = ctx.__registered[0];
check("工具名 heal_api", tool?.name === "heal_api");
check("有 description", typeof tool?.description === "string" && tool.description.length > 40);
check("parameters 编译成 JSON Schema", tool?.parameters?.type === "object");
check("parameters.properties.provider 存在", tool?.parameters?.properties?.provider?.type === "string");
check("provider 非必填", !(tool?.parameters?.required ?? []).includes("provider"));
check("output.schema 是 object", tool?.output?.schema?.type === "object");
check("output.schema.required 有 3 项", (tool?.output?.schema?.required ?? []).length === 3, JSON.stringify(tool?.output?.schema?.required));
check("output.schema 关掉了额外属性", tool?.output?.schema?.additionalProperties === false);
check("steps 是 string 数组", tool?.output?.schema?.properties?.steps?.items?.type === "string");
check("有 output.render", typeof tool?.output?.render === "function");
check("render 产出 text", (() => {
  try {
    const out = tool.output.render({}, { ok: true, summary: "x", steps: ["a"] });
    return Array.isArray(out) && out[0]?.type === "text";
  } catch { return false; }
})());
check("有 presentCall", typeof tool?.presentCall === "function");
check("presentCall 返回卡片", tool?.presentCall({})?.card === "generic");

console.log("\n=== 5. 工具真跑(三家全修) ===");
const toolResult = await tool.execute({});
check("execute 返回 ok 字段", typeof toolResult.ok === "boolean");
check("execute 返回 summary", typeof toolResult.summary === "string" && toolResult.summary.length > 0);
check("execute 返回 steps 数组", Array.isArray(toolResult.steps) && toolResult.steps.length >= 3, `${toolResult.steps.length} 步`);
check("三条链路都成功", toolResult.ok === true, toolResult.steps.join(" | "));

console.log("\n=== 6. 自动自愈监听器 ===");
const handler = (ctx.__listeners.get("agent/request-error") ?? [])[0];

// 6a. 非认证类错误 → 应放行给下游
let nextCalled = false;
const passthrough = await handler(
  { provider: "qoder", failure: { code: "QUOTA", message: "quota exceeded" }, signal: new AbortController().signal },
  async () => { nextCalled = true; return undefined; },
);
check("QUOTA 错误直接放行", nextCalled === true && passthrough === undefined);

// 6b. 认证类错误 → 全量自愈,成功后 retry
nextCalled = false;
const retryAction = await handler(
  { provider: "our-free-model-region", failure: { code: "AUTH", message: "answered 401" }, signal: new AbortController().signal },
  async () => { nextCalled = true; return undefined; },
);
check("AUTH 错误触发自愈并返回 retry", retryAction?.kind === "retry", JSON.stringify(retryAction));
check("自愈成功时不调用 next(否决下游报错)", nextCalled === false);
if (retryAction?.kind !== "retry") {
  console.log("    ↳ 相关日志:");
  for (const line of ctx.__logs.slice(-6)) console.log(`      ${line}`);
}

// 6c. 同一个 provider 再来一次 → 撞冷却期,应放行
nextCalled = false;
const cooled = await handler(
  { provider: "our-free-model-region", failure: { code: "AUTH", message: "answered 401" }, signal: new AbortController().signal },
  async () => { nextCalled = true; return undefined; },
);
check("冷却期内放行给下游", nextCalled === true && cooled === undefined);

// 6d. 无 failure 的畸形 payload 不应抛
let malformedThrew = null;
try {
  await handler({ provider: "qoder", failure: undefined, signal: new AbortController().signal }, async () => undefined);
} catch (error) { malformedThrew = error; }
check("failure 缺失时不抛", malformedThrew === null);

console.log("\n=== 7. 状态路由 ===");
const route = ctx.__routes[0];
const captured = { status: 0, body: "" };
const fakeRes = {
  writeHead(status) { captured.status = status; return this; },
  end(text) { captured.body = text ?? ""; return this; },
};
await route.handler({ method: "GET" }, fakeRes);
check("GET 返回 200", captured.status === 200);
let payload = null;
try { payload = JSON.parse(captured.body); } catch { /* noop */ }
check("返回合法 JSON", payload !== null);
check("payload.plugin 正确", payload?.plugin === "dsh-api-heal");
check("payload.baseUrl 正确", payload?.baseUrl === "http://127.0.0.1:19387");
check("payload.stats.heals > 0", (payload?.stats?.heals ?? 0) > 0, `heals=${String(payload?.stats?.heals)}`);
check("payload.stats.succeeded > 0", (payload?.stats?.succeeded ?? 0) > 0);
check("payload.lastHealAt 有记录", Object.keys(payload?.lastHealAt ?? {}).length > 0);

captured.status = 0;
await route.handler({ method: "POST" }, fakeRes);
check("POST 返回 405", captured.status === 405);

console.log("\n=== 8. 日志 ===");
check("打了 info 日志", ctx.__logs.filter((l) => l.startsWith("info")).length >= 3);
check("日志带插件前缀", ctx.__logs.some((l) => l.includes("dsh-api-heal")));

rmSync(stage, { recursive: true, force: true });
console.log(failures === 0 ? "\n加载测试全部通过 ✅" : `\n${String(failures)} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
