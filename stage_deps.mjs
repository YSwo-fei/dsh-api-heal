/**
 * 从 app.asar 里递归抽取一个包的依赖闭包到本地目录,
 * 让插件能脱离 DSH 进程直接 import 真实的 @deepseek-ai/* 包。
 *
 * 用法: node stage_deps.mjs <输出目录> <包名> [<包名> ...]
 * 例:   node stage_deps.mjs testmods @deepseek-ai/dsh-tools @deepseek-ai/schemastery
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ASAR = "D:\\DSH\\resources\\app.asar";
const PREFIX = "dsh/node_modules/";

// ── 读 asar 头 ────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
const fd = readFileSync(ASAR);
const headerSize = fd.readUInt32LE(12);
const headerJson = fd.subarray(16, 16 + headerSize).toString("utf8");
const header = JSON.parse(headerJson);
const dataStart = 16 + headerSize;

/** 在 asar 树里按路径找节点。 */
function lookup(path) {
  let node = header;
  for (const part of path.split("/")) {
    if (node?.files === undefined) return undefined;
    node = node.files[part];
    if (node === undefined) return undefined;
  }
  return node;
}

function readAsarFile(path) {
  const node = lookup(path);
  if (node === undefined || node.files !== undefined) return undefined;
  const offset = Number(node.offset);
  return fd.subarray(dataStart + offset, dataStart + offset + node.size);
}

function listDir(path) {
  const node = lookup(path);
  if (node?.files === undefined) return [];
  return Object.keys(node.files);
}

// ── 抽取一个包(含其 dependencies 的闭包)────────────────────────────────
const outRoot = process.argv[2];
const roots = process.argv.slice(3);
if (outRoot === undefined || roots.length === 0) {
  console.error("用法: node stage_deps.mjs <输出目录> <包名> ...");
  process.exit(2);
}

const staged = new Set();
const queue = [...roots];

function packageDirOf(name) {
  return `${PREFIX}${name}`;
}

function copyFile(asarPath, destPath) {
  const bytes = readAsarFile(asarPath);
  if (bytes === undefined) return false;
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, bytes);
  return true;
}

/** 递归复制包目录下的所有文件。 */
function copyTree(asarDir, destDir) {
  let count = 0;
  for (const name of listDir(asarDir)) {
    const child = `${asarDir}/${name}`;
    const node = lookup(child);
    if (node === undefined) continue;
    if (node.files !== undefined) count += copyTree(child, join(destDir, name));
    else {
      if (copyFile(child, join(destDir, name))) count += 1;
    }
  }
  return count;
}

let totalFiles = 0;
const missing = [];

while (queue.length > 0) {
  const name = queue.shift();
  if (staged.has(name)) continue;
  staged.add(name);

  const dir = packageDirOf(name);
  const pkgRaw = readAsarFile(`${dir}/package.json`);
  if (pkgRaw === undefined) {
    missing.push(name);
    continue;
  }
  const pkg = JSON.parse(pkgRaw.toString("utf8"));

  const dest = join(outRoot, "node_modules", ...name.split("/"));
  const files = copyTree(dir, dest);
  totalFiles += files;

  const deps = Object.keys(pkg.dependencies ?? {});
  for (const dep of deps) if (!staged.has(dep)) queue.push(dep);
}

console.log(`已抽取 ${String(staged.size)} 个包 / ${String(totalFiles)} 个文件 -> ${outRoot}`);
if (missing.length > 0) console.log(`asar 里没有的包(可能是 peer,由宿主提供): ${missing.join(", ")}`);
console.log(`包列表: ${[...staged].join(", ")}`);
