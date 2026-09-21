// Responses API ⇄ Chat Completions 桥接：纯逻辑，便于单测。
//
// 背景（v1：Codex 流式被吞）：
// gateway.mjs 只把 /v1/responses 桥接成「非流式」的 Chat Completions —— 上游请求体
// 恒为 stream:false，必须等模型把整段回答生成完，网关才合成一串 Responses SSE 事件
// 一次性吐出。对 Codex 这种长回答 + 工具调用的客户端，表现为：
//
//   1. 首字节延迟 = 总耗时（实测 2000 字回答 TTFB=24.7s，TTFB==total）；
//   2. 期间连接上没有任何字节，任何客户端/中间层的空闲超时都会把会话掐断；
//   3. 引擎侧按非流式聚合，受 idle_timeout_seconds(300s) 约束，超时回 502
//      （实测日志里 300.9s 的 502 就是这条路径）。
//
// 修法：让 stream 标志从客户端一路透传到引擎，并把引擎的 Chat Completions SSE
// 增量翻译成 Responses SSE 事件，边收边发。

// ---------------------------------------------------------------------------
// 与具体传输无关的文本/内容搬运
// ---------------------------------------------------------------------------

export function responseTextPart(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(responseTextPart).filter(Boolean).join('');
  if (typeof value === 'object') return String(value.text || value.content || '');
  return String(value);
}

