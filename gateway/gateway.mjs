import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { lstat, readlink, symlink, unlink } from 'node:fs/promises';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncDshCredentials, watchDshCredentials } from './dsh-bridge.mjs';
import { aggregateUsage, recordOfficialUsage } from './usage.mjs';
import { bareRouteAttempts, createModelStore, ModelConfigError, normalizeEngineCatalog, normalizeRoute } from './model-config.mjs';
import {
  chatPayloadFromResponses,
  createResponsesStreamTranslator,
  responsePayloadFromChat,
} from './responses-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'gateway', 'config.json');

// config.json 不进版本库（本机 key 与渠道配置在里面）。新克隆只有 config.example.json，
// 首次启动自动落一份 config.json，让「clone → npm install 式的下一步」不需要手工复制。
async function loadGatewayConfig() {
  try {
    return JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const examplePath = path.join(root, 'gateway', 'config.example.json');
    let example;
    try {
      example = await readFile(examplePath, 'utf8');
    } catch (exampleError) {
      throw new Error(`缺少 ${configPath}，且读不到模板 ${examplePath}：${exampleError.message}`);
    }
    JSON.parse(example);
    await writeFile(configPath, example, { mode: 0o600 });
    console.log('[gateway] 首次运行：已从 config.example.json 生成 config.json，请按需修改渠道凭据');
    return JSON.parse(example);
  }
}

const config = await loadGatewayConfig();
const engineBaseUrl = new URL(config.engine.baseUrl).origin;
// engine 的监听地址直接取自 config.json 的 baseUrl（host:port 形式），
// 避免「配置里写 7863、engine 默认绑别的口」这类两边打架。
const engineListen = new URL(config.engine.baseUrl).host;
const publicApiKey = config.gateway.apiKey;
const engineApiKey = config.engine.apiKey;
const defaultRealm = config.routing?.defaultRealm || 'cn';
const officialChannels = (config.channels || []).filter(channel => channel.type === 'openai-chat-completions');
const modelStore = await createModelStore({ configPath, config });
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const consoleFiles = new Map([
  ['/console/', { file: 'console.html', type: 'text/html; charset=utf-8' }],
  ['/console/console.css', { file: 'console.css', type: 'text/css; charset=utf-8' }],
  ['/console/console.js', { file: 'console.js', type: 'text/javascript; charset=utf-8' }],
]);

let engineProcess;
let engineStarting;
let shuttingDown = false;
let latestModels = [];

// 由网关托管的外部 channel 子进程，见 startChannelProcess。
const channelProcesses = new Map();
const channelRestarts = new Map();

// 引擎目录发现的路由表：裸模型名 → 该名字在引擎里的真实 realm 路由（有序）。
// 由 normalizeEngineModels 在每次拉取 /v1/models 时重建。
// 用途：裸名请求必须按引擎声明的 realm 发送。像 gpt-5.6-* 这代模型只存在于
// global realm，若按 defaultRealm(cn) 发出去，上游必定回 11102 并触发账号级
// 负缓存，把单个模型的问题放大成整池不可用。
let engineRouteIndex = new Map();

// 上游 wireModel → 引擎声明的档位能力。用于请求日志里还原「有效档位」：
// 客户端不传 reasoning_effort 时，真正生效的是引擎按模型声明补的默认档，
// 只看请求体是看不出来的。
let engineEffortIndex = new Map();

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

// Windows 上可执行文件带 .exe 后缀，配置里只写不带后缀的名字（macOS/Linux 的写法），
// 这里按平台补齐，让 config.json 在三个平台上是同一份。
function resolveExecutable(value) {
  const resolved = resolveFromRoot(value);
  if (process.platform !== 'win32' || resolved.endsWith('.exe')) return resolved;
  return `${resolved}.exe`;
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && cryptoTimingSafeEqual(a, b);
}

function authorized(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match && timingSafeEqual(match[1], publicApiKey));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, type = 'gateway_error', code = status) {
  sendJson(res, status, { error: { message, type, code } });
}

function publicOrigin(req) {
  return `http://${req.headers.host || `${config.gateway.host}:${config.gateway.port}`}`;
}

function expandHome(value) {
  const text = String(value || '');
  // 必须用 os.homedir()：Windows 上没有 HOME 变量（家目录是 USERPROFILE），
  // 直接读 process.env.HOME 会把 "~/.dsh/..." 解析成当前工作目录下的相对路径。
  if (text === '~') return path.resolve(homedir());
  if (/^~[/\\]/u.test(text)) return path.resolve(homedir(), text.slice(2));
  return path.resolve(text);
}

async function resolveChannelCredential(channel) {
  if (channel.apiKey) return channel.apiKey;
  if (!channel.credentialRef) return '';
  if (process.env[channel.credentialRef]) return process.env[channel.credentialRef];
  if (!channel.credentialFile) return '';
  try {
    const text = await readFile(expandHome(channel.credentialFile), 'utf8');
    const pattern = new RegExp(`^\\s*${channel.credentialRef}:\\s*(["']?)(.*)\\1\\s*$`, 'm');
    return pattern.exec(text)?.[2] || '';
  } catch {
    return '';
  }
}

function officialChannelForModel(value) {
  const model = String(value || '').trim();
  for (const channel of officialChannels) {
    const prefixes = [channel.routing?.prefix, ...(channel.routing?.aliases || [])].filter(Boolean);
    for (const prefix of prefixes) {
      const match = new RegExp(`^${prefix}:(.+)$`, 'u').exec(model);
      if (match) return { channel, model: match[1] };
    }
  }
  return null;
}

function officialModels() {
  return officialChannels.flatMap(channel => (channel.models || []).map(model => ({
    ...model,
    id: `${channel.routing.prefix}:${model.id}`,
    routes: [{ channelId: channel.id, realm: 'official', model: model.id, wireModel: `${channel.routing.prefix}:${model.id}` }],
  })));
}

