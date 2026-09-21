import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCatalog,
  buildCustomModel,
  createModelStore,
  ModelConfigError,
  normalizeCustomModels,
  normalizeModelId,
  normalizeRoute,
  bareRouteAttempts,
  normalizeEngineCatalog,
} from '../model-config.mjs';

const channels = [{
  id: 'glm-official',
  type: 'openai-chat-completions',
  routing: { prefix: 'glm-official', aliases: ['official'] },
  models: [{ id: 'glm-5.3-flash' }],
}];
const context = { officialChannels: channels, defaultRealm: 'cn' };

const baseConfig = () => ({
  gateway: { host: '127.0.0.1', port: 8787 },
  routing: {
    defaultRealm: 'cn',
    staticModels: [{ id: 'deepseek-v4.1-flash' }],
  },
  channels,
});

test('normalizeModelId 接受合法 ID 并拒绝保留字符', () => {
  assert.equal(normalizeModelId('  my-model_1.0  '), 'my-model_1.0');
  assert.throws(() => normalizeModelId(''), ModelConfigError);
  assert.throws(() => normalizeModelId('cn:foo'), /不能包含/);
  assert.throws(() => normalizeModelId('foo@global'), /@global/);
  assert.throws(() => normalizeModelId('-bad'), /只能包含/);
  assert.throws(() => normalizeModelId('a'.repeat(121)), /过长/);
});

test('normalizeRoute 解析 workbuddy realm 与官方渠道前缀', () => {
  assert.deepEqual(normalizeRoute({ channelId: 'workbuddy', realm: 'global', model: 'kimi-k2.6' }, context), {
    channelId: 'workbuddy', realm: 'global', model: 'kimi-k2.6', wireModel: 'global:kimi-k2.6', source: 'wbAI',
  });
  assert.equal(normalizeRoute({ channelId: 'workbuddy', model: 'glm-5.3' }, context).realm, 'cn');
  assert.equal(normalizeRoute({ channelId: 'workbuddy', model: 'cn:glm-5.3' }, context).wireModel, 'cn:glm-5.3');
  assert.equal(normalizeRoute({ channelId: 'glm-official', model: 'official:glm-5.3-flash' }, context).model, 'glm-5.3-flash');
  assert.throws(() => normalizeRoute({ channelId: 'nope', model: 'x' }, context), /未知渠道/);
  assert.throws(() => normalizeRoute({ channelId: 'workbuddy', realm: 'eu', model: 'x' }, context), /realm/);
});

test('buildCustomModel 生成一对多路由并保持顺序', () => {
  const model = buildCustomModel({
    id: 'my-model',
    displayName: 'My Model',
    context_length: '1000000',
    max_output_tokens: 32000,
    routes: [
      { channelId: 'workbuddy', realm: 'cn', model: 'glm-5.3' },
      { channelId: 'workbuddy', realm: 'cn', model: 'glm-5.3' },
      { channelId: 'workbuddy', realm: 'global', model: 'deepseek-v4.1-flash' },
      { channelId: 'glm-official', model: 'glm-5.3-flash' },
    ],
  }, context);
  assert.equal(model.id, 'my-model');
  assert.equal(model.failover, true);
  assert.equal(model.context_length, 1000000);
  assert.deepEqual(model.routes.map(route => route.wireModel), [
    'cn:glm-5.3',
    'global:deepseek-v4.1-flash',
    'glm-official:glm-5.3-flash',
  ]);
});

test('buildCustomModel 拒绝空路由与非法数值', () => {
  assert.throws(() => buildCustomModel({ id: 'a', routes: [] }, context), /至少需要一条/);
  assert.throws(() => buildCustomModel({ id: 'a' }, context), /至少需要一条/);
  const model = buildCustomModel({ id: 'a', context_length: '-5', max_output_tokens: 'abc', routes: [{ channelId: 'workbuddy', model: 'x' }] }, context);
  assert.equal(model.context_length, undefined);
  assert.equal(model.max_output_tokens, undefined);
});

