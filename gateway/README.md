# Local LLM Gateway

本地 OpenAI-compatible 总控网关，默认对外暴露：

- API: `http://127.0.0.1:8787/v1`
- Console: `http://127.0.0.1:8787/console/`
- WorkBuddy panel: `http://127.0.0.1:8787/panel/`
- Usage API: `GET /admin/usage`

所有 API 和 admin 接口都需要 `Authorization: Bearer <gateway apiKey>`。

## 路由模型

`config.json > routing.customModels` 定义对外模型名。一个对外名可以映射到多条内部路由，网关按顺序尝试：

```json
{
  "id": "hy4",
  "routes": [
    { "channelId": "workbuddy", "realm": "cn", "model": "hy4-preview" },
    { "channelId": "workbuddy", "realm": "global", "model": "hy4-preview-f" }
  ]
}
```

裸模型名使用 ordered failover；`cn:model`、`global:model`、`glm-official:model` 会被固定到对应渠道，不自动跨渠道。

当前 `glm-5.3-flash` 先走 WorkBuddy CN 池；收到 402、408、429、502、503、504 或额度/积分不足类错误时，切换到 GLM Official Coding Plan。响应头 `x-gateway-route` 显示实际命中的内部路由。

## 用量

`/admin/usage` 汇总三个来源：

- `wb`: WorkBuddy CN
- `wbAI`: WorkBuddy AI / Global
- `glm-official`: GLM Official Coding Plan

WorkBuddy 用量读取 engine 的 `data/usage.json`；官方渠道用量由网关写入 `gateway/data/usage.json`。API 返回总量、按来源汇总、按模型和来源拆分的 requests、errors、prompt/completion/total tokens。

## 模型管理（总控看板）

Console 的「模型路由」区块打开「管理模式」后，可以直接增删改查对外模型：

- 新建：自定义一个对外 `id`，挂一条或多条内部路由，路由按顺序故障转移。
- 编辑：修改 ID、显示名称、上下文长度、最大输出、支持图片、是否故障转移，以及路由列表。
- 删除：自定义模型从 `routing.customModels` 删除；内置模型写入 `routing.disabledModels` 隐藏，不修改内置定义。
- 隐藏/恢复：只影响 `/v1/models` 列表，不影响已配置的静态模型定义。

一个对外 ID 可以混选 WorkBuddy CN、WorkBuddy Global 与官方直连路由，例如：

```json
{
  "id": "my-mix",
  "routes": [
    { "channelId": "workbuddy", "realm": "cn", "model": "glm-5.3-flash" },
    { "channelId": "workbuddy", "realm": "global", "model": "kimi-k2.6" },
    { "channelId": "glm-official", "model": "glm-5.3-flash" }
  ]
}
```

写入成功后才更新内存路由，配置变更会原子写回 `gateway/config.json`。

### 管理接口

- `GET /admin/models`：自定义模型列表、`disabledModels`、`hiddenModels`
- `GET /admin/catalog`：WorkBuddy CN/Global 与官方渠道的可选模型
- `POST /admin/models`：新建或编辑，body 为模型对象；重命名时带 `previousId`
- `DELETE /admin/models/:id`：自定义模型删除；内置模型隐藏
- `PATCH /admin/models/:id`：body `{ "hidden": true|false }` 控制内置模型隐藏/恢复

模型 ID 只能包含字母、数字、`.`、`_`、`-`、`/`，不能含 `:`，不能以 `@global` 结尾。

## 测试

```bash
npm test
```