async function channelStatuses() {
  return Promise.all(officialChannels.map(async channel => {
    const spec = channelSpawnSpec(channel);
    return {
      id: channel.id,
      type: channel.type,
      // configured 只表示「凭据有值」。带 spawn 的渠道其 apiKey 是本地约定值，恒为真，
      // 所以另给一个 running（子进程健康检查）供面板判断，避免显示与实际不符。
      configured: Boolean(await resolveChannelCredential(channel)),
      spawned: Boolean(spec),
      running: spec?.health ? await channelHealthy(spec.health) : null,
      models: (channel.models || []).map(model => model.id),
      routing: channel.routing,
    };
  }));
}

function serveConsole(res, pathname) {
  const spec = consoleFiles.get(pathname);
  if (!spec) return false;
  readFile(path.join(publicDir, spec.file))
    .then(body => {
      res.writeHead(200, {
        'content-type': spec.type,
        'cache-control': 'no-store',
      });
      res.end(body);
    })
    .catch(error => sendError(res, 500, error.message));
  return true;
}

function filterProxyHeaders(headers, body) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (['host', 'connection', 'authorization', 'content-length', 'transfer-encoding'].includes(normalized)) continue;
    out[key] = value;
  }
  if (body !== undefined) out['content-length'] = Buffer.byteLength(body);
  out.authorization = `Bearer ${engineApiKey}`;
  return out;
}

function proxy(req, res, requestPath, body, options = {}) {
  let url;
  if (options.baseUrl) {
    const base = new URL(options.baseUrl);
    const basePath = base.pathname.replace(/\/+$/, '');
    const suffix = requestPath.replace(/^\/+/, '');
    url = new URL(`${basePath}/${suffix}`, base);
  } else {
    url = new URL(requestPath, engineBaseUrl);
  }
  const headers = filterProxyHeaders(req.headers, body);
  if (options.authorization) headers.authorization = options.authorization;
  const transport = url.protocol === 'https:' ? https : http;
  const upstream = transport.request(url, {
    method: req.method,
    headers,
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', error => {
    const owner = options.baseUrl ? options.baseUrl : 'WorkBuddy engine';
    if (!res.headersSent) sendError(res, 502, `${owner} unavailable: ${error.message}`);
    else res.destroy();
  });
  req.on('aborted', () => upstream.destroy());
  if (body === undefined) req.pipe(upstream);
  else upstream.end(body);
}

function chatEndpoint(route) {
  if (route.channelId === 'workbuddy') return new URL('/v1/chat/completions', engineBaseUrl);
  const channel = officialChannels.find(item => item.id === route.channelId);
  const base = new URL(channel.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const chatPath = String(channel.chatPath || '/chat/completions').replace(/^\/+/, '');
  return new URL(`${basePath}/${chatPath}`, base);
}

// 账号池「无可用账号」不是额度问题，是终态。
// 引擎在选号阶段就拒绝时回 503 + no_healthy_account：此时账号该模型的 11102 负缓存
// 已经生效（BlockModelBackoff，TTL 6h 起）。把它当 quota failure 重试，会让网关把
// 全部 route 挨个再打一遍，每次都重新喂一遍负缓存——越重试越选不出号，把单个模型的
// 问题放大成整池不可用。故从 quota 判定中摘出，由 nonRetryableChatFailureBody 单独
// 识别为终态，见 retryableChatFailure。
const nonRetryableChatFailureBody = body =>
  /no_healthy_account|no_such_model|model_not_available/i.test(String(body || '').slice(0, 5000));

// 请求体本身被上游判为非法（参数错误）：换账号/换路由都不会好，且它是 400 而非 503。
// 引擎把这类错误也包成 no_healthy_account/503，此处按内层 extError.code 还原成 400，
// 否则客户端（Codex）会误以为账号池故障而反复重试。
const CLIENT_PARAM_ERROR_CODES = new Set([
  'invalid_value',
  'invalid_request_error',
  'integer_below_min_value',
  'integer_above_max_value',
  'string_too_short',
  'string_too_long',
  'missing_required_parameter',
  'context_length_exceeded',
  'unsupported_value',
]);

// 从引擎错误信封里挖出内层上游错误体（message 字段往往是被字符串化的 JSON）。
function innerUpstreamError(body) {
  try {
    const outer = JSON.parse(String(body || ''));
    const message = outer?.error?.message ?? outer?.message;
    if (typeof message !== 'string') return null;
    const inner = JSON.parse(message);
    return inner && typeof inner === 'object' ? inner : null;
  } catch {
    return null;
  }
}

// 返回 { status, body } 修正后的失败；无需修正时原样返回。
function normalizeClientParamFailure(failure) {
  const inner = innerUpstreamError(failure.body);
  const code = String(inner?.extError?.code || '');
  if (!CLIENT_PARAM_ERROR_CODES.has(code)) return failure;
  const param = inner?.extError?.param;
  const detail = inner?.extError?.message || inner?.msg || 'request parameters were rejected by the provider';
  return {
    ...failure,
    status: 400,
    body: JSON.stringify({
      error: {
        message: param ? `${detail} (param: ${param})` : detail,
        type: 'invalid_request_error',
        code: 'upstream_invalid_request',
        param: param || undefined,
      },
    }),
  };
}

function quotaFailureBody(body) {
  return /额度|积分不足|余额不足|insufficient\s+(?:balance|credits?|quota)|no\s+resource\s+package|14018/i
    .test(String(body || '').slice(0, 5000));
}

function retryableChatFailure(status, body) {
  // 终态优先：账号池已判定不可服务时，重试只会加深负缓存污染，直接透传。
  if (nonRetryableChatFailureBody(body)) return false;
  return [402, 408, 429, 502, 503, 504].includes(Number(status)) || quotaFailureBody(body);
}

function sseUsageCollector(onUsage) {
  let buffer = '';
  let recorded = false;
  return chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const match = /^data:\s*(.+)$/i.exec(line.trim());
      if (!match) continue;
      const payload = match[1].trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.usage && !recorded) {
          recorded = true;
          onUsage(parsed.usage);
        }
      } catch {}
    }
  };
}

