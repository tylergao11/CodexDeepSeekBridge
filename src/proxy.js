const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = process.env.DEEPSEEK_RESPONSES_PROXY_HOST || '127.0.0.1';
const PORT = Number(process.env.DEEPSEEK_RESPONSES_PROXY_PORT || 18081);
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const LOG_PATH = path.join(__dirname, 'proxy.log');

const responseStore = new Map();
let sequenceNumber = 0;
const KNOWN_DEEPSEEK_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash']);
const MAX_STORED_RESPONSES = Number(process.env.DEEPSEEK_RESPONSES_STORE_LIMIT || 256);

const SUPPORTED_REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth' },
  { effort: 'high', description: 'Greater reasoning depth' },
  { effort: 'xhigh', description: 'Extra high reasoning depth' },
];

function modelCard(id, displayName) {
  return {
    id,
    slug: id,
    priority: id === 'deepseek-v4-pro' ? 0 : 1,
    base_instructions: '',
    display_name: displayName,
    description: `${displayName} through a local Responses-to-DeepSeek proxy.`,
    default_reasoning_level: 'xhigh',
    supported_reasoning_levels: SUPPORTED_REASONING_LEVELS,
    object: 'model',
    owned_by: 'deepseek',
    context_window: 128000,
    max_context_window: 128000,
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: false,
    default_reasoning_summary: 'none',
    support_verbosity: true,
    default_verbosity: 'low',
    shell_type: 'shell_command',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supported_in_api: true,
    visibility: 'list',
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    supports_image_detail_original: false,
    comp_hash: 'deepseek-local',
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: false,
    use_responses_lite: false,
  };
}

function normalizeDeepSeekModel(model) {
  return KNOWN_DEEPSEEK_MODELS.has(model) ? model : DEEPSEEK_MODEL;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function cachePrefixHash(body) {
  const toolSummary = Array.isArray(body.tools)
    ? body.tools.map((tool) => ({
      type: tool?.type || '',
      name: tool?.name || '',
      description: tool?.description || '',
      parameters: tool?.parameters || tool?.input_schema || null,
    }))
    : [];
  return stableHash(JSON.stringify({
    instructions: body.instructions || '',
    tools: toolSummary,
  }));
}

function summarizeInput(input) {
  if (typeof input === 'string') return 'string';
  if (!Array.isArray(input)) return typeof input;
  return input.map((item) => {
    if (!item || typeof item !== 'object') return typeof item;
    const base = item.type || item.role || 'object';
    if (item.type === 'function_call') return `${base}:${item.name || 'tool'}:${item.call_id || item.id || ''}`;
    if (item.type === 'function_call_output') return `${base}:${item.call_id || ''}`;
    return base;
  }).join(',');
}

function inputHasFunctionCall(input) {
  return Array.isArray(input) && input.some((item) => item && item.type === 'function_call');
}

function usageFromDeepSeek(usage) {
  const promptCacheHit = usage?.prompt_cache_hit_tokens || 0;
  const promptCacheMiss = usage?.prompt_cache_miss_tokens || 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens || promptCacheHit || 0;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens || 0;
  return {
    input_tokens: usage?.prompt_tokens || 0,
    output_tokens: usage?.completion_tokens || 0,
    total_tokens: usage?.total_tokens || 0,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    prompt_cache_hit_tokens: promptCacheHit,
    prompt_cache_miss_tokens: promptCacheMiss,
  };
}

function logUsage(responseId, usage, prefixHash) {
  const normalized = usageFromDeepSeek(usage);
  log(`DONE response=${responseId} prefix=${prefixHash} tokens in=${normalized.input_tokens} out=${normalized.output_tokens} cache_hit=${normalized.prompt_cache_hit_tokens} cache_miss=${normalized.prompt_cache_miss_tokens} cached=${normalized.input_tokens_details.cached_tokens}`);
}

function rememberResponse(id, messages) {
  responseStore.set(id, messages);
  while (responseStore.size > MAX_STORED_RESPONSES) {
    const oldest = responseStore.keys().next().value;
    if (!oldest) break;
    responseStore.delete(oldest);
  }
}

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  fs.appendFile(LOG_PATH, text, () => {});
}

