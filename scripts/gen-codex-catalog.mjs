#!/usr/bin/env node
// 从本地网关的实时模型能力生成 Codex(ChatGPT 桌面版) 的 model_catalog_json。
//
// 为什么需要它：
//   Codex 的模型选择器（推理层级 / Fast 开关 / 上下文长度）**不从 /v1/models 读取**，
//   而是读 config.toml 里 `model_catalog_json` 指向的本地 catalog 文件。
//   该文件里每个模型必须声明 supported_reasoning_levels、context_window、
//   max_context_window、service_tiers 等字段；缺哪个，Codex 就不渲染哪个控件。
//   之前的 catalog 是手工/旧版 CC Switch 生成的，三个字段组都是空或写死：
//     supported_reasoning_levels: [none, high]  → 选择器只剩两档，且默认 high
//     context_window == max_context_window == 128000 → 无法在 300K/1M 间选择
//     service_tiers: []                         → Fast 开关不出现
//
// 本脚本把网关 /v1/models 暴露的真实能力（reasoning_supported_efforts、
// reasoning_default_effort、context_length、max_output_tokens）映射成 Codex 的
// catalog schema，使三个控件都按上游真实能力渲染。
//
// 用法：
//   node scripts/gen-codex-catalog.mjs                 # 写入 ~/.codex/cc-switch-model-catalog.json
//   node scripts/gen-codex-catalog.mjs --out <path>     # 指定输出
//   node scripts/gen-codex-catalog.mjs --dry-run        # 只打印
//   node scripts/gen-codex-catalog.mjs --models a,b     # 只导出指定模型

import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_GATEWAY = 'http://127.0.0.1:8787/v1';
const DEFAULT_KEY = 'sk-local-llm-gateway-2026';
// 默认写到项目内，而不是 ~/.codex/。
// 原因：~/.codex/cc-switch-model-catalog.json 归 CC Switch 管，它每次推送 provider
// 配置都会覆盖该文件（实测：修复后 10 分钟内被推回旧版，三个控件全部失效）。
// 直连网关后 catalog 完全由本脚本维护，放在项目内 CC Switch 不会碰。
const DEFAULT_OUT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'gateway',
  'codex-model-catalog.json',
);

// Codex 界面里会与网关模型并列显示的内置官方模型（来自 ~/.codex/models_cache.json，
// 由 Codex 从 OpenAI 官方拉取，绕过网关）。直连场景下选中它们必然失败，
// 默认不写进 catalog（catalog 只描述本网关真实提供的模型）。
const CODEX_CACHE_MODELS = ['gpt-reserve', 'codex-auto-review'];

// 默认导出集合 = 网关配置里的**自定义对外模型**（config.json routing.customModels）。
//
// 这是刻意的默认：自定义模型是你亲手配的对外别名，承载着多路由 failover 语义
// （例如 deepseek-flash = cn → global → global-sg 三条兜底），是期望被下游使用的入口。
// catalog 若绕过它们去列引擎原生模型名，等于把你的 failover 配置架空。
//
// 自定义模型在 /v1/models 里带 owned_by === 'gateway' 标记（引擎模型是
// workbuddy / workbuddy-global，官方渠道是渠道 id），以此区分。
function defaultSelection(models) {
  const custom = models.filter(m => m.owned_by === 'gateway');
  return custom.length ? new Set(custom.map(m => String(m.id))) : null; // null → 回退到全部
}

// Codex 的 effort 词表。引擎声明的是同一套（low/medium/high/xhigh/max），
// 外加 can_disable_thinking → "none"。这里只做白名单收敛，防止上游出现未知档位时
// Codex 解析失败（未知枚举值会让整个 catalog 条目被丢弃）。
const KNOWN_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// Codex 的上下文上限来自 catalog，不来自 /v1/models。WorkBuddy 侧可在 300K / 1M
// 之间切换，因此 catalog 必须给出 max_context_window ≥ 1M，才能让选择器出现高档位。
const CONTEXT_CHOICES = [300000, 1000000];

function parseArgs(argv) {
  const out = { gateway: DEFAULT_GATEWAY, key: DEFAULT_KEY, out: DEFAULT_OUT, dryRun: false, models: null, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--gateway') out.gateway = argv[++i];
    else if (arg === '--key') out.key = argv[++i];
    else if (arg === '--models') out.models = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--help' || arg === '-h') { out.help = true; }
    else throw new Error(`未知参数：${arg}`);
  }
  return out;
}

