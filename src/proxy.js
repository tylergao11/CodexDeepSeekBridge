const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Reuse HTTPS connections to avoid TLS handshake per request (~200ms saving)
// --- Git Bash auto-discovery (cross-machine, mirrors deepcode-cli) ---
let _cachedBashPath = null;
function resolveBashPath() {
  if (_cachedBashPath) return _cachedBashPath;
  if (process.platform !== 'win32') return null;
  // 1) where.exe bash
  try {
    const out = execFileSync('where.exe', ['bash'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'], windowsHide: true });
    const candidates = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .filter(c => !/system32[\\/]bash\.exe$/i.test(c));
    for (const c of candidates) { if (fs.existsSync(c)) { _cachedBashPath = c; return c; } }
  } catch (_) { /* where.exe may not exist or bash not in PATH */ }
  // 2) Known install locations
  const LOCS = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
  for (const c of LOCS) { if (fs.existsSync(c)) { _cachedBashPath = c; return c; } }
  // 3) git --exec-path fallback
  try {
    const ep = execFileSync('git', ['--exec-path'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'], windowsHide: true }).trim();
    if (ep) {
      const p = require('path');
      for (const rel of ['../../bin/bash.exe', '../bin/bash.exe', '../../../bin/bash.exe']) {
        const candidate = p.join(ep, rel);
        if (fs.existsSync(candidate)) { _cachedBashPath = candidate; return candidate; }
      }
    }
  } catch (_) { /* git not available */ }
  return null;
}

// --- Available tool discovery (preheat for tool description hints) ---
// Run once at startup to inform DeepSeek which CLI tools are available,
// reducing first-round failures from "command not found" errors.
let _toolCache = null;
function discoverTools() {
  if (_toolCache) return _toolCache;
  if (process.platform !== 'win32') { _toolCache = ''; return ''; }
  const candidates = ['node', 'jq', 'grep', 'sed', 'git', 'find', 'ls', 'cat', 'which', 'sort', 'uniq', 'wc'];
  const found = [];
  for (const t of candidates) {
    try {
      execFileSync('where.exe', [t + '.exe'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'], windowsHide: true });
      found.push(t);
    } catch (_) { /* not found */ }
  }
  _toolCache = found.length > 0 ? found.join(', ') : '';
  return _toolCache;
}
const AVAILABLE_TOOLS = discoverTools();

// --- Cache prefix tracking (diagnostic: logs WHY cache misses happen) ---
// Two-key design: prevId stores the last-seen hash; prevId:data stores the
// DeepSeek-facing payload signature (converted tools + instructions + injected prompt)
// so diagnoseCachePrefix can explain WHAT changed when the hash drifts.
const _cachePrefixHistory = new Map();
function diagnoseCachePrefix(body, currentHash, convertedTools) {
  const prev = body.previous_response_id;
  if (!prev) return ''; // first message, no history to compare
  const lastHash = _cachePrefixHistory.get(prev);
  if (!lastHash) { _cachePrefixHistory.set(prev, currentHash); return 'first_request'; }
  if (lastHash === currentHash) return 'stable';
  _cachePrefixHistory.set(prev, currentHash);
  // Hash changed — compare current DeepSeek-facing payload against stored baseline
  const last = _cachePrefixHistory.get(prev + ':data') || {};
  const currentToolsSig = (convertedTools || []).map(t => t.function?.name || t.name || '').sort().join(',');
  const currentInstr = (body.instructions || '').replace(/\s+/g, ' ').trim();
  const injected = process.env.DEEPSEEK_INJECT_SYSTEM_PROMPT || '';
  if (last.toolsSig !== currentToolsSig) return 'tools_changed';
  if (last.instrSig !== currentInstr) return 'instructions_changed';
  if (last.injected !== injected) return 'injected_prompt_changed';
  return 'unknown_change';
}

const BASH_PATH = resolveBashPath();

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 6 });

const HOST = process.env.DEEPSEEK_RESPONSES_PROXY_HOST || '127.0.0.1';
const PORT = Number(process.env.DEEPSEEK_RESPONSES_PROXY_PORT || 18081);
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const LOG_PATH = path.join(__dirname, 'proxy.log');
const STORE_PATH = path.join(__dirname, 'response-store.json');

const responseStore = new Map();
let sequenceNumber = 0;
const KNOWN_DEEPSEEK_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash']);
const MAX_STORED_RESPONSES = Number(process.env.DEEPSEEK_RESPONSES_STORE_LIMIT || 256);
const MAX_TOOLS = Number(process.env.DEEPSEEK_MAX_TOOLS || 128);
// Tool snapshot: Codex sends variable tool sets (162 tools on first request,
// 16 on subsequent ones — confirmed from production logs). Each switch nukes
// DeepSeek's KV cache. Fix: freeze the largest set ever seen and reuse it.
let _stableToolSnapshot = null;
let _stableToolSnapshotSize = 0;
let _stableToolReverseMap = null;
const UNSUPPORTED_IMAGE_NOTICE = '[Image omitted: DeepSeek image input is not supported by this bridge. Please describe the image or paste OCR text.]';

// DeepSeek thinking mode only supports two effective effort levels:
//   high → standard reasoning; max → deepest reasoning.
// low/medium are mapped to high; xhigh is mapped to max.
// We advertise only high and xhigh to match Codex expectations.
const SUPPORTED_REASONING_LEVELS = [
  { effort: "high", description: "Standard reasoning depth" },
  { effort: "xhigh", description: "Maximum reasoning depth (maps to DeepSeek max)" },
];

// Maps Codex reasoning_effort values to DeepSeek-compatible values.
// Per DeepSeek docs: low/medium → high; xhigh → max.
function mapReasoningEffort(effort) {
  if (!effort) return "high";
  switch (effort.toLowerCase()) {
    case "xhigh":
    case "max":
      return "max";
    case "high":
    case "medium":
    case "low":
    default:
      return "high";
  }
}

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
    context_window: 262144,
    max_context_window: 262144,
    max_completion_tokens: 4096,
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: true,
    default_reasoning_summary: 'auto',
    support_verbosity: true,
    default_verbosity: 'low',
    shell_type: 'shell_command',
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'tokens', limit: 262144 },
    supported_in_api: true,
    visibility: 'list',
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    supports_image_detail_original: true,
    comp_hash: 'deepseek-local',
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    supports_search_tool: true,
    use_responses_lite: false,
  };
}

function normalizeDeepSeekModel(model) {
  return KNOWN_DEEPSEEK_MODELS.has(model) ? model : DEEPSEEK_MODEL;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function cachePrefixHash(body, convertedTools) {
  // Hash the ACTUAL payload DeepSeek receives (converted tools), NOT raw Codex tools.
  // Raw tools may differ in order, contain namespaces/oneOf/anyOf that get compiled away,
  // but the KV cache prefix is determined by the final sorted+compiled tool definitions.
  const toolsForHash = convertedTools || [];
  const injected = process.env.DEEPSEEK_INJECT_SYSTEM_PROMPT || '';
  return stableHash(JSON.stringify({
    instructions: body.instructions || '',
    injected_prompt: injected,
    tools: toolsForHash,
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

function logUsage(responseId, usage, prefixHash, cacheDiagnosis) {
  const normalized = usageFromDeepSeek(usage);
  const diag = cacheDiagnosis && cacheDiagnosis !== 'stable' ? ` cache_diag=${cacheDiagnosis}` : '';
  log(`DONE response=${responseId} prefix=${prefixHash} tokens in=${normalized.input_tokens} out=${normalized.output_tokens} cache_hit=${normalized.prompt_cache_hit_tokens} cache_miss=${normalized.prompt_cache_miss_tokens} cached=${normalized.input_tokens_details.cached_tokens}${diag}`);

  // Rolling cache hit-rate summary — logged every N requests to surface drift patterns.
  _cacheStats.requests++;
  _cacheStats.totalInput += normalized.input_tokens;
  _cacheStats.totalCached += normalized.input_tokens_details.cached_tokens;
  _cacheStats.totalCacheMiss += normalized.prompt_cache_miss_tokens;
  if (cacheDiagnosis && cacheDiagnosis !== 'stable' && cacheDiagnosis !== 'first_request') {
    _cacheStats.prefixChanges++;
  }
  if (_cacheStats.requests % 10 === 0) {
    const hitRate = _cacheStats.totalInput > 0
      ? ((_cacheStats.totalCached / _cacheStats.totalInput) * 100).toFixed(1)
      : '0.0';
    log(`CACHE_SUMMARY requests=${_cacheStats.requests} cached_input_pct=${hitRate}% total_input=${_cacheStats.totalInput} total_cached=${_cacheStats.totalCached} total_miss=${_cacheStats.totalCacheMiss} prefix_changes=${_cacheStats.prefixChanges}`);
  }
}

// Rolling cache statistics for periodic summary logging.
const _cacheStats = {
  requests: 0,
  totalInput: 0,
  totalCached: 0,
  totalCacheMiss: 0,
  prefixChanges: 0,
};

// Turn-to-turn drift tracking: compare per-component hashes across requests.
let _lastInstrHash = '';
let _lastToolsHash = '';
let _lastInjectedHash = '';

function persistStore() {
  // Serialize Maps as arrays for JSON storage
  const snapshot = [...responseStore].map(([id, entry]) => {
    const msgs = entry.messages || entry; // compat: old format
    const items = entry.outputItems ? [...entry.outputItems] : [];
    return [id, { messages: msgs, outputItems: items }];
  });
  // Atomic write: write to temp file then rename, so a crash mid-write
  // never leaves a corrupted store that nukes all conversation history.
  const tmp = STORE_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    log('store persist: ' + err.message);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    for (const [id, value] of entries) {
      if (typeof id !== 'string') continue;
      // Backward compat: old format was [id, messages[]], new format is [id, {messages, outputItems}]
      if (Array.isArray(value)) {
        // Old format: migrate to new
        responseStore.set(id, { messages: value, outputItems: new Map() });
      } else if (value && typeof value === 'object' && Array.isArray(value.messages)) {
        // New format: reconstruct Maps from arrays
        const itemsArr = value.outputItems || [];
        const outputItems = new Map(itemsArr);
        responseStore.set(id, { messages: value.messages, outputItems });
        // Rebuild outputItemIndex
        for (const [itemId] of outputItems) {
          outputItemIndex.set(itemId, id);
        }
      }
    }
    log('store loaded ' + responseStore.size + ' responses');
    // Rebuild reasoningIndex from stored data — survives restart.
    for (const entry of responseStore.values()) {
      const msgs = entry.messages || entry; // compat
      indexReasoningFromMessages(msgs);
    }
    log('reasoning index rebuilt ' + reasoningIndex.size + ' entries, outputItemIndex ' + outputItemIndex.size + ' entries');
  } catch (err) {
    log('store load error: ' + (err.message || String(err)));
    // Don't delete — rename to .corrupted so data is recoverable.
    try { fs.renameSync(STORE_PATH, STORE_PATH + '.corrupted'); } catch { try { fs.unlinkSync(STORE_PATH); } catch {} }
  }
}

function rememberResponse(id, messages, outputItems) {
  const items = outputItems || new Map();
  responseStore.set(id, { messages, outputItems: items });
  indexReasoningFromMessages(messages);
  // Maintain outputItemIndex for item_reference expansion
  for (const [itemId] of items) {
    outputItemIndex.set(itemId, id);
  }
  // Evict oldest responses when over capacity
  while (responseStore.size > MAX_STORED_RESPONSES) {
    const oldest = responseStore.keys().next().value;
    if (!oldest) break;
    const evicted = responseStore.get(oldest);
    if (evicted) {
      // Clean up reasoning entries
      const msgs = evicted.messages || evicted; // compat: old format was messages[]
      for (const m of msgs) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            if (tc.id) reasoningIndex.delete(tc.id);
          }
        }
      }
      // Clean up outputItemIndex entries
      const evictedItems = evicted.outputItems || new Map();
      for (const [itemId] of evictedItems) {
        outputItemIndex.delete(itemId);
      }
    }
    responseStore.delete(oldest);
  }
  persistStore();
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

// Convert Codex content parts to DeepSeek-compatible format.
// Images are downgraded to a stable text notice because DeepSeek rejects image parts.
function convertContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;

    // DeepSeek V4 currently rejects image content. Keep the conversation usable
    // with a stable text placeholder, without replaying image URLs/base64 into KV cache.
    if (part.type === 'input_image') {
      parts.push({ type: 'text', text: UNSUPPORTED_IMAGE_NOTICE });
      continue;
    }

    // Already DeepSeek image format; downgrade it for the same reason.
    if (part.type === 'image_url') {
      parts.push({ type: 'text', text: UNSUPPORTED_IMAGE_NOTICE });
      continue;
    }

    // Text parts (input_text, output_text, text)
    const text = part.text || part.input_text || part.output_text || '';
    if (text) {
      parts.push({ type: 'text', text });
    }
  }

  // Backwards compat: return plain string for text-only content
  if (parts.length === 0) return '';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  if (parts.every((part) => part.type === 'text')) return parts.map((part) => part.text).join('\n');
  return parts;
}

function sanitizeReplayedMessage(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const hadTopLevelImage = Object.prototype.hasOwnProperty.call(msg, 'image_url')
    || Object.prototype.hasOwnProperty.call(msg, 'image_data');
  const result = { ...msg };
  delete result.image_url;
  delete result.image_data;

  if (Array.isArray(result.content)) {
    result.content = convertContent(result.content);
  } else if (hadTopLevelImage && typeof result.content === 'string' && !result.content.includes(UNSUPPORTED_IMAGE_NOTICE)) {
    result.content = result.content ? `${result.content}\n${UNSUPPORTED_IMAGE_NOTICE}` : UNSUPPORTED_IMAGE_NOTICE;
  }

  return result;
}

// O(1) index: call_id → reasoning_content for tool-call continuation.
// Populated by rememberResponse whenever an assistant message has tool_calls.
const reasoningIndex = new Map();

// O(1) index: output item id → response_id for item_reference expansion.
// Populated by rememberResponse. Survives restart via loadStore rebuild.
const outputItemIndex = new Map();

// Reverse map: short tool name → expanded full name (for namespace replay).
// Populated by convertTools, consumed by convertInputItems within the same request.
let toolNameReverseMap = new Map();

function findReasoningContent(callId) {
  return reasoningIndex.get(callId) || '';
}

// Rebuild reasoningIndex from stored messages.
// Used at startup (loadStore) and on every request (buildChatRequest)
// to guarantee the index is always populated from the authoritative source.
function indexReasoningFromMessages(messages) {
  for (const m of messages) {
    if (m.role === 'assistant' && m.reasoning_content && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id) reasoningIndex.set(tc.id, m.reasoning_content);
      }
    }
  }
}