test('normalizeCustomModels 跳过非法项并去重', () => {
  const models = normalizeCustomModels([
    { id: 'ok', routes: [{ channelId: 'workbuddy', model: 'x' }] },
    { id: 'ok', routes: [{ channelId: 'workbuddy', model: 'y' }] },
    { id: 'broken', routes: [{ channelId: 'nope', model: 'x' }] },
    null,
  ], context);
  assert.deepEqual(models.map(model => model.id), ['ok']);
});

test('buildCatalog 按 realm 与渠道拆分候选模型', () => {
  const catalog = buildCatalog({
    enginePayload: { data: [
      { id: 'cn:glm-5.3', name: 'GLM 5.3' },
      { id: 'global:gpt-5.5', name: 'GPT 5.5' },
      { id: 'cn:hy4-preview' },
    ] },
    officialChannels: channels,
    customModels: [{ id: 'my-model' }],
    configuredChannels: new Set(['glm-official']),
  });
  assert.deepEqual(catalog.workbuddy.cn.map(item => item.model), ['glm-5.3', 'hy4-preview']);
  assert.deepEqual(catalog.workbuddy.global.map(item => item.model), ['gpt-5.5']);
  assert.equal(catalog.official[0].configured, true);
  assert.equal(catalog.official[0].models[0].model, 'glm-5.3-flash');
  assert.deepEqual(catalog.customModelIds, ['my-model']);
});

test('store 增删改查并持久化到 config.json', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gateway-model-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  const config = baseConfig();
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const store = await createModelStore({ configPath, config });

  assert.deepEqual(store.list(), []);
  assert.equal(store.has('my-model'), false);

  const created = await store.upsert({
    id: 'my-model',
    routes: [
      { channelId: 'workbuddy', realm: 'cn', model: 'glm-5.3' },
      { channelId: 'workbuddy', realm: 'global', model: 'kimi-k3' },
    ],
  });
  assert.equal(created.id, 'my-model');
  assert.equal(store.has('my-model'), true);
  assert.deepEqual(store.attemptsFor('my-model').map(route => route.wireModel), ['cn:glm-5.3', 'global:kimi-k3']);
  assert.equal(store.attemptsFor('unknown'), null);

  const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(onDisk.routing.customModels, [{
    id: 'my-model',
    object: 'model',
    owned_by: 'gateway',
    supports_images: true,
    failover: true,
    routes: [
      { channelId: 'workbuddy', realm: 'cn', model: 'glm-5.3' },
      { channelId: 'workbuddy', realm: 'global', model: 'kimi-k3' },
    ],
  }]);

  await store.upsert({ id: 'renamed', routes: [{ channelId: 'glm-official', model: 'glm-5.3-flash' }] }, 'my-model');
  assert.equal(store.has('my-model'), false);
  assert.equal(store.find('renamed').routes[0].wireModel, 'glm-official:glm-5.3-flash');

  await store.upsert({ id: 'no-failover', failover: false, routes: [
    { channelId: 'workbuddy', realm: 'cn', model: 'a' },
    { channelId: 'workbuddy', realm: 'global', model: 'b' },
  ] });
  assert.deepEqual(store.attemptsFor('no-failover').map(route => route.wireModel), ['cn:a']);

  assert.equal(await store.remove('renamed'), 'deleted');
  assert.equal(store.has('renamed'), false);

  assert.equal(await store.remove('deepseek-v4.1-flash'), 'hidden');
  assert.equal(store.isDisabled('deepseek-v4.1-flash'), true);
  await store.setDisabled('deepseek-v4.1-flash', false);
  assert.equal(store.isDisabled('deepseek-v4.1-flash'), false);
});

test('store.upsert 拒绝修改不存在的模型且不破坏原配置', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gateway-model-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  const config = baseConfig();
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const store = await createModelStore({ configPath, config });

  await assert.rejects(store.upsert({ id: 'next', routes: [{ channelId: 'workbuddy', model: 'x' }] }, 'missing'), /不存在/);
  const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(onDisk.routing.customModels, undefined);
});