class DeepSeekApiError extends Error {
  constructor(status, message, remedy) {
    super(`DeepSeek ${status}: ${message}${remedy ? ` | ${remedy}` : ''}`);
    this.name = 'DeepSeekApiError';
    this.status = status;
    this.upstreamMessage = message;
    this.remedy = remedy;
  }
}

function deepSeekErrorRemedy(status) {
  switch (status) {
    case 400:
      return '格式错误：请求体格式错误，请检查代理转换后的 messages/tools。';
    case 401:
      return '认证失败：请检查 DEEPSEEK_API_KEY 是否正确。';
    case 402:
      return '余额不足：请确认 DeepSeek 账户余额并充值。';
    case 422:
      return '参数错误：请根据 DeepSeek 返回信息修正参数。';
    case 429:
      return '请求速率达到上限：请稍后重试或降低并发/频率。';
    case 500:
      return 'DeepSeek 服务器内部故障：请稍后重试。';
    case 503:
      return 'DeepSeek 服务器繁忙：请稍后重试。';
    default:
      return status >= 500 ? 'DeepSeek 上游服务异常，请稍后重试。' : '请根据 DeepSeek 返回信息处理。';
  }
}

function deepSeekErrorFromResponse(status, raw) {
  let parsed = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch {}
  const detail = parsed.error?.message || parsed.message || raw || `HTTP ${status}`;
  return new DeepSeekApiError(status, detail, deepSeekErrorRemedy(status));
}

function requestModuleForUrl(url) {
  return url.protocol === 'http:' ? http : https;
}