function convertInputItems(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  const pendingCalls = [];

  function flushPendingCalls() {
    if (pendingCalls.length === 0) return;
    const reasoning = pendingCalls.map((call) => call.reasoning).find(Boolean) || '';
    // Mark ALL function_calls as already-executed history.
    // Codex replays them in input; DeepSeek must not re-execute.
    // Non-empty content signals to DeepSeek: "this turn is done, don't continue."
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
      // Resolve short namespace names to expanded full names (P1-2).
      const rawName = item.name || 'tool';
      const expandedName = toolNameReverseMap.get(rawName) || rawName;
      if (expandedName !== rawName) {
        log(`NAME_MAP ${rawName} → ${expandedName}`);
      }
      pendingCalls.push({
        id: callId || `call_${Math.random().toString(36).slice(2, 12)}`,
        name: expandedName,
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
    // --- tool_search_call / tool_search_output: DeepSeek doesn't support these.
    // The bridge eager-loads all tools via convertTools(), so we silently skip
    // these items rather than aborting. Logging for visibility.
    if (item.type === 'tool_search_call') {
      log(`INPUT_SKIP tool_search_call query="${String(item.query || '').slice(0, 80)}"`);
      continue;
    }
    if (item.type === 'tool_search_output') {
      log(`INPUT_SKIP tool_search_output tool_count=${Array.isArray(item.tools) ? item.tools.length : 0}`);
      continue;
    }
    // --- item_reference: expand Codex output item reference into message/tool_call ---
    // Codex uses item_reference to point to prior output items by id rather than
    // re-sending content inline. We look up the referenced item via outputItemIndex.
    if (item.type === 'item_reference') {
      const refId = item.id || '';
      const responseId = outputItemIndex.get(refId);
      if (!responseId) {
        log(`ITEM_REF_MISS id=${refId} — referenced item not found in any stored response`);
        continue;
      }
      const stored = responseStore.get(responseId);
      const refItem = stored?.outputItems?.get(refId);
      if (!refItem) {
        log(`ITEM_REF_MISS id=${refId} response=${responseId} — item not in outputItems map`);
        continue;
      }
      switch (refItem.type) {
        case 'message':
          flushPendingCalls();
          messages.push({ role: 'assistant', content: refItem.content });
          break;
        case 'function_call':
          pendingCalls.push({
            id: refItem.call_id || `call_${Math.random().toString(36).slice(2, 12)}`,
            name: refItem.name || 'tool',
            arguments: refItem.arguments || '{}',
            reasoning: findReasoningContent(refItem.call_id),
          });
          break;
        case 'reasoning':
          // Reasoning is display-only; no conversational content to expand.
          break;
        default:
          log(`ITEM_REF_UNKNOWN type=${refItem.type} id=${refId}`);
      }
      continue;
    }
    if (item.type === 'message' || item.role) {
      flushPendingCalls();
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user';
      messages.push({ role, content: convertContent(item.content) });
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

  // DEBUG: log ALL tool types from Codex to understand what's being sent.
  // This helps diagnose tool_search, namespace, mcp, and defer_loading patterns.
  const toolSummary = tools.map(t => ({
    type: t.type || 'unknown',
    name: t.name || '',
    server_label: t.server_label || '',
    defer_loading: !!t.defer_loading,
    has_params: !!(t.parameters || t.input_schema),
    nested_count: Array.isArray(t.tools) ? t.tools.length : 0,
  }));
  log('TOOLS_RAW ' + JSON.stringify(toolSummary));

  const converted = [];
  let namespaceCount = 0;
  let deferredCount = 0;
  let toolSearchCount = 0;

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;

    // --- tool_search: DeepSeek doesn't support runtime deferred tool discovery.
    // We skip it here; the tools it would have loaded are already in the tool list
    // as namespace entries with defer_loading:true on individual tools.
    if (tool.type === 'tool_search') {
      toolSearchCount++;
      continue;
    }

    // --- namespace: expand nested tools into flat function definitions.
    // Codex uses namespaces to group related tools (e.g., MCP server tools).
    // Each nested tool may have defer_loading:true, but we eagerly load all of them
    // since DeepSeek has no deferred-loading mechanism.
    // Recursively expands nested namespaces (namespaces within namespaces).
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      namespaceCount++;

      function expandNamespace(nsTools, nsPrefix) {
        for (const nested of nsTools) {
          if (!nested || typeof nested !== 'object') continue;
          const nestedType = nested.type || 'function';

          // Recursively expand nested namespaces, prefixing with parent name
          if (nestedType === 'namespace' && Array.isArray(nested.tools)) {
            log(`TOOLS_NESTED_NS expanding namespace=${nsPrefix}_${nested.name || '?'} tools=${nested.tools.length}`);
            expandNamespace(nested.tools, `${nsPrefix}_${nested.name || 'unnamed'}`);
            continue;
          }

          // Only expand known function-like types
          if (nestedType !== 'function' && nestedType !== 'mcp') {
            log(`TOOLS_SKIP_NESTED type=${nestedType} name=${nested.name || '?'} — not a function tool`);
            continue;
          }
          const nestedName = nested.name || nested.function?.name;
          if (!nestedName) continue;
          // Prefix with full namespace path, truncated to 64 chars (DeepSeek limit)
          const fullName = `${nsPrefix}_${nestedName}`.slice(0, 64);
          // Detect truncation collisions: use hash suffix to disambiguate
          const collision = converted.find(c => c.function.name === fullName);
          const finalName = collision
            ? `${nsPrefix.slice(0, 50)}_${nestedName.slice(0, 8)}_${stableHash(fullName)}`
            : fullName;
          if (collision) {
            log(`TOOLS_NAME_COLLISION original=${fullName} resolved=${finalName}`);
          }
          const desc = nested.description || nested.function?.description || `Tool: ${finalName}`;
          const params = nested.parameters || nested.input_schema || nested.function?.parameters
            || { type: 'object', properties: {}, required: [] };
          if (nested.defer_loading) deferredCount++;
          converted.push({
            type: 'function',
            function: {
              name: finalName,
              description: desc,
              parameters: compileSchema(params),
            },
          });
        }
      }

      expandNamespace(tool.tools, tool.name);
      continue;
    }

    // --- Deferred individual tools (defer_loading outside namespace):
    // Eager-load them — Codex marks them deferred but DeepSeek needs full definitions.
    if (tool.defer_loading && tool.type === 'function') {
      deferredCount++;
    }

    // --- Standard function / mcp / shell_command tools ---
    const name = tool.name || tool.function?.name || tool.type;
    if (!name) continue;
    const desc = tool.description || tool.function?.description || `Codex tool: ${name}`;
    const params = tool.parameters || tool.input_schema || tool.function?.parameters
      || { type: 'object', properties: {}, required: [] };
    converted.push({
      type: 'function',
      function: {
        name,
        description: desc,
        parameters: compileSchema(params),
      },
    });
  }

  if (toolSearchCount > 0 || namespaceCount > 0 || deferredCount > 0) {
    log(`TOOLS_CONVERT tool_search_skipped=${toolSearchCount} namespaces_expanded=${namespaceCount} deferred_eager=${deferredCount} total_functions=${converted.length}`);
  }

  // Build reverse map for namespace replay: shortName → fullName.
  // When Codex replays function_calls with short names, convertInputItems uses
  // this map to translate back to the expanded names DeepSeek expects.
  const reverseMap = new Map();
  for (const t of converted) {
    reverseMap.set(t.function.name, t.function.name); // identity for non-namespace tools
  }
  // Namespace tools: map both full name and short name to full name
  for (const tool of tools) {
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) {
        const shortName = nested.name || nested.function?.name;
        if (!shortName) continue;
        const fullName = converted.find(c =>
          c.function.name.endsWith('_' + shortName) || c.function.name === shortName
        )?.function?.name;
        if (fullName && fullName !== shortName) {
          reverseMap.set(shortName, fullName);
        }
      }
    }
  }
  toolNameReverseMap = reverseMap;

  // Inject bash path into shell tool descriptions so DeepSeek auto-sets the "shell" parameter.
  // This is read when the model decides to call exec_command/shell_command — high attention, zero context waste.
  if (BASH_PATH) {
    const availStr = AVAILABLE_TOOLS ? `Available CLI tools: ${AVAILABLE_TOOLS}. No npm install needed - all pre-installed.` : '';
    const HINT = `\n\n--- SHELL RULE ---\nThis Windows machine uses Git Bash: "${BASH_PATH}".\nYou MUST set the "shell" parameter to "${BASH_PATH}".\nUse bash syntax (ls, cat, grep, sed, jq, node, etc.).\nNEVER use PowerShell cmdlets (Get-Content, ConvertFrom-Json, Out-File).\nPowerShell corrupts UTF-8 Chinese text. Bash does not.\n${availStr}\nPARALLELISM: You CAN issue MULTIPLE independent exec_command calls in ONE response to save rounds.\nGOTCHAS: Use SINGLE quotes for JSON strings in bash. Node inline scripts: use single-quote heredoc or write to .js file.\nFile encoding: all project files are UTF-8 (no BOM).`;
    for (const tool of converted) {
      const n = tool.function.name;
      if ((n === 'exec_command' || n === 'shell_command') && !tool.function.description.includes('SHELL RULE')) {
        tool.function.description += HINT;
      }
    }
  }
  // Sort by name for deterministic cache prefix regardless of Codex tool ordering
  converted.sort((a, b) => a.function.name.localeCompare(b.function.name));

  // Truncate if tool count exceeds DeepSeek API limit (P1-4).
  if (converted.length > MAX_TOOLS) {
    const dropped = converted.length - MAX_TOOLS;
    log(`TOOLS_TRUNCATE total=${converted.length} limit=${MAX_TOOLS} dropped=${dropped}`);
    converted.length = MAX_TOOLS;
  }

  return converted.length > 0 ? converted : undefined;
}