function normalizedUsage(usage) {
  return {
    promptTokens: Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0,
    completionTokens: Number(usage?.completion_tokens ?? usage?.output_tokens) || 0,
    totalTokens: Number(usage?.total_tokens) || 0,
  };
}

async function recordOfficialResponse(payload, route, publicModel) {
  const usage = normalizedUsage(payload?.usage);
  await recordOfficialUsage({
    model: route.model,
    publicModel,
    ...usage,
  }).catch(error => console.error(`[usage] official usage write failed: ${error.message}`));
}

async function copyResponseHeaders(res, response, route) {
  const headers = {};
  for (const [key, value] of response.headers.entries()) {
    if (['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) continue;
    headers[key] = value;
  }
  headers['x-gateway-route'] = route.wireModel;
  headers['cache-control'] = 'no-store';
  res.writeHead(response.status, headers);
}

async function forwardChatResponse(res, response, route, publicModel) {
  await copyResponseHeaders(res, response, route);
  if (!response.body) {
    res.end();
    return;
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text();
    res.end(text);
    if (route.channelId !== 'workbuddy') {
      try {
        await recordOfficialResponse(JSON.parse(text), route, publicModel);
      } catch {}
    }
    return;
  }

  const decoder = new TextDecoder();
  const collectUsage = route.channelId === 'workbuddy' ? null : sseUsageCollector(usage => {
    recordOfficialResponse({ usage }, route, publicModel)
      .catch(error => console.error(`[usage] official usage write failed: ${error.message}`));
  });

  try {
    for await (const chunk of response.body) {
      const text = decoder.decode(chunk, { stream: true });
      collectUsage?.(text);
      if (!res.write(text)) {
        await Promise.race([once(res, 'drain'), once(res, 'close')]);
        if (res.destroyed && !res.writableEnded) break;
      }
    }
    const tail = decoder.decode();
    if (tail) {
      collectUsage?.(tail);
      res.write(tail);
    }
    res.end();
  } catch (error) {
    if (!res.writableEnded) res.destroy(error);
  }
}

async function requestChatRoute(route, parsed, signal) {
  const endpoint = chatEndpoint(route);
  let authorization;
  if (route.channelId === 'workbuddy') {
    authorization = `Bearer ${engineApiKey}`;
  } else {
    const channel = officialChannels.find(item => item.id === route.channelId);
    const credential = await resolveChannelCredential(channel);
    if (!credential) {
      logUpstreamAttempt(route, parsed, 'no-credential');
      return { kind: 'failure', status: 503, contentType: 'application/json', body: JSON.stringify({
        error: { message: `Channel credential is not configured: ${route.channelId}.`, type: 'invalid_request_error', code: 'channel_credential_missing' },
      }) };
    }
    authorization = `Bearer ${credential}`;
  }

  const upstreamModel = route.channelId === 'workbuddy' ? route.wireModel : route.model;
  const upstreamPayload = { ...parsed, model: upstreamModel };
  if (route.channelId !== 'workbuddy' && upstreamPayload.stream && !upstreamPayload.stream_options) {
    upstreamPayload.stream_options = { include_usage: true };
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        accept: parsed.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(upstreamPayload),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return { kind: 'aborted' };
    logUpstreamAttempt(route, parsed, 'netfail');
    return {
      kind: 'retry',
      failure: { status: 502, contentType: 'application/json', body: JSON.stringify({
        error: { message: `${route.channelId} unavailable: ${error.message}`, type: 'gateway_error', code: 'upstream_unavailable' },
      }) },
    };
  }

  logUpstreamAttempt(route, parsed, response.status);
  if (!response.ok) {
  const body = await response.text();
  if (route.channelId !== 'workbuddy') {
    await recordOfficialUsage({
      model: route.model,
      publicModel: parsed.model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      errors: 1,
    }).catch(error => console.error(`[usage] official failure write failed: ${error.message}`));
  }
  const failure = {
      status: response.status,
      contentType: response.headers.get('content-type') || 'application/json',
      body,
    };
    if (retryableChatFailure(response.status, body)) return { kind: 'retry', failure };
    return { kind: 'failure', ...failure };
  }
  return { kind: 'response', response };
}

async function dispatchChat(req, res, publicModel, parsed) {
  const attempts = routeAttempts(publicModel);
  const controller = new AbortController();
  let lastFailure;

  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('aborted', abort);
  res.on('close', () => {
    if (!res.writableEnded) abort();
  });

  for (const route of attempts) {
    if (controller.signal.aborted) return;
    const result = await requestChatRoute(route, parsed, controller.signal);
    if (result.kind === 'aborted') return;
    if (result.kind === 'response') {
      await forwardChatResponse(res, result.response, route, publicModel);
      return;
    }
    if (result.kind === 'retry') lastFailure = result.failure;
    else {
      lastFailure = result;
      break;
    }
  }

  if (controller.signal.aborted || res.headersSent) {
    if (!res.writableEnded) res.destroy();
    return;
  }

  const failure = normalizeClientParamFailure(
    lastFailure || { status: 502, contentType: 'application/json', body: 'No route available.' },
  );
  let payload;
  try {
    payload = JSON.parse(failure.body);
  } catch {
    sendError(res, failure.status || 502, String(failure.body || 'Upstream request failed.').slice(0, 1000));
    return;
  }
  sendJson(res, failure.status || 502, payload);
}

// 把 Responses 事件写成 SSE 帧。
function sendResponsesEvent(res, payload) {
  res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// 流式桥接：边读上游 Chat Completions SSE，边翻译成 Responses SSE 往下游推。
//
// 与旧实现（等上游整段结束再合成事件）的区别就在这里：
//   - 上游请求体带 stream:true（见 chatPayloadFromResponses 的 stream 选项），
//     模型吐一个字就能往下游推一个字；
//   - 首字节延迟回到正常的 TTFB，而不是等于总耗时；
//   - 连接上持续有字节，不会被中间层或引擎的 idle_timeout(300s) 当成死连接掐断。
async function pipeChatCompletionsAsResponsesStream(req, res, response, route, publicModel, aliasToName) {
  const translator = createResponsesStreamTranslator({
    model: publicModel,
    route,
    aliasToName,
    write: event => sendResponsesEvent(res, event),
  });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-gateway-route': route.wireModel,
  });
  translator.start();

  // 官方渠道（非 workbuddy）需要自己记账；在流里抓 usage 事件。
  const collectUsage = route.channelId === 'workbuddy' ? null : sseUsageCollector(usage => {
    recordOfficialResponse({ usage }, route, publicModel)
      .catch(error => console.error(`[usage] official usage write failed: ${error.message}`));
  });

  const decoder = new TextDecoder();
  try {
    for await (const chunk of response.body) {
      const text = decoder.decode(chunk, { stream: true });
      collectUsage?.(text);
      translator.push(text);
      if (res.writableEnded) return;
    }
    const tail = decoder.decode();
    if (tail) {
      collectUsage?.(tail);
      translator.push(tail);
    }
    translator.end();
    res.end();
  } catch (error) {
    // 上游中途断开：尽量用 response.failed 收尾，让客户端拿到结构化错误
    // 而不是 TCP 断连。已发过头时只能结束响应。
    if (!res.writableEnded && !res.destroyed) {
      translator.fail(error.message);
      res.end();
    }
  }
}

async function dispatchResponses(req, res, parsed) {
  const wantsStream = parsed.stream === true;
  let chatPayload;
  let aliasToName = new Map();
  try {
    // ★ stream 必须透传给上游。写死 false 会让网关卡在「整段生成完再回」，
    // 长回答 TTFB 等于总耗时，并在引擎 idle_timeout(300s) 处变成 502。
    ({ payload: chatPayload, aliasToName } = chatPayloadFromResponses(parsed, { stream: wantsStream }));
  } catch (error) {
    sendError(res, 400, error.message, 'invalid_request_error', 'responses_bridge_unsupported_input');
    return;
  }

  const attempts = routeAttempts(parsed.model);
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('aborted', abort);
  res.on('close', () => {
    if (!res.writableEnded) abort();
  });

  let lastFailure;
  for (const route of attempts) {
    if (controller.signal.aborted) return;
    const result = await requestChatRoute(route, chatPayload, controller.signal);
    if (result.kind === 'aborted') return;
    if (result.kind === 'retry') {
      lastFailure = result.failure;
      continue;
    }
    if (result.kind === 'failure') {
      lastFailure = result;
      break;
    }

    if (wantsStream) {
      // 流式：直接把上游 SSE 翻译后转发，不做整段缓冲。
      const contentType = result.response.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream')) {
        await pipeChatCompletionsAsResponsesStream(
          req, res, result.response, route, parsed.model, aliasToName,
        );
        return;
      }
      // 上游忽略了 stream:true（个别渠道可能返回整段 JSON）：
      // 退化成「一次性翻译」，保证功能可用，但要记一条日志便于排查。
      console.warn(`[responses] upstream returned non-SSE despite stream:true (route=${route.wireModel})`);
    }

    const text = await result.response.text();
    let chat;
    try {
      chat = JSON.parse(text);
    } catch {
      lastFailure = {
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Upstream returned invalid Chat Completions JSON.' } }),
      };
      continue;
    }
    try {
      if (route.channelId !== 'workbuddy') await recordOfficialResponse(chat, route, parsed.model);
      const response = responsePayloadFromChat(chat, parsed.model, route, aliasToName);
      if (wantsStream) {
        // 上游不支持流式时的兜底：把聚合结果拆成 SSE 事件发出（TTFB 会退化，
        // 但语义正确）。
        const translator = createResponsesStreamTranslator({
          model: parsed.model,
          route,
          aliasToName,
          write: event => sendResponsesEvent(res, event),
        });
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-gateway-route': route.wireModel,
        });
        translator.start();
        // tool_call 的 index 必须唯一且递增，否则多个调用会被翻译器合并成一个。
        let toolIndex = 0;
        for (const item of response.output) {
          if (item.type === 'message') {
            for (const part of item.content || []) {
              if (part.text) {
                translator.push(`data: ${JSON.stringify({ choices: [{ delta: { content: part.text } }] })}\n\n`);
              }
            }
          } else if (item.type === 'function_call') {
            translator.push(`data: ${JSON.stringify({
              choices: [{ delta: { tool_calls: [{ index: toolIndex++, id: item.call_id, function: { name: item.name, arguments: item.arguments } }] } }],
            })}\n\n`);
          }
        }
        translator.push(`data: ${JSON.stringify({ usage: {
          prompt_tokens: chat?.usage?.prompt_tokens,
          completion_tokens: chat?.usage?.completion_tokens,
          total_tokens: chat?.usage?.total_tokens,
        } })}\n\n`);
        translator.end();
        res.end();
      } else {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-gateway-route': route.wireModel,
        });
        res.end(JSON.stringify(response));
      }
    } catch (error) {
      lastFailure = {
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: error.message } }),
      };
    }
    return;
  }

  if (controller.signal.aborted || res.headersSent) {
    if (!res.writableEnded) res.destroy();
    return;
  }
  const failure = normalizeClientParamFailure(
    lastFailure || { status: 502, contentType: 'application/json', body: 'No route available.' },
  );
  let payload;
  try {
    payload = JSON.parse(failure.body);
  } catch {
    sendError(res, failure.status || 502, String(failure.body || 'Upstream request failed.').slice(0, 1000));
    return;
  }
  sendJson(res, failure.status || 502, payload);
}