function responsesContentToChat(value, kind = 'input') {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return responseTextPart(value);
  const parts = value.map(part => {
    if (part?.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || part.url;
      if (!url) throw new Error(`Responses ${kind} input_image is missing image_url.`);
      return { type: 'image_url', image_url: { url } };
    }
    const text = responseTextPart(part);
    return text ? { type: 'text', text } : undefined;
  }).filter(Boolean);
  if (!parts.some(part => part.type === 'image_url')) {
    return parts.map(part => part.text).join('');
  }
  return parts;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

// Tool types that only exist on the Responses wire format and carry no
// Chat Completions equivalent. They are dropped instead of failing the whole
// request: Codex sends them speculatively, and rejecting the request would make
// the session unusable even though the remaining tools are perfectly callable.
const droppedResponsesToolTypes = new Set([
  'web_search',
  'web_search_preview',
  'web_search_preview_2025_03_11',
  'file_search',
  'computer_use_preview',
  'computer',
  'code_interpreter',
  'image_generation',
  'local_shell',
  'mcp',
  'custom',
  'apply_patch',
]);

// Chat Completions tool names must match ^[a-zA-Z0-9_-]{1,64}$ and be unique.
export function sanitizeToolName(name) {
  const cleaned = String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || undefined;
}

// Codex wraps MCP tools in a namespace container and refers to them as
// `<namespace>__<child>`:
//   { type: 'namespace', name: 'mcp__playwright',
//     tools: [ { type: 'function', name: 'browser_click', ... } ] }   -> call: mcp__playwright__browser_click
// Chat Completions has no namespace concept, so children are flattened into the
// top-level list under their fully qualified name. Both the qualified and the
// bare name are registered as aliases so a model that answers with either one
// still resolves, and the bare name is only kept when it is unambiguous.
function collectNamespaceTools(tool, converted, aliasToName, seen) {
  const prefix = sanitizeToolName(tool?.name);
  for (const child of Array.isArray(tool?.tools) ? tool.tools : []) {
    if (child?.type === 'namespace') {
      collectNamespaceTools({ ...child, name: [prefix, child.name].filter(Boolean).join('__') }, converted, aliasToName, seen);
      continue;
    }
    if (child?.type !== 'function' || !child.name) continue;
    const bare = sanitizeToolName(child.name);
    if (!bare) continue;
    const qualified = sanitizeToolName(prefix ? `${prefix}__${bare}` : bare);
    const name = qualified && !seen.has(qualified) ? qualified : bare;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    converted.push({
      type: 'function',
      function: {
        name,
        ...(child.description ? { description: child.description } : {}),
        ...(child.parameters ? { parameters: child.parameters } : {}),
        ...(child.strict === undefined ? {} : { strict: child.strict }),
      },
    });
    // Prefer the most recently declared owner of a bare alias; the qualified
    // name always wins so namespace tools stay addressable.
    if (bare !== name && !aliasToName.has(bare)) aliasToName.set(bare, name);
  }
}

// Returns { tools, aliasToName }. aliasToName maps a model-emitted bare tool
// name back to the fully qualified name actually registered upstream.
export function responsesToolsToChat(tools) {
  if (!Array.isArray(tools)) return { tools: undefined, aliasToName: new Map() };
  const converted = [];
  const aliasToName = new Map();
  const seen = new Set();
  for (const tool of tools) {
    if (tool?.type === 'function') {
      const name = sanitizeToolName(tool?.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      converted.push({
        type: 'function',
        function: {
          name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.parameters ? { parameters: tool.parameters } : {}),
          ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        },
      });
      continue;
    }
    if (tool?.type === 'namespace') {
      collectNamespaceTools(tool, converted, aliasToName, seen);
      continue;
    }
    if (droppedResponsesToolTypes.has(tool?.type)) continue;
    throw new Error(`Responses tool type is not supported by the Chat Completions bridge: ${tool?.type || 'unknown'}`);
  }
  return { tools: converted.length ? converted : undefined, aliasToName };
}

function responsesToolChoiceToChat(value) {
  if (!value || ['auto', 'none', 'required'].includes(value)) return value;
  if (value.type === 'function' && value.name) {
    return { type: 'function', function: { name: value.name } };
  }
  throw new Error(`Responses tool_choice is not supported by the Chat Completions bridge: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// 输入搬运
// ---------------------------------------------------------------------------

export function responsesInputToChatMessages(body) {
  const messages = [];
  const instructions = responseTextPart(body.instructions).trim();
  if (instructions) messages.push({ role: 'system', content: instructions });

  const input = body.input === undefined ? [] : body.input;
  const items = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  if (!Array.isArray(items)) throw new Error('Responses input must be a string or an array.');

  for (const item of items) {
    const type = item?.type || (item?.role ? 'message' : '');
    if (type === 'message') {
      const role = item.role === 'developer' ? 'system' : item.role;
      if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
        throw new Error(`Unsupported Responses message role: ${item.role}`);
      }
      const message = { role, content: responsesContentToChat(item.content, `${role} message`) };
      if (item.tool_calls) message.tool_calls = item.tool_calls;
      messages.push(message);
      continue;
    }
    if (type === 'function_call') {
      const existing = messages.at(-1);
      const toolCall = {
        id: item.call_id || item.id || `call_${Math.random().toString(36).slice(2)}`,
        type: 'function',
        function: { name: item.name, arguments: String(item.arguments || '{}') },
      };
      if (existing?.role === 'assistant' && !existing.content) {
        existing.tool_calls = [...(existing.tool_calls || []), toolCall];
      } else {
        messages.push({ role: 'assistant', content: '', tool_calls: [toolCall] });
      }
      continue;
    }
    if (type === 'function_call_output') {
      const output = typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output ?? '');
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: output });
      continue;
    }
    if (type === 'reasoning') continue;
    throw new Error(`Unsupported Responses input item type: ${type || 'unknown'}`);
  }
  return messages;
}

// Codex 在新版协议里把推理档放在 reasoning.effort；旧版/CLI 用顶层 reasoning_effort。
// 两者都认，显式 "none" 表示关闭思维链（引擎的 thinking.type=disabled 语义）。
export function responsesReasoningEffort(body) {
  const raw = body?.reasoning?.effort ?? body?.reasoning_effort;
  if (raw === undefined || raw === null || raw === '') return undefined;
  return String(raw);
}

// body 是 Responses 请求体；stream 必须显式传入并原样透传给上游。
// 传 false（或省略）时保持旧的整段聚合路径，供非流式客户端使用。
export function chatPayloadFromResponses(body, options = {}) {
  const messages = responsesInputToChatMessages(body);
  if (!messages.length) throw new Error('Responses input must contain at least one message.');

  const payload = {
    model: body.model,
    messages,
    stream: options.stream === true,
  };
  const { tools, aliasToName } = responsesToolsToChat(body.tools);
  const toolChoice = responsesToolChoiceToChat(body.tool_choice);
  if (tools) payload.tools = tools;
  if (toolChoice) payload.tool_choice = toolChoice;
  if (body.parallel_tool_calls !== undefined) payload.parallel_tool_calls = body.parallel_tool_calls;
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) payload.max_tokens = body.max_output_tokens;
  if (body.text?.format !== undefined) payload.response_format = body.text.format;

  // --- Responses → Chat Completions 能力参数桥接 ---
  // Codex 用 /v1/responses，而引擎只认 Chat Completions。这些字段不翻译就会被静默
  // 丢弃，表现为「推理层级选不了、永远是默认 high」「Fast 开关无效」。
  // 只在客户端明确传了对应字段时才写入，保持「未指定 → 由引擎按模型默认档决定」。
  const effort = responsesReasoningEffort(body);
  if (effort !== undefined) payload.reasoning_effort = effort;

  if (body.service_tier !== undefined) {
    // Codex 的 Fast 开关 = service_tier: "fast"/"priority"；"default"/"auto"/null
    // 表示回到标准档。引擎侧没有 tier 概念，Fast 语义是「优先/低延迟」，这里透传，
    // 由引擎与上游决定是否识别（不识别时是无害的未知字段）。
    payload.service_tier = body.service_tier;
  }
  return { payload, aliasToName };
}

// ---------------------------------------------------------------------------
// 输出搬运：Chat Completions → Responses
// ---------------------------------------------------------------------------

export function responsesUsage(chatUsage) {
  const inputTokens = Number(chatUsage?.prompt_tokens ?? chatUsage?.input_tokens) || 0;
  const outputTokens = Number(chatUsage?.completion_tokens ?? chatUsage?.output_tokens) || 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: Number(chatUsage?.total_tokens) || inputTokens + outputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function newItemId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function chatMessageToResponseItems(message, startIndex, aliasToName) {
  const items = [];
  const text = typeof message?.content === 'string'
    ? message.content
    : responseTextPart(message?.content);
  if (text) {
    items.push({
      id: newItemId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const call of message?.tool_calls || []) {
    const rawName = call.function?.name;
    items.push({
      id: newItemId('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: call.id,
      // Re-qualify names the model answered with in bare form so Codex sees the
      // `mcp__<namespace>__<tool>` name it actually dispatches on.
      name: aliasToName?.get(rawName) || rawName,
      arguments: call.function?.arguments || '{}',
    });
  }
  if (!items.length) {
    items.push({
      id: newItemId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }
  return items;
}

export function responsePayloadFromChat(chat, publicModel, route, aliasToName) {
  const choice = chat?.choices?.[0];
  if (!choice) throw new Error('Upstream Chat Completions response has no choices.');
  const items = chatMessageToResponseItems(choice.message, 0, aliasToName);
  return {
    id: newItemId('resp'),
    object: 'response',
    created_at: Math.floor(Number(chat.created || Date.now() / 1000)),
    status: choice.finish_reason === 'length' ? 'incomplete' : 'completed',
    model: publicModel,
    output: items,
    parallel_tool_calls: chat.parallel_tool_calls,
    usage: responsesUsage(chat.usage),
    metadata: {},
    x_gateway_route: route.wireModel,
  };
}

// ---------------------------------------------------------------------------
// 流式翻译器：Chat Completions SSE → Responses SSE
//
// 用法：
//   const t = createResponsesStreamTranslator({ model, route, aliasToName, write });
//   t.start();                       // 立刻写出 response.created / in_progress
//   for await (chunk of upstream) t.push(decoder.decode(chunk, {stream:true}));
//   t.push(decoder.decode()); t.end();
//
// write(event) 由调用方序列化成 `event: <type>\ndata: <json>\n\n`。
// 事件顺序与官方 Responses 流一致：created → in_progress → output_item.added →
// content_part.added → output_text.delta* → output_text.done → content_part.done →
// output_item.done → completed。
// ---------------------------------------------------------------------------

export function createResponsesStreamTranslator({ model, route, aliasToName = new Map(), write }) {
  let sequence = 0;
  let started = false;
  let ended = false;
  let buffer = '';
  let finishReason = null;
  // 上游错误帧（引擎识别截断/上游报错时会补一帧 {"error":{...}}）。
  // 记录下来，收尾时必须走 response.failed —— 曾经这里直接 return 丢掉 error，
  // 于是截断流照样发出 response.completed，客户端看到「任务完成」但回答是半截。
  let streamError = null;
  // sawDone：上游/引擎发出过 [DONE]。引擎保证每条流恰好补一个 [DONE]，
  // 因此它是最权威的「流正常收尾」凭据 —— 有它就不该判截断，
  // 即使某些上游不发 finish_reason。
  let sawDone = false;
  let usage = null;
  let textItem = null;              // 已打开的 message item
  const toolItems = new Map();      // tool_call index → 已打开的 function_call item
  const completedItems = [];        // 按 output_index 顺序收集，供最终 response 对象使用
  const responseId = newItemId('resp');
  const createdAt = Math.floor(Date.now() / 1000);

  const emit = (type, extra = {}) => {
    write({ type, sequence_number: sequence++, ...extra });
  };

  const baseResponse = () => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'in_progress',
    model,
    output: [],
    metadata: {},
    x_gateway_route: route.wireModel,
  });

  function openTextItem() {
    if (textItem) return textItem;
    const outputIndex = completedItems.length + toolItems.size;
    textItem = { id: newItemId('msg'), outputIndex };
    emit('response.output_item.added', {
      output_index: outputIndex,
      item: { id: textItem.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
    emit('response.content_part.added', {
      item_id: textItem.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    return textItem;
  }

  function openToolItem(index, call) {
    if (toolItems.has(index)) return toolItems.get(index);
    const outputIndex = completedItems.length + toolItems.size + (textItem ? 1 : 0);
    const item = {
      id: newItemId('fc'),
      outputIndex,
      callId: call?.id || newItemId('call'),
      name: aliasToName.get(call?.function?.name) || call?.function?.name || '',
      args: '',
    };
    toolItems.set(index, item);
    emit('response.output_item.added', {
      output_index: outputIndex,
      item: { id: item.id, type: 'function_call', status: 'in_progress', call_id: item.callId, name: item.name, arguments: '' },
    });
    return item;
  }

  function closeTextItem() {
    if (!textItem) return;
    const outputIndex = textItem.outputIndex;
    const text = textItem.text || '';
    const part = { type: 'output_text', text, annotations: [] };
    emit('response.output_text.done', {
      item_id: textItem.id, output_index: outputIndex, content_index: 0, text,
    });
    emit('response.content_part.done', {
      item_id: textItem.id, output_index: outputIndex, content_index: 0, part,
    });
    const item = {
      id: textItem.id, type: 'message', status: 'completed', role: 'assistant', content: [part],
    };
    emit('response.output_item.done', { output_index: outputIndex, item });
    completedItems.push({ ...item, _outputIndex: outputIndex });
    textItem = null;
  }

  function closeToolItems() {
    for (const [index, item] of [...toolItems.entries()].sort((a, b) => a[1].outputIndex - b[1].outputIndex)) {
      emit('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: item.outputIndex,
        arguments: item.args,
      });
      const done = {
        id: item.id,
        type: 'function_call',
        status: 'completed',
        call_id: item.callId,
        name: item.name,
        arguments: item.args,
      };
      emit('response.output_item.done', { output_index: item.outputIndex, item: done });
      completedItems.push({ ...done, _outputIndex: item.outputIndex });
      toolItems.delete(index);
    }
  }

  function handleDelta(delta) {
    if (typeof delta?.content === 'string' && delta.content !== '') {
      const item = openTextItem();
      item.text = (item.text || '') + delta.content;
      emit('response.output_text.delta', {
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: 0,
        delta: delta.content,
      });
    }
    for (const call of delta?.tool_calls || []) {
      const index = Number.isInteger(call?.index) ? call.index : 0;
      const item = openToolItem(index, call);
      if (call?.function?.name && !item.name) {
        item.name = aliasToName.get(call.function.name) || call.function.name;
      }
      const args = call?.function?.arguments;
      if (typeof args === 'string' && args !== '') {
        item.args += args;
        emit('response.function_call_arguments.delta', {
          item_id: item.id,
          output_index: item.outputIndex,
          delta: args,
        });
      }
    }
  }

  function handleChunk(payload) {
    // 错误帧优先：上游/引擎报错时整条流必须以 failed 收尾，不能静默忽略。
    if (payload?.error) {
      streamError = payload.error;
      return;
    }
    if (payload?.usage) usage = payload.usage;
    const choice = payload?.choices?.[0];
    if (!choice) return;
    if (choice.delta) handleDelta(choice.delta);
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    const match = /^data:\s*(.*)$/u.exec(trimmed);
    if (!match) return;
    const data = match[1].trim();
    if (!data) return;
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }
    try {
      handleChunk(JSON.parse(data));
    } catch {
      // 上游插了非 JSON 的 keep-alive 之类的行：忽略，不要因此中断整个流。
    }
  }

  // hasProducedOutput 判断本轮是否已经向客户端吐过内容/工具调用。
  // 用于区分「上游断在半路」（有输出但无结束信号 → 截断）与
  // 「模型本来就返回空」（无输出 → 合法空回答）。
  function hasProducedOutput() {
    return Boolean(textItem && (textItem.text || '').length) || toolItems.size > 0;
  }

  // finishFailed 以 response.failed 收尾，保留已经吐给客户端的部分内容，
  // 并透传上游 error 的 code/message 便于排查。
  function finishFailed(message, detail) {
    if (ended) return;
    ended = true;
    closeTextItem();
    closeToolItems();
    emit('response.failed', {
      response: {
        ...baseResponse(),
        status: 'failed',
        output: [...completedItems]
          .sort((a, b) => a._outputIndex - b._outputIndex)
          .map(({ _outputIndex, ...item }) => item),
        error: {
          code: detail?.code || 'upstream_stream_error',
          message: String(message || 'upstream stream failed'),
        },
      },
    });
  }

  return {
    // 立刻写出响应头之后的事件，让客户端马上知道流已经开始，而不是干等。
    start() {
      if (started || ended) return;
      started = true;
      emit('response.created', { response: baseResponse() });
      emit('response.in_progress', { response: baseResponse() });
    },

    // 增量喂入上游 SSE 文本（可以是不完整的行）。
    push(text) {
      if (ended || !text) return;
      buffer += text;
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    },

    // 上游流结束：补齐未关闭的 item，写出最终 response.completed。
    end() {
      if (ended) return;
      // 先把残留的半行处理掉——错误帧可能正好落在缓冲区里。
      if (buffer) {
        handleLine(buffer);
        buffer = '';
      }
      // 上游给过 error 帧：必须 failed 收尾，绝不能伪装成正常完成。
      if (streamError) {
        finishFailed(streamError.message, streamError);
        return;
      }
      // 没收到任何 error 帧，但上游确实吐过内容、却既没有 finish_reason 也没有
      // [DONE] 就 EOF：属于漏网的中途断流（如上游直接断开、中间层截断）。
      // 这种情况若按 completed 收尾，客户端就会把半截回答当成任务做完——
      // 不报错、也不继续，正是「跑着跑着就结束了」的最终表现。
      // 注意：整条流一个字都没有（空回答）是合法的 completed，不能误判。
      if (!sawDone && !finishReason && hasProducedOutput()) {
        finishFailed('upstream stream ended without finish_reason or [DONE]');
        return;
      }
      ended = true;
      // 上游一个字都没给（空回答/纯 reasoning）时也要给出一个空 message，
      // 否则 Codex 收到 output: [] 会认为响应不合法。
      if (!textItem && !toolItems.size && !completedItems.length) {
        const outputIndex = 0;
        const itemId = newItemId('msg');
        const part = { type: 'output_text', text: '', annotations: [] };
        emit('response.output_item.added', {
          output_index: outputIndex,
          item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        });
        emit('response.content_part.added', {
          item_id: itemId, output_index: outputIndex, content_index: 0, part: { ...part, text: '' },
        });
        emit('response.output_text.done', {
          item_id: itemId, output_index: outputIndex, content_index: 0, text: '',
        });
        emit('response.content_part.done', {
          item_id: itemId, output_index: outputIndex, content_index: 0, part,
        });
        const item = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [part] };
        emit('response.output_item.done', { output_index: outputIndex, item });
        completedItems.push({ ...item, _outputIndex: outputIndex });
      }
      closeTextItem();
      closeToolItems();
      // output 必须按 output_index 升序，否则「先工具后文本」的场景下会颠倒。
      const output = [...completedItems]
        .sort((a, b) => a._outputIndex - b._outputIndex)
        .map(({ _outputIndex, ...item }) => item);
      const completed = {
        ...baseResponse(),
        status: finishReason === 'length' ? 'incomplete' : 'completed',
        output,
        usage: responsesUsage(usage),
      };
      emit('response.completed', { response: completed });
      return completed;
    },

    // 上游中途失败：尽量给客户端一个结构化的收尾，而不是静默断开。
    fail(message, detail) {
      finishFailed(message, detail);
    },

    get done() {
      return ended;
    },
  };
}