// --- Unified Schema Compiler for DeepSeek compatibility ---
// Single-pass recursive traversal: strip banned keywords, enforce object schema
// rules, recover oneOf/anyOf properties, inject enum hints into descriptions.
// See: https://api-docs.deepseek.com/guides/tool_calls

const DEEPSEEK_BANNED_KEYWORDS = new Set([
  'minLength', 'maxLength', 'minItems', 'maxItems',
  'examples', '$schema', 'default', 'pattern', 'format',
]);

// Fields whose values may contain nested JSON Schema nodes and need recursive walk.
// Two categories:
//   DIRECT containers: value IS a schema node → walk(value) directly
//   DICT containers: value is {key: schemaNode, ...} → walk each value
const SCHEMA_CONTAINER_DIRECT = new Set([
  'items', 'additionalProperties', 'contains',
  'prefixItems', 'propertyNames',
  'if', 'then', 'else', 'not',
]);
const SCHEMA_CONTAINER_DICT = new Set([
  'properties', 'patternProperties', '$defs', 'definitions',
]);
const SCHEMA_CONTAINER_FIELDS = new Set([
  ...SCHEMA_CONTAINER_DIRECT,
  ...SCHEMA_CONTAINER_DICT,
  'oneOf', 'anyOf', 'allOf', // handled in Step 1, stripped in Step 2
]);