function customModelList() {
  return modelStore.list();
}

function splitRealmModel(model) {
  const value = String(model || '').trim();
  const match = /^(cn|global):(.+)$/u.exec(value);
  if (match) return { realm: match[1], model: match[2], wireModel: value };
  const suffix = /^(.+?)@global$/u.exec(value);
  if (suffix) return { realm: 'global', model: suffix[1], wireModel: `global:${suffix[1]}` };
  return { realm: defaultRealm, model: value, wireModel: `${defaultRealm}:${value}` };
}

function routeAttempts(value) {
  const official = officialChannelForModel(value);
  if (official) {
    return [{
      channelId: official.channel.id,
      realm: 'official',
      model: official.model,
      wireModel: `${official.channel.routing.prefix}:${official.model}`,
    }];
  }

  const realmRoute = splitRealmModel(value);
  if (/^(cn|global):/.test(value) || /.+@global$/u.test(value)) {
    return [{
      channelId: 'workbuddy',
      realm: realmRoute.realm,
      model: realmRoute.model,
      wireModel: realmRoute.wireModel,
    }];
  }

  const custom = modelStore.attemptsFor(String(value).trim());
  if (custom?.length) return custom;

  // 裸名按引擎目录声明的真实 realm 发送，而不是无条件 defaultRealm(cn)。
  // 旧实现漏了这一层，使 /v1/models 里 global-only 条目的自带宽名路由形同虚设：
  // `gpt-5.6-luna` 与 `cn:gpt-5.6-luna` 实际走的是同一条死路。
  return bareRouteAttempts(value, engineRouteIndex, defaultRealm);
}