// 引擎 → Codex 的 effort 映射。引擎给的是能力上限列表，Codex 需要有序档位。
function reasoningLevels(model) {
  const declared = Array.isArray(model.reasoning_supported_efforts) ? model.reasoning_supported_efforts : [];
  const levels = [];
  // 关闭思维链：只有模型显式支持时才暴露 "none" 档（否则选它会失败）。
  if (model.can_disable_thinking === true) levels.push({ effort: 'none', description: 'Disable Thinking' });
  for (const effort of declared) {
    const e = String(effort).toLowerCase();
    if (!KNOWN_EFFORTS.includes(e) || e === 'none') continue;
    levels.push({ effort: e, description: `Enabled Thinking (${e})` });
  }
  // 引擎声明了 efforts 但一个都没通过白名单 → 退回单档，保证 Codex 至少能渲染。
  if (!levels.length) levels.push({ effort: 'high', description: 'Enabled Thinking' });
  return levels;
}

function defaultLevel(model, levels) {
  const declared = String(model.reasoning_default_effort || '').toLowerCase();
  if (declared && levels.some(l => l.effort === declared)) return declared;
  // 无声明默认档时，Codex 侧用 "auto" 让它自行决定，而不是写死 high。
  return 'auto';
}

// context_window 决定「可用上下文」，max_context_window 决定选择器上限。
// 引擎的 context_length 是真实上限（WorkBuddy 为 1000000）。
function contextWindow(model) {
  const raw = Number(model.context_length) || 0;
  const upper = CONTEXT_CHOICES.filter(c => c <= raw).pop() || raw || 128000;
  // 留出输出空间，避免把整个窗口都当输入用导致上游 prompt_too_long。
  const reserve = Number(model.max_output_tokens) || 0;
  const usable = Math.max(1024, upper - (reserve > 0 && reserve < upper ? reserve : 0));
  return { contextWindow: usable, maxContextWindow: upper || usable };
}

function toCodexEntry(model, { priority }) {
  const levels = reasoningLevels(model);
  const { contextWindow: cw, maxContextWindow: mcw } = contextWindow(model);
  const slug = model.id;
  const display = model.name || model.id;

  const entry = {
    slug,
    display_name: display,
    description: model.description || display,
    default_reasoning_level: defaultLevel(model, levels),
    supported_reasoning_levels: levels,
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    // Fast 模式的开关由 service_tiers 驱动。Codex 的 "fast" tier 对应上游的
    // 低延迟/优先处理；引擎会原样透传 service_tier，不识别时是无害字段。
    service_tiers: [
      { id: 'default', name: 'Standard', description: 'Standard processing' },
      { id: 'fast', name: 'Fast', description: 'Prioritized, lower-latency processing' },
    ],
    default_service_tier: 'default',
    upgrade: null,
    base_instructions: 'You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user\'s goals.',
    context_window: cw,
    max_context_window: mcw,
    effective_context_window_percent: 95,
    // Codex 自动压缩阈值：跟随可用窗口，避免长会话提前触发压缩。
    auto_compact_token_limit: Math.max(1000, Math.floor(cw * 0.9)),
    input_modalities: model.supports_images === false ? ['text'] : ['text', 'image'],
    supports_image_detail_original: false,
    supports_parallel_tool_calls: model.supports_tool_call !== false,
    supports_reasoning_summaries: model.supports_reasoning === true,
    supports_reasoning_summary_parameter: model.supports_reasoning === true,
    default_reasoning_summary: model.reasoning_summary || 'auto',
    supports_search_tool: false,
    support_verbosity: false,
    experimental_supported_tools: [],
    truncation_policy: { mode: 'bytes', limit: 10000 },
    model_messages: null,
    availability_nux: null,
  };
  return entry;
}