function compileSchema(schema) {
  const degradations = [];   // human-readable descriptions of what was stripped/recovered
  const enumHints = {};      // propName -> Set of JSON-stringified enum values (scoped per object)

  function walk(node, parentEnumHints) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(el => walk(el, parentEnumHints));

    // --- Step 1: oneOf / anyOf recovery (before stripping) ---
    // Merge properties from all branches so DeepSeek still sees parameter structure.
    // Also collect enum values per property for injection into descriptions.
    let mergedFromOneOf = {};
    let localEnumHints = {}; // scoped to this object node

    const combinators = node.oneOf || node.anyOf;
    if (Array.isArray(combinators) && combinators.length > 0) {
      const combinatorKey = node.oneOf ? 'oneOf' : 'anyOf';
      for (const branch of combinators) {
        if (!branch || typeof branch !== 'object') continue;
        const branchProps = branch.properties || {};
        for (const [propName, propSchema] of Object.entries(branchProps)) {
          if (!propSchema || typeof propSchema !== 'object') continue;
          // Merge: first-seen type wins, later branches add to enum hints
          if (!mergedFromOneOf[propName]) {
            mergedFromOneOf[propName] = {};
          }
          // Shallow-merge schema keys (type, description, etc.)
          for (const [sk, sv] of Object.entries(propSchema)) {
            if (sk === 'enum') {
              if (!localEnumHints[propName]) localEnumHints[propName] = new Set();
              if (Array.isArray(sv)) sv.forEach(v => localEnumHints[propName].add(JSON.stringify(v)));
            } else if (!(sk in mergedFromOneOf[propName])) {
              mergedFromOneOf[propName][sk] = sv;
            }
          }
        }
      }
      const recoveredCount = Object.keys(mergedFromOneOf).length;
      if (recoveredCount > 0) {
        degradations.push(`${combinatorKey}:recovered_${recoveredCount}_props`);
      } else {
        degradations.push(`${combinatorKey}:empty`);
      }
    }

    // Merge local enum hints into parent scope (for non-object nodes that have oneOf)
    Object.assign(parentEnumHints, localEnumHints);

    // --- Step 2: Strip banned keywords + recurse into container fields ---
    // Pre-pass: capture top-level enum values before they get stripped (P1-3).
    const topLevelEnum = Array.isArray(node.enum) ? [...node.enum] : [];

    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'oneOf' || k === 'anyOf') {
        // Already processed in Step 1; don't pass to DeepSeek
        continue;
      }
      if (k === 'allOf' || k === 'not') {
        // allOf/not are not recoverable in a meaningful way for DeepSeek.
        // allOf could be merged but often contains constraints (if/then) that don't merge cleanly.
        // Log and strip.
        if (Array.isArray(v)) {
          degradations.push(`allOf:${v.length}_branches`);
        } else {
          degradations.push(k);
        }
        continue;
      }
      if (DEEPSEEK_BANNED_KEYWORDS.has(k)) {
        // Track what's being stripped for diagnostics
        if (k === 'enum' && Array.isArray(v)) {
          degradations.push(`enum_${v.length}vals`);
        } else if (k === 'pattern' || k === 'format') {
          degradations.push(`${k}:${typeof v === 'string' ? v : '?'}`);
        } else {
          degradations.push(k);
        }
        continue;
      }
      if (SCHEMA_CONTAINER_FIELDS.has(k)) {
        // Recursively compile nested schema nodes.
        // Dict containers (properties, patternProperties, $defs, definitions)
        // hold {key: schema} maps — walk each value individually.
        // Direct containers hold a single schema node — walk the value directly.
        if (SCHEMA_CONTAINER_DICT.has(k)) {
          const walked = {};
          for (const [dk, dv] of Object.entries(v)) {
            walked[dk] = walk(dv, localEnumHints);
          }
          out[k] = walked;
        } else {
          out[k] = walk(v, localEnumHints);
        }
      } else {
        out[k] = v;
      }
    }

    // Inject top-level enum values into description before they're lost (P1-3).
    if (topLevelEnum.length > 0) {
      const hint = `Valid values: ${topLevelEnum.join(', ')}`;
      out.description = out.description ? `${out.description}. ${hint}` : hint;
    }

    // --- Step 3: Enforce DeepSeek strict-mode object rules ---
    if (node.type === 'object') {
      // Inject recovered oneOf/anyOf properties (out.properties already compiled via walk)
      if (Object.keys(mergedFromOneOf).length > 0) {
        const existing = out.properties || {};
        // Compile each merged property before adding (they're raw schema fragments)
        for (const [propName, rawProp] of Object.entries(mergedFromOneOf)) {
          if (!existing[propName]) {
            existing[propName] = walk(rawProp, localEnumHints);
          }
        }
        out.properties = existing;
      }

      // Inject enum hints into property descriptions
      for (const [propName, values] of Object.entries(localEnumHints)) {
        const prop = out.properties && out.properties[propName];
        if (prop && values.size > 0) {
          const parsed = [...values].map(v => {
            try { return JSON.parse(v); } catch { return v; }
          });
          const hint = `Valid values: ${parsed.map(String).join(', ')}`;
          const existing = prop.description || '';
          prop.description = existing ? `${existing}. ${hint}` : hint;
        }
      }

      // Enforce DeepSeek strict mode: additionalProperties must be false
      out.additionalProperties = false;

      // Auto-populate required if missing or not an array
      if (!Array.isArray(out.required)) {
        out.required = Object.keys(out.properties || {});
      }
    }

    return out;
  }

  const result = walk(schema, enumHints);

  // --- Step 4: Summary log ---
  // Only log when something was actually degraded — avoid noise for clean schemas.
  if (degradations.length > 0) {
    log(`SCHEMA_COMPILE stripped=[${degradations.join(', ')}]`);
  }

  return result;
}

