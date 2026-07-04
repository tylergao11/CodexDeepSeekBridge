# Operations

## Daily Use

First-time or key change:

```powershell
cd <CodexDeepSeekBridge project root>
powershell -ExecutionPolicy Bypass -File .\一键配置DeepSeek.ps1
```

Check it:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\status.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\codex-smoke.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\agent-torture.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\agent-concurrency.ps1
```

Then open Codex. New sessions should show:

```text
model: deepseek-v4-pro
provider: deepseek
reasoning effort: xhigh
```

## After Editing `src/proxy.js`

```powershell
npm run check
npm test
npm run test:http
npm run test:system
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

## Debugging

Log file:

```text
%USERPROFILE%\.codex\deepseek-responses-proxy\proxy.log
```

Common cases:

```text
deepseek_http_401  key is invalid or missing
deepseek_http_402  account balance is insufficient
deepseek_http_429  too many requests
proxy_error        local bridge bug or malformed local request
```

## Clean Restore

```powershell
cd <CodexDeepSeekBridge project root>
powershell -ExecutionPolicy Bypass -File .\一键还原ChatGPT.ps1
```

Then restart Codex.
