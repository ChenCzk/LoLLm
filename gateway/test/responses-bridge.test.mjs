// Responses → Chat Completions 桥接的行为测试。
//
// 重点回归 v1 缺陷：/v1/responses 恒以非流式请求上游，导致
//   1) 首字节延迟 == 总耗时（客户端视角「卡住」）；
//   2) 长回答在引擎 idle_timeout(300s) 处被掐断成 502。
// 这两条的根因都是 stream 标志在桥接层被写死为 false。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatPayloadFromResponses,
  createResponsesStreamTranslator,
  responseTextPart,
  responsesInputToChatMessages,
  responsesReasoningEffort,
  responsesToolsToChat,
} from '../responses-bridge.mjs';

// ---------------------------------------------------------------------------
// 复现用例：stream 标志必须透传
// ---------------------------------------------------------------------------

test('chatPayloadFromResponses 在 stream:true 时必须向上游请求流式', () => {
  const { payload } = chatPayloadFromResponses(
    { model: 'deepseek-flash', input: 'hi' },
    { stream: true },
  );
  assert.equal(payload.stream, true, '上游请求体必须 stream:true，否则网关卡在整段聚合');
});

test('chatPayloadFromResponses 在非流式下仍然 stream:false', () => {
  const { payload } = chatPayloadFromResponses(
    { model: 'deepseek-flash', input: 'hi' },
    { stream: false },
  );
  assert.equal(payload.stream, false);
});

test('chatPayloadFromResponses 默认不带 stream 时按非流式处理（保持旧调用方兼容）', () => {
  const { payload } = chatPayloadFromResponses({ model: 'deepseek-flash', input: 'hi' });
  assert.equal(payload.stream, false);
});

// ---------------------------------------------------------------------------
// 参数桥接（回归既有能力，防改动时被误删）
// ---------------------------------------------------------------------------

test('reasoning.effort 与顶层 reasoning_effort 都能桥接到上游', () => {
  assert.equal(
    chatPayloadFromResponses({ model: 'm', input: 'hi', reasoning: { effort: 'low' } }).payload.reasoning_effort,
    'low',
  );
  assert.equal(
    chatPayloadFromResponses({ model: 'm', input: 'hi', reasoning_effort: 'max' }).payload.reasoning_effort,
    'max',
  );
});

test('service_tier 透传到上游（Fast 开关）', () => {
  assert.equal(
    chatPayloadFromResponses({ model: 'm', input: 'hi', service_tier: 'fast' }).payload.service_tier,
    'fast',
  );
});

test('显式 none 表示关闭思维链，不能被当成「未指定」丢掉', () => {
  assert.equal(responsesReasoningEffort({ reasoning: { effort: 'none' } }), 'none');
  assert.equal(
    chatPayloadFromResponses({ model: 'm', input: 'hi', reasoning: { effort: 'none' } }).payload.reasoning_effort,
    'none',
  );
});

test('未指定推理档时不下发该字段，交由引擎按模型默认档决定', () => {
  const { payload } = chatPayloadFromResponses({ model: 'm', input: 'hi' });
  assert.equal('reasoning_effort' in payload, false);
});

test('max_output_tokens 映射到上游 max_tokens', () => {
  const { payload } = chatPayloadFromResponses({ model: 'm', input: 'hi', max_output_tokens: 4096 });
  assert.equal(payload.max_tokens, 4096);
});

// ---------------------------------------------------------------------------
// 输入搬运
// ---------------------------------------------------------------------------

test('instructions 变成 system 消息，developer 角色归一成 system', () => {
  const messages = responsesInputToChatMessages({
    instructions: 'be terse',
    input: [{ type: 'message', role: 'developer', content: 'rule' }],
  });
  assert.deepEqual(messages, [
    { role: 'system', content: 'be terse' },
    { role: 'system', content: 'rule' },
  ]);
});

