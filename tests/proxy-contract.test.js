const assert = require('assert');
const {
  buildChatRequest,
  cachePrefixHash,
  convertInputItems,
  convertTools,
  modelCard,
  responseFromChat,
  sseEventsForResponse,
  usageFromDeepSeek,
} = require('../src/proxy');

function testModelCardShape() {
  const card = modelCard('deepseek-v4-pro', 'DeepSeek V4 Pro');
  assert.strictEqual(card.id, 'deepseek-v4-pro');
  assert.strictEqual(card.base_instructions, '');
  assert.deepStrictEqual(card.truncation_policy, { mode: 'tokens', limit: 10000 });
  assert.strictEqual(card.supports_parallel_tool_calls, true);
  assert.strictEqual(card.shell_type, 'shell_command');
  assert.strictEqual(card.apply_patch_tool_type, 'freeform');
  assert.strictEqual(card.context_window, 128000);
}

function testToolConversion() {
  const tools = convertTools([
    {
      type: 'shell_command',
      description: 'Run a shell command',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
    {
      name: 'apply_patch',
      parameters: { type: 'object', properties: {} },
    },
  ]);
  assert.strictEqual(tools.length, 2);
  assert.strictEqual(tools[0].type, 'function');
  assert.strictEqual(tools[0].function.name, 'shell_command');
  assert.strictEqual(tools[0].function.parameters.required[0], 'command');
  assert.strictEqual(tools[1].function.name, 'apply_patch');
}

function testInputConversionKeepsParallelToolCallsTogether() {
  const messages = convertInputItems([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read two files' }] },
    { type: 'function_call', call_id: 'call_a', name: 'shell_command', arguments: '{"command":"Get-Content README.md"}' },
    { type: 'function_call', call_id: 'call_b', name: 'shell_command', arguments: '{"command":"Get-Content package.json"}' },
    { type: 'function_call_output', call_id: 'call_a', output: 'readme' },
    { type: 'function_call_output', call_id: 'call_b', output: 'package' },
  ]);

  assert.strictEqual(messages.length, 4);
  assert.strictEqual(messages[1].role, 'assistant');
  assert.strictEqual(messages[1].tool_calls.length, 2);
  assert.strictEqual(messages[1].tool_calls[0].id, 'call_a');
  assert.strictEqual(messages[1].tool_calls[1].id, 'call_b');
  assert.strictEqual(messages[2].role, 'tool');
  assert.strictEqual(messages[3].role, 'tool');
}

function testBuildChatRequest() {
  const req = buildChatRequest({
    model: 'unknown-model',
    instructions: 'You are Codex.',
    input: 'hello',
    tools: [{ type: 'shell_command', input_schema: { type: 'object', properties: {} } }],
  });

  assert.strictEqual(req.model, 'deepseek-v4-pro');
  assert.strictEqual(req.messages[0].role, 'system');
  assert.strictEqual(req.messages[1].role, 'user');
  assert.strictEqual(req.thinking.type, 'enabled');
  assert.strictEqual(req.reasoning_effort, 'max');
  assert.strictEqual(req.parallel_tool_calls, true);
  assert.strictEqual(req.tools[0].function.name, 'shell_command');
}

function testResponseToolCallsAreNotCollapsed() {
  const response = responseFromChat(
    { model: 'deepseek-v4-pro' },
    { messages: [{ role: 'user', content: 'do two things' }] },
    {
      choices: [{
        message: {
          content: '',
          reasoning_content: 'private chain',
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'shell_command', arguments: '{"command":"a"}' } },
            { id: 'call_b', type: 'function', function: { name: 'shell_command', arguments: '{"command":"b"}' } },
          ],
        },
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 64,
        prompt_cache_miss_tokens: 36,
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    },
  );

  assert.strictEqual(response.output.length, 2);
  assert.strictEqual(response.output[0].type, 'function_call');
  assert.strictEqual(response.output[0].call_id, 'call_a');
  assert.strictEqual(response.output[1].call_id, 'call_b');
  assert.strictEqual(response.usage.input_tokens_details.cached_tokens, 64);
  assert.strictEqual(response.usage.output_tokens_details.reasoning_tokens, 12);

  const events = sseEventsForResponse(response);
  assert(events.some((event) => event.type === 'response.function_call_arguments.done'));
  assert(events.some((event) => event.type === 'response.completed'));
}

function testUsageAndPrefixHash() {
  const usage = usageFromDeepSeek({
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 7 },
  });
  assert.strictEqual(usage.input_tokens_details.cached_tokens, 7);
  assert.strictEqual(usage.total_tokens, 15);

  const a = cachePrefixHash({ instructions: 'same', tools: [{ type: 'x', input_schema: { type: 'object' } }], input: 'one' });
  const b = cachePrefixHash({ instructions: 'same', tools: [{ type: 'x', input_schema: { type: 'object' } }], input: 'two' });
  assert.strictEqual(a, b);
}

testModelCardShape();
testToolConversion();
testInputConversionKeepsParallelToolCallsTogether();
testBuildChatRequest();
testResponseToolCallsAreNotCollapsed();
testUsageAndPrefixHash();

console.log('proxy contract tests passed');
