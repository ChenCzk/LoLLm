// 模型路由配置：对外模型的校验、规范化与持久化。
// gateway.mjs 负责 HTTP，本模块只处理数据，便于单测。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REALMS = ['cn', 'global'];
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/u;

export class ModelConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelConfigError';
    this.statusCode = 400;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function positiveInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  return number;
}

export function officialChannelsOf(config) {
  return (config?.channels || []).filter(channel => channel.type === 'openai-chat-completions');
}

export function channelPrefix(channel) {
  return channel?.routing?.prefix || channel?.id || '';
}

function channelPrefixes(channel) {
  return [channelPrefix(channel), ...(channel?.routing?.aliases || [])].filter(Boolean);
}

export function normalizeModelId(value) {
  const id = String(value ?? '').trim();
  if (!id) throw new ModelConfigError('模型 ID 不能为空。');
  if (id.includes(':')) throw new ModelConfigError('模型 ID 不能包含 “:”，realm 前缀由网关内部维护。');
  if (id.endsWith('@global')) throw new ModelConfigError('模型 ID 不能以 “@global” 结尾，该写法是 global realm 的保留后缀。');
  if (id.length > 120) throw new ModelConfigError('模型 ID 过长（最多 120 个字符）。');
  if (!MODEL_ID_PATTERN.test(id)) {
    throw new ModelConfigError('模型 ID 只能包含字母、数字、点、下划线、短横线和斜杠，且必须以字母或数字开头。');
  }
  return id;
}

// 把一条路由描述规范化为内部路由对象。
export function normalizeRoute(spec, context = {}) {
  const officialChannels = context.officialChannels || [];
  const defaultRealm = context.defaultRealm || 'cn';
  if (!spec || typeof spec !== 'object') throw new ModelConfigError('每条内部路由都必须是对象。');
  const channelId = String(spec.channelId ?? '').trim();
  if (!channelId) throw new ModelConfigError('内部路由缺少 channelId。');
  let model = String(spec.model ?? '').trim();
  if (!model) throw new ModelConfigError('内部路由缺少 model 名称。');

  if (channelId === 'workbuddy') {
    const match = /^(cn|global):(.+)$/u.exec(model);
    if (match) model = match[2].trim();
    const realm = String(spec.realm || (match ? match[1] : defaultRealm)).trim().toLowerCase();
    if (!REALMS.includes(realm)) throw new ModelConfigError(`WorkBuddy realm 只能是 cn 或 global，收到 “${realm}”。`);
    if (!model) throw new ModelConfigError('WorkBuddy 路由缺少 model 名称。');
    return {
      channelId: 'workbuddy',
      realm,
      model,
      wireModel: `${realm}:${model}`,
      source: realm === 'global' ? 'wbAI' : 'wb',
    };
  }

  const channel = officialChannels.find(item => item.id === channelId);
  if (!channel) {
    const known = ['workbuddy', ...officialChannels.map(item => item.id)].join('、');
    throw new ModelConfigError(`未知渠道 “${channelId}”，可用渠道：${known}。`);
  }
  for (const prefix of channelPrefixes(channel)) {
    const match = new RegExp(`^${escapeRegExp(prefix)}:(.+)$`, 'u').exec(model);
    if (match) {
      model = match[1].trim();
      break;
    }
  }
  if (!model) throw new ModelConfigError(`${channelId} 路由缺少 model 名称。`);
  const prefix = channelPrefix(channel);
  return { channelId, realm: 'official', model, wireModel: `${prefix}:${model}`, source: channelId };
}

// 内部路由对象 → 写入 config.json 的紧凑形式。
export function serializeRoute(route) {
  if (route.channelId === 'workbuddy') {
    return { channelId: 'workbuddy', realm: route.realm, model: route.model };
  }
  return { channelId: route.channelId, model: route.model };
}

