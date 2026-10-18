<!-- top banner -->
<div align="center">

# Hermes · WorkBuddy Provider

**Turn a WorkBuddy AI subscription into a standard model backend for any OpenAI-compatible client**

[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows&logoColor=white)](#-platform-support)
[![Tests](https://img.shields.io/badge/tests-17%2F17%20passed-success)](server/verify-proxy.mjs)
[![Chinese](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-red)](README_CN.md)

</div>

---

## What this is

The WorkBuddy desktop app keeps your login encrypted on disk. This project decrypts it and exposes a local, **zero-dependency** OpenAI-compatible server (`127.0.0.1:8788`), so **any** client that accepts a `base_url` + `api_key` — Hermes, the OpenAI SDK, Cherry Studio, any agent framework — can call WorkBuddy's 27 models directly. Credentials refresh **automatically**; you only need to have logged in once in the app.

```
   your client                 local proxy                WorkBuddy
 ┌──────────────┐          ┌──────────────┐          ┌────────────────┐
 │ OpenAI SDK   │  Bearer  │              │  Bearer  │  www.workbuddy │
 │ Hermes       │ ───────► │ 127.0.0.1    │ ───────► │  .ai           │
 │ CherryStudio │  /v1/... │   :8788      │  +session│  /v2/chat/...  │
 └──────────────┘          └──────┬───────┘          └────────────────┘
                                  │ read + decrypt
                                  ▼
                     <LOCALAPPDATA>\CodeBuddyExtension\
                       Data\Public\auth\*.info   (AES-256-GCM)
```

---

## ✨ Features

| | |
|---|---|
| **Zero dependencies** | Node built-ins only. No `node_modules`, no supply-chain surface. |
| **Automatic decryption** | Reads WorkBuddy's encrypted credential vault directly — no manual token copying. |
| **Auto refresh** | Single-flight refresh before expiry; concurrent requests trigger it once. |
| **OpenAI compatible** | `/v1/chat/completions` (streaming + non-streaming), `/v1/models`. |
| **27 models** | Including `glm-5.3`, `deepseek-v4.1-flash`, `kimi-k3`, `gpt-6-astra`. |
| **Error classification** | 402 quota / 401 dead session / 429 rate limit, each mapped to a clear error type. |
| **Diagnosable** | One command tells you why your login state cannot be read. |
| **17 regression tests** | Ships a mock upstream — verifiable without a real account. |

---

## 🚀 Quick start

### 1. Prerequisites

- **Node.js ≥ 22** (developed on 24.18.1)
- **WorkBuddy AI desktop app installed and logged in**
- Windows (the credential vault paths are implemented for the Windows layout — see [Platform support](#-platform-support))

### 2. Start the server

```powershell
node server\workbuddy-proxy.mjs
```

On first run it will:

1. Generate `.workbuddy-proxy.json` in `$DSH_HOME` (or `%USERPROFILE%\.dsh` if unset), containing a random Bearer
2. Detect and decrypt the WorkBuddy credentials
3. Listen on `127.0.0.1:8788`

You are up when you see:

```json
{"ts":"...","event":"listening","host":"127.0.0.1","port":8788}
```

### 3. Verify

```powershell
# no auth
curl http://127.0.0.1:8788/healthz

# requires the Bearer from .workbuddy-proxy.json (bearerToken)
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8788/v1/models

# a real completion
curl -X POST http://127.0.0.1:8788/v1/chat/completions ^
  -H "Authorization: Bearer <token>" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"glm-5.3\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
```

### 4. Point your client at it

Two values, any OpenAI-compatible config:

| Field | Value |
|---|---|
| `base_url` | `http://127.0.0.1:8788/v1` |
| `api_key` | `bearerToken` from `.workbuddy-proxy.json` |

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8788/v1", api_key="<token>")
r = client.chat.completions.create(
    model="glm-5.3",
    messages=[{"role": "user", "content": "hi"}],
)
print(r.choices[0].message.content)
```

> **⚠️ Seeing mysterious empty 502 responses on Windows?** Read [Troubleshooting: empty 502](#empty-502) first.

---

## 🔌 Wiring into Hermes

This repo is itself a Hermes skill. Two ways to install it:

### Option A: let Hermes read SKILL.md

```
Copy server/ to <HERMES_HOME>\skills\workbuddy-reverse-proxy\server\
Keep SKILL.md at the same level — Hermes loads it as a skill.
```

### Option B: plain config (recommended, no skill needed)

Add a provider to `$HERMES_HOME/config.yaml`:

```yaml
providers:
  workbuddy:
    base_url: http://127.0.0.1:8788/v1
    key_env: WORKBUDDY_API_KEY
    api_mode: chat_completions
```

Put the token in `$HERMES_HOME/.env`:

```
WORKBUDDY_API_KEY=<bearerToken from .workbuddy-proxy.json>
```

Then point the default model at it:

```yaml
model:
  default: deepseek-v4.1-flash
  provider: workbuddy
```

**This line, `provider: workbuddy`, must not be written as `custom:workbuddy`** — Hermes 0.19.1's auth layer rejects the `custom:<name>` form with `custom endpoint is incomplete`.

Full details and gotchas: [references/hermes-wiring.md](references/hermes-wiring.md).

---

## 📡 API

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/healthz` | ❌ | Liveness probe, returns `{ok, status, uptime_s}` |
| GET | `/v1/models` | ✅ | Model list with `context_window` / `max_tokens` |
| POST | `/v1/chat/completions` | ✅ | Streaming + non-streaming, supports `tools` / `tool_calls` |
| GET | `/v1/auth/status` | ✅ | Credential source, domain, time remaining |
| GET | `/v1/catalog` | ✅ | Raw model catalog (with vendor metadata) |

### Error types

| HTTP | `error.type` | Meaning | What to do |
|---|---|---|---|
| 401 | `invalid_bearer` | Wrong local Bearer | Re-read it from `.workbuddy-proxy.json` |
| 401 | `workbuddy_session_dead` | WorkBuddy session expired | Log in again in the app |
| 402 | `workbuddy_credit_exhausted` | Quota/credits exhausted | Check your plan in the app |
| 429 | `workbuddy_rate_limited` | Upstream rate limited | Back off and retry |
| 400 | `workbuddy_client_error` | Upstream 4xx (including "model not supported") | Switch models |

---

## 🧠 Models

`/v1/models` returns 27 models, all with `supports_images: true`. A few of the useful ones:

| Model | Context | Max output | Fastest measured | Notes |
|---|---|---|---|---|
| `glm-5.3` | 1,000,000 | 48,000 | 1.1s | One of the longest-context flagships |
| `deepseek-v4.1-flash` | 300,000 | 128,000 | 1.3s | **Default recommendation**, cheapest in tokens |
| `kimi-k2.6` | — | — | 0.9s | Lowest measured latency |
| `gpt-6-astra` | 400,000 | 128,000 | — | Large output |
| `default-model` | 176,000 | 24,000 | 2.2s | WorkBuddy's Auto, upstream picks |

**Measured (same prompt "reply with one word: ok", `max_tokens=300`)**

```
deepseek-v4.1-flash   1.3s   in=15   out=1   total=16     <- cheapest
glm-5.3-flash         1.1s   in=24   out=3   total=27
kimi-k2.6             0.9s   in=21   out=4   total=25     <- fastest
default-model         2.2s   in=18   out=1   total=19
fast-model            1.4s   in=167  out=2   total=169    <- 7-11x input tokens, avoid
```

> **Note**: `gpt-5.4` / `gpt-5.5` return `11158 model not supported for this account type`
> on a normal subscription. The whole `gpt-6-*` family most likely behaves the same.
> Quota is shared — WorkBuddy bills from one subscription pool, not per model.

---

## 🔍 Diagnostics

### Why the login state cannot be read

```powershell
node server\inspect-vault.mjs
```

Success looks like:

```
解出成功：长度 1306，前缀前 4 位 "eyJh"，信封解密=是，剩余 525524 分钟
```

On failure it tells you exactly which stage broke — executable not found, credential file unreadable, or decryption failed.

### WorkBuddy installed somewhere unusual

If WorkBuddy lives on a non-default drive the detection may miss it. Point it explicitly:

```powershell
$env:WORKBUDDY_EXE = "D:\Apps\WorkBuddyAI\WorkBuddyAI.exe"
node server\inspect-vault.mjs
```

---

## 🔥 Troubleshooting

### Empty 502

**Symptom**: PowerShell / curl work fine against the proxy, but the Python `openai` SDK raises `InternalServerError: Error code: 502` with an empty body `b''`.

**Cause**: system proxy loopback. `httpx` defaults to `trust_env=True` and on Windows it reads the WinINET proxy from the registry, **without honouring the `127.*` exclusion in `ProxyOverride`**. Requests to `127.0.0.1:8788` are handed to the proxy (e.g. Clash core `verge-mihomo` on port 7897), which loops them back and returns an empty 502.

**Fix**:

```powershell
$env:NO_PROXY = "127.0.0.1,localhost"
$env:no_proxy = "127.0.0.1,localhost"
```

> Only libraries that read the system proxy — `httpx`, `openai` — are affected. `Invoke-WebRequest` and curl honour `ProxyOverride`, which is why it looks like "only Python is broken".

### `content` is empty but tokens are all spent

```json
{"choices":[{"message":{"content":""},"finish_reason":"stop"}],
 "usage":{"completion_tokens":80}}
```

**Cause**: nothing was lost — `max_tokens` was too small and the model's reasoning consumed the whole budget.

**Test**: `content == ""` and `completion_tokens == max_tokens`.

**Fix**: raise `max_tokens` above **200**.

### The service disappears silently

A killed proxy leaves no record. Three layers of defence:

1. **Scheduled task** (recommended) — Task Scheduler is more reliable than the Startup folder and is not reclaimed with its parent process:

   ```powershell
   $action  = New-ScheduledTaskAction -Execute 'C:\Windows\System32\cmd.exe' -Argument '/c "C:\path\to\server\autostart.cmd"'
   $trigger = New-ScheduledTaskTrigger -AtLogOn
   $trigger.Delay = 'PT20S'   # let the WorkBuddy vault unlock first
   $principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Limited
   Register-ScheduledTask -TaskPath '\' -TaskName 'WorkBuddyProxy' `
     -Action $action -Trigger $trigger -Principal $principal -Force
   ```

2. **Exit-code record** — `autostart.cmd` writes every exit `rc` to `workbuddy-proxy.exit.log`
3. **Structured crash log** — `uncaughtException` / `unhandledRejection` become one-line JSON on `stderr`

> **Windows-specific gotcha**: `schtasks /Create` fails with `Access is denied` on a non-admin account — you must use `Register-ScheduledTask`. Also, the `LogonType` enum value is `Interactive` (not the XML spelling `InteractiveToken`).

---

## 🛠 Development & testing

No real account needed — the suite ships its own mock upstream:

```powershell
cd server
node verify-proxy.mjs
```

```
PASS 17/17  FAIL 0       exit code 0
```

Covered: streaming chunk assembly, segmented `tool_calls`, request-body rewriting (`developer`→`system`), four upstream error mappings, Bearer validation, model-catalog caching, single-flight refresh on expiry, and **byte-level AAD comparison + AES-256-GCM round-trip + three tampering cases that must fail authentication**.

CI runs the same suite on Ubuntu and Windows across Node 22 and 24 — see [`.github/workflows/tests.yml`](.github/workflows/tests.yml).

---

## 📁 Layout

```
hermes-workbuddy-provider/
├── SKILL.md                        # Hermes skill definition (when to use, how to fix)
├── README.md                       # this file (English)
├── README_CN.md                    # 中文说明
├── LICENSE                         # MIT
├── DISCLAIMER.md                   # disclaimer
├── .github/workflows/tests.yml     # CI: Node 22/24 on Ubuntu + Windows
├── references/
│   ├── hermes-wiring.md            # full Hermes wiring priority order + gotchas
│   └── upstream-protocol.md        # reverse-engineered upstream protocol details
└── server/
    ├── workbuddy-proxy.mjs         # the proxy: ~1464 lines, zero dependencies
    ├── inspect-vault.mjs           # credential-vault diagnostic tool
    ├── verify-proxy.mjs            # 17-check regression suite
    ├── verify-catalog.mjs          # model-catalog validation
    ├── mock-upstream.mjs           # fake upstream for tests
    ├── config.example.json         # sample config
    ├── autostart.cmd               # Windows autostart (with exit-code logging)
    ├── uninstall-autostart.cmd     # remove autostart
    └── README.md                   # server-level notes
```

---

## 🖥 Platform support

| Platform | Status |
|---|---|
| Windows | ✅ Fully supported, tested on Windows 11 + Node 24.18.1 |
| macOS | ⚠️ Credential paths implemented for `~/Library/Application Support`, **untested** |
| Linux / WSL | ⚠️ Credential paths implemented per XDG (with a `/mnt/c/Users/<profile>` fallback), **untested** |

Credential detection order (`workbuddy-proxy.mjs`):

- Windows: `%LOCALAPPDATA%\CodeBuddyExtension\...` → `%APPDATA%\CodeBuddyExtension\...`
- macOS: `~/Library/Application Support/CodeBuddyExtension/...`
- Linux: `$XDG_CONFIG_HOME/...` → `$XDG_DATA_HOME/...`

---

## ❓ Known limitations

- **Model ids drift.** When upstream renames or retires a model, `/v1/models` follows — do not hardcode model names.
- **No balance endpoint.** WorkBuddy exposes no quota query API; check the app.
- **The encrypted envelope may change.** Currently `suite=1`, AES-256-GCM; a format change requires re-reverse-engineering.
- **Non-default install locations** are not auto-detected; set `WORKBUDDY_EXE`.

---

## Disclaimer

This project is for **personal study and local interoperability research** only.

Read [DISCLAIMER.md](DISCLAIMER.md) before use.

---

<div align="center">

**[⬆ Back to top](#hermes--workbuddy-provider)**

<sub>Not affiliated with, endorsed by, or authorized by WorkBuddy / Tencent / CodeBuddy.</sub>

</div>
