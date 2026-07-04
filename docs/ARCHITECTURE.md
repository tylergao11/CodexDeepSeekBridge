# Architecture

## Boundary

Codex currently expects an OpenAI Responses-compatible provider:

```text
GET  /v1/models
POST /v1/responses
SSE events for streamed responses
Responses-style function_call / function_call_output items
```

DeepSeek V4 Pro currently accepts:

```text
POST /chat/completions
Chat messages
OpenAI-style tools/tool_calls
thinking.type
reasoning_effort
```

This project owns only the protocol bridge between those two shapes.

## Model Catalog Contract

`GET /v1/models` is a Codex compatibility surface, not a DeepSeek API mirror. Codex decodes this metadata before it starts an agent turn, so missing or wrongly typed fields can degrade local agent behavior before DeepSeek is called.

The source of truth is `modelCard()` in `src/proxy.js`. It intentionally includes Codex-facing fields such as `base_instructions`, `truncation_policy`, `supports_parallel_tool_calls`, `shell_type`, and `apply_patch_tool_type`.

DeepSeek JSON output mode is unrelated to this catalog. JSON output mode constrains model text; the model catalog describes provider and tool capabilities to Codex.

## Request Flow

```text
Codex
  -> model catalog: GET /v1/models
  -> agent turn: POST /v1/responses stream=true
Bridge
  -> converts input/items/tools to Chat Completions messages/tools
  -> calls DeepSeek /chat/completions stream=true
  -> emits Responses SSE events back to Codex
Codex
  -> executes local tools if DeepSeek returns function calls
  -> sends function_call + function_call_output to the bridge
Bridge
  -> preserves assistant tool_calls and tool result ordering for DeepSeek
```

## Reasoning Contract

DeepSeek thinking mode can return `reasoning_content`. When a tool call happens, DeepSeek expects the assistant tool-call message to be preserved correctly in the next round. The bridge stores `reasoning_content` together with assistant messages so multi-round tool use does not lose the reasoning/tool-call relationship.

The bridge never forwards reasoning text to Codex as user-visible output. Codex receives only normal Responses output text or function calls.

## Error Contract

DeepSeek upstream errors are mapped to Codex-friendly JSON/SSE errors while keeping the upstream HTTP status and message:

```json
{
  "error": {
    "type": "deepseek_api_error",
    "code": "deepseek_http_402",
    "upstream_status": 402,
    "upstream_message": "...",
    "remedy": "余额不足：请确认 DeepSeek 账户余额并充值。"
  }
}
```

## Security

- API key is read from `DEEPSEEK_API_KEY`.
- The key is not written to project files.
- The bridge binds to `127.0.0.1` by default.
- Logs avoid request bodies and secrets.

## Known Edges

- Long-lived `previous_response_id` state is in memory. Restarting the bridge drops old response state.
- Codex metadata requirements may change between versions. The model catalog lives in `modelCard()` in `src/proxy.js`.
- This is a compatibility bridge, not a full OpenAI Responses API implementation.