test('input_image 转换成 Chat 的 image_url 结构', () => {
  const messages = responsesInputToChatMessages({
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '看图' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
      ],
    }],
  });
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
  ]);
});

test('function_call 与 function_call_output 配对成 tool_calls / tool 消息', () => {
  const messages = responsesInputToChatMessages({
    input: [
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  });
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].tool_calls[0].function.name, 'f');
  assert.equal(messages[0].tool_calls[0].function.arguments, '{"a":1}');
  assert.deepEqual(messages[1], { role: 'tool', tool_call_id: 'c1', content: 'ok' });
});

test('reasoning 类型的 input item 被跳过而不是报错', () => {
  const messages = responsesInputToChatMessages({
    input: [{ type: 'reasoning', id: 'r1' }, { type: 'message', role: 'user', content: 'hi' }],
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'hi');
});

test('空 input 抛错（避免向上游发没有消息的请求）', () => {
  assert.throws(() => chatPayloadFromResponses({ model: 'm', input: [] }), /at least one message/i);
});

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

test('namespace 工具被展开成限定名，bare 名可反查回去', () => {
  const { tools, aliasToName } = responsesToolsToChat([{
    type: 'namespace',
    name: 'mcp__playwright',
    tools: [{ type: 'function', name: 'browser_click', parameters: { type: 'object' } }],
  }]);
  assert.equal(tools[0].function.name, 'mcp__playwright__browser_click');
  assert.equal(aliasToName.get('browser_click'), 'mcp__playwright__browser_click');
});

test('仅 Responses 支持的工具类型被静默丢弃，不使整个请求失败', () => {
  const { tools } = responsesToolsToChat([
    { type: 'web_search' },
    { type: 'function', name: 'real_tool' },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].function.name, 'real_tool');
});

test('非法的 Responses 工具类型明确报错', () => {
  assert.throws(() => responsesToolsToChat([{ type: 'totally_unknown' }]), /not supported/i);
});

// ---------------------------------------------------------------------------
// 流式翻译器（本次修复的核心）
// ---------------------------------------------------------------------------

// 把翻译器产出的所有事件收集到数组，便于断言顺序与内容。
function collect({ model = 'deepseek-flash', aliasToName = new Map() } = {}) {
  const events = [];
  const translator = createResponsesStreamTranslator({
    model,
    route: { wireModel: 'cn:deepseek-v4.1-flash' },
    aliasToName,
    write: event => events.push(event),
  });
  return { events, translator };
}

function deltaEvent(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

test('start() 立刻写出 created / in_progress，客户端能马上看到响应开始', () => {
  const { events, translator } = collect();
  translator.start();
  assert.deepEqual(events.map(e => e.type), ['response.created', 'response.in_progress']);
});

test('增量文本按 delta 逐块写出，而不是等 end() 才一次性给', () => {
  const { events, translator } = collect();
  translator.start();
  translator.push(deltaEvent('你'));
  // 关键断言：第一个字到达时就已经产生了 output_text.delta，
  // 这正是「首字节不再等于总耗时」的保证。
  const deltas = events.filter(e => e.type === 'response.output_text.delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta, '你');

  translator.push(deltaEvent('好'));
  const deltas2 = events.filter(e => e.type === 'response.output_text.delta');
  assert.deepEqual(deltas2.map(e => e.delta), ['你', '好']);
});

test('跨 chunk 被切断的 SSE 行能正确拼接，不会丢字', () => {
  const { events, translator } = collect();
  translator.start();
  const line = deltaEvent('完整');
  // 故意从中间切开，模拟 TCP 分片
  translator.push(line.slice(0, 12));
  translator.push(line.slice(12));
  const deltas = events.filter(e => e.type === 'response.output_text.delta');
  assert.deepEqual(deltas.map(e => e.delta), ['完整']);
});

test('事件顺序符合 Responses 规范，且 sequence_number 递增', () => {
  const { events, translator } = collect();
  translator.start();
  translator.push(deltaEvent('hi'));
  translator.end();
  assert.deepEqual(events.map(e => e.type), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
  const numbers = events.map(e => e.sequence_number);
  assert.deepEqual(numbers, numbers.map((_, i) => i));
});

test('end() 返回的最终 response 收敛全部文本与 usage', () => {
  const { translator } = collect();
  translator.start();
  translator.push(deltaEvent('你好'));
  translator.push(`data: ${JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`);
  const completed = translator.end();
  const text = completed.output[0].content[0].text;
  assert.equal(text, '你好');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.usage, {
    input_tokens: 7,
    output_tokens: 3,
    total_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  });
});

test('finish_reason=length 映射成 incomplete', () => {
  const { translator } = collect();
  translator.start();
  translator.push(deltaEvent('被截断'));
  translator.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
  assert.equal(translator.end().status, 'incomplete');
});

test('工具调用按 index 合并增量 arguments，并用限定名回填 name', () => {
  const aliasToName = new Map([['browser_click', 'mcp__playwright__browser_click']]);
  const { events, translator } = collect({ aliasToName });
  translator.start();
  translator.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'browser_click', arguments: '{"a"' } }] } }],
  })}\n\n`);
  translator.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }],
  })}\n\n`);
  const completed = translator.end();
  const fc = completed.output.find(item => item.type === 'function_call');
  assert.equal(fc.name, 'mcp__playwright__browser_click');
  assert.equal(fc.arguments, '{"a":1}');
  assert.equal(fc.call_id, 'call_1');
  const argDeltas = events
    .filter(e => e.type === 'response.function_call_arguments.delta')
    .map(e => e.delta);
  assert.deepEqual(argDeltas, ['{"a"', ':1}']);
});

