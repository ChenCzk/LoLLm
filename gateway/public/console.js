const STORAGE_KEY = 'local-llm-gateway.api-key';
const TARGET_MODELS = new Set([
  'hy4',
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
  'glm-official:glm-5.3-flash',
]);
const SOURCE_LABELS = {
  wb: 'wb',
  wbAI: 'wbAI',
  'glm-official': 'glm-official',
};

const elements = {
  authPanel: document.getElementById('authPanel'),
  authError: document.getElementById('authError'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  saveKeyButton: document.getElementById('saveKeyButton'),
  dashboard: document.getElementById('dashboard'),
  connectionState: document.getElementById('connectionState'),
  refreshButton: document.getElementById('refreshButton'),
  syncButton: document.getElementById('syncButton'),
  gatewayVersion: document.getElementById('gatewayVersion'),
  gatewayHealth: document.getElementById('gatewayHealth'),
  modelCount: document.getElementById('modelCount'),
  accountTotal: document.getElementById('accountTotal'),
  accountHealth: document.getElementById('accountHealth'),
  dshTotal: document.getElementById('dshTotal'),
  dshState: document.getElementById('dshState'),
  engineHealthText: document.getElementById('engineHealthText'),
  channelBody: document.getElementById('channelBody'),
  dshBody: document.getElementById('dshBody'),
  dshUpdatedText: document.getElementById('dshUpdatedText'),
  usageGeneratedText: document.getElementById('usageGeneratedText'),
  usageBody: document.getElementById('usageBody'),
  modelBody: document.getElementById('modelBody'),
  modelSearch: document.getElementById('modelSearch'),
  modelSummaryText: document.getElementById('modelSummaryText'),
  modelActionHead: document.getElementById('modelActionHead'),
  showAllModelsToggle: document.getElementById('showAllModelsToggle'),
  manageModelsToggle: document.getElementById('manageModelsToggle'),
  newModelButton: document.getElementById('newModelButton'),
  modelModal: document.getElementById('modelModal'),
  modelModalTitle: document.getElementById('modelModalTitle'),
  modelModalHint: document.getElementById('modelModalHint'),
  modelIdInput: document.getElementById('modelIdInput'),
  modelNameInput: document.getElementById('modelNameInput'),
  modelContextInput: document.getElementById('modelContextInput'),
  modelMaxOutputInput: document.getElementById('modelMaxOutputInput'),
  modelImagesInput: document.getElementById('modelImagesInput'),
  modelFailoverInput: document.getElementById('modelFailoverInput'),
  routeList: document.getElementById('routeList'),
  addRouteButton: document.getElementById('addRouteButton'),
  modelFormError: document.getElementById('modelFormError'),
  saveModelButton: document.getElementById('saveModelButton'),
  requestBody: document.getElementById('requestBody'),
  requestSummaryText: document.getElementById('requestSummaryText'),
  requestEffortOnlyToggle: document.getElementById('requestEffortOnlyToggle'),
  toast: document.getElementById('toast'),
};

let refreshTimer;
let loading = false;
let models = [];
let customModelIds = new Set();
let hiddenModelIds = new Set();
let catalog;
let editingModelId = '';
let lastRequests = [];
let manageMode = false;
// 默认只列自定义对外模型；勾选开关后才展开内置模型，避免 58 个内置模型刷屏。
let showAllModels = false;

function apiKey() {
  return localStorage.getItem(STORAGE_KEY) || '';
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function setConnectionState(state, label) {
  elements.connectionState.className = `state-chip ${state}`;
  elements.connectionState.textContent = label;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3600);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${apiKey()}`,
    },
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: { message: text.slice(0, 240) || `HTTP ${response.status}` } };
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }
  return payload;
}

function emptyRow(tbody, columns, text) {
  tbody.innerHTML = `<tr class="empty-row"><td colspan="${columns}">${text}</td></tr>`;
}

function formatExpiry(value) {
  if (!value) return '未知';
  return new Date(value * 1000).toLocaleString('zh-CN', { hour12: false });
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function sourceLabel(route) {
  if (route.channelId === 'workbuddy') return route.realm === 'global' ? 'wbAI' : 'wb';
  return SOURCE_LABELS[route.channelId] || route.channelId;
}

function routeChips(model, options = {}) {
  const routes = Array.isArray(model.routes) ? model.routes : [];
  if (!routes.length) return '';
  return routes.map((route, index) => `
    <div class="route-chain">
      ${options.showOrder === false ? '' : `<span class="route-order">${index + 1}</span>`}
      <span class="realm-chip">${escapeHtml(sourceLabel(route))}</span>
      <span class="model-code">${escapeHtml(route.model || route.wireModel || '-')}</span>
      ${options.showArrow && index < routes.length - 1 ? '<span class="route-arrow">→</span>' : ''}
    </div>`).join('');
}

// channel 的状态不能只看「有没有填 apiKey」：Qoder 这种渠道的 apiKey 是本地子进程之间的
// 约定值，永远非空。真正的判据是**子进程在不在跑**，否则新克隆的机器会看到「凭据就绪」
// 却每次请求都 fetch failed。
function channelStateChip(channel) {
  if (channel.running === true) return '<span class="state-chip ready">运行中</span>';
  if (channel.running === false) {
    const hint = channel.configured ? '子进程未运行' : '缺少凭据';
    return `<span class="state-chip warn">${hint}</span>`;
  }
  return `<span class="state-chip ${channel.configured ? 'ready' : 'warn'}">${channel.configured ? '凭据就绪' : '缺少凭据'}</span>`;
}

function renderStatus(status) {
  const engineBody = isRecord(status.engine?.body) ? status.engine.body : {};
  const bridge = isRecord(status.dshBridge) ? status.dshBridge : {};
  const engineReady = status.engine?.httpStatus === 200;

  elements.gatewayVersion.textContent = status.gateway?.version || '-';
  elements.gatewayHealth.textContent = engineReady ? '接口就绪' : '引擎异常';
  elements.modelCount.textContent = formatNumber(status.gateway?.publicModelCount);
  elements.accountTotal.textContent = formatNumber(engineBody.total);
  elements.accountHealth.textContent = `健康 ${engineBody.healthy || 0} · 冷却 ${engineBody.cooling || 0} · 禁用 ${engineBody.disabled || 0}`;
  elements.dshTotal.textContent = formatNumber(bridge.total);
  elements.dshState.textContent = bridge.error ? bridge.error : (bridge.changed ? '有新导入' : '已对齐');
  elements.engineHealthText.textContent = engineReady
    ? `WorkBuddy engine · HTTP ${status.engine.httpStatus}`
    : `WorkBuddy engine · ${status.engine?.httpStatus || 'unavailable'}`;

  const realmTotals = engineBody.realm_totals || {};
  const realmText = ['cn', 'global'].map(realm => {
    const item = realmTotals[realm];
    return item ? `${realm.toUpperCase()} ${item.healthy || 0}/${item.total || 0}` : `${realm.toUpperCase()} 0/0`;
  }).join(' · ');

  const officialChannels = Array.isArray(status.channels) ? status.channels : [];
  elements.channelBody.innerHTML = [
  `
      <tr>
        <td>workbuddy2api-panel</td>
        <td><span class="realm-chip">CN</span> <span class="realm-chip">Global</span></td>
        <td>${engineBody.healthy || 0}</td>
        <td>${engineBody.cooling || 0}</td>
        <td>${engineBody.disabled || 0}</td>
        <td><span class="state-chip ${engineReady ? 'ready' : 'error'}">${engineReady ? realmText : '不可用'}</span></td>
      </tr>
    `,
    ...officialChannels.map(channel => `
      <tr>
        <td>${escapeHtml(channel.id)}</td>
        <td><span class="realm-chip">${channel.spawned ? '子进程' : 'Coding Plan'}</span></td>
        <td>${channel.models?.length || 0}</td>
        <td>-</td>
        <td>-</td>
        <td>${channelStateChip(channel)}</td>
      </tr>
    `),
  ].join('');

  const accounts = Array.isArray(bridge.accounts) ? bridge.accounts : [];
  if (!accounts.length) {
    emptyRow(elements.dshBody, 5, '暂无 DSH 凭据');
  } else {
    elements.dshBody.innerHTML = accounts.map(account => `
      <tr>
        <td>${escapeHtml(account.label || '未命名账号')}</td>
        <td><span class="realm-chip">${escapeHtml(account.realm || '-')}</span></td>
        <td class="model-code">${escapeHtml(account.uidMasked || '-')}</td>
        <td>${formatExpiry(account.expiresAt)}</td>
        <td>${escapeHtml(account.source || '-')}</td>
      </tr>`).join('');
  }
  elements.dshUpdatedText.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function renderUsage(usage) {
  const rows = [];
  for (const [model, sources] of Object.entries(usage.models || {})) {
    for (const [source, stats] of Object.entries(sources || {})) {
      rows.push({ model, source, stats });
    }
  }
  rows.sort((left, right) => (right.stats.totalTokens || 0) - (left.stats.totalTokens || 0));
  elements.usageGeneratedText.textContent = `更新 ${new Date(usage.generatedAt || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })}`;
  if (!rows.length) {
    emptyRow(elements.usageBody, 7, '暂无用量记录');
    return;
  }
  elements.usageBody.innerHTML = rows.map(({ model, source, stats }) => `
    <tr>
      <td class="model-code">${escapeHtml(model)}</td>
      <td><span class="realm-chip">${escapeHtml(source)}</span></td>
      <td>${formatNumber(stats.requests)}</td>
      <td>${formatNumber(stats.errors)}</td>
      <td>${formatNumber(stats.promptTokens)}</td>
      <td>${formatNumber(stats.completionTokens)}</td>
      <td>${formatNumber(stats.totalTokens)}</td>
    </tr>`).join('');
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

// 档位标签的三种形态要能一眼区分，否则「没传，引擎补了 high」会被误读成
// 「客户端指定了 high」——这两件事的排查方向完全不同。
function effortChip(effort) {
  const value = String(effort || '-');
  if (value === '-') return '<span class="muted-text">—</span>';
  if (value.endsWith('(default)')) {
    const base = value.slice(0, -'(default)'.length);
    return `<span class="state-chip pending">${escapeHtml(base)} · 默认</span>`;
  }
  return `<span class="state-chip ready">${escapeHtml(value)}</span>`;
}

function statusChip(status) {
  const value = String(status || '-');
  const cls = value === '200' ? 'ready' : (value === 'netfail' || value === 'no-credential' ? 'error' : 'warn');
  return `<span class="state-chip ${cls}">${escapeHtml(value)}</span>`;
}

function renderRequests(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  lastRequests = rows;
  const explicitOnly = elements.requestEffortOnlyToggle.checked;
  // 「显式指定」= 不是引擎补的默认档，也不是「该渠道无档位概念」。off 也算显式。
  const filtered = explicitOnly ? rows.filter(row => !row.effort.endsWith('(default)') && row.effort !== '-') : rows;
  const maxCount = lastRequests.filter(row => row.effort === 'max').length;
  elements.requestSummaryText.textContent = rows.length
    ? `显示 ${filtered.length} / 最近 ${rows.length} 条 · 其中 ${maxCount} 条用了 max（极致）`
    : '暂无请求';

  if (!filtered.length) {
    emptyRow(elements.requestBody, 6, rows.length ? '没有显式指定档位的请求' : '还没有请求经过网关');
    return;
  }
  elements.requestBody.innerHTML = filtered.map(row => `
    <tr>
      <td class="model-code">${escapeHtml(formatClock(row.at))}</td>
      <td class="model-code">${escapeHtml(row.model || '-')}</td>
      <td class="model-code">${escapeHtml(row.target || '-')}</td>
      <td>${effortChip(row.effort)}</td>
      <td>${row.stream ? '是' : '否'}</td>
      <td>${statusChip(row.status)}</td>
    </tr>`).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function modelSource(model) {
  if (customModelIds.has(model.id)) return 'custom';
  if (hiddenModelIds.has(model.id)) return 'hidden';
  if (model.id.startsWith('global:')) return 'wbAI';
  if (model.owned_by === 'zai' || String(model.owned_by || '').startsWith('glm')) return 'official';
  return 'wb';
}

function materializeRoutes(model) {
  if (Array.isArray(model.routes) && model.routes.length) return model.routes;
  const realm = model.workbuddy_default_realm || 'cn';
  return [{ channelId: 'workbuddy', realm, model: model.id.replace(/^global:/, '') }];
}

function renderModels() {
  const query = elements.modelSearch.value.trim().toLowerCase();
  const routeText = model => materializeRoutes(model)
    .map(route => `${sourceLabel(route)} ${route.model || ''} ${route.wireModel || ''}`)
    .join(' ')
    .toLowerCase();
  const scoped = showAllModels
    ? models
    : models.filter(model => customModelIds.has(model.id));
  const filtered = scoped.filter(model => !query
    || String(model.id).toLowerCase().includes(query)
    || routeText(model).includes(query));

  const builtinCount = models.length - customModelIds.size;
  elements.modelSummaryText.textContent = showAllModels
    ? `共 ${models.length} 个对外模型 · 自定义 ${customModelIds.size} 个 · 内置 ${builtinCount} 个 · 已隐藏 ${hiddenModelIds.size} 个`
    : `自定义对外模型 ${customModelIds.size} 个 · 内置 ${builtinCount} 个已折叠`;
  elements.modelActionHead.hidden = !manageMode;
  elements.newModelButton.hidden = !manageMode;

  const columns = manageMode ? 6 : 5;
  if (!filtered.length) {
    const hint = query
      ? (showAllModels ? '没有匹配模型' : '自定义模型里没有匹配项，可勾选「显示全部对外模型」再搜')
      : (showAllModels ? '暂无模型' : '暂无自定义模型，点「管理模式」→「新建模型」添加');
    emptyRow(elements.modelBody, columns, hint);
    return;
  }

  elements.modelBody.innerHTML = filtered.map(model => {
    const custom = customModelIds.has(model.id);
    const hidden = hiddenModelIds.has(model.id);
    const target = TARGET_MODELS.has(model.id) ? '<span class="target-mark">P0</span>' : '';
    const badges = [
      custom ? '<span class="realm-chip tag-custom">自定义</span>' : '',
      hidden ? '<span class="realm-chip tag-hidden">已隐藏</span>' : '',
    ].join('');
    const routes = materializeRoutes(model);
    const actions = manageMode ? `
      <td class="action-cell">
        <button class="ghost-button mini-button" type="button" data-model-edit="${escapeHtml(model.id)}">编辑</button>
        <button class="ghost-button mini-button ${custom ? 'danger-button' : ''}" type="button"
          data-model-remove="${escapeHtml(model.id)}" data-model-custom="${custom ? '1' : '0'}">
          ${custom ? '删除' : (hidden ? '恢复显示' : '隐藏')}
        </button>
      </td>` : '';
    return `
      <tr class="${hidden ? 'row-hidden' : ''}">
        <td class="model-code">${escapeHtml(model.id)}${target} ${badges}</td>
        <td>${routeChips({ routes }, { showArrow: routes.length > 1 }) || '<span class="muted-text">-</span>'}</td>
        <td>${model.context_length ? formatNumber(model.context_length) : '-'}</td>
        <td>${model.max_output_tokens ? formatNumber(model.max_output_tokens) : '-'}</td>
        <td><span class="realm-chip">${escapeHtml(modelSource(model))}</span></td>
        ${actions}
      </tr>`;
  }).join('');
}

// ---------- 模型编辑弹窗 ----------

function channelOptionLabel(channelId) {
  if (channelId === 'workbuddy') return 'WorkBuddy';
  return channelId;
}

function catalogEntries(channelId, realm) {
  if (!catalog) return [];
  if (channelId === 'workbuddy') return catalog.workbuddy?.[realm] || [];
  const channel = (catalog.official || []).find(item => item.channelId === channelId);
  return channel?.models || [];
}

function channelIds() {
  return ['workbuddy', ...(catalog?.official || []).map(channel => channel.channelId)];
}

let routeDraft = [];

function defaultRoute() {
  return { channelId: 'workbuddy', realm: 'cn', model: '' };
}

function renderRouteList() {
  if (!routeDraft.length) routeDraft.push(defaultRoute());
  elements.routeList.innerHTML = routeDraft.map((route, index) => {
    const isWorkbuddy = route.channelId === 'workbuddy';
    const entries = catalogEntries(route.channelId, route.realm);
    const known = entries.some(entry => entry.model === route.model);
    const channelSelect = `
      <select data-route-field="channelId" data-route-index="${index}">
        ${channelIds().map(id => `<option value="${escapeHtml(id)}" ${id === route.channelId ? 'selected' : ''}>${escapeHtml(channelOptionLabel(id))}</option>`).join('')}
      </select>`;
    const realmSelect = isWorkbuddy ? `
      <select data-route-field="realm" data-route-index="${index}">
        <option value="cn" ${route.realm === 'cn' ? 'selected' : ''}>CN</option>
        <option value="global" ${route.realm === 'global' ? 'selected' : ''}>Global</option>
      </select>` : '<span class="realm-chip">官方直连</span>';
    const modelField = entries.length && (known || !route.model) ? `
      <select data-route-field="model" data-route-index="${index}">
        <option value="">选择模型…</option>
        ${entries.map(entry => `<option value="${escapeHtml(entry.model)}" ${entry.model === route.model ? 'selected' : ''}>${escapeHtml(entry.model)}${entry.credits ? ` · ${escapeHtml(entry.credits)}` : ''}</option>`).join('')}
      </select>` : `
      <input type="text" data-route-field="model" data-route-index="${index}" value="${escapeHtml(route.model)}" placeholder="上游模型名">
      ${entries.length ? `<button class="ghost-button mini-button" type="button" data-route-pick="${index}">从列表选</button>` : ''}`;
    return `
      <div class="route-row">
        <span class="route-order">${index + 1}</span>
        ${channelSelect}
        ${realmSelect}
        ${modelField}
        <div class="route-buttons">
          <button class="ghost-button mini-button" type="button" data-route-move="${index}" data-route-dir="-1" ${index === 0 ? 'disabled' : ''} aria-label="上移">↑</button>
          <button class="ghost-button mini-button" type="button" data-route-move="${index}" data-route-dir="1" ${index === routeDraft.length - 1 ? 'disabled' : ''} aria-label="下移">↓</button>
          <button class="ghost-button mini-button danger-button" type="button" data-route-delete="${index}" aria-label="删除路由">✕</button>
        </div>
      </div>`;
  }).join('');
}

function showModelFormError(message = '') {
  elements.modelFormError.hidden = !message;
  elements.modelFormError.textContent = message;
}

async function ensureCatalog() {
  if (catalog) return catalog;
  catalog = await request('/admin/catalog');
  return catalog;
}

async function openModelModal(model) {
  try {
    await ensureCatalog();
  } catch (error) {
    catalog = catalog || { workbuddy: { cn: [], global: [] }, official: [] };
    showToast(`候选模型加载失败：${error.message}`);
  }
  editingModelId = model ? model.id : '';
  elements.modelModalTitle.textContent = model ? '编辑模型' : '新建模型';
  elements.modelModalHint.textContent = model
    ? '修改后立即生效；模型 ID 重命名会让下游改用新名字。'
    : '对外暴露一个模型 ID，可以挂多条内部路由。';
  elements.modelIdInput.value = model?.id || '';
  elements.modelIdInput.disabled = false;
  elements.modelNameInput.value = model?.displayName || '';
  elements.modelContextInput.value = model?.context_length || '';
  elements.modelMaxOutputInput.value = model?.max_output_tokens || '';
  elements.modelImagesInput.checked = model ? model.supports_images !== false : true;
  elements.modelFailoverInput.checked = model ? model.failover !== false : true;
  routeDraft = model && Array.isArray(model.routes) && model.routes.length
    ? model.routes.map(route => ({
      channelId: route.channelId,
      realm: route.channelId === 'workbuddy' ? (route.realm || 'cn') : '',
      model: route.model || '',
    }))
    : [defaultRoute()];
  renderRouteList();
  showModelFormError();
  elements.modelModal.hidden = false;
  elements.modelIdInput.focus();
}

function closeModelModal() {
  elements.modelModal.hidden = true;
  editingModelId = '';
  routeDraft = [];
  showModelFormError();
}

async function saveModel() {
  const payload = {
    id: elements.modelIdInput.value.trim(),
    displayName: elements.modelNameInput.value.trim(),
    context_length: elements.modelContextInput.value.trim(),
    max_output_tokens: elements.modelMaxOutputInput.value.trim(),
    supports_images: elements.modelImagesInput.checked,
    failover: elements.modelFailoverInput.checked,
    routes: routeDraft
      .filter(route => String(route.model || '').trim())
      .map(route => ({
        channelId: route.channelId,
        ...(route.channelId === 'workbuddy' ? { realm: route.realm } : {}),
        model: route.model.trim(),
      })),
  };
  if (!payload.routes.length) {
    showModelFormError('至少需要一条填好模型名的内部路由。');
    return;
  }
  if (editingModelId) payload.previousId = editingModelId;

  elements.saveModelButton.disabled = true;
  try {
    const result = await request('/admin/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    closeModelModal();
    showToast(`已保存模型 ${result.model?.id || payload.id}`);
    await loadAll();
  } catch (error) {
    showModelFormError(error.message);
  } finally {
    elements.saveModelButton.disabled = false;
  }
}

async function removeModel(id, isCustom) {
  const hidden = hiddenModelIds.has(id);
  const label = isCustom ? '删除' : (hidden ? '恢复显示' : '隐藏');
  if (!window.confirm(`确认${label}模型 ${id}？`)) return;
  try {
    if (isCustom) {
      await request(`/admin/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } else {
      await request(`/admin/models/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hidden: !hidden }),
      });
    }
    showToast(`已${label}模型 ${id}`);
    await loadAll();
  } catch (error) {
    showToast(error.message);
  }
}

function showAuth(message = '') {
  elements.authPanel.hidden = false;
  elements.dashboard.hidden = true;
  elements.authError.hidden = !message;
  elements.authError.textContent = message;
  setConnectionState('pending', '未连接');
}

function showDashboard() {
  elements.authPanel.hidden = true;
  elements.dashboard.hidden = false;
}

async function loadAll() {
  if (loading || !apiKey()) return;
  loading = true;
  elements.refreshButton.disabled = true;
  elements.syncButton.disabled = true;
  try {
    const status = await request('/admin/status');
    const usage = await request('/admin/usage');
    const requests = await request('/admin/requests?limit=80');
    const modelPayload = await request('/v1/models');
    const adminPayload = await request('/admin/models');
    const visibleModels = Array.isArray(modelPayload.data) ? modelPayload.data : [];
    const visibleIds = new Set(visibleModels.map(model => model.id));
    // 被隐藏的模型不在 /v1/models 里，需要补回控制台以便恢复显示。
    const hiddenModels = (adminPayload.hiddenModels || []).filter(model => !visibleIds.has(model.id));
    models = [...visibleModels, ...hiddenModels].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    customModelIds = new Set((adminPayload.data || []).map(model => model.id));
    hiddenModelIds = new Set(adminPayload.disabledModels || []);
    status.gateway.publicModelCount = models.length;
    showDashboard();
    setConnectionState('ready', '已连接');
    renderStatus(status);
    renderUsage(usage);
    renderRequests(requests);
    renderModels();
    scheduleRefresh();
  } catch (error) {
    if (String(error.message).includes('Invalid gateway API key')) {
      localStorage.removeItem(STORAGE_KEY);
      showAuth('API Key 不正确，请重新输入。');
    } else {
      showDashboard();
      setConnectionState('error', '连接异常');
      showToast(error.message);
      scheduleRefresh();
    }
  } finally {
    loading = false;
    elements.refreshButton.disabled = false;
    elements.syncButton.disabled = false;
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(loadAll, 15000);
}

elements.saveKeyButton.addEventListener('click', () => {
  const value = elements.apiKeyInput.value.trim();
  if (!value) {
    showAuth('请输入网关 API Key。');
    return;
  }
  localStorage.setItem(STORAGE_KEY, value);
  elements.apiKeyInput.value = '';
  loadAll();
});

elements.apiKeyInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') elements.saveKeyButton.click();
});

elements.refreshButton.addEventListener('click', loadAll);

elements.syncButton.addEventListener('click', async () => {
  elements.syncButton.disabled = true;
  try {
    const result = await request('/admin/dsh/sync', { method: 'POST' });
    showToast(result.changed ? `已导入 ${result.imported.length} 个新凭据` : 'DSH 凭据无变化');
    setTimeout(loadAll, result.changed ? 1200 : 0);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.syncButton.disabled = false;
  }
});

elements.modelSearch.addEventListener('input', renderModels);

elements.manageModelsToggle.addEventListener('change', () => {
  manageMode = elements.manageModelsToggle.checked;
  renderModels();
});

elements.showAllModelsToggle.addEventListener('change', () => {
  showAllModels = elements.showAllModelsToggle.checked;
  renderModels();
});

// 只重渲染已有数据，不必为一个筛选再打一次接口。
elements.requestEffortOnlyToggle.addEventListener('change', () => {
  renderRequests({ data: lastRequests });
});

elements.newModelButton.addEventListener('click', () => openModelModal(null));

elements.modelBody.addEventListener('click', event => {
  const edit = event.target.closest('[data-model-edit]');
  if (edit) {
    const model = models.find(item => item.id === edit.dataset.modelEdit);
    if (model) openModelModal(model);
    return;
  }
  const remove = event.target.closest('[data-model-remove]');
  if (remove) removeModel(remove.dataset.modelRemove, remove.dataset.modelCustom === '1');
});

elements.modelModal.addEventListener('click', event => {
  if (event.target.closest('[data-close-modal]')) closeModelModal();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !elements.modelModal.hidden) closeModelModal();
});

elements.addRouteButton.addEventListener('click', () => {
  routeDraft.push(defaultRoute());
  renderRouteList();
});

elements.saveModelButton.addEventListener('click', saveModel);

elements.routeList.addEventListener('change', event => {
  const field = event.target.dataset.routeField;
  if (!field) return;
  const index = Number(event.target.dataset.routeIndex);
  const route = routeDraft[index];
  if (!route) return;
  if (field === 'channelId') {
    route.channelId = event.target.value;
    route.realm = event.target.value === 'workbuddy' ? 'cn' : '';
    route.model = '';
  } else if (field === 'realm') {
    route.realm = event.target.value;
    route.model = '';
  } else if (field === 'model') {
    route.model = event.target.value;
  }
  if (field !== 'model') renderRouteList();
});

elements.routeList.addEventListener('input', event => {
  const field = event.target.dataset.routeField;
  if (field !== 'model') return;
  const route = routeDraft[Number(event.target.dataset.routeIndex)];
  if (route) route.model = event.target.value;
});

elements.routeList.addEventListener('click', event => {
  const move = event.target.closest('[data-route-move]');
  if (move) {
    const index = Number(move.dataset.routeMove);
    const target = index + Number(move.dataset.routeDir);
    if (target < 0 || target >= routeDraft.length) return;
    [routeDraft[index], routeDraft[target]] = [routeDraft[target], routeDraft[index]];
    renderRouteList();
    return;
  }
  const remove = event.target.closest('[data-route-delete]');
  if (remove) {
    routeDraft.splice(Number(remove.dataset.routeDelete), 1);
    if (!routeDraft.length) routeDraft.push(defaultRoute());
    renderRouteList();
    return;
  }
  const pick = event.target.closest('[data-route-pick]');
  if (pick) {
    const index = Number(pick.dataset.routePick);
    const route = routeDraft[index];
    const entries = catalogEntries(route.channelId, route.realm);
    if (!entries.length) return;
    route.model = entries[0].model;
    renderRouteList();
  }
});

if (apiKey()) {
  setConnectionState('pending', '连接中');
  loadAll();
} else {
  showAuth();
}