function normalizeEngineModels(payload) {
  // 纯逻辑在 model-config.mjs（normalizeEngineCatalog），此处只把目录发现的路由表
  // 挂到模块级 engineRouteIndex，供 routeAttempts 解析裸名使用。
  const { models, routeIndex } = normalizeEngineCatalog({
    enginePayload: payload,
    staticModels: config.routing?.staticModels || [],
    defaultRealm,
  });
  engineRouteIndex = routeIndex;
  const effortIndex = new Map();
  for (const item of payload?.data || []) {
    const id = String(item?.id || '');
    if (!id) continue;
    effortIndex.set(id, {
      defaultEffort: String(item.reasoning_default_effort || ''),
      supported: Array.isArray(item.reasoning_supported_efforts) ? item.reasoning_supported_efforts : [],
      canDisable: item.can_disable_thinking === true,
    });
  }
  engineEffortIndex = effortIndex;
  return models;
}

// 还原这次请求实际会用的思考档位。三者优先级与人读日志的习惯一致：
//   客户端显式给了 → 用它（none/disabled 归一成 off）
//   没给但模型声明了默认档 → 引擎会补上它，这就是真正生效的值，标 (default)
//   都没有 → -（例如官方渠道模型，档位靠上游自己决定）
function effectiveEffort(parsed, route) {
  const thinkingType = parsed?.thinking?.type;
  if (typeof thinkingType === 'string' && thinkingType.toLowerCase() === 'disabled') {
    return 'off';
  }
  const raw = parsed?.reasoning_effort ?? parsed?.reasoningEffort ?? parsed?.reasoning?.effort;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const value = String(raw).trim().toLowerCase();
    return value === 'none' ? 'off' : value;
  }
  const declared = engineEffortIndex.get(route.wireModel || route.model);
  return declared?.defaultEffort ? `${declared.defaultEffort}(default)` : '-';
}

// 客户端用了别的写法表达思考开关时，把原样形态带出来，免得日志显示 default
// 而实际是别的值。正常路径（reasoning_effort / reasoning.effort / thinking.type）
// 不会触发这里。
function uninterpretedThinking(parsed) {
  const thinking = parsed?.thinking;
  if (thinking && typeof thinking === 'object' && typeof thinking.type === 'string'
    && thinking.type !== '' && thinking.type.toLowerCase() !== 'disabled') {
    return `thinking.type=${thinking.type}`;
  }
  const reasoning = parsed?.reasoning;
  if (reasoning && typeof reasoning === 'object' && !('effort' in reasoning)) {
    return `reasoning{${Object.keys(reasoning).join(',')}}`;
  }
  return '';
}

// 每个上游请求打一行：下游点名了什么 → 实际发去哪个上游模型 → 哪档思考 → 结果。
// 档位以前只在「发生降级」时才落日志，导致事后无法回答「这次走的是哪档」。
function logUpstreamAttempt(route, parsed, status) {
  const stamp = new Date().toTimeString().slice(0, 8);
  const target = route.wireModel || route.model;
  const unknown = uninterpretedThinking(parsed);
  console.log(
    `[req] ${stamp} | ${parsed?.model ?? '-'} -> ${target} | eff=${effectiveEffort(parsed, route)}`
    + ` | stream=${parsed?.stream ? '1' : '0'} | status=${status}`
    + (unknown ? ` | raw=${unknown}` : ''),
  );
}

// 能力字段：自定义模型（config.json customModels）是网关级别的别名/组合路由，自身
// 不声明这些字段，但同名的引擎模型声明了。合并时若先到的条目缺这些字段、后到的
// 条目有，则补进去——否则 /v1/models 会丢掉推理档位，下游（Codex）无法渲染选择器。
const CAPABILITY_FIELDS = [
  'reasoning_supported_efforts',
  'reasoning_default_effort',
  'reasoning_summary',
  'can_disable_thinking',
  'supports_reasoning',
  'supports_tool_call',
  'only_reasoning',
  'max_allowed_size',
  'tags',
];

