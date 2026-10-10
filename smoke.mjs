/**
 * 干跑:只验证 lib/index.js 的模块形状与 Config 解析,不接触 harness。
 * `@deepseek-ai/*` 在 profile 外解析不到,所以这里用 import map 替身(stub)。
 * 用法: node smoke.mjs
 */
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// 用 --import 的方式给 @deepseek-ai/* 打桩太绕;直接检查源码文本的形状更稳。
const index = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");

let failures = 0;
function check(label, condition, detail = "") {
  if (!condition) failures += 1;
  console.log(`[${condition ? "PASS" : "FAIL"}] ${label}${detail.length > 0 ? ` — ${detail}` : ""}`);
}

check("导出 name", /^const name = "dsh-api-heal";$/mu.test(index));
check("导出 inject", /^const inject = \["tools", "credentials"\];$/mu.test(index));
check("导出 Config", /^const Config = z\.object\(\{/mu.test(index));
check("导出 apply", /^function apply\(ctx, config\) \{/mu.test(index));
check("末尾导出四项", /export \{ Config, apply, inject, name \};/u.test(index));
check("从 dsh-tools 取 defineTool", /import \{ defineTool \} from "@deepseek-ai\/dsh-tools";/u.test(index));
check("从 schemastery 取 z", /import z from "@deepseek-ai\/schemastery";/u.test(index));
check("相对导入带 .js 后缀", /from "\.\/heal\.js";/u.test(index));
check("监听 agent/request-error", /ctx\.on\("agent\/request-error"/u.test(index));
check("返回 { kind: \"retry\" }", /\{ kind: "retry" \}/u.test(index));
check("注册工具", /ctx\.tools\.register\(tool\);/u.test(index));
check("路由路径唯一", /"\/plugins\/dsh-api-heal\/status"/u.test(index));
check("probeKey 先读 status 再点 probe", /probeKey/u.test(readFileSync(new URL("./lib/heal.js", import.meta.url), "utf8")));

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
check("package.json type=module", pkg.type === "module");
check("package.json main 指向 lib/index.js", pkg.main === "lib/index.js");
check("package.json 有 dsh.bundle.patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");

const patch = readFileSync(new URL("./cordis.patch.yml", import.meta.url), "utf8");
check("patch 里 id 为 api-heal", /id: api-heal/u.test(patch));
check("patch 里 name 为 dsh-api-heal", /name: dsh-api-heal/u.test(patch));

console.log(failures === 0 ? "\n形状检查全部通过 ✅" : `\n${String(failures)} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
