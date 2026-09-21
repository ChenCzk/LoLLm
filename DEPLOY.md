# LoLLm 落地提示词

> 用法：把**本文件全文**复制粘贴给你的 AI 助手（Claude Code / Codex / 任意编码智能体），
> 它就会带着你把网关在这台机器上装起来、配好、验证通过。

---

# 任务：把 LoLLm 本地大模型网关部署到本机并跑通

仓库地址：https://github.com/ChenCzk/LoLLm

## 这是什么

一个本机运行的「大模型统一入口」。它把几套不同来源的模型能力（WorkBuddy、GLM Official、
Qoder）收敛成**一套 OpenAI 兼容 API**，只监听 `127.0.0.1:8787`。之后 Codex、Claude Code、
任何 OpenAI 客户端都只认这一个地址，换渠道不用改下游配置。

仓库里**不含**任何账号凭据，也**不含**两个第三方渠道的源码 —— 那些由安装脚本按 commit
拉取并编译。所以必须先跑安装脚本，网关才有东西可路由。

## 开始之前

先确认这台机器是 macOS、Linux 还是 Windows，以及是否已装齐：

- Node.js ≥ 18（推荐 20+）—— 网关本身零第三方依赖，不需要 `npm install`
- Go ≥ 1.22 —— 只用来编译渠道子进程
- Git

缺哪个就告诉我，先装齐再继续。

## 执行步骤

每步做完都要**验证通过再进下一步**。任何一步失败，把原始报错贴给我，不要自己猜着改。

### 第 1 步 · 克隆

```bash
git clone https://github.com/ChenCzk/LoLLm.git
cd LoLLm
```

验证：目录里应有 `gateway/`、`scripts/`、`patches/`、`package.json`，且**没有**
`gateway/config.json`、`.qoder-src/`、`channels/workbuddy2api-panel/`（那些是本地生成的）。

### 第 2 步 · 拉渠道并编译

```bash
npm run setup
```

这一步会：拉取两个第三方渠道仓库（锁定 commit）→ 给 Qoder 打 CN 排队补丁 →
分别编译 → 生成 `gateway/config.json`。首次约 1～3 分钟。

验证：出现 `[setup] 完成。下一步：npm start`，且存在 `channels/workbuddy2api-panel/wb2api`
（Windows 上是 `wb2api.exe`）和 `.qoder-src/qodercli2api`（Windows 上是 `.exe`）。

> 只想装其中一个渠道，可用 `npm run setup:engine` 或 `npm run setup:qoder`。

### 第 3 步 · 启动

```bash
npm start
```

验证：

```bash
curl http://127.0.0.1:8787/healthz
```

要看到 `"gateway": "ready"` 和 `"engine": "ready"`。三个端口应处于监听状态：
`8787`（网关）、`7863`（WorkBuddy engine）、`8377`（Qoder channel）。

### 第 4 步 · 配渠道凭据

网关此时已经能起，但三个渠道各配各的凭据，**缺一个不影响其它渠道**。
先打开 <http://127.0.0.1:8787/console/>，填入 API Key `sk-local-llm-gateway-2026`，
看「适配器」表格里每个渠道的状态。

**需要我配合的地方，停下来问我要，不要凭空编造：**

**① WorkBuddy** —— 打开 <http://127.0.0.1:8787/panel/> →「添加账号」，走浏览器设备流授权。
这一步需要我自己扫码/登录，你把链接给我。
（另一种方式：如果本机已有 DSH 且登录过 WorkBuddy，网关会自动扫描
`~/.dsh/workbuddy-accounts/` 导入，不用手动做。）

**② GLM Official** —— 需要我提供 Z.ai Coding Plan 的 `ZAI_API_KEY`。
配法二选一：设为环境变量 `ZAI_API_KEY`，或写进 `~/.dsh/.credentials.yaml` 的同名项。
不要写进 `config.json`。

**③ Qoder（含限免模型）** —— 需要我提供一个 Qoder **CN** 账号。执行：

