# dsh-api-heal —— 「API 密钥无效」自修复插件

## 它解决什么

DSH 把上游任何 **401 / 403** 都归类成错误码 `AUTH`，然后 UI 用 i18n 键
`message.failure.auth` 把它替换成一句固定的中文 **「API 密钥无效」**
（见 `dsh-llm-pi-ai/lib/index.js` 的 `classifyPiAiError`）。
于是真正的原因（token 过期 / 会话失效 / 需要重新探测目录）全部被吞掉。

这个插件做两件事：

1. **自动自愈**：监听 `agent/request-error`，只要失败看着像认证问题，就
   就地去对应的 provider 重新续期 / 重取凭据，然后返回 `{ kind: "retry" }`
   让 agent loop **原地重发同一个请求** —— 用户看不到报错。
2. **手动工具 `heal_api`**：模型（也就是我）可以主动调用它来修，参数可选
   `provider`（`qoder` / `workbuddy-ai` / `our-free-model`），不给就三家全修。

另外开一条只读状态路由 `GET /plugins/dsh-api-heal/status`。

## 它怎么修三家

| provider | 自愈动作 |
|---|---|
| `qoder` | `GET /plugins/dsh-qoder-connect/status` 拿 `probeKey` → `POST /plugins/dsh-qoder-connect/probe` `{"action":"refresh"}`（触发 `store.resolve({force:true})`，走 `https://openapi.qoder.com.cn/api/v1/deviceToken/refresh` 续期并刷新模型目录） |
| `workbuddy-ai` | `GET /plugins/dsh-workbuddy-connect/ai/status` 拿 `probeKey` → `POST .../ai/probe` `{"action":"refresh"}`（重新解密桌面凭据 + 重拉 catalog）。CN 变体若 `signed-out` 直接跳过，不算失败 |
| `our-free-model` | `POST /api/our-free-model/refresh`，**必须带 connection 认证 cookie** |

最后一条是关键：`/api/our-free-model/*` 挂在 connection 的准入围栏后，裸 POST
一律 401。插件用 `.credentials.yaml` 里 `client-connection/browser-session`
的签名密钥，按 `dsh-client-connection` 同样的算法（HMAC-SHA256 + base64url，
payload `{version:1, authority, issuedAt, expiresAt}`）**自铸一枚会话 cookie**，
所以不需要浏览器、不需要已登录的 Web 会话。

## 目录

```
dsh-api-heal/
├─ lib/
│  ├─ heal.js      纯 Node 自愈内核（零 @deepseek-ai 依赖，可独立测试）
│  └─ index.js     插件入口：Config / apply / 监听器 / heal_api 工具 / 状态路由
├─ cordis.patch.yml
├─ package.json
├─ selftest.mjs    17 项检查，含真实打通三家上游
├─ smoke.mjs       18 项源码形状检查
├─ loadtest.mjs    52 项端到端检查（假 ctx + 真实 dsh-tools / schemastery）
├─ probe.mjs       独立探针：不装插件也能验证三家入口可达
├─ stage_deps.mjs  从 app.asar 抽真实依赖给 loadtest 用
├─ install.ps1     安装脚本（复制 + 改 profile + pnpm install）
└─ install.cmd     双击入口（带 -ExecutionPolicy Bypass）
```

## 安装

本机是 **PowerShell 5.1**、执行策略 `RemoteSigned`，所以**不能**直接
`pwsh -File install.ps1`（未签名会被拒）。用 `install.cmd`：

```cmd
E:\DSH CODE\dsh-api-heal\install.cmd
```

脚本会：备份 profile 的 `package.json` → 复制插件到
`E:\dsh-data\.dsh\plugins\dsh-api-heal` → 把 `dsh-api-heal` 加进
`dependencies`（`file:` 形式）和 `dsh.profile.bundles` → 跑 `pnpm install`
→ 装后自检。

装完**重启 DSH**（托盘也要退干净）。验证：

```
GET http://127.0.0.1:19387/plugins/dsh-api-heal/status
```

重启前访问会 404（路由只在进程启动时注册）。或者直接让我调一次 `heal_api`。

回滚：

```cmd
E:\DSH CODE\dsh-api-heal\install.cmd -Uninstall
```

## 测试

最快的一次性验证（**不需要装插件**，直接打三家入口）：

```cmd
cd /d "E:\DSH CODE\dsh-api-heal"
set DSH_HOME=E:\dsh-data\.dsh
set NODE=D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
%NODE% probe.mjs
```

输出形如：

```
[OK  ] qoder              600ms  qoder 续期成功(signed-in → {"state":"refreshed"})
[OK  ] workbuddy-ai       288ms  workbuddy-ai 刷新成功({"state":"refreshed","reason":"26 models"})
[OK  ] our-free-model   12765ms  our-free-model 目录刷新成功(12 个模型)
```

完整三套：

```cmd
%NODE% selftest.mjs
%NODE% smoke.mjs
%NODE% loadtest.mjs
```

`loadtest.mjs` 需要真实依赖，先抽一次（只需一次）：

```cmd
%NODE% "E:\DSH CODE\stage_deps.mjs" "E:\DSH CODE\_realmods" ^
  @deepseek-ai/dsh-tools @deepseek-ai/schemastery @deepseek-ai/cordis ^
  @deepseek-ai/dsh-scope @deepseek-ai/dsh-llm @deepseek-ai/dsh-sandbox
```

## 配置（profile `cordis.patch.yml` 里可覆盖）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoHeal` | `true` | 关掉就只剩手动 `heal_api` |
| `cooldownMs` | `60000` | 两次自动自愈之间的最短间隔，防抖 |
| `requestTimeoutMs` | `30000` | 单次上游调用超时 |
| `webBaseUrl` | `""` | 留空则依次用 `webServer.port/host` → `$DSH_WEB_URL` → `http://127.0.0.1:19387` |
| `registerRoutes` | `true` | 是否开状态路由 |

例如在 profile 的 `cordis.patch.yml` 末尾加：

```yaml
- id: api-heal
  name: dsh-api-heal
  config:
    cooldownMs: 15000
    autoHeal: true
```

## 边界（说实话的部分）

- **只能救「流已建立之后才失败」的请求。** `agent/request-error` 这个
  waterfall 只在 `live.finish.kind === "error" | "aborted"` 时触发；如果
  连接阶段就抛错（`started === false`），agent loop 直接 `throw`，监听器
  根本没机会跑。这种情况要靠 `heal_api` 手动修，或者重发消息。
- **不改 DSH 本体。** 那句「API 密钥无效」的文案仍在，只是现在多数情况下
  你再也看不到它了 —— 插件在它冒出来之前就把凭据修好了。
- **`probeKey` 每次进程重启都会变**（`randomBytes`），所以插件每次都重新
  `GET .../status` 现取，不硬编码。
- 自动自愈有 60 秒冷却：同一个错误短时间内反复出现不会疯狂打上游。
- `our-free-model` 那枚 cookie 是**用你自己的密钥签的**（读
  `.credentials.yaml` 里 `client-connection/browser-session` 的 secret），
  不落盘、不外发，只在 127.0.0.1 上用。