test('文本与工具调用混排时两者都进入最终 output', () => {
  const { translator } = collect();
  translator.start();
  translator.push(deltaEvent('先解释'));
  translator.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'f', arguments: '{}' } }] } }],
  })}\n\n`);
  const completed = translator.end();
  assert.deepEqual(completed.output.map(i => i.type), ['message', 'function_call']);
});

test('[DONE] 与 heartbeat 注释行不会破坏解析', () => {
  const { translator } = collect();
  translator.start();
  translator.push(': heartbeat\n\n');
  translator.push('data: [DONE]\n\n');
  const completed = translator.end();
  assert.equal(completed.status, 'completed');
});

test('上游非 JSON 的 keep-alive 行被忽略，不中断整个流', () => {
  const { events, translator } = collect();
  translator.start();
  translator.push('data: not-json\n\n');
  translator.push(deltaEvent('ok'));
  const completed = translator.end();
  assert.equal(completed.output[0].content[0].text, 'ok');
  assert.ok(events.some(e => e.type === 'response.completed'));
});

test('fail() 用 response.failed 收尾，而不是静默断开', () => {
  const { events, translator } = collect();
  translator.start();
  translator.push(deltaEvent('部分'));
  translator.fail('upstream boom');
  const failed = events.find(e => e.type === 'response.failed');
  assert.ok(failed, '必须发出 response.failed');
  assert.equal(failed.response.status, 'failed');
  assert.equal(failed.response.error.code, 'upstream_stream_error');
  assert.equal(translator.done, true);
});

test('end() 幂等：重复调用不会重复发 completed', () => {
  const { events, translator } = collect();
  translator.start();
  translator.end();
  translator.end();
  assert.equal(events.filter(e => e.type === 'response.completed').length, 1);
});

test('push() 在 end() 之后不再产生事件', () => {
  const { events, translator } = collect();
  translator.start();
  translator.end();
  const before = events.length;
  translator.push(deltaEvent('迟到'));
  assert.equal(events.length, before);
});

test('没有任何内容时也给出一个空 message，避免 Codex 收到空 output', () => {
  const { translator } = collect();
  translator.start();
  const completed = translator.end();
  assert.equal(completed.output.length, 1);
  assert.equal(completed.output[0].type, 'message');
  assert.equal(completed.output[0].content[0].text, '');
});

test('混合换行符（CRLF / LF）都能正确切分', () => {
  const { translator } = collect();
  translator.start();
  translator.push('data: {"choices":[{"delta":{"content":"A"}}]}\r\n\r\n');
  translator.push('data: {"choices":[{"delta":{"content":"B"}}]}\n\n');
  const completed = translator.end();
  assert.equal(completed.output[0].content[0].text, 'AB');
});

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

test('responseTextPart 归一字符串 / 数组 / 对象 / 空值', () => {
  assert.equal(responseTextPart('a'), 'a');
  assert.equal(responseTextPart([{ text: 'a' }, { text: 'b' }]), 'ab');
  assert.equal(responseTextPart({ text: 'a' }), 'a');
  assert.equal(responseTextPart(null), '');
});

// ---------------------------------------------------------------------------
// 复审补充：多工具调用与输出顺序
// ---------------------------------------------------------------------------

test('多个工具调用分别按各自 index 归并，不会互相污染', () => {
  const { translator } = collect();
  translator.start();
  translator.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [
      { index: 0, id: 'c0', function: { name: 'first', arguments: '{}' } },
      { index: 1, id: 'c1', function: { name: 'second', arguments: '{}' } },
    ] } }],
  })}\n\n`);
  const calls = translator.end().output.filter(i => i.type === 'function_call');
  assert.deepEqual(calls.map(c => c.name), ['first', 'second']);
  assert.deepEqual(calls.map(c => c.call_id), ['c0', 'c1']);
});

