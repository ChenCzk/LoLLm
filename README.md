# 本地大模型网关

把几套不同来源的大模型能力，收敛成**一套本机 OpenAI 兼容 API**。下游工具（Codex、Claude Code、
任何 OpenAI 客户端）只需要认一个地址：`http://127.0.0.1:8787/v1`。

换渠道、加账号、切模型，下游配置都不用改。

当前内置三个渠道：

| 渠道 | 来源 | 说明 |
|---|---|---|
| `workbuddy` | WorkBuddy 国内版 + 国际版 | 多账号池、token 自动刷新、冷却熔断 |
| `glm-official` | Z.ai Coding Plan | 远端直连，独立凭据 |
| `qoder` | Qoder（CN） | 走 `qodercli2api` 子进程，含限免 Qwen 系模型 |

## 架构

```text
下游工具（Codex / Claude Code / 任意客户端）
  ↓ OpenAI 兼容 API, 127.0.0.1:8787
gateway/gateway.mjs（Node，零 npm 依赖）
  - API Key 鉴权
  - /v1/models 聚合与规范化
  - 路由 + 有序故障转移
  - SSE 流式透传
  - 托管子进程启停（engine / channel）
  - 网页控制台 /console/ 与管理接口 /admin/
  ├─ WorkBuddy Channel Engine（Go 子进程, :7863）
  |  - 多账号池、token 刷新、冷却熔断、CN / Global 路由
  ├─ GLM Official Channel Adapter
  |  - Z.ai Coding Plan，OpenAI 兼容代理，独立凭据
  └─ Qoder Channel Adapter（Go 子进程, :8377）
     - qodercli2api，含 CN 排队重试补丁
     - 独立凭据，不混入 WorkBuddy 池
```

子进程（engine 与各 channel）的**生命周期由 gateway 托管**：网关启动它们，崩了自动重起，
网关退出时一起收掉。所以只需要跑网关这一个进程。

## 快速开始

> 想让 AI 助手带着你装？把 [`DEPLOY.md`](DEPLOY.md) 全文复制给它，它会按步骤带着你配完并验证。
> 下面是人手操作的版本。

### 环境要求

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | 18+（推荐 20+） | 跑网关；不需要 `npm install`，无第三方依赖 |
| Go | 1.22+ | 编译两个渠道子进程（只需一次） |
| Git | 任意 | `setup` 拉取第三方渠道 |

### 三步跑起来

```bash
npm run setup     # 拉取两个第三方渠道（按 commit 锁定）+ 编译，生成 config.json
npm start         # 编译 engine 后启动网关
```

打开 <http://127.0.0.1:8787/console/>，填入 API Key `sk-local-llm-gateway-2026`。

```text
Base URL: http://127.0.0.1:8787/v1
API Key:  sk-local-llm-gateway-2026
```

> 这个 Key 只对本机 `127.0.0.1` 生效，网关不监听外部网卡，所以它写在文档和代码里是安全的。
> 想换就在 `gateway/config.json` 的 `gateway.apiKey` 改。

### 配好渠道凭据

`npm run setup` 完成后网关已经能起，但**三个渠道各自的凭据要单独配**。缺哪个都不影响其它渠道启动，
面板的「适配器」表会显示「缺少凭据」。

<details>
<summary><b>WorkBuddy 账号</b>（唯一需要网页登录的）</summary>

有两种来源，任选：

1. **面板添加**（推荐）：打开 <http://127.0.0.1:8787/panel/> →「添加账号」，走浏览器设备流授权。
2. **DSH 导入**：如果你本机有 DSH 且已登录 WorkBuddy，网关启动时会自动扫描
   `~/.dsh/workbuddy-accounts/{cn,ai}/*.info` 并导入，之后监听该目录，发现新账号自动导入。
   手动同步：`npm run sync:dsh`。

账号文件落在 `channels/workbuddy2api-panel/auths/`，**已在 `.gitignore` 里**。
</details>

<details>
<summary><b>GLM Official</b>（Z.ai Coding Plan）</summary>

优先级从高到低：

1. 环境变量 `ZAI_API_KEY`
2. `~/.dsh/.credentials.yaml` 里的同名项

不改代码、不写进 `config.json`，也不会打进日志。
</details>

<details>
<summary><b>Qoder</b>（含限免模型）</summary>

需要一个 Qoder CN 账号凭据。设备流登录：