// --- tool_choice format normalization ---
// Codex (OpenAI Responses) sends: { type: "function", name: "X" }
// DeepSeek (Chat Completions) expects: { type: "function", function: { name: "X" } }
function normalizeToolChoice(raw) {
  // String values pass through directly: "auto", "none", "required"
  if (typeof raw === 'string') return raw;
  // null/undefined/missing → default
  if (!raw || typeof raw !== 'object') return 'auto';

  const tcType = raw.type;

  // Already DeepSeek format: { type: "function", function: { name: "X" } }
  if (tcType === 'function' && raw.function && typeof raw.function === 'object') {
    return raw;
  }

  // Codex/OpenAI Responses format: { type: "function", name: "X" }
  if (tcType === 'function' && typeof raw.name === 'string') {
    log(`TOOL_CHOICE remapped: name="${raw.name}" → DeepSeek format`);
    return { type: 'function', function: { name: raw.name } };
  }

  // Unknown format (e.g. { type: "web_search" }, { type: "allowed_tools" })
  // → DeepSeek doesn't support these; degrade to auto with a warning.
  log(`TOOL_CHOICE_DEGRADE unsupported: ${JSON.stringify(raw)} → defaulting to "auto"`);
  return 'auto';
}

function buildChatRequest(body, preConvertedTools) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });

  // Inject bridge-level system prompt (appended after Codex instructions).
  // Fixed position = part of cache prefix from round 2 onward → 99% hit.
  const injected = process.env.DEEPSEEK_INJECT_SYSTEM_PROMPT;
  if (injected) messages.push({ role: 'system', content: injected });

  const previousId = body.previous_response_id;
  const stored = previousId ? responseStore.get(previousId) : undefined;
  // Compat: new format is {messages, outputItems}, old format was messages[]
  const previous = stored?.messages || stored;
  if (previous && Array.isArray(previous)) {
    // Belt-and-suspenders: rebuild any missing reasoningIndex entries from
    // the loaded previous messages. Handles edge cases where the in-memory
    // index was lost (e.g. crash between loadStore and first request).
    indexReasoningFromMessages(previous);
    if (inputHasFunctionCall(body.input)) {
      // Find last assistant tool call IDs from stored previous.
      const lastIds = new Set();
      for (let i = previous.length - 1; i >= 0; i--) {
        const m = previous[i];
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          for (const tc of m.tool_calls) lastIds.add(tc.id);
          break;
        }
      }
      // Everything from the first matching function_call_output
      // to the end of input is new; everything before is in previous.
      let newItems = body.input;
      if (lastIds.size > 0) {
        for (let i = 0; i < body.input.length; i++) {
          const item = body.input[i];
          if (item && item.type === 'function_call_output' && lastIds.has(item.call_id)) {
            newItems = body.input.slice(i);
            break;
          }
        }
      }
      // Skip ALL leading system messages from previous history.
      // They are already covered by current instructions + injected prompt.
      // If we only skip 1 but there are 2+ system messages (instructions +
      // injected prompt), the extras get duplicated each turn, growing the
      // conversation by one system msg/turn → KV cache prefix NEVER matches.
      let startIdx = 0;
      if (messages.length > 0) {
        while (startIdx < previous.length && previous[startIdx]?.role === 'system') {
          startIdx++;
        }
      }
      for (let i = startIdx; i < previous.length; i++) messages.push(sanitizeReplayedMessage(previous[i]));
      messages.push(...convertInputItems(newItems));
    } else {
      // Skip ALL leading system messages from previous history.
      // Same rationale as above — prevents KV cache prefix poisoning.
      let startIdx = 0;
      if (messages.length > 0) {
        while (startIdx < previous.length && previous[startIdx]?.role === 'system') {
          startIdx++;
        }
      }
      for (let i = startIdx; i < previous.length; i++) messages.push(sanitizeReplayedMessage(previous[i]));
      messages.push(...convertInputItems(body.input));
    }
  } else {
    if (previousId) {
      log(`PREVIOUS_MISS id=${previousId} — response not found in store, starting fresh`);
    }
    messages.push(...convertInputItems(body.input));
  }

  // DIAGNOSTIC: per-component hashes (split across here and tools declaration below).
  const msgSample = messages.slice(0, Math.min(3, messages.length));
  const msgPrefixHash = stableHash(JSON.stringify(msgSample));
  const msgFullHash = stableHash(JSON.stringify(messages));
  const instrHash = stableHash(String(body.instructions || ''));
  const injectedHash = stableHash(injected || '');

  const req = {
    model: normalizeDeepSeekModel(body.model),
    messages,
    stream: false,
    parallel_tool_calls: body.parallel_tool_calls !== false,
  };

  // Reasoning effort: read from Codex request, map to DeepSeek-compatible values.
  // Codex sends reasoning_effort (top-level) or reasoning.effort (nested).
  const codexEffort = body.reasoning_effort || (body.reasoning && body.reasoning.effort) || 'xhigh';
  req.reasoning_effort = mapReasoningEffort(codexEffort);

  // max_tokens: Codex's max_output_tokens assumes GPT-style counting (output only).
  // DeepSeek counts reasoning tokens inside max_tokens, so we multiply by 2.5x
  // to leave headroom for the thinking chain while still enforcing a ceiling.
  // Without this, a runaway model could waste tokens on unbounded output.
  if (body.max_output_tokens && typeof body.max_output_tokens === 'number') {
    req.max_tokens = Math.floor(body.max_output_tokens * 2.5);
  }

  // Do NOT forward temperature — thinking mode is always enabled and
  // DeepSeek's thinking mode is incompatible with temperature.
  req.thinking = { type: 'enabled' };

  const tools = preConvertedTools || convertTools(body.tools);
  const toolsHash = stableHash(JSON.stringify(tools || []));
  // Turn-to-turn drift detection: which component changed since last request?
  const driftParts = [];
  if (_lastInstrHash && _lastInstrHash !== instrHash) driftParts.push('INSTR');
  if (_lastToolsHash && _lastToolsHash !== toolsHash) driftParts.push('TOOLS');
  if (_lastInjectedHash && _lastInjectedHash !== injectedHash) driftParts.push('INJECTED');
  const driftTag = driftParts.length > 0 ? ` DRIFT=${driftParts.join(',')}` : '';
  _lastInstrHash = instrHash;
  _lastToolsHash = toolsHash;
  _lastInjectedHash = injectedHash;
  log('DIAG_MSG msgs=' + messages.length + ' instr_len=' + (body.instructions ? String(body.instructions).length : 0) + ' msg_prefix=' + msgPrefixHash + ' msg_full=' + msgFullHash + ' instr=' + instrHash + ' tools=' + toolsHash + ' injected=' + injectedHash + driftTag);
  // Stash converted tools on the request object so downstream (logUsage/diagnoseCachePrefix)
  // can access the actual DeepSeek-facing tool definitions for accurate cache diagnostics.
  req._convertedTools = tools;
  if (tools) {
    // Hard assertion: DeepSeek only supports type=function tools.
    // If any non-function tool leaks through, log and drop before sending.
    const badTools = tools.filter(t => t.type !== 'function');
    if (badTools.length > 0) {
      const badSummary = badTools.map(t => `${t.type}:${t.function?.name || t.name || '?'}`).join(',');
      log(`TOOLS_ASSERT_FAIL ${badSummary} — dropping non-function tools before DeepSeek request`);
    }
    const cleanTools = tools.filter(t => t.type === 'function');
    req.tools = cleanTools;
    req.tool_choice = normalizeToolChoice(body.tool_choice);
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
      ...(url.protocol === "https:" ? { agent: httpsAgent } : {}),
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

function postDeepSeekStream(json, onChunk, onOpen) {
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
      ...(url.protocol === "https:" ? { agent: httpsAgent } : {}),
    }, (resp) => {
      let buffer = '';
      const errorChunks = [];
      if (resp.statusCode >= 200 && resp.statusCode < 300 && onOpen) {
        onOpen();
      }
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
  // P2: detect empty choices — DeepSeek returned 200 but no content.
  if (!Array.isArray(chatResp.choices) || chatResp.choices.length === 0) {
    log('UPSTREAM_EMPTY_CHOICES response has no choices — returning empty output');
  }
  const reasoningContent = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const output = [];

  // Show reasoning in Codex when enabled (display-only, not carried into history).
  // Codex renders reasoning items as foldable "Thinking" blocks like o3/o4-mini.
  const showReasoning = process.env.DEEPSEEK_SHOW_REASONING !== '0';
  if (showReasoning && reasoningContent) {
    output.push({
      id: `rs_${Math.random().toString(36).slice(2, 12)}`,
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: reasoningContent }],
    });
  }

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

  // Build outputItems map for item_reference expansion (P0-3).
  // Stores minimal form of each output item keyed by its Codex id.
  const outputItems = new Map();
  for (const item of output) {
    outputItems.set(item.id, {
      type: item.type,
      content: item.content?.[0]?.text || '',
      call_id: item.call_id || '',
      name: item.name || '',
      arguments: item.arguments || '',
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
    // No tool calls → reasoning_content not needed in history (per DeepSeek docs)
    stored.push({ role: 'assistant', content: message.content || '' });
  }
  rememberResponse(id, stored, outputItems);
  const prefixHash = cachePrefixHash(body, chatReq._convertedTools);
  logUsage(id, chatResp.usage, prefixHash, diagnoseCachePrefix(body, prefixHash, chatReq._convertedTools));
  return response;
}

function sseEventsForResponse(response) {
  const events = [
    { type: 'response.created', data: { response: { ...response, output: [], status: 'in_progress' } } },
  ];
  response.output.forEach((item, outputIndex) => {
    events.push({ type: 'response.output_item.added', data: { output_index: outputIndex, item } });
    if (item.type === 'reasoning') {
      const summaryText = (item.summary && item.summary[0] && item.summary[0].text) || '';
      events.push({ type: 'response.reasoning.summary_text.delta', data: { item_id: item.id, output_index: outputIndex, summary_index: 0, delta: summaryText } });
      events.push({ type: 'response.reasoning.summary_text.done', data: { item_id: item.id, output_index: outputIndex, summary_index: 0, text: summaryText } });
    } else if (item.type === 'message') {
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
  // Show reasoning in Codex when enabled (default on).
  const showReasoning = process.env.DEEPSEEK_SHOW_REASONING !== '0';
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

  let streamOpened = false;
  function openResponseStream() {
    if (streamOpened) return;
    streamOpened = true;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    // P2: detect client disconnect during streaming
    res.on('close', () => {
      if (!res.writableEnded) {
        log(`STREAM_CLIENT_CLOSE response=${id} — client disconnected before stream completed`);
      }
    });
    writeSse(res, 'response.created', { response: responseBase });
  }

  let partAdded = false;
  let outputAdded = false;
  let text = '';
  let reasoningContent = '';
  let usage = {};
  const toolCalls = new Map();

  // Reasoning streaming state: emitted progressively before content, at output_index 0.
  let reasoningStarted = false;
  let reasoningItemId = null;
  let outputIndexBase = 0;

  await postDeepSeekStream(chatReq, (chunk) => {
    if (chunk.usage) {
      usage = {
        ...usage,
        ...chunk.usage,
      };
    }
    const delta = chunk.choices?.[0]?.delta || {};

    // Reasoning deltas arrive before content; stream them progressively at output_index 0.
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      if (!reasoningStarted && showReasoning) {
        reasoningItemId = `rs_${Math.random().toString(36).slice(2, 12)}`;
        const reasoningItem = {
          id: reasoningItemId,
          type: 'reasoning',
          status: 'in_progress',
          summary: [],
        };
        writeSse(res, 'response.output_item.added', { output_index: 0, item: reasoningItem });
        // P3: emit reasoning.started event for Codex "Thinking..." UI
        writeSse(res, 'response.reasoning.started', { item_id: reasoningItemId, output_index: 0 });
        reasoningStarted = true;
        outputIndexBase = 1;
      }
      reasoningContent += delta.reasoning_content;
      if (reasoningStarted) {
        writeSse(res, 'response.reasoning.summary_text.delta', {
          item_id: reasoningItemId, output_index: 0, summary_index: 0, delta: delta.reasoning_content,
        });
      }
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
        writeSse(res, 'response.output_item.added', { output_index: outputIndexBase, item: output });
        outputAdded = true;
      }
      if (!partAdded) {
        const part = { type: 'output_text', text: '', annotations: [] };
        output.content = [part];
        writeSse(res, 'response.content_part.added', { item_id: msgId, output_index: outputIndexBase, content_index: 0, part });
        partAdded = true;
      }
      text += contentDelta;
      writeSse(res, 'response.output_text.delta', { item_id: msgId, output_index: outputIndexBase, content_index: 0, delta: contentDelta });
    }
  }, openResponseStream);

  openResponseStream();

  // Complete reasoning item if it was started during the stream.
  if (reasoningStarted) {
    const reasoningItem = {
      id: reasoningItemId,
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: reasoningContent }],
    };
    writeSse(res, 'response.reasoning.summary_text.done', { item_id: reasoningItemId, output_index: 0, summary_index: 0, text: reasoningContent });
    writeSse(res, 'response.output_item.done', { output_index: 0, item: reasoningItem });
  }

  let finalOutput = [];
  const returnedToolCalls = [...toolCalls.values()];

  // Output message content if any text was accumulated (P1-5: preserve content
  // even when tool_calls are also present — they can coexist in one response).
  if (text) {
    const part = { type: 'output_text', text, annotations: [] };
    if (!outputAdded) {
      writeSse(res, 'response.output_item.added', { output_index: outputIndexBase, item: output });
      outputAdded = true;
    }
    if (!partAdded) {
      output.content = [part];
      writeSse(res, 'response.content_part.added', { item_id: msgId, output_index: outputIndexBase, content_index: 0, part });
    }
    output.status = 'completed';
    output.content = [part];
    writeSse(res, 'response.output_text.done', { item_id: msgId, output_index: outputIndexBase, content_index: 0, text });
    writeSse(res, 'response.content_part.done', { item_id: msgId, output_index: outputIndexBase, content_index: 0, part });
    writeSse(res, 'response.output_item.done', { output_index: outputIndexBase, item: output });
    finalOutput.push(output);
  }

  // Output tool calls (may coexist with content above).
  if (returnedToolCalls.length > 0) {
    const fcOutput = returnedToolCalls.map((item, index) => ({
      ...item,
      id: `fc_${Math.random().toString(36).slice(2, 12)}`,
      name: item.name || 'tool',
      arguments: item.arguments || '{}',
    }));
    fcOutput.forEach((item, index) => {
      const oi = outputIndexBase + finalOutput.length + index;
      writeSse(res, 'response.output_item.added', { output_index: oi, item });
      // P3: emit delta before done for SSE renderers that track real-time argument buildup
      writeSse(res, 'response.function_call_arguments.delta', { item_id: item.id, output_index: oi, delta: item.arguments });
      writeSse(res, 'response.function_call_arguments.done', { item_id: item.id, output_index: oi, arguments: item.arguments });
      writeSse(res, 'response.output_item.done', { output_index: oi, item });
    });
    finalOutput = finalOutput.concat(fcOutput);
  }
  // Fallback: neither content nor tool calls (empty response)
  if (!text && returnedToolCalls.length === 0) {
    const part = { type: 'output_text', text: '', annotations: [] };
    output.status = 'completed';
    output.content = [part];
    if (!outputAdded) {
      writeSse(res, 'response.output_item.added', { output_index: outputIndexBase, item: output });
    }
    writeSse(res, 'response.output_text.done', { item_id: msgId, output_index: outputIndexBase, content_index: 0, text: '' });
    writeSse(res, 'response.content_part.done', { item_id: msgId, output_index: outputIndexBase, content_index: 0, part });
    writeSse(res, 'response.output_item.done', { output_index: outputIndexBase, item: output });
    finalOutput = [output];
  }

  // If reasoning was streamed, include it in the final output array (at index 0).
  if (reasoningStarted && showReasoning) {
    finalOutput.unshift({
      id: reasoningItemId,
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: reasoningContent }],
    });
  }

  // Build outputItems map for item_reference expansion (P0-3).
  const outputItems = new Map();
  for (const item of finalOutput) {
    outputItems.set(item.id, {
      type: item.type,
      content: item.content?.[0]?.text || '',
      call_id: item.call_id || '',
      name: item.name || '',
      arguments: item.arguments || '',
    });
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
      content: text || '',
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      tool_calls: returnedToolCalls.map((item) => ({
        id: item.call_id,
        type: 'function',
        function: { name: item.name || 'tool', arguments: item.arguments || '{}' },
      })),
    });
  } else {
    // No tool calls → reasoning_content not needed in history (per DeepSeek docs)
    stored.push({ role: 'assistant', content: text });
  }
  rememberResponse(id, stored, outputItems);
  const prefixHash = cachePrefixHash(body, chatReq._convertedTools);
  logUsage(id, usage, prefixHash, diagnoseCachePrefix(body, prefixHash, chatReq._convertedTools));
  writeSse(res, 'response.completed', { response });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleResponses(req, res) {
  try {
    const body = await readJson(req);
    const requestedModel = body.model || DEEPSEEK_MODEL;
    const model = normalizeDeepSeekModel(requestedModel);
    // TOOL SNAPSHOT: production logs show Codex sends 162 tools on first request
    // but only 16 on subsequent ones. Each switch nukes DeepSeek's KV cache.
    // Fix: freeze the largest tool set ever seen and reuse it for every request.
    const freshTools = convertTools(body.tools);
    const freshSize = freshTools ? freshTools.length : 0;
    let convertedTools;
    if (freshSize > 0) {
      // Request has tools — apply snapshot logic
      if (!_stableToolSnapshot || freshSize > _stableToolSnapshotSize) {
        _stableToolSnapshot = freshTools;
        _stableToolSnapshotSize = freshSize;
        _stableToolReverseMap = new Map(toolNameReverseMap);
        convertedTools = freshTools;
        log(`TOOLS_SNAPSHOT frozen=${freshSize} tools — KV cache prefix locked`);
      } else {
        convertedTools = _stableToolSnapshot;
        toolNameReverseMap = _stableToolReverseMap || new Map();
        const freshHash = stableHash(JSON.stringify(freshTools));
        const stableHashVal = stableHash(JSON.stringify(_stableToolSnapshot));
        if (freshHash !== stableHashVal) {
          log(`TOOLS_DRIFT current=${freshSize}tools sent=${_stableToolSnapshotSize}tools — bridge using frozen snapshot`);
        }
      }
    } else {
      // No tools in this request — don't inject, keep snapshot for next tooled request
      convertedTools = freshTools;
    }
    const prefixHash = cachePrefixHash(body, convertedTools);
    const rawToolsCount = Array.isArray(body.tools) ? body.tools.length : 0;
    const convertedToolsCount = convertedTools ? convertedTools.length : 0;
  log(`POST ${req.url} model=${requestedModel}${model !== requestedModel ? `->${model}` : ''} stream=${Boolean(body.stream)} prev=${body.previous_response_id || ''} prefix=${prefixHash} input=${summarizeInput(body.input)} tools_raw=${rawToolsCount} tools_converted=${convertedToolsCount} parallel=${body.parallel_tool_calls !== false}`);
  // Store converted-tool signature for cache miss root-cause diagnostics.
  // Written under prevKey:data so diagnoseCachePrefix can diff against it
  // when the prefix hash changes between requests sharing the same previous_response_id.
  if (body.previous_response_id) {
    _cachePrefixHistory.set(body.previous_response_id + ':data', {
      toolsSig: (convertedTools || []).map(t => t.function?.name || t.name || '').sort().join(','),
      instrSig: (body.instructions || '').replace(/\s+/g, ' ').trim(),
      injected: process.env.DEEPSEEK_INJECT_SYSTEM_PROMPT || '',
    });
  }
    const chatReq = buildChatRequest(body, convertedTools);
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
  loadStore();
  // Log injected system prompt hash for KV cache stability monitoring.
  // If this hash changes between restarts, all cached prefixes are invalidated.
  const injected = process.env.DEEPSEEK_INJECT_SYSTEM_PROMPT;
  if (injected) {
    const injectedHash = stableHash(injected);
    log('KV_CACHE injected_system_prompt_hash=' + injectedHash + ' (change invalidates all cached prefixes)');
  }
  const server = createServer();
  server.listen(PORT, HOST, () => {
    log(`listening on http://${HOST}:${PORT}/v1 -> ${DEEPSEEK_BASE_URL}`);
  if (BASH_PATH) {
    log('BASH discovered: ' + BASH_PATH + ' (shell hints injected into tool descriptions)');
    if (AVAILABLE_TOOLS) log('TOOLS discovered: ' + AVAILABLE_TOOLS);
  }
  else if (process.platform === 'win32') log('BASH WARNING: Git Bash not found. Shell commands may use PowerShell.');
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
  loadStore,
  mapReasoningEffort,
  modelCard,
  normalizeDeepSeekModel,
  requestModuleForUrl,
  responseFromChat,
  sseEventsForResponse,
  usageFromDeepSeek,
};
