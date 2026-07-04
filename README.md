# Codex DeepSeek Bridge

Codex DeepSeek Bridge is a local compatibility layer that lets Codex Desktop/CLI use DeepSeek V4 Pro as a custom provider.

Codex speaks the OpenAI Responses API. DeepSeek currently exposes Chat Completions / Anthropic-compatible APIs, so Codex cannot call `https://api.deepseek.com/responses` directly. This project runs a local HTTP bridge:

```text
Codex -> http://127.0.0.1:18081/v1/responses -> DeepSeek /chat/completions
```

The bridge keeps DeepSeek thinking mode enabled and maps Codex tools to DeepSeek tool calls.

## What It Installs

```text
%USERPROFILE%\.codex\deepseek-responses-proxy\proxy.js
%USERPROFILE%\.codex\config.toml
DEEPSEEK_API_KEY user environment variable
```

The project does not store your API key in source files or docs.

## One-Key Scripts

There are two primary user-facing scripts:

```powershell
cd <CodexDeepSeekBridge project root>
.\一键配置DeepSeek.ps1
.\一键还原ChatGPT.ps1
```

Use `一键配置DeepSeek.ps1` to paste a DeepSeek API key and switch Codex to DeepSeek V4 Pro.
If `DEEPSEEK_API_KEY` is already set in the user environment, the script reuses it and does not prompt again.
Use `-ForcePrompt` when you intentionally want to replace the saved key:

```powershell
.\一键配置DeepSeek.ps1 -ForcePrompt
```

Use `一键还原ChatGPT.ps1` to stop the bridge and restore Codex to the default ChatGPT login provider config.

## Install Internals

From this project:

```powershell
powershell -ExecutionPolicy Bypass -File .\一键配置DeepSeek.ps1
```

If the machine already has a DeepSeek key in `ANTHROPIC_AUTH_TOKEN`, you can reuse it:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -UseExistingAnthropicToken
```

For isolated tests, `install.ps1 -NoPersistApiKey` uses the supplied key only for the current PowerShell process and does not write it to the user environment.

The installer backs up `%USERPROFILE%\.codex\config.toml` before editing it. If `CODEX_HOME` is set, scripts use that instead.

Default install config:

```toml
model_provider = "deepseek"
model = "deepseek-v4-pro"
model_reasoning_effort = "xhigh"

[model_providers.deepseek]
name = "DeepSeek Pro (local Responses proxy)"
base_url = "http://127.0.0.1:18081/v1"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
```

## Start / Stop / Status

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\status.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\stop.ps1
```

## Verify

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

`verify.ps1` runs syntax checks, offline proxy contract tests, a local HTTP mock-upstream integration test, a temporary `CODEX_HOME` install/restore test, bridge status, and Codex doctor.

For a real Codex smoke test:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\codex-smoke.ps1
```

The smoke script locates the usable Codex executable under the local Codex install and injects the user-level `DEEPSEEK_API_KEY` into the current process. This avoids stale PowerShell environment blocks and WindowsApps launcher permission issues.

For a stronger agent-runtime test:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent-torture.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\agent-concurrency.ps1
```

These launch real Codex agent runs through the bridge in temporary workspaces and verify read, write, patch, shell command, error-recovery, multi-step context, and concurrent agent behavior.

## Restore

Restore from a specific backup:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore.ps1 -BackupPath "$env:USERPROFILE\.codex\config.toml.before-codex-deepseek-bridge-YYYYMMDD-HHMMSS.bak"
```

Or remove the DeepSeek provider block and switch back to the ChatGPT login default:

```powershell
powershell -ExecutionPolicy Bypass -File .\一键还原ChatGPT.ps1
```

Restart Codex after install or restore.

Default restore config:

```toml
model = "gpt-5.5"
model_reasoning_effort = "medium"
```

Restore removes the top-level `model_provider` entry and removes `[model_providers.deepseek]`, so Codex goes back to the normal ChatGPT login provider.

## Runtime Defaults

Codex config:

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek"
model_reasoning_effort = "xhigh"
```

DeepSeek request:

```json
{
  "thinking": { "type": "enabled" },
  "reasoning_effort": "max"
}
```

## Codex Model Metadata Contract

DeepSeek JSON output mode is not the model catalog shape Codex reads. JSON output mode only constrains model text output.

Codex reads model metadata from the provider model endpoint and its local model cache. The bridge therefore serves a Codex-compatible `/v1/models` response with fields such as:

```text
base_instructions
truncation_policy
supports_parallel_tool_calls
shell_type
apply_patch_tool_type
context_window
```

Keep this catalog aligned with Codex expectations in `src/proxy.js` `modelCard()`. If Codex starts warning about model metadata, check this function first.

## Capability Contract

The bridge must preserve Codex's agent runtime behavior:

- do not collapse multiple tool calls into one call
- do not hide or rewrite Codex tool names
- preserve `function_call` / `function_call_output` ordering across turns
- keep DeepSeek `reasoning_content` private while preserving it for tool-call continuation
- observe DeepSeek cache telemetry instead of adding a local prompt cache

DeepSeek server-side cache usage is logged as:

```text
cache_hit=... cache_miss=... cached=...
```

The local `prefix=...` hash is only an observability aid for stable instructions and tool schemas.

## DeepSeek Error Codes

The bridge preserves DeepSeek upstream status and adds a short remedy:

```text
400  bad request / malformed messages or tools
401  invalid API key
402  insufficient balance
422  invalid parameters
429  rate limit
500  DeepSeek internal error
503  DeepSeek overloaded
```

Logs:

```text
%USERPROFILE%\.codex\deepseek-responses-proxy\proxy.log
```

The bridge logs DeepSeek cache telemetry for each completed request:

```text
DONE response=... prefix=... tokens in=... out=... cache_hit=... cache_miss=... cached=...
```

`prefix` is a local hash of stable instructions and tool schemas. `cache_hit` / `cache_miss` come from DeepSeek usage fields, so cache behavior is observable without adding a custom local cache layer.

## Official References

- https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
- https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat
- https://api-docs.deepseek.com/zh-cn/guides/tool_calls
- https://api-docs.deepseek.com/zh-cn/guides/json_mode
- https://api-docs.deepseek.com/zh-cn/guides/kv_cache
- https://api-docs.deepseek.com/zh-cn/quick_start/error_codes