export function buildCustomModel(input, context = {}) {
  if (!input || typeof input !== 'object') throw new ModelConfigError('请求体必须是 JSON 对象。');
  const id = normalizeModelId(input.id);
  if (!Array.isArray(input.routes) || input.routes.length === 0) {
    throw new ModelConfigError('至少需要一条内部路由。');
  }
  if (input.routes.length > 32) throw new ModelConfigError('单条模型最多 32 条内部路由。');

  const seen = new Set();
  const routes = [];
  for (const spec of input.routes) {
    const route = normalizeRoute(spec, context);
    if (seen.has(route.wireModel)) continue;
    seen.add(route.wireModel);
    routes.push(route);
  }
  if (!routes.length) throw new ModelConfigError('去重后没有可用的内部路由。');

  const model = {
    id,
    object: 'model',
    owned_by: 'gateway',
    routes,
  };
  const displayName = String(input.displayName ?? '').trim();
  if (displayName) model.displayName = displayName.slice(0, 120);
  model.supports_images = input.supports_images === undefined ? true : Boolean(input.supports_images);
  model.failover = input.failover === undefined ? true : Boolean(input.failover);
  if (model.failover) model.routing = 'ordered-failover';
  const contextLength = positiveInt(input.context_length);
  const maxOutput = positiveInt(input.max_output_tokens);
  if (contextLength) model.context_length = contextLength;
  if (maxOutput) model.max_output_tokens = maxOutput;
  return model;
}

// 读取 config.json 里的自定义模型，跳过非法项而不是让网关启动失败。
export function normalizeCustomModels(list, context = {}) {
  const models = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    try {
      const model = buildCustomModel(item, context);
      if (seen.has(model.id)) {
        console.error(`[models] duplicated custom model id skipped: ${model.id}`);
        continue;
      }
      seen.add(model.id);
      models.push(model);
    } catch (error) {
      console.error(`[models] invalid custom model skipped: ${error.message}`);
    }
  }
  return models;
}

export function normalizeDisabledModels(list) {
  const ids = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const id = String(item ?? '').trim();
    if (id) ids.add(id);
  }
  return ids;
}

// /v1/models 对外形态：routes 展开为内部路由，供控制台展示。
export function publicModel(model) {
  return {
    ...model,
    routes: model.routes.map(route => ({ ...route })),
  };
}

// ---------------------------------------------------------------------------
// 引擎模型目录 → 公开模型列表 + 裸名路由索引。
//
// 这是 realm 正确性的唯一来源，抽出来便于单测（gateway.mjs 只做 HTTP 编排）。
//
// 核心不变式：**裸名只代表一个真实存在的后端**。CN 与 Global 同名时 CN 优先；
// global-only 的模型（gpt-5.6-luna / terra / sol 这代）**不生成裸别名**，只导出
// `global:<name>`。
//
// 历史缺陷（已修）：旧实现用 `preferred = realm === 'cn' || !current` 无条件把
// global 提升成裸名，于是 /v1/models 同时列出 `gpt-5.6-luna` 与
// `global:gpt-5.6-luna`。调用方看到裸名就按 README 约定补 `cn:` 前缀，正好覆盖掉
// 唯一可用的 realm —— 上游 100% 回 11102，并让引擎对该 (账号, 模型) 打 6h 起的
// 负缓存，最终把单个模型的问题放大成整池 no_healthy_account。
export function normalizeEngineCatalog({ enginePayload, staticModels = [], defaultRealm = 'cn' } = {}) {
  const byBare = new Map(); // bare → { cn?: item, global?: item }
  const data = [...(enginePayload?.data || []), ...staticModels];
  for (const item of data) {
    const rawId = String(item?.id || '');
    const match = /^(cn|global):(.+)$/u.exec(rawId);
    const realm = match ? match[1] : defaultRealm;
    const bare = match ? match[2] : rawId;
    if (!bare) continue;
    const slot = byBare.get(bare) || {};
    // staticModels 排在最后，用于按需**覆盖元数据**（context_length 等）。
    // 注意不能整体替换：staticModels 通常只有寥寥几个字段，整体替换会把引擎声明的
    // 能力字段（reasoning_supported_efforts / can_disable_thinking …）一并抹掉，
    // 下游（Codex）就渲染不出推理档位选择器。故按字段合并：static 显式声明的字段
    // 生效，其余保留引擎值。
    slot[realm] = slot[realm] ? { ...slot[realm], ...item } : item;
    byBare.set(bare, slot);
  }

  const models = [];
  const routeIndex = new Map();
  const workbuddyRoute = (realm, bare) =>
    ({ channelId: 'workbuddy', realm, model: bare, wireModel: `${realm}:${bare}` });

  for (const [bare, slot] of byBare) {
    if (slot.cn) {
      models.push({
        ...slot.cn,
        id: bare,
        owned_by: 'workbuddy',
        workbuddy_default_realm: 'cn',
        routes: [workbuddyRoute('cn', bare)],
      });
      // 两个 realm 都有 → 裸名走 CN，global 保留显式前缀并作为 failover 兜底。
      routeIndex.set(bare, slot.global
        ? [workbuddyRoute('cn', bare), workbuddyRoute('global', bare)]
        : [workbuddyRoute('cn', bare)]);
    }
    if (slot.global) {
      // global 恒导出带前缀形态：CN 也有同名时它是显式入口，global-only 时它是唯一入口。
      models.push({
        ...slot.global,
        id: `global:${bare}`,
        owned_by: 'workbuddy-global',
        routes: [workbuddyRoute('global', bare)],
      });
    }
  }

  models.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { models, routeIndex };
}

