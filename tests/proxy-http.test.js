const assert = require('assert');
const http = require('http');
const { once } = require('events');

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendSse(res, chunks) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

async function startServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

function requestJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const target = new URL(url);
    const req = http.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function requestSse(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const target = new URL(url);
    const req = http.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function main() {
  const upstreamRequests = [];
  const upstream = await startServer(async (req, res) => {
    if (req.url !== '/chat/completions') {
      sendJson(res, 404, { error: { message: 'not found' } });
      return;
    }
    const body = await readJson(req);
    upstreamRequests.push(body);
    const last = body.messages[body.messages.length - 1]?.content || '';
    if (last.includes('force-error')) {
      sendJson(res, 422, { error: { message: 'mock invalid request' } });
      return;
    }
    if (body.stream && last.includes('stream-tool')) {
      sendSse(res, [
        { choices: [{ delta: { reasoning_content: 'hidden' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_stream_a', function: { name: 'shell_command', arguments: '{"command":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"echo stream"}' } }] } }] },
        { usage: { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 5 } },
      ]);
      return;
    }
    if (body.stream) {
      sendSse(res, [
        { choices: [{ delta: { reasoning_content: 'hidden' } }] },
        { choices: [{ delta: { content: 'stream ' } }] },
        { choices: [{ delta: { content: 'ok' } }] },
        { usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13, prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 4 } },
      ]);
      return;
    }
    if (last.includes('tool')) {
      sendJson(res, 200, {
        choices: [{
          message: {
            content: '',
            reasoning_content: 'hidden tool thought',
            tool_calls: [
              { id: 'call_mock_a', type: 'function', function: { name: 'shell_command', arguments: '{"command":"echo a"}' } },
              { id: 'call_mock_b', type: 'function', function: { name: 'shell_command', arguments: '{"command":"echo b"}' } },
            ],
          },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_cache_hit_tokens: 9, prompt_cache_miss_tokens: 11 },
      });
      return;
    }
    sendJson(res, 200, {
      choices: [{ message: { content: 'mock ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 4 },
    });
  });

  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.DEEPSEEK_BASE_URL = upstream.url;
  process.env.DEEPSEEK_RESPONSES_PROXY_PORT = '0';
  delete require.cache[require.resolve('../src/proxy')];
  const { createServer } = require('../src/proxy');
  const proxy = createServer();
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  try {
    const models = await new Promise((resolve, reject) => {
      http.get(`${proxyUrl}/v1/models`, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      }).on('error', reject);
    });
    assert.strictEqual(models.models[0].supports_parallel_tool_calls, true);

    const normal = await requestJson(`${proxyUrl}/v1/responses`, { model: 'deepseek-v4-pro', input: 'hello' });
    assert.strictEqual(normal.status, 200);
    assert.strictEqual(normal.body.output[0].content[0].text, 'mock ok');
    assert.strictEqual(normal.body.usage.input_tokens_details.cached_tokens, 6);

    const follow = await requestJson(`${proxyUrl}/v1/responses`, {
      model: 'deepseek-v4-pro',
      previous_response_id: normal.body.id,
      input: 'follow up',
    });
    assert.strictEqual(follow.status, 200);
    const followUpstream = upstreamRequests[upstreamRequests.length - 1];
    assert(followUpstream.messages.some((message) => message.role === 'assistant' && message.content === 'mock ok'));

    const tool = await requestJson(`${proxyUrl}/v1/responses`, {
      model: 'deepseek-v4-pro',
      input: 'please call tool',
      tools: [{ type: 'shell_command', input_schema: { type: 'object', properties: {} } }],
    });
    assert.strictEqual(tool.status, 200);
    assert.strictEqual(tool.body.output.length, 2);
    assert.strictEqual(tool.body.output[0].call_id, 'call_mock_a');
    assert.strictEqual(tool.body.output[1].call_id, 'call_mock_b');

    const stream = await requestSse(`${proxyUrl}/v1/responses`, { model: 'deepseek-v4-pro', input: 'hello stream', stream: true });
    assert.strictEqual(stream.status, 200);
    assert(stream.raw.includes('response.output_text.delta'));
    assert(stream.raw.includes('stream ok'));
    assert(stream.raw.includes('response.completed'));

    const streamTool = await requestSse(`${proxyUrl}/v1/responses`, {
      model: 'deepseek-v4-pro',
      input: 'please stream-tool',
      stream: true,
      tools: [{ type: 'shell_command', input_schema: { type: 'object', properties: {} } }],
    });
    assert.strictEqual(streamTool.status, 200);
    assert(streamTool.raw.includes('response.function_call_arguments.done'));
    assert(streamTool.raw.includes('call_stream_a'));

    const bad = await requestJson(`${proxyUrl}/v1/responses`, { model: 'deepseek-v4-pro', input: 'force-error' });
    assert.strictEqual(bad.status, 422);
    assert.strictEqual(bad.body.error.type, 'deepseek_api_error');
    assert.strictEqual(bad.body.error.upstream_status, 422);

    const badStream = await requestJson(`${proxyUrl}/v1/responses`, { model: 'deepseek-v4-pro', input: 'force-error', stream: true });
    assert.strictEqual(badStream.status, 422);
    assert.strictEqual(badStream.body.error.type, 'deepseek_api_error');

    assert(upstreamRequests.some((req) => req.thinking?.type === 'enabled' && req.reasoning_effort === 'max'));
  } finally {
    proxy.close();
    upstream.server.close();
  }

  console.log('proxy http integration tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