function mergeCapabilities(primary, fallback) {
  if (!fallback) return primary;
  const merged = { ...primary };
  for (const field of CAPABILITY_FIELDS) {
    if (merged[field] === undefined && fallback[field] !== undefined) merged[field] = fallback[field];
  }
  // 上下文/输出上限：自定义模型常写死保守值（如 32000），而引擎声明的是真实上限。
  // 取两者较大值，让下游能按上游真实能力展示（WorkBuddy 侧为 1M）。
  for (const field of ['context_length', 'max_output_tokens']) {
    const a = Number(primary[field]) || 0;
    const b = Number(fallback[field]) || 0;
    const best = Math.max(a, b);
    if (best > 0) merged[field] = best;
  }
  return merged;
}

function mergeModels(groups, hiddenIds = new Set()) {
  const models = new Map();
  for (const group of groups) {
    for (const model of group) {
      const id = String(model?.id || '');
      if (!id || hiddenIds.has(id)) continue;
      models.set(id, models.has(id) ? mergeCapabilities(models.get(id), model) : model);
    }
  }
  return [...models.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function engineModels() {
  const response = await fetch(`${engineBaseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${engineApiKey}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`engine /v1/models returned ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// 合并后的完整模型列表：自定义 → 引擎目录 → 官方渠道。
async function mergedModelList() {
  let payload = { data: [] };
  try {
    payload = await engineModels();
  } catch (error) {
    console.error(`[engine] model catalog unavailable: ${error.message}`);
  }
  return mergeModels([customModelList(), normalizeEngineModels(payload), officialModels()]);
}

async function modelsHandler(res) {
  try {
    const hidden = new Set(modelStore.disabledIds());
    latestModels = (await mergedModelList()).filter(model => !hidden.has(String(model.id)));
    sendJson(res, 200, { object: 'list', data: latestModels });
  } catch (error) {
    sendError(res, 502, error.message);
  }
}

function sendModelError(res, error) {
  const status = error instanceof ModelConfigError ? 400 : 500;
  sendError(res, status, error.message, 'invalid_request_error', status === 400 ? 'invalid_model_config' : 'model_config_error');
}

// 控制台新建/编辑模型时需要的候选项：WorkBuddy CN/Global 全量 + 官方渠道模型。
async function catalogHandler(res) {
  try {
    const [engine, channels] = await Promise.all([
      engineModels().catch(error => {
        console.error(`[engine] model catalog unavailable: ${error.message}`);
        return { data: [] };
      }),
      channelStatuses().catch(() => []),
    ]);
    const configured = new Set(
      (Array.isArray(channels) ? channels : []).filter(channel => channel?.configured).map(channel => channel.id),
    );
    sendJson(res, 200, modelStore.catalog(engine, configured));
  } catch (error) {
    sendError(res, 502, error.message);
  }
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function engineStatus() {
  const response = await fetch(`${engineBaseUrl}/status`, {
    headers: { authorization: `Bearer ${engineApiKey}` },
  });
  const text = await response.text();
  return { httpStatus: response.status, body: response.ok ? JSON.parse(text) : text.slice(0, 500) };
}

async function startEngine() {
  const command = resolveExecutable(config.engine.command);
  try {
    await access(command, fsConstants.X_OK);
  } catch {
    throw new Error(`engine binary is missing or not executable: ${command}; run npm run build:engine`);
  }

  const child = spawn(command, config.engine.args || [], {
    cwd: resolveFromRoot(config.engine.cwd),
    env: {
      ...process.env,
      // engine 在没有 config.local.json 时会自己生成随机 api_key，并按内置默认绑
      // 0.0.0.0:7863 —— 新克隆出来的机器上，这会让两边端口/密钥对不上，网关直接起不来。
      // 这两个环境变量会覆盖配置文件（含自动生成的那份），把 config.json 变成唯一真源，
      // 顺带把 engine 收回到回环地址。
      WB2A_LISTEN: engineListen,
      WB2A_API_KEY: engineApiKey,
      ...(config.engine.env || {}),
    },
    stdio: 'inherit',
  });
  engineProcess = child;
  console.log(`[engine] pid=${child.pid} started`);
  child.on('error', error => {
    engineProcess = undefined;
    console.error(`[engine] 启动失败：${error.message}`);
  });
  child.on('exit', (code, signal) => {
    engineProcess = undefined;
    if (shuttingDown) return;
    console.error(`[engine] exited code=${code ?? 'null'} signal=${signal ?? 'null'}; restarting in 1s`);
    engineStarting = setTimeout(startEngine, 1000).unref();
  });

  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`${engineBaseUrl}/healthz`);
      if (response.ok || response.status === 503) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(
    `WorkBuddy engine 未在 ${engineBaseUrl} 就绪。请检查：\n`
    + `  1) engine 二进制是否匹配当前平台：npm run build:engine\n`
    + `  2) 端口是否被占用：${engineListen}\n`
    + '  3) 上面 engine 的启动日志里是否有报错（最常见是账号池目录不可写）',
  );
}

async function restartEngine(reason) {
  if (!engineProcess) return;
  console.log(`[engine] restarting: ${reason}`);
  const child = engineProcess;
  engineProcess = undefined;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      // Windows 上 SIGKILL 不可用，Node 会退化成 TerminateProcess；万一抛错不能让
      // 这个 Promise 永远挂着（否则整个重启流程卡死）。
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  clearTimeout(engineStarting);
  await startEngine();
}

// 外部 channel 子进程（如 qodercli2api）：由网关统一托管生命周期，
// 与 engine 一样跟随网关启停。放在网关里而不是启动脚本，是因为 macOS 状态栏 App
// 直接 spawn `node gateway/gateway.mjs`，不经过脚本；终端里拉起的进程也活不过会话。
function channelSpawnSpec(channel) {
  const spec = channel?.spawn;
  if (!spec?.command) return null;
  return {
    command: resolveExecutable(spec.command),
    args: (spec.args || []).map(arg => String(arg).replaceAll('{root}', root)),
    env: spec.envKey && channel.apiKey ? { [spec.envKey]: channel.apiKey } : {},
    health: spec.health ? String(spec.health).replaceAll('{root}', root) : '',
    ensureLinks: Array.isArray(spec.ensureLinks) ? spec.ensureLinks : [],
  };
}

// channel 声明的目录链接，例如 Qoder 需要 <auth-dir>/../.models 指向 Qoder CLI
// 自己的模型目录缓存（catalog-v6 在运行时解密，跟着 CLI 更新）。
// Windows 上用 junction：不需要管理员权限，也不需要开开发者模式；符号链接两者都要。
async function ensureChannelLinks(channel, links) {
  for (const link of links) {
    const linkPath = resolveFromRoot(String(link.path || ''));
    const target = expandHome(link.target);
    if (!link.path || !link.target) continue;
    try {
      const existing = await lstat(linkPath);
      if (!existing.isSymbolicLink()) {
        console.warn(`[channel] ${channel.id} 链接位置已存在且不是链接，跳过：${linkPath}`);
        continue;
      }
      const current = path.resolve(path.dirname(linkPath), await readlink(linkPath));
      if (current === target) continue;
      await unlink(linkPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[channel] ${channel.id} 无法检查链接 ${linkPath}：${error.message}`);
        continue;
      }
    }
    try {
      await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      console.log(`[channel] ${channel.id} 已建立链接 ${link.path} -> ${target}`);
    } catch (error) {
      console.warn(`[channel] ${channel.id} 建立链接失败（${error.message}）；请手工把 ${linkPath} 指向 ${target}`);
    }
  }
}

async function channelHealthy(url) {
  if (!url) return false;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startChannelProcess(channel, attempt = 0) {
  const spec = channelSpawnSpec(channel);
  if (!spec) return;
  if (await channelHealthy(spec.health)) {
    console.log(`[channel] ${channel.id} already listening at ${spec.health}; reusing`);
    return;
  }
  await ensureChannelLinks(channel, spec.ensureLinks);
  // 二进制不存在时 spawn 是异步抛 ENOENT，不先挡掉的话会带着退避无限重试刷屏。
  try {
    await access(spec.command, fsConstants.X_OK);
  } catch {
    console.error(`[channel] ${channel.id} 可执行文件不存在：${spec.command}；运行 npm run setup 后再重启网关`);
    return;
  }
  let child;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: root,
      env: { ...process.env, ...spec.env },
      stdio: 'inherit',
    });
  } catch (error) {
    console.error(`[channel] ${channel.id} spawn failed: ${error.message}`);
    return;
  }
  channelProcesses.set(channel.id, child);
  console.log(`[channel] ${channel.id} pid=${child.pid} started`);
  // 没有 error 监听器时子进程的 'error' 事件会作为未捕获异常直接终止网关。
  child.on('error', error => {
    if (channelProcesses.get(channel.id) === child) channelProcesses.delete(channel.id);
    console.error(`[channel] ${channel.id} 启动失败：${error.message}`);
  });
  child.on('exit', (code, signal) => {
    if (channelProcesses.get(channel.id) === child) channelProcesses.delete(channel.id);
    if (shuttingDown) return;
    // 凭据缺失等持续性失败会快速退出，用递增退避避免刷屏。
    const delay = Math.min(1000 * (attempt + 1), 15000);
    console.error(`[channel] ${channel.id} exited code=${code ?? 'null'} signal=${signal ?? 'null'}; restarting in ${delay}ms`);
    channelRestarts.set(channel.id, setTimeout(() => startChannelProcess(channel, attempt + 1), delay).unref());
  });

  for (let i = 0; i < 40; i += 1) {
    if (await channelHealthy(spec.health)) {
      console.log(`[channel] ${channel.id} ready`);
      return;
    }
    if (!channelProcesses.has(channel.id)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  console.error(`[channel] ${channel.id} did not become ready; requests to it will fail until it is up`);
}

async function startChannelProcesses() {
  await Promise.all(officialChannels.map(channel => startChannelProcess(channel)));
}

function stopChannelProcesses(signal) {
  for (const timer of channelRestarts.values()) clearTimeout(timer);
  channelRestarts.clear();
  for (const child of channelProcesses.values()) {
    try {
      child.kill(signal);
    } catch {}
  }
  channelProcesses.clear();
}

async function handleRequest(req, res) {
  const url = new URL(req.url, publicOrigin(req));
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    let engine = 'unavailable';
    try {
      const response = await fetch(`${engineBaseUrl}/healthz`);
      engine = response.ok ? 'ready' : `status-${response.status}`;
    } catch {}
    sendJson(res, 200, { gateway: 'ready', engine, channel: 'workbuddy' });
    return;
  }

  if (pathname === '/panel/' || pathname === '/panel/app.js') {
    proxy(req, res, pathname + url.search);
    return;
  }

  if (pathname === '/' || pathname === '/console') {
    res.writeHead(302, { location: '/console/', 'cache-control': 'no-store' });
    res.end();
    return;
  }

  if (pathname.startsWith('/console/')) {
    if (!serveConsole(res, pathname)) sendError(res, 404, 'Console asset not found.', 'invalid_request_error', 'not_found');
    return;
  }

  if (!authorized(req)) {
    res.setHeader('www-authenticate', 'Bearer realm="local-llm-gateway"');
    sendError(res, 401, 'Invalid gateway API key.', 'invalid_request_error', 'invalid_api_key');
    return;
  }

  if (pathname.startsWith('/panel/')) {
    proxy(req, res, pathname + url.search);
    return;
  }

  if (pathname === '/admin/status') {
    const [engine, bridge, channels] = await Promise.all([
      engineStatus().catch(error => ({ httpStatus: 502, body: error.message })),
      syncDshCredentials(config.dsh).catch(error => ({ error: error.message })),
      channelStatuses().catch(error => ({ error: error.message })),
    ]);
    sendJson(res, 200, {
      gateway: { version: '0.1.0', publicModelCount: latestModels.length },
      routing: modelStore.routingSnapshot(),
      dshBridge: bridge,
      engine,
      channels,
    });
    return;
  }

  if (pathname === '/admin/usage') {
    try {
      sendJson(res, 200, await aggregateUsage(config));
    } catch (error) {
      sendError(res, 500, error.message);
    }
    return;
  }

  if (pathname === '/admin/models' && req.method === 'GET') {
    const hidden = new Set(modelStore.disabledIds());
    const hiddenModels = modelStore.disabledIds().length
      ? (await mergedModelList()).filter(model => hidden.has(String(model.id)))
      : [];
    sendJson(res, 200, {
      object: 'list',
      data: modelStore.list(),
      disabledModels: [...hidden],
      hiddenModels,
    });
    return;
  }

  if (pathname === '/admin/catalog' && req.method === 'GET') {
    await catalogHandler(res);
    return;
  }

  if (pathname === '/admin/models' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body.toString('utf8') || '{}');
      const model = await modelStore.upsert(parsed, parsed.previousId || parsed.originalId || '');
      latestModels = [];
      sendJson(res, 200, { ok: true, model });
    } catch (error) {
      sendModelError(res, error);
    }
    return;
  }

  if (pathname.startsWith('/admin/models/') && (req.method === 'DELETE' || req.method === 'PATCH')) {
    const id = decodeURIComponent(pathname.slice('/admin/models/'.length));
    try {
      if (req.method === 'DELETE') {
        const action = await modelStore.remove(id);
        latestModels = [];
        sendJson(res, 200, { ok: true, action, id });
      } else {
        const body = await readBody(req);
        const parsed = JSON.parse(body.toString('utf8') || '{}');
        const hidden = Boolean(parsed.hidden);
        await modelStore.setDisabled(id, hidden);
        latestModels = [];
        sendJson(res, 200, { ok: true, id, hidden });
      }
    } catch (error) {
      sendModelError(res, error);
    }
    return;
  }

  if (pathname === '/admin/dsh/sync' && req.method === 'POST') {
    try {
      const result = await syncDshCredentials(config.dsh);
      if (result.changed) await restartEngine('DSH credentials changed');
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, 500, error.message);
    }
    return;
  }

  if (pathname === '/v1/models') {
    await modelsHandler(res);
    return;
  }

  if (pathname === '/v1/chat/completions') {
    try {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendError(res, 400, 'Request body must be JSON.', 'invalid_request_error', 'invalid_json');
        return;
      }
      if (typeof parsed.model === 'string' && parsed.model !== '') {
        await dispatchChat(req, res, parsed.model, parsed);
        return;
      }
      proxy(req, res, pathname, JSON.stringify(parsed));
    } catch (error) {
      sendError(res, 413, error.message, 'invalid_request_error', 'request_body_too_large');
    }
    return;
  }

  if (pathname === '/v1/responses' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendError(res, 400, 'Request body must be JSON.', 'invalid_request_error', 'invalid_json');
        return;
      }
      if (typeof parsed.model === 'string' && parsed.model !== '') {
        await dispatchResponses(req, res, parsed);
        return;
      }
      sendError(res, 400, 'Responses model is required.', 'invalid_request_error', 'invalid_model');
    } catch (error) {
      sendError(res, 413, error.message, 'invalid_request_error', 'request_body_too_large');
    }
    return;
  }

  if (pathname === '/v1' || pathname.startsWith('/v1/')) {
    proxy(req, res, pathname + url.search);
    return;
  }

  sendError(res, 404, `Unknown gateway path: ${pathname}`, 'invalid_request_error', 'not_found');
}

process.on('SIGINT', async () => {
  shuttingDown = true;
  if (engineProcess) engineProcess.kill('SIGINT');
  stopChannelProcesses('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  shuttingDown = true;
  if (engineProcess) engineProcess.kill('SIGTERM');
  stopChannelProcesses('SIGTERM');
  process.exit(0);
});

const syncResult = await syncDshCredentials(config.dsh);
console.log(`[dsh-bridge] accounts=${syncResult.total} imported=${syncResult.imported.length}`);
console.table(syncResult.accounts.map(account => ({
  label: account.label,
  realm: account.realm,
  uid: account.uidMasked,
  expiresAt: account.expiresAt ? new Date(account.expiresAt * 1000).toISOString() : 'unknown',
  source: account.source,
})));

await startEngine();
startChannelProcesses().catch(error => console.error(`[channel] startup failed: ${error.message}`));
watchDshCredentials(config.dsh, result => {
  console.log(`[dsh-bridge] new credentials imported: ${result.imported.join(', ')}`);
  restartEngine('DSH credentials changed');
});

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error(`[gateway] ${error.stack || error.message}`);
    if (!res.headersSent) sendError(res, 500, error.message);
    else res.destroy();
  });
});
server.listen(config.gateway.port, config.gateway.host, () => {
  console.log(`[gateway] listening on http://${config.gateway.host}:${config.gateway.port}/v1`);
  console.log(`[gateway] management panel: http://${config.gateway.host}:${config.gateway.port}/panel/`);
});