async function fetchModels({ gateway, key }) {
  const response = await fetch(`${gateway.replace(/\/+$/, '')}/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`gateway /v1/models 返回 ${response.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed?.data) ? parsed.data : [];
}

// 自定义模型（config.json 的 customModels）是网关级别名，本身不带引擎能力字段。
// 它们的真实能力要从路由指向的底层模型继承，否则会在 Codex 侧丢失推理档位。
// 按路由顺序取第一个能找到引擎元数据的候选；都没有则返回空对象（调用方回退）。
function resolveCapabilities(model, byId) {
  if (model.reasoning_supported_efforts || model.can_disable_thinking !== undefined) return model;
  const routes = Array.isArray(model.routes) ? model.routes : [];
  for (const route of routes) {
    if (route?.channelId !== 'workbuddy') continue;
    // 网关对 CN 模型只导出裸名（`cn:xxx` 在 /v1/models 里不存在），对 global-only
    // 模型只导出 `global:xxx`。所以两种键都要试：先 wireModel，再裸模型名。
    const candidates = [
      route.wireModel,
      route.realm && route.model ? `${route.realm}:${route.model}` : '',
      route.model,
    ].filter(Boolean);
    const hit = candidates.map(key => byId.get(key)).find(Boolean);
    if (hit) {
      // 保留别名自身的展示信息与上下文声明，只借底层模型的推理能力。
      // owned_by 必须保留别名原值（gateway），否则会被 hit 的 workbuddy 覆盖，
      // 导致 defaultSelection 认不出这是自定义对外模型而被漏掉。
      //
      // name 的回退链刻意不直接用 hit.name：别名（如 deepseek-flash）与底层模型
      // （DeepSeek-V4.1-Flash）是两个不同的对外身份，直接把底层 name 拿来当别名
      // 的显示名，选择器里就会出现「配的是 deepseek-flash、显示的是
      // DeepSeek-V4.1-Flash」的错位。别名没声明 displayName 时回退到别名 id 本身。
      const isAlias = model.owned_by === 'gateway' && model.id !== hit.id;
      return {
        ...hit,
        id: model.id,
        owned_by: model.owned_by,
        name: model.displayName || model.name || (isAlias ? model.id : hit.name) || model.id,
        description: model.description || hit.description,
        context_length: Number(model.context_length) || hit.context_length,
        max_output_tokens: Number(model.max_output_tokens) || hit.max_output_tokens,
        supports_images: model.supports_images ?? hit.supports_images,
      };
    }
  }
  return model;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/gen-codex-catalog.mjs [--out <path>] [--models a,b] [--all] [--dry-run]');
    return;
  }

  const models = await fetchModels(args);
  if (!models.length) throw new Error('网关没有返回任何模型。');

  const byId = new Map(models.map(m => [String(m.id), m]));
  const resolved = models
    .map(m => resolveCapabilities(m, byId))
    // 剔除与 Codex 内置官方缓存同名的条目，避免 UI 里出现点了必然失败的重名项。
    .filter(m => !CODEX_CACHE_MODELS.includes(String(m.id)));

  // 默认导出自定义对外模型（见 defaultSelection）；--all 导出全部；
  // --models 显式指定时以显式为准。
  const wanted = args.models ? new Set(args.models) : (args.all ? null : defaultSelection(resolved));
  const selected = wanted
    ? resolved.filter(m => wanted.has(String(m.id)))
    : resolved;
  if (!selected.length) {
    const hint = args.models ? args.models.join(', ') : '（默认集合为空，请用 --all 或 --models 指定）';
    throw new Error(`未匹配到模型：${hint}`);
  }

  // 优先展示带推理能力的模型；裸名（无 realm 前缀）排前，便于 Codex 默认选中。
  const ranked = [...selected].sort((a, b) => {
    const score = m => (m.reasoning_supported_efforts ? 2 : 0) + (String(m.id).includes(':') ? 0 : 1);
    return score(b) - score(a) || String(a.id).localeCompare(String(b.id));
  });

  const catalog = {
    models: ranked.map((model, index) => toCodexEntry(model, { priority: 1000 + index })),
  };

  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  if (args.dryRun) {
    process.stdout.write(serialized);
    return;
  }
  await writeFile(args.out, serialized, { mode: 0o644 });
  console.log(`已写入 ${args.out}（${catalog.models.length} 个模型）`);
  for (const m of catalog.models.slice(0, 8)) {
    const efforts = m.supported_reasoning_levels.map(l => l.effort).join('/');
    console.log(`  ${m.slug.padEnd(34)} efforts=${efforts.padEnd(28)} ctx=${m.context_window} max=${m.max_context_window} tiers=${m.service_tiers.map(t => t.id).join('/')}`);
  }
  if (catalog.models.length > 8) console.log(`  ... 其余 ${catalog.models.length - 8} 个`);
  await warnIfConfigModelMissing(catalog, args.out);
}

// config.toml 的 `model` 必须是 catalog 里的 slug，否则 Codex 启动即失效。
// 用户在 Codex UI 里切模型会重写该字段，容易切到 catalog 里没有的名字（例如引擎
// 原生名 deepseek-v4.1-flash，而非自定义别名 deepseek-flash）。此处主动告警。
async function warnIfConfigModelMissing(catalog, catalogPath) {
  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    const text = await readFile(configPath, 'utf8');
    const configured = /^\s*model\s*=\s*"([^"]+)"/mu.exec(text)?.[1];
    if (!configured) return;
    const declared = /^\s*model_catalog_json\s*=\s*"([^"]+)"/mu.exec(text)?.[1];
    if (declared && path.resolve(declared) !== path.resolve(catalogPath)) {
      console.warn(`\n⚠  config.toml 的 model_catalog_json 指向 ${declared}，不是本次写入的 ${catalogPath}`);
    }
    if (!catalog.models.some(m => m.slug === configured)) {
      const alternatives = catalog.models.map(m => m.slug);
      console.warn(`\n⚠  config.toml 的 model = "${configured}" 不在 catalog 里，Codex 会启动失败。`);
      console.warn(`   可用：${alternatives.join(', ')}`);
      console.warn(`   修：把 ~/.codex/config.toml 的 model 改成上面其一（或在 Codex UI 里重选）。`);
    }
  } catch {
    // config.toml 不存在或不可读：不阻断 catalog 生成
  }
}

main().catch(error => {
  console.error(`[gen-codex-catalog] ${error.message}`);
  process.exitCode = 1;
});