function proxyErrorPayload(err) {
  if (err instanceof DeepSeekApiError) {
    return {
      status: err.status,
      error: {
        message: err.message,
        type: 'deepseek_api_error',
        code: `deepseek_http_${err.status}`,
        upstream_status: err.status,
        upstream_message: err.upstreamMessage,
        remedy: err.remedy,
      },
    };
  }
  return {
    status: 500,
    error: {
      message: err.message || String(err),
      type: 'proxy_error',
      code: 'proxy_error',
    },
  };
}

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT ${err.stack || err.message || String(err)}`);
});

process.on('unhandledRejection', (err) => {
  log(`UNHANDLED ${err && (err.stack || err.message) || String(err)}`);
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendSse(res, events) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  for (const event of events) {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeSse(res, type, data) {
  if (res.destroyed || res.writableEnded) return;
  const payload = {
    type,
    sequence_number: sequenceNumber++,
    ...data,
  };
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    return part.text || part.input_text || part.output_text || '';
  }).filter(Boolean).join('\n');
}

function findReasoningContent(callId) {
  for (const msgs of responseStore.values()) {
    for (const m of msgs) {
      if (m.role === 'assistant' && m.reasoning_content && Array.isArray(m.tool_calls)) {
        const matched = m.tool_calls.some((tc) => tc.id === callId || tc.call_id === callId);
        if (matched) return m.reasoning_content;
      }
    }
  }
  return '';
}

function convertInputItems(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  const pendingCalls = [];

  function flushPendingCalls() {
    if (pendingCalls.length === 0) return;
    const reasoning = pendingCalls.map((call) => call.reasoning).find(Boolean) || '';
    messages.push({
      role: 'assistant',
      content: '',
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      tool_calls: pendingCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      })),
    });
    pendingCalls.length = 0;
  }

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call') {
      const callId = item.call_id || item.id || '';
      const reasoning = findReasoningContent(callId);
      pendingCalls.push({
        id: callId || `call_${Math.random().toString(36).slice(2, 12)}`,
        name: item.name || 'tool',
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
        reasoning,
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      flushPendingCalls();
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      });
      continue;
    }
    if (item.type === 'message' || item.role) {
      flushPendingCalls();
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user';
      messages.push({ role, content: textFromContent(item.content) });
      continue;
    }
    if (item.type === 'input_text') {
      flushPendingCalls();
      messages.push({ role: 'user', content: item.text || '' });
    }
  }
  flushPendingCalls();
  return messages;
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const name = tool.name || tool.type;
    if (!name) continue;
    converted.push({
      type: 'function',
      function: {
        name,
        description: tool.description || `Codex tool: ${name}`,
        parameters: tool.parameters || tool.input_schema || { type: 'object', properties: {}, additionalProperties: true },
      },
    });
  }
  return converted.length > 0 ? converted : undefined;
}

function buildChatRequest(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });

  const previousId = body.previous_response_id;
  const previous = previousId ? responseStore.get(previousId) : undefined;
  if (previous && !inputHasFunctionCall(body.input)) {
    messages.push(...previous);
    messages.push(...convertInputItems(body.input));
  } else {
    messages.push(...convertInputItems(body.input));
  }

  const req = {
    model: normalizeDeepSeekModel(body.model),
    messages,
    stream: false,
    parallel_tool_calls: body.parallel_tool_calls !== false,
  };

  const maxTokens = body.max_output_tokens || body.max_tokens;
  if (maxTokens) req.max_tokens = maxTokens;
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  req.thinking = { type: 'enabled' };
  req.reasoning_effort = 'max';

  const tools = convertTools(body.tools);
  if (tools) {
    req.tools = tools;
    req.tool_choice = body.tool_choice || 'auto';
  }
  if (body.stream) req.stream_options = { include_usage: true };
  return req;
}

function postDeepSeek(json) {
  const url = new URL('/chat/completions', DEEPSEEK_BASE_URL);
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');
  const body = JSON.stringify(json);
  const timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 300000);
  const transport = requestModuleForUrl(url);
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (resp) => {
      const chunks = [];
      resp.on('data', (chunk) => chunks.push(chunk));
      resp.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch {}
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          reject(deepSeekErrorFromResponse(resp.statusCode, raw));
          return;
        }
        resolve(parsed);
      });
      resp.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('DeepSeek request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postDeepSeekStream(json, onChunk) {
  const url = new URL('/chat/completions', DEEPSEEK_BASE_URL);
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');
  const body = JSON.stringify({ ...json, stream: true });
  const timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 300000);
  const transport = requestModuleForUrl(url);
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (resp) => {
      let buffer = '';
      const errorChunks = [];
      resp.on('data', (chunk) => {
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          errorChunks.push(chunk);
          return;
        }
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            onChunk(parsed);
          } catch (err) {
            log(`stream parse error: ${err.message}`);
          }
        }
      });
      resp.on('end', () => {
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          const raw = Buffer.concat(errorChunks).toString('utf8');
          reject(deepSeekErrorFromResponse(resp.statusCode, raw));
          return;
        }
        // flush any remaining buffer data (incomplete SSE frame at stream end)
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith('data:')) {
            const payload = trimmed.slice(5).trim();
            if (payload && payload !== '[DONE]') {
              try { onChunk(JSON.parse(payload)); } catch {}
            }
          }
        }
        resolve();
      });
      resp.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('DeepSeek stream timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function responseFromChat(body, chatReq, chatResp) {
  const id = `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const message = chatResp.choices?.[0]?.message || {};
  const reasoningContent = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const output = [];

  const returnedToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (returnedToolCalls.length > 0) {
    for (const call of returnedToolCalls) {
      output.push({
        id: `fc_${Math.random().toString(36).slice(2, 12)}`,
        type: 'function_call',
        status: 'completed',
        call_id: call.id || `call_${Math.random().toString(36).slice(2, 12)}`,
        name: call.function?.name || call.name || 'tool',
        arguments: call.function?.arguments || call.arguments || '{}',
      });
    }
  } else {
    output.push({
      id: `msg_${Math.random().toString(36).slice(2, 12)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content || '', annotations: [] }],
    });
  }

  const response = {
    id,
    object: 'response',
    created_at: created,
    status: 'completed',
    model: normalizeDeepSeekModel(body.model),
    output,
    parallel_tool_calls: body.parallel_tool_calls !== false,
    usage: usageFromDeepSeek(chatResp.usage),
  };

  const stored = [...chatReq.messages];
  if (output.some((item) => item.type === 'function_call')) {
    stored.push({
      role: 'assistant',
      content: message.content || '',
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      tool_calls: returnedToolCalls,
    });
  } else {
    stored.push({ role: 'assistant', content: message.content || '', ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
  }
  rememberResponse(id, stored);
  logUsage(id, chatResp.usage, cachePrefixHash(body));
  return response;
}

function sseEventsForResponse(response) {
  const events = [
    { type: 'response.created', data: { response: { ...response, output: [], status: 'in_progress' } } },
  ];
  response.output.forEach((item, outputIndex) => {
    events.push({ type: 'response.output_item.added', data: { output_index: outputIndex, item } });
    if (item.type === 'message') {
      const part = item.content[0] || { type: 'output_text', text: '' };
      events.push({ type: 'response.content_part.added', data: { item_id: item.id, output_index: outputIndex, content_index: 0, part } });
      events.push({ type: 'response.output_text.delta', data: { item_id: item.id, output_index: outputIndex, content_index: 0, delta: part.text || '' } });
      events.push({ type: 'response.output_text.done', data: { item_id: item.id, output_index: outputIndex, content_index: 0, text: part.text || '' } });
      events.push({ type: 'response.content_part.done', data: { item_id: item.id, output_index: outputIndex, content_index: 0, part } });
    } else if (item.type === 'function_call') {
      events.push({ type: 'response.function_call_arguments.delta', data: { item_id: item.id, output_index: outputIndex, delta: item.arguments || '' } });
      events.push({ type: 'response.function_call_arguments.done', data: { item_id: item.id, output_index: outputIndex, arguments: item.arguments || '{}' } });
    }
    events.push({ type: 'response.output_item.done', data: { output_index: outputIndex, item } });
  });
  events.push({ type: 'response.completed', data: { response } });
  return events;
}

async function streamResponseFromChat(body, chatReq, res) {
  const id = `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const model = normalizeDeepSeekModel(body.model);
  const msgId = `msg_${Math.random().toString(36).slice(2, 12)}`;
  const output = {
    id: msgId,
    type: 'message',
    status: 'in_progress',
    role: 'assistant',
    content: [],
  };
  const responseBase = {
    id,
    object: 'response',
    created_at: created,
    status: 'in_progress',
    model,
    output: [],
    parallel_tool_calls: body.parallel_tool_calls !== false,
  };

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  writeSse(res, 'response.created', { response: responseBase });

  let partAdded = false;
  let outputAdded = false;
  let text = '';
  let reasoningContent = '';
  let usage = {};
  const toolCalls = new Map();

  await postDeepSeekStream(chatReq, (chunk) => {
    if (chunk.usage) {
      usage = {
        ...usage,
        ...chunk.usage,
      };
    }
    const delta = chunk.choices?.[0]?.delta || {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoningContent += delta.reasoning_content;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = call.index ?? 0;
        const current = toolCalls.get(index) || {
          id: call.id || `call_${Math.random().toString(36).slice(2, 12)}`,
          type: 'function_call',
          status: 'completed',
          call_id: call.id || `call_${Math.random().toString(36).slice(2, 12)}`,
          name: '',
          arguments: '',
        };
        if (call.id) {
          current.call_id = call.id;
        }
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        toolCalls.set(index, current);
      }
    }
    const contentDelta = delta.content || '';
    if (contentDelta) {
      if (!outputAdded) {
        writeSse(res, 'response.output_item.added', { output_index: 0, item: output });
        outputAdded = true;
      }
      if (!partAdded) {
        const part = { type: 'output_text', text: '', annotations: [] };
        output.content = [part];
        writeSse(res, 'response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part });
        partAdded = true;
      }
      text += contentDelta;
      writeSse(res, 'response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: contentDelta });
    }
  });

  let finalOutput;
  const returnedToolCalls = [...toolCalls.values()];
  if (returnedToolCalls.length > 0) {
    finalOutput = returnedToolCalls.map((item, index) => ({
      ...item,
      id: `fc_${Math.random().toString(36).slice(2, 12)}`,
      name: item.name || 'tool',
      arguments: item.arguments || '{}',
    }));
    finalOutput.forEach((item, index) => {
      writeSse(res, 'response.output_item.added', { output_index: index, item });
      writeSse(res, 'response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
      writeSse(res, 'response.output_item.done', { output_index: index, item });
    });
  } else {
    const part = { type: 'output_text', text, annotations: [] };
    if (!outputAdded) {
      writeSse(res, 'response.output_item.added', { output_index: 0, item: output });
      outputAdded = true;
    }
    if (!partAdded) {
      output.content = [part];
      writeSse(res, 'response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part });
    }
    output.status = 'completed';
    output.content = [part];
    writeSse(res, 'response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text });
    writeSse(res, 'response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part });
    writeSse(res, 'response.output_item.done', { output_index: 0, item: output });
    finalOutput = [output];
  }

  const response = {
    ...responseBase,
    status: 'completed',
    output: finalOutput,
    usage: usageFromDeepSeek(usage),
  };
  const stored = [...chatReq.messages];
  if (returnedToolCalls.length > 0) {
    stored.push({
      role: 'assistant',
      content: '',
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      tool_calls: returnedToolCalls.map((item) => ({
        id: item.call_id,
        type: 'function',
        function: { name: item.name || 'tool', arguments: item.arguments || '{}' },
      })),
    });
  } else {
    stored.push({ role: 'assistant', content: text, ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
  }
  rememberResponse(id, stored);
  logUsage(id, usage, cachePrefixHash(body));
  writeSse(res, 'response.completed', { response });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleResponses(req, res) {
  try {
    const body = await readJson(req);
    const requestedModel = body.model || DEEPSEEK_MODEL;
    const model = normalizeDeepSeekModel(requestedModel);
    log(`POST ${req.url} model=${requestedModel}${model !== requestedModel ? `->${model}` : ''} stream=${Boolean(body.stream)} prev=${body.previous_response_id || ''} prefix=${cachePrefixHash(body)} input=${summarizeInput(body.input)} tools=${Array.isArray(body.tools) ? body.tools.length : 0} parallel=${body.parallel_tool_calls !== false}`);
    const chatReq = buildChatRequest(body);
    if (body.stream) {
      await streamResponseFromChat(body, chatReq, res);
      return;
    }
    const chatResp = await postDeepSeek(chatReq);
    const response = responseFromChat(body, chatReq, chatResp);
    sendJson(res, 200, response);
  } catch (err) {
    const payload = proxyErrorPayload(err);
    const detail = err instanceof DeepSeekApiError
      ? `upstream_status=${err.status} upstream_message="${err.upstreamMessage}"`
      : (err.stack || err.message || String(err));
    log(`ERROR ${payload.error.code}: ${payload.error.message} | detail: ${detail}`);
    if (res.headersSent && !res.writableEnded) {
      try {
        writeSse(res, 'response.failed', { error: payload.error });
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (writeErr) {
        log(`Failed to write response.failed SSE: ${writeErr.message}`);
      }
      return;
    }
    if (!res.headersSent) {
      sendJson(res, payload.status, { error: payload.error });
    }
  }
}

function createServer() {
  return http.createServer((req, res) => {
    req.on('error', (err) => log(`client request error: ${err.message}`));
    res.on('error', (err) => log(`client response error: ${err.message}`));
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === 'GET' && (url.pathname === '/models' || url.pathname === '/v1/models')) {
      const cards = [
        modelCard('deepseek-v4-pro', 'DeepSeek V4 Pro'),
        modelCard('deepseek-v4-flash', 'DeepSeek V4 Flash'),
      ];
      return sendJson(res, 200, {
        object: 'list',
        models: cards,
        data: cards,
      });
    }
    if (req.method === 'POST' && (url.pathname === '/responses' || url.pathname === '/v1/responses')) {
      return handleResponses(req, res);
    }
    sendJson(res, 404, { error: { message: `No route for ${req.method} ${url.pathname}` } });
  });
}

function startServer() {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    log(`listening on http://${HOST}:${PORT}/v1 -> ${DEEPSEEK_BASE_URL}`);
    if (process.env.DEEPSEEK_PROXY_CONSOLE === '1') {
      console.log(`DeepSeek Responses proxy listening on http://${HOST}:${PORT}/v1`);
    }
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  buildChatRequest,
  cachePrefixHash,
  convertInputItems,
  convertTools,
  createServer,
  inputHasFunctionCall,
  modelCard,
  normalizeDeepSeekModel,
  requestModuleForUrl,
  responseFromChat,
  sseEventsForResponse,
  usageFromDeepSeek,
};