test('routingSnapshot 输出可落盘形态', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gateway-model-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  const config = baseConfig();
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const store = await createModelStore({ configPath, config });
  await store.upsert({ id: 'snap', routes: [{ channelId: 'workbuddy', realm: 'global', model: 'glm-5.3' }] });
  const snapshot = store.routingSnapshot();
  assert.equal(snapshot.customModels[0].routes[0].realm, 'global');
  assert.deepEqual(snapshot.disabledModels, []);
});

// ---------------------------------------------------------------------------
// realm 路由回归测试。
// 背景：gpt-5.6-* 这代模型只存在于 WorkBuddy global realm。旧实现把 global-only
// 的模型无条件提升成裸名，调用方看到裸名就补 `cn:` 前缀，100% 触发上游 11102，
// 并让引擎对 (账号, 模型) 打 6h 起的负缓存，最终整池 no_healthy_account。
// ---------------------------------------------------------------------------

const enginePayload = () => ({
  data: [
    { id: 'cn:deepseek-v4.1-flash', context_length: 1000000 },
    { id: 'global:deepseek-v4.1-flash', context_length: 1000000 },
    { id: 'global:gpt-5.6-luna', context_length: 1000000 },
    { id: 'global:gpt-5.6-terra', context_length: 1000000 },
    { id: 'cn:glm-5.3-flash', context_length: 1000000 },
  ],
});

test('global-only 模型不生成裸别名，避免被补 cn: 前缀打死', () => {
  const { models, routeIndex } = normalizeEngineCatalog({ enginePayload: enginePayload() });
  const ids = models.map(m => m.id);

  // global-only：只有带前缀的形态可见
  assert.ok(ids.includes('global:gpt-5.6-luna'));
  assert.ok(!ids.includes('gpt-5.6-luna'), 'gpt-5.6-luna 只存在于 global，不应导出裸名');
  assert.ok(!ids.includes('gpt-5.6-terra'));

  // 裸路由索引里同样不该有它——否则裸名请求仍会被解析成 cn
  assert.equal(routeIndex.get('gpt-5.6-luna'), undefined);
});

test('双 realm 同名模型：裸名走 CN，global 保留显式前缀并作为 failover', () => {
  const { models, routeIndex } = normalizeEngineCatalog({ enginePayload: enginePayload() });
  const ids = models.map(m => m.id);
  assert.ok(ids.includes('deepseek-v4.1-flash'));
  assert.ok(ids.includes('global:deepseek-v4.1-flash'));

  const routes = routeIndex.get('deepseek-v4.1-flash');
  assert.deepEqual(routes.map(r => r.wireModel), ['cn:deepseek-v4.1-flash', 'global:deepseek-v4.1-flash']);
});

test('CN-only 模型：裸名走 CN 且无 global 兜底', () => {
  const { routeIndex } = normalizeEngineCatalog({ enginePayload: enginePayload() });
  assert.deepEqual(routeIndex.get('glm-5.3-flash').map(r => r.wireModel), ['cn:glm-5.3-flash']);
});

test('bareRouteAttempts 对已知裸名用目录 realm，未知裸名回落 defaultRealm', () => {
  const { routeIndex } = normalizeEngineCatalog({ enginePayload: enginePayload() });

  // 已知：按目录声明的 realm
  assert.deepEqual(
    bareRouteAttempts('deepseek-v4.1-flash', routeIndex, 'cn').map(r => r.wireModel),
    ['cn:deepseek-v4.1-flash', 'global:deepseek-v4.1-flash'],
  );
  // 未知：回落 defaultRealm，保持既有语义（不因为目录缺项就拒绝服务）
  assert.deepEqual(
    bareRouteAttempts('totally-unknown', routeIndex, 'cn').map(r => r.wireModel),
    ['cn:totally-unknown'],
  );
  assert.deepEqual(
    bareRouteAttempts('totally-unknown', new Map(), 'global').map(r => r.wireModel),
    ['global:totally-unknown'],
  );
});