```bash
./.qoder-src/qodercli2api -login \
  -auth-dir ./.qoder-auth-cn \
  -web-endpoint https://qoder.com.cn \
  -openapi-endpoint https://openapi.qoder.com.cn
```

**CN 与 Global 的账号池和端点彼此独立，token 不能混用**。CN token 打到默认的
`api2.qoder.sh` 会回 `Login expired`，所以 `config.json` 里显式指定了 CN 端点。

模型目录不是写死的：`qodercli2api` 在运行时解密 Qoder CLI 自己的模型缓存
（`<auth-dir>/../.models/<uid>/catalog-v6`）。网关启动时会自动把项目内 `.models`
链接到 `~/.qoder-cn/.models`，所以 **Qoder 侧新增或更换限免模型，不用改本仓库配置**，
重启网关即可看到。没装 Qoder CN 客户端的话，模型列表会退化成内置的 16 个。

详见[下方 Qoder 渠道](#qoder-渠道)一节。
</details>

## 跨平台

网关与两个 Go 渠道都支持 macOS / Linux / Windows，配置是同一份。

- 可执行文件后缀按平台自动补（Windows 上找 `.exe`），不用改 `config.json`
- 家目录用 `os.homedir()` 解析，不依赖 `HOME` 环境变量
- `.models` 在 Windows 上用 **junction**（不需要管理员权限，也不需要开开发者模式）
- 所有脚本都是 Node（`scripts/*.mjs`），不依赖 bash

Windows 上运行时注意：网关被强杀（任务管理器 / `taskkill /F`）时子进程不会跟着退出，
建议正常 Ctrl+C 关闭；需要常驻可以用任务计划程序或注册成服务。

## DSH 凭据桥接

gateway 启动时会扫描并导入：

```text
~/.dsh/workbuddy-accounts/cn/*.info
~/.dsh/workbuddy-accounts/ai/*.info
```

规则：

- `active.info` symlink 不导入。
- JSON 解析失败或缺少 `accessToken` / `uid` 的文件跳过。
- DSH 的 `ai` 目录制映射为 engine 的 `global` realm。
- DSH 毫秒时间戳会转换为面板需要的 Unix 秒。
- 同一账号只在 DSH 凭据比网关内凭据更新时覆盖。
- 网关内凭据文件权限为 `0600`。
- 监听 DSH 目录；发现新账号后自动导入并重启 WorkBuddy engine。

也可以手动同步：

```bash
npm run sync:dsh
```

## 模型路由

`/v1/models` 以**裸名只代表一个真实存在的后端**为不变式做规范化：

- CN 与 Global 同名 → 裸名走 CN，同时保留 `global:<name>` 显式入口，并作为 failover 兜底。
- **仅 Global 存在的模型 → 只导出 `global:<name>`，不生成裸别名。**

第二条约定的由来：`gpt-5.6-luna` / `terra` / `sol` 这代模型只存在于 WorkBuddy AI 国际版。
早期实现无条件把 global 提升成裸名，使 `/v1/models` 同时列出 `gpt-5.6-luna` 与
`global:gpt-5.6-luna`；调用方看到裸名就按文档补 `cn:` 前缀，正好覆盖掉唯一可用的 realm，
上游 100% 回 `11102 model is only available for authorized users`，并让引擎对该
(账号, 模型) 打 6h 起的负缓存，最终把单个模型的问题放大成整池 `no_healthy_account`。
现在裸名会按引擎目录声明的真实 realm 发送（`engineRouteIndex`），不再无条件走 `defaultRealm`。

常用请求模型名：

```text
deepseek-v4.1-flash
glm-5.3-flash
global:deepseek-v4.1-flash
global:gpt-5.6-luna
glm-official:glm-5.3-flash
```

裸模型名默认走 WorkBuddy CN。GLM Official 是独立 channel，需要使用显式前缀；它不会和 WorkBuddy 的 GLM 池互相故障转移。也可以显式写：

```text
cn:deepseek-v4.1-flash
global:deepseek-v4.1-flash
official:glm-5.3-flash
```

`config.json` 的 `routing.staticModels` 用于**按字段覆盖**引擎元数据（如收紧
`max_output_tokens`），不会抹掉引擎声明的能力字段（`reasoning_supported_efforts`、
`can_disable_thinking` 等）——这些字段是下游渲染推理档位选择器的依据。

GLM Official 渠道优先读取 `ZAI_API_KEY` 环境变量；未注入时会从 `~/.dsh/.credentials.yaml` 解析同名引用。Key 不写入项目配置，也不会打印到日志。

## Codex / ChatGPT 桌面版接入

Codex 使用 `/v1/responses`，而引擎只认 Chat Completions。网关会把 Responses 的能力参数
桥接到 Chat Completions：`reasoning.effort`（兼容顶层 `reasoning_effort`）→
`reasoning_effort`，`service_tier` → `service_tier`。不桥接时这些参数会被静默丢弃，
表现为「推理层级选不了、永远是默认 high」和「Fast 开关无效」。

### 直连模式（当前采用）

Codex 直接连网关，不经 CC Switch：

```toml
# ~/.codex/config.toml
model_provider = "custom"
model = "global:gpt-5.6-terra"
model_catalog_json = "/Users/zekaichen/Documents/code/project/ai/gateway/codex-model-catalog.json"
model_reasoning_effort = "medium"

[model_providers.custom]
name = "local-llm-gateway"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://127.0.0.1:8787/v1"
experimental_bearer_token = "sk-local-llm-gateway-2026"
```

```text
Codex → 网关 (8787) → 引擎 (7863) → WorkBuddy
```

### 为什么不用 CC Switch 中转

CC Switch 会把自己数据库里的 `modelCatalog` 推送覆盖
`~/.codex/cc-switch-model-catalog.json`。实测：手工修好该文件后 10 分钟内即被推回旧版，
三个控件全部失效（`[none, high]` / `128000` / 空 `service_tiers`）。
直连后 catalog 由本项目的 `gen-codex-catalog` 维护、写在项目内，CC Switch 不再触碰。

### 生成 catalog

Codex 的模型选择器**不读 `/v1/models`**，只读 `model_catalog_json` 指向的文件。

```bash
npm run gen:codex-catalog              # 默认精选集合
npm run gen:codex-catalog -- --all     # 全部 71 个模型
npm run gen:codex-catalog -- --models global:gpt-5.6-sol,deepseek-v4.1-flash
npm run gen:codex-catalog -- --dry-run # 预览不写盘
```

脚本把 `reasoning_supported_efforts` → `supported_reasoning_levels`、
`context_length` → `context_window` / `max_context_window`（上限 1M，覆盖 WorkBuddy 的
300K / 1M 两档）、并写入 `service_tiers: [default, fast]` 以启用 Fast 模式。
自定义模型（`customModels`）是网关级别名，脚本会自动继承其路由指向的底层模型能力。

改了 `gateway/config.json`（`staticModels` / `customModels`）后需重跑本脚本，
否则 Codex 侧的能力声明不会更新。

### 已知的 UI 干扰项

`~/.codex/models_cache.json` 是 Codex 从 OpenAI 官方拉取的模型缓存
（`gpt-5.6-luna`、`gpt-5.5`、`gpt-reserve` 等），**绕过网关**，会在选择器里与网关模型
并列显示。选中它们会失败。脚本已默认剔除 `gpt-reserve` / `codex-auto-review`；
其余同名项因与网关 `global:` 模型重名而难以区分，建议在 UI 中忽略裸名项、优先选带
realm 前缀的条目。

### 错误语义

上游对非法参数返回 `503 no_healthy_account` + 内层 `extError.code`；网关会把
`invalid_value` / `integer_below_min_value` 这类**客户端参数错误**还原成 `400`
（带 `param`），避免客户端误以为账号池故障而反复重试。

## Qoder 渠道

把 `qodercli2api`（源码在 `.qoder-src/`，纯 Go）转出的 OpenAI 兼容端点接成网关的一个
`openai-chat-completions` channel。它复用 Qoder CN CLI 自己的凭据与模型目录缓存，
因此 Qoder 侧限免 / 新增模型无需改本仓库配置，重启子进程即可自动可见。

```text
下游 → 网关(8787) → qodercli2api(8377) → gateway.qoder.com.cn
```

生命周期由网关托管（`config.json` 的 `channels[].spawn`），与 engine 同一套启停 + 崩溃重启。
不放进启动脚本是因为网关自己就是唯一的常驻进程，子进程跟着它走最省心。

调用方式（前缀 `qoder:`，别名 `qd:`）：

```bash
# 本月限免模型（裸名别名，走 qoder channel）
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer sk-local-llm-gateway-2026' \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3.8-flash","messages":[{"role":"user","content":"hi"}]}'

# 同渠道其它模型（前缀匹配不依赖 channels[].models 名单，名单只影响 /v1/models 展示）
curl ... -d '{"model":"qoder:Qwen3.8-Max", ...}'
```

已注册别名：`qwen3.8-flash`。
`qoder:<模型名>` 可直连该账号全部 19 个模型（`/v1/models` 只展示其中 4 个）。

### 配置要点

- **CN / Global 不能混用**：CN token 打到默认的 `api2.qoder.sh` 会回 `Login expired`，
  必须显式指定 `-endpoint https://gateway.qoder.com.cn` 与
  `-openapi-endpoint https://openapi.qoder.com.cn`。
- **凭据**：项目内 `.qoder-auth-cn/`（CN 账号，已在 `.gitignore`）。登录命令见上文
  「配好渠道凭据 → Qoder」。
- **模型目录**：`qodercli2api` 会解密 `<auth-dir>/../.models/<uid>/catalog-v6`。
  网关启动时把项目内 `.models` 链接到 `~/.qoder-cn/.models`（即 Qoder CN CLI 自己的缓存），
  所以目录始终跟 CLI 同步；找不到该缓存时会退回内置的 16 个模型。
- **CN 排队补丁**：CN 侧对限免模型会返回 `10605 Queuing failed`，而且**藏在 HTTP 200 的
  SSE 首帧里**。上游原版不识别这种形态，会把它当正常流直接放给下游（表现为空回答）。
  `patches/qodercli2api-cn-queue.patch` 补上了「预读首帧 → 识别 10605 → 按
  retryAfterSeconds 重试」，`npm run setup` 会自动应用。补丁打不上时脚本只告警不中断，
  Qoder 渠道仍可用，但排队时不会自动重试。
- **重试耗尽后的行为**：重试 4 次仍排队，会回**空内容的 200**（不是错误）。表现为
  `content: null`，换模型或稍后重试即可。

## 下游接入

```yaml
llm:
  providers:
    gateway:
      baseURL: http://127.0.0.1:8787/v1
      apiKey: sk-local-llm-gateway-2026
```

## 网页控制台

只跑网关一个进程，控制台和 WorkBuddy 工作台都在里面：

| 地址 | 用途 |
|---|---|
| <http://127.0.0.1:8787/console/> | 总控面板：网关状态、账号池、最近请求（含每条的思考档位）、Token 用量、模型路由增删改 |
| <http://127.0.0.1:8787/panel/> | WorkBuddy 工作台：账号登录/签到/任务、模型与档位、配置、日志 |

「模型路由」区勾选 **管理模式** 后才会出现「操作」列（编辑 / 删除）和「新建模型」按钮 ——
这是刻意设计，避免误删。一个对外模型名可以挂多条内部路由，按顺序故障转移，
响应头 `x-gateway-route` 会告诉实际命中了哪条。

## 管理接口

```bash
curl -H 'Authorization: Bearer sk-local-llm-gateway-2026' \
  http://127.0.0.1:8787/admin/status
```

手动重新同步 DSH：

```bash
curl -X POST -H 'Authorization: Bearer sk-local-llm-gateway-2026' \
  http://127.0.0.1:8787/admin/dsh/sync
```

## 第三方依赖与许可证

本仓库**不包含**两个渠道的代码，只记录来源、锁定的 commit 和补丁，由 `npm run setup` 拉取：

| 目录 | 上游 | 锁定 commit | 许可证 |
|---|---|---|---|
| `channels/workbuddy2api-panel/` | [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | `c192fd1` | MIT（原项目 [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)） |
| `.qoder-src/` | [Liki4/qodercli2api](https://github.com/Liki4/qodercli2api) | `b8b595f` | AGPL-3.0 |

两者都是各自独立的程序，以子进程方式运行，与本仓库是聚合而非派生关系。
本仓库自己的代码（`gateway/` 与 `scripts/`）不含上述项目的任何代码。

`patches/qodercli2api-cn-queue.patch` 是本仓库针对上游的**增量补丁**（+129 行，无删除），
仅修复 CN 排队信号的识别，未改动上游其它逻辑。

## 注意

- 所有服务只监听 `127.0.0.1`，不对外暴露。
- 凭据一律不进版本库，`.gitignore` 已覆盖账号池、Qoder 凭据、本机配置。克隆后需要自己配。
- 请只使用自己合法拥有的账号与订阅，并遵守各服务的条款。