```bash
./.qoder-src/qodercli2api -login \
  -auth-dir ./.qoder-auth-cn \
  -web-endpoint https://qoder.com.cn \
  -openapi-endpoint https://openapi.qoder.com.cn
```

然后把浏览器里出现的授权链接给我。

> 注意：Qoder 的 CN 和 Global 是两套独立的账号池与端点，token 不能混用。
> 另外这个渠道的模型列表来自 **Qoder CN 客户端自己的缓存**（`~/.qoder-cn/.models/`）。
> 如果这台机器没装过 Qoder CN 客户端、或没登录过，Qoder 渠道只会显示内置的 16 个模型，
> 看不到限免的 Qwen3.8-Flash —— 遇到这种情况直接告诉我。

### 第 5 步 · 端到端验收

```bash
# 列出所有可用模型
curl -s -H 'Authorization: Bearer sk-local-llm-gateway-2026' \
  http://127.0.0.1:8787/v1/models

# 实际打一次推理（换成上面列表里任一模型名）
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer sk-local-llm-gateway-2026' \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3.8-flash","max_tokens":40,
       "messages":[{"role":"user","content":"只回复：OK"}]}'
```

判据：返回体里有 `choices[0].message.content` 且内容非空。

> `max_tokens` 别设太小。这批模型是**带思维链**的，32 个 token 可能全花在
> `reasoning_content` 上，`content` 是空串、`finish_reason` 是 `length` —— 这不是故障。
> 建议 ≥ 40，并且判断成功时看 `content`，不要只看 HTTP 200。

### 第 6 步 · 接入下游

以 OpenCode / 兼容 YAML 配置为例：

```yaml
llm:
  providers:
    gateway:
      baseURL: http://127.0.0.1:8787/v1
      apiKey: sk-local-llm-gateway-2026
```

### 第 7 步 · 让它常驻

`npm start` 是前台进程，关掉终端就停。装好并验收通过后告诉我，我再跟你确认
要不要配开机自启；配置前先不要动系统服务。

## 已知坑（先看这里，别重复踩）

| 现象 | 原因 / 处理 |
|---|---|
| 启动报 `WorkBuddy engine did not become ready` | 多为 `7863` 端口被占用，或 `channels/workbuddy2api-panel/config.local.json` 里的密钥与 `gateway/config.json` 不一致。删掉那个文件重新 `npm run setup:engine` 即可 |
| 某渠道回 `upstream_unavailable: fetch failed` | 该渠道的子进程没起来。去 `/console/` 看「适配器」表格的状态列，会显示「子进程未运行」还是「缺少凭据」 |
| Qoder 返回 HTTP 200 但 `content` 是 `null` | 上游排队（错误码 10605，Qoder CN 对限免模型限流）。重试或换模型；这是上游负载问题，不是配置错误 |
| Qoder 模型只有 16 个 | 本机没有 Qoder CN 客户端的模型缓存，限免模型看不到。装客户端登录一次即可 |
| 端口冲突 | 改 `gateway/config.json` 里的 `gateway.port` / `engine.baseUrl` / Qoder channel 的 `baseUrl` 与 `spawn.args` 里的端口 |
| Windows 上关不掉 | 用任务管理器强杀网关时子进程不会跟着退出，建议 Ctrl+C 正常关闭。若残留，手动结束 `wb2api.exe` / `qodercli2api.exe` |
| Windows 上 `.models` 建不出来 | 网关用的是 junction，不需要管理员权限也不需要开发者模式；如果仍失败，检查目标目录 `%USERPROFILE%\.qoder-cn\.models` 是否存在 |

## 交付给我

做完后请给我一份简短报告，包含：

1. 操作系统与 Node / Go 版本
2. `/healthz` 的原始返回
3. `/v1/models` 的模型总数，以及其中 Qoder 系（`qoder:` 前缀）有几个
4. 第 5 步那次推理的模型名与返回的 `content`
5. 三个渠道各自的状态（就绪 / 缺少凭据 / 未运行）
6. 遇到的所有报错原文，以及你做了什么