// 裸模型名 → 路由。显式 realm 前缀 / @global 后缀 / 官方渠道 / 自定义模型均由
// 调用方先行处理；本函数只负责「裸名该走哪个 realm」这一层。
export function bareRouteAttempts(value, routeIndex, defaultRealm = 'cn') {
  const bare = String(value ?? '').trim();
  const discovered = routeIndex?.get?.(bare);
  if (discovered?.length) return discovered.map(route => ({ ...route }));
  return [{ channelId: 'workbuddy', realm: defaultRealm, model: bare, wireModel: `${defaultRealm}:${bare}` }];
}

// 引擎模型目录 + 官方渠道 + 已有自定义模型 → 控制台可选项。
export function buildCatalog({ enginePayload, officialChannels = [], customModels = [], configuredChannels = new Set(), defaultRealm = 'cn' } = {}) {
  const cn = [];
  const global = [];
  for (const item of enginePayload?.data || []) {
    const raw = String(item.id || '');
    const match = /^(cn|global):(.+)$/u.exec(raw);
    const realm = match ? match[1] : 'cn';
    const model = match ? match[2] : raw;
    if (!model) continue;
    const entry = {
      model,
      name: item.name || model,
      description: item.description || '',
      context_length: item.context_length,
      max_output_tokens: item.max_output_tokens,
      credits: item.credits,
      supports_images: item.supports_images !== false,
    };
    (realm === 'global' ? global : cn).push(entry);
  }
  const byName = list => list.sort((a, b) => String(a.model).localeCompare(String(b.model)));
  return {
    defaultRealm,
    workbuddy: { cn: byName(cn), global: byName(global) },
    official: officialChannels.map(channel => ({
      channelId: channel.id,
      prefix: channelPrefix(channel),
      configured: configuredChannels.has(channel.id),
      models: (channel.models || []).map(model => ({
        model: model.id,
        name: model.displayName || model.id,
        context_length: model.context_length,
        max_output_tokens: model.max_output_tokens,
        supports_images: model.supports_images !== false,
      })),
    })),
    customModelIds: customModels.map(model => model.id),
  };
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

// 自定义模型 + 隐藏列表的读写入口。写盘成功后才更新内存状态。
export async function createModelStore({ configPath, config }) {
  const context = {
    officialChannels: officialChannelsOf(config),
    defaultRealm: config.routing?.defaultRealm || 'cn',
  };
  let models = normalizeCustomModels(config.routing?.customModels, context);
  let disabled = normalizeDisabledModels(config.routing?.disabledModels);

  function index() {
    return new Map(models.map(model => [model.id, model]));
  }

  async function persist(mutate) {
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    raw.routing = raw.routing || {};
    mutate(raw.routing);
    await writeJsonAtomic(configPath, raw);
    config.routing = raw.routing;
    models = normalizeCustomModels(raw.routing.customModels, context);
    disabled = normalizeDisabledModels(raw.routing.disabledModels);
  }

  return {
    list() {
      return models.map(publicModel);
    },
    ids() {
      return models.map(model => model.id);
    },
    has(id) {
      return index().has(String(id));
    },
    find(id) {
      const model = index().get(String(id));
      return model ? publicModel(model) : null;
    },
    disabledIds() {
      return [...disabled];
    },
    isDisabled(id) {
      return disabled.has(String(id));
    },
    // 路由尝试顺序：failover 关闭时只用第一条。
    attemptsFor(id) {
      const model = index().get(String(id));
      if (!model) return null;
      const routes = model.routes.map(route => ({ ...route }));
      if (model.failover === false) return routes.slice(0, 1);
      return routes;
    },
    async upsert(input, previousId = '') {
      const model = buildCustomModel(input, context);
      const previous = String(previousId || '').trim();
      if (previous && previous !== model.id && !index().has(previous)) {
        throw new ModelConfigError(`要修改的模型不存在：${previous}`);
      }
      await persist(routing => {
        const list = normalizeCustomModels(routing.customModels, context)
          .map(item => serializeModel(item));
        const from = previous || model.id;
        const at = list.findIndex(item => item.id === from);
        const serialized = serializeModel(model);
        if (at >= 0) list[at] = serialized;
        else list.push(serialized);
        routing.customModels = list;
      });
      return this.find(model.id);
    },
    // 自定义模型 → 删除；内置模型 → 加入隐藏列表。
    async remove(id) {
      const value = String(id ?? '').trim();
      if (!value) throw new ModelConfigError('缺少模型 ID。');
      const isCustom = index().has(value);
      await persist(routing => {
        if (isCustom) {
          routing.customModels = normalizeCustomModels(routing.customModels, context)
            .filter(model => model.id !== value)
            .map(model => serializeModel(model));
          return;
        }
        const list = normalizeDisabledModels(routing.disabledModels);
        list.add(value);
        routing.disabledModels = [...list];
      });
      return isCustom ? 'deleted' : 'hidden';
    },
    async setDisabled(id, value) {
      const target = String(id ?? '').trim();
      if (!target) throw new ModelConfigError('缺少模型 ID。');
      await persist(routing => {
        const list = normalizeDisabledModels(routing.disabledModels);
        if (value) list.add(target);
        else list.delete(target);
        routing.disabledModels = [...list];
      });
      return value;
    },
    // 供 /admin/status 返回的最新 routing 视图。
    routingSnapshot() {
      return {
        ...config.routing,
        customModels: models.map(model => serializeModel(model)),
        disabledModels: [...disabled],
      };
    },
    catalog(enginePayload, configuredChannels) {
      return buildCatalog({
        enginePayload,
        officialChannels: context.officialChannels,
        customModels: models,
        configuredChannels,
        defaultRealm: context.defaultRealm,
      });
    },
  };
}

export function serializeModel(model) {
  const out = {
    id: model.id,
    object: model.object || 'model',
    owned_by: model.owned_by || 'gateway',
    supports_images: model.supports_images !== false,
    failover: model.failover !== false,
  };
  if (model.displayName) out.displayName = model.displayName;
  if (model.context_length) out.context_length = model.context_length;
  if (model.max_output_tokens) out.max_output_tokens = model.max_output_tokens;
  out.routes = model.routes.map(serializeRoute);
  return out;
}