test('交错到达的多个工具调用按 index 正确归并', () => {
  const { translator } = collect();
  translator.start();
  translator.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{"x":' } }] } }],
  })}\n\n`);
  translator.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'b', arguments: '{"y":' } }] } }],
  })}\n\n`);
  translator.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }],
  })}\n\n`);
  translator.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] } }],
  })}\n\n`);
  const calls = translator.end().output.filter(i => i.type === 'function_call');
  assert.deepEqual(calls.map(c => [c.name, c.arguments]), [['a', '{"x":1}'], ['b', '{"y":2}']]);
});

test('先工具后文本时，最终 output 仍按 output_index 升序', () => {
  const { translator } = collect();
  translator.start();
  // 先开工具项
  translator.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'f', arguments: '{}' } }] } }],
  })}\n\n`);
  // 再补文本
  translator.push(deltaEvent('后到的说明'));
  const output = translator.end().output;
  assert.deepEqual(output.map(i => i.type), ['function_call', 'message']);
  assert.equal(output[1].content[0].text, '后到的说明');
});

test('最终 output 不泄漏内部排序字段 _outputIndex', () => {
  const { translator } = collect();
  translator.start();
  translator.push(deltaEvent('x'));
  for (const item of translator.end().output) {
    assert.equal('_outputIndex' in item, false);
  }
});

test('文本与工具同时到达时各自只开一个 item', () => {
  const { events, translator } = collect();
  translator.start();
  translator.push(deltaEvent('a'));
  translator.push(deltaEvent('b'));
  translator.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{}' } }] } }],
  })}\n\n`);
  translator.end();
  const addedMessages = events.filter(e => e.type === 'response.output_item.added' && e.item.type === 'message');
  assert.equal(addedMessages.length, 1, '文本 item 不能被重复打开');
});

// ---------------------------------------------------------------------------
// 上游截断/错误帧必须变成 response.failed，不能静默变成 response.completed
//
// 背景：引擎在识别到上游中途断流时会补一帧
//   data: {"error":{"message":"upstream stream truncated",...}}
// 再补 [DONE]。若翻译器不认 error 帧，就会把这一轮当成正常说完，
// 客户端看到「任务完成」但回答其实是半截 —— 正是用户报的「跑着跑着就结束了」。
// ---------------------------------------------------------------------------

function errorEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

test('上游 error 帧必须收尾成 response.failed，而不是 response.completed', () => {
  const { events, translator } = collect();
  translator.start();
  translator.push(deltaEvent('我来分析一下'));
  // 引擎识别到截断后补的 error 帧
  translator.push(errorEvent({
    error: { message: 'upstream stream truncated', type: 'upstream_error', code: 'upstream_stream_truncated' },
  }));
  translator.push('data: [DONE]\n\n');
  translator.end();

  const types = events.map(e => e.type);
  assert.ok(
    types.includes('response.failed'),
    `截断流必须以 response.failed 收尾，实际事件序列：${types.join(', ')}`,
  );
  assert.ok(
    !types.includes('response.completed'),
    `截断流不得发出 response.completed，实际事件序列：${types.join(', ')}`,
  );
});

test('error 帧的 message/code 要透传进 response.failed', () => {
  const { events, translator } = collect();
  translator.start();
  translator.push(deltaEvent('半截内容'));
  translator.push(errorEvent({
    error: { message: 'upstream stream truncated', code: 'upstream_stream_truncated' },
  }));
  translator.end();

  const failed = events.find(e => e.type === 'response.failed');
  assert.ok(failed, '应有 response.failed 事件');
  assert.equal(failed.response.status, 'failed');
  assert.match(
    String(failed.response.error?.message || ''),
    /truncat/i,
    'error.message 应透传上游原因，便于客户端排查',
  );
});

test('正常流（有 finish_reason）仍然收尾成 response.completed', () => {
  const { events, translator } = collect();
  translator.start();
  translator.push(deltaEvent('正常回答'));
  translator.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  translator.push('data: [DONE]\n\n');
  translator.end();

  const types = events.map(e => e.type);
  assert.ok(types.includes('response.completed'), '正常流必须 completed');
  assert.ok(!types.includes('response.failed'), '正常流不得 failed');
});

test('已收到的部分内容要保留在 failed 的 output 里，不能丢', () => {
  const { events, translator } = collect();
  translator.start();
  translator.push(deltaEvent('已经收到的内容'));
  translator.push(errorEvent({ error: { message: 'upstream stream truncated' } }));
  translator.end();

  const failed = events.find(e => e.type === 'response.failed');
  assert.ok(failed, '应有 response.failed');
  const text = JSON.stringify(failed.response.output || []);
  assert.match(text, /已经收到的内容/, '已输出的部分内容必须保留在 output 中');
});

test('上游既无 finish_reason 也无 error 就 EOF：不得静默 completed', () => {
  const { events, translator } = collect();
  translator.start();
  // 半截内容后流直接结束：既没有 finish_reason，也没有引擎补的 error 帧。
  // 这正是「跑着跑着就完成了」的最裸形态，必须 failed 收尾。
  translator.push(deltaEvent('我正准备继续'));
  translator.end();

  const types = events.map(e => e.type);
  assert.ok(
    !types.includes('response.completed'),
    `没有结束信号的流不得发出 response.completed，实际：${types.join(', ')}`,
  );
  assert.ok(
    types.includes('response.failed'),
    `没有结束信号的流应以 response.failed 收尾，实际：${types.join(', ')}`,
  );
});

test('上游有 finish_reason 但无 [DONE] 仍算正常完成', () => {
  const { events, translator } = collect();
  translator.start();
  translator.push(deltaEvent('完整'));
  translator.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  translator.end();

  assert.ok(events.some(e => e.type === 'response.completed'), '有 finish_reason 应正常完成');
});

test('整条流一个字都没有：保持 completed（空回答是合法结果）', () => {
  const { events, translator } = collect();
  translator.start();
  translator.end();

  const types = events.map(e => e.type);
  assert.ok(types.includes('response.completed'), '空回答不应被判成截断');
  assert.ok(!types.includes('response.failed'), '空回答不得 failed');
});