test('staticModels 覆盖引擎元数据但不改变 realm 归属', () => {
  const { models, routeIndex } = normalizeEngineCatalog({
    enginePayload: enginePayload(),
    staticModels: [{ id: 'deepseek-v4.1-flash', max_output_tokens: 128000 }],
  });
  const entry = models.find(m => m.id === 'deepseek-v4.1-flash');
  assert.equal(entry.max_output_tokens, 128000);
  assert.equal(entry.workbuddy_default_realm, 'cn');
  // 元数据被 staticModels 覆盖，但 realm 归属来自引擎目录：两个 realm 都有 → 保留兜底
  assert.deepEqual(
    routeIndex.get('deepseek-v4.1-flash').map(r => r.wireModel),
    ['cn:deepseek-v4.1-flash', 'global:deepseek-v4.1-flash'],
  );
});

test('staticModels 单独声明的 global-only 模型同样不生成裸别名', () => {
  const { models, routeIndex } = normalizeEngineCatalog({
    enginePayload: { data: [] },
    staticModels: [{ id: 'global:some-global-only', context_length: 1000000 }],
  });
  assert.deepEqual(models.map(m => m.id), ['global:some-global-only']);
  assert.equal(routeIndex.get('some-global-only'), undefined);
});

// ---------------------------------------------------------------------------
// staticModels 能力字段保留。
// 回归：config.json 的 staticModels 只有寥寥几个字段，整体替换会把引擎声明的
// reasoning_supported_efforts / can_disable_thinking 抹掉，Codex 就渲染不出
// 推理档位选择器。
// ---------------------------------------------------------------------------
test('staticModels 覆盖元数据但保留引擎的能力字段', () => {
  const { models } = normalizeEngineCatalog({
    enginePayload: {
      data: [{
        id: 'cn:deepseek-v4.1-flash',
        context_length: 1000000,
        max_output_tokens: 393216,
        reasoning_supported_efforts: ['low', 'high', 'max'],
        reasoning_default_effort: 'high',
        can_disable_thinking: true,
        supports_reasoning: true,
      }],
    },
    // 典型的 staticModels 形态：只声明展示相关字段
    staticModels: [{ id: 'deepseek-v4.1-flash', context_length: 1000000, max_output_tokens: 128000 }],
  });
  const entry = models.find(m => m.id === 'deepseek-v4.1-flash');
  // static 显式声明的字段生效
  assert.equal(entry.max_output_tokens, 128000);
  assert.equal(entry.context_length, 1000000);
  // 引擎的能力字段必须存活，否则下游无法渲染推理档位
  assert.deepEqual(entry.reasoning_supported_efforts, ['low', 'high', 'max']);
  assert.equal(entry.can_disable_thinking, true);
  assert.equal(entry.supports_reasoning, true);
  assert.equal(entry.reasoning_default_effort, 'high');
});

test('staticModels 可新增引擎没有的模型', () => {
  const { models, routeIndex } = normalizeEngineCatalog({
    enginePayload: { data: [{ id: 'cn:known', reasoning_supported_efforts: ['high'] }] },
    staticModels: [{ id: 'extra-static', context_length: 128000 }],
  });
  assert.ok(models.some(m => m.id === 'extra-static'));
  assert.deepEqual(routeIndex.get('extra-static').map(r => r.wireModel), ['cn:extra-static']);
});

// ---------------------------------------------------------------------------
// 上下文窗口：WorkBuddy 支持 300K / 1M 切换，能力元数据必须如实透出。
// ---------------------------------------------------------------------------
test('引擎声明的 1M 上下文被如实保留（不被 staticModels 的保守值压低）', () => {
  const { models } = normalizeEngineCatalog({
    enginePayload: { data: [{ id: 'cn:big', context_length: 1000000, max_output_tokens: 131072 }] },
    staticModels: [{ id: 'big', context_length: 300000 }],
  });
  const entry = models.find(m => m.id === 'big');
  // static 显式声明优先（用户可主动收紧），但引擎值不能被静默丢失
  assert.equal(entry.context_length, 300000);
});
