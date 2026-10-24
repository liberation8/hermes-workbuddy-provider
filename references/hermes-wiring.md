# Hermes 侧接线：把 WorkBuddy 反代接成 `custom:workbuddy`

目标：让 Hermes 通过本机反代 `http://127.0.0.1:8788/v1` 调用 WorkBuddy AI 订阅模型。

**唯一推荐形态：纯 `config.yaml` 的 `providers.<key>` 条目（形态 c）。**
不安装 `model-providers` 插件——原因见「为什么不用 provider 插件」一节。

涉及的文件（都在 `D:\Hermes` 下，不在 `hermes-agent` 源码里）：

| 文件 | 作用 | 是否必改 |
|---|---|---|
| `D:\Hermes\config.yaml` | `providers.workbuddy` 条目 + `model` 指向 | 必改 |
| `D:\Hermes\.env` | `WORKBUDDY_API_KEY=<反代的 Bearer>` | 必改（见下「必须给真 key」） |

---

## 1. 最小接线（可直接粘贴）

### 1.1 `D:\Hermes\config.yaml`

```yaml
model:
  provider: custom:workbuddy
  base_url: http://127.0.0.1:8788/v1
  name: workbuddy/glm-5.3

providers:
  workbuddy:
    base_url: http://127.0.0.1:8788/v1
    key_env: WORKBUDDY_API_KEY
    api_mode: chat_completions
    default_headers: {}
```

字段说明（`providers.<key>` 段只认这些键；未知键被忽略并告警，camelCase 会自动
映射但同样告警——所以一律写 snake_case）：

| 键 | 值 | 说明 |
|---|---|---|
| `base_url` | `http://127.0.0.1:8788/v1` | 带 `/v1`。Hermes 会拼 `/chat/completions`、`/models` |
| `key_env` | `WORKBUDDY_API_KEY` | 指向 `.env` 里的变量名；**环境变量必须真实存在且有值** |
| `api_mode` | `chat_completions` | 反代只实现 OpenAI Chat Completions |
| `default_headers` | `{}` | 上游私有头由反代自己加，Hermes 不参与 |

### 1.2 `D:\Hermes\.env`

```
WORKBUDDY_API_KEY=<反代的 Bearer>
```

Bearer 的来源（按反代优先级）：
1. 环境变量 `WORKBUDDY_PROXY_BEARER`（启动反代时用的那个值）
2. `server\config.json` 的 `bearerToken`
3. `$DSH_HOME\.workbuddy-proxy.json` 的 `bearer`（反代自动生成时写在这里；
   `DSH_HOME` 未设置时落在 `%USERPROFILE%\.dsh\.workbuddy-proxy.json`）

> 注意：`/healthz` **不需要** Bearer；`/v1/models`、`/v1/auth/status`、
> `/v1/chat/completions` 三个都要 `Authorization: Bearer <token>`，错了返回
> `401 invalid_bearer`。

### 1.3 不想动默认模型时

把上面 `model:` 段整段删掉/保持原样（例如继续用 deepseek），只用 `providers.workbuddy`
条目；之后在 Hermes 里用 `/model` 临时切到 `custom:workbuddy`。`providers.*` 段本身
不影响当前默认模型。

---

## 2. 为什么必须给 `key_env` 真值

Hermes 在没拿到 key 时**不是**跳过鉴权，而是填一个字面量占位符并真的作为
`Authorization` 发出去：

- `hermes_cli/runtime_provider.py:1157` / `:1091` / `:1303` 里 key 为空时回落到
  字面量 `"no-key-required"`。
- 反代的鉴权是严格字符串比较（`workbuddy-proxy.mjs` 的 `safeEqual(provided, state.bearer)`），
  `no-key-required` 必然不等于真 Bearer → 每个请求 401 `invalid_bearer`。

所以「反代在本机、都是 localhost，应该免鉴权」这个想法是错的：反代不校验来源，
只校验 Bearer。请老实写 `.env`。

key 解析优先级（`hermes_cli/runtime_provider.py`、`hermes_cli/auth.py`、`hermes_cli/env_loader.py`）：

1. `providers.workbuddy.api_key`（字面值，直接写死在 config.yaml 里）
2. `providers.workbuddy.key_env` 指向的环境变量
   - 来自 `D:\Hermes\.env`，由 `hermes_cli/env_loader.py:462` `load_hermes_dotenv`
     载入（`:478`、`:488` 处 `override=True`，即 `.env` 会覆盖进程已有同名变量）
3. profile 的 `env_vars` 中首个非空（本方案不装 profile，不适用）
4. 兜底字面量 `"no-key-required"`（`runtime_provider.py:1157`）

## 3. 为什么必须有 `base_url`（以及为什么不用 bundled 名）

base_url 优先级（`hermes_cli/runtime_provider.py` 约 `1040-1160`）：

```python
base_url = (cp.get("base_url") or profile.base_url or model_base_url or "").rstrip("/")
```

即：`providers.<key>.base_url` > 插件 `ProviderProfile.base_url` > `model.base_url`。

这带来两条硬结论：

- **`model.provider` 不能写 bundled 名**（`deepseek`、`openai` 之类）。那样 Hermes 会
  找到 bundled profile，`providers.<key>.base_url` 不存在，于是 `profile.base_url`
  生效——请求继续打官方域名（例如 `https://api.deepseek.com`），你的反代根本不会被访问，
  而且用的还是官方的 key。必须用 `custom:<key>` 形式，让 `providers.<key>.base_url`
  成为第一优先级。
- 反过来，`providers.workbuddy.base_url` 和 `model.base_url` 写的是同一个值，这是有意的
  双保险：`/model` 切换时某些路径只读 `model.base_url`（例如模型探测
  `probe_api_models` 打 `GET {base_url}/models`，`hermes_cli/models.py:4253`）。

## 4. 模型 id 的写法与稳定性

### 4.1 两种写法

```yaml
model:
  provider: custom:workbuddy
  base_url: http://127.0.0.1:8788/v1
  name: workbuddy/glm-5.3          # 推荐：provider 前缀形式
```

或直接写裸 id：

```yaml
  name: glm-5.3
```

两者 Hermes 都接受；`workbuddy/<id>` 形式能在日志和 `/model` 列表里明确区分来源。
真实 id 以反代 `GET /v1/models` 返回的 `data[].id` 为准。

### 4.2 静态 models + context_length（可选，需要稳定复现时才加）

**默认什么都不写，让 Hermes 从端点探测**——反代 `/v1/models` 每条自带
`context_window`，探测一次就够。只有在你需要跨机器、跨 `hermes update`、或在反代没起
时仍要正确上下文长度时，才加静态条目。

要做静态锁定，就照下面这个形状写（`<...>` 全部由你替换）：

```yaml
providers:
  workbuddy:
    base_url: http://127.0.0.1:8788/v1
    key_env: WORKBUDDY_API_KEY
    api_mode: chat_completions
    models:
      <model-id>:
        context_length: <把 /v1/models 的 context_window 抄这里>
```

取值来源：反代 `GET /v1/models` 每条自带
`context_window: m.contextWindow ?? m.maxInputTokens`（`toOpenAiModels` 的映射），
把你自己机器上那条输出里的 `context_window` 值抄进
`providers.workbuddy.models.<id>.context_length` 即可。

**具体数值以你机器上 `curl /v1/models`（或 `Invoke-RestMethod`）的结果为准**；
本文不写任何具体数字，避免本文成为二次来源。

为什么静态写比靠探测稳：

- context_length 解析链是 `model.context_length` 或 `providers.<key>.models.<id>.context_length`
  > 端点 `/v1/models` 的 `context_length` > `context_length_cache.yaml` > models.dev >
  GGUF 探测 > 默认 `128000`（`agent/model_metadata.py:2321` `get_model_context_length`、
  `:2400` `get_custom_provider_context_length`）。
- 缺省会退回 `128000` 并**告警**（`model_metadata.py:282` `_warn_context_length_fallback`）。
- 探测结果缓存在 `D:\Hermes\provider_models_cache.json` / `context_length_cache.yaml`；
  反代没起、`hermes update`、profile clone 到新机器时缓存不跟着走，就会出现「模型列表空」
  或「上下文长度 128000」的漂移。静态条目是唯一跟仓库/配置走的稳定来源。
- 上游模型 id 本身会漂移（新增/下线），所以静态列表只写你确实在用的几个，其余靠 `/model`
  时的实时探测补充。

## 5. `/model` 与校验

- `/model` 选择器对 custom provider 会 `GET {base_url}/models` 拉目录
  （`hermes_cli/models.py:4253` `probe_api_models`），所以**反代的 `/v1/models` 是必需项**，
  不只是锦上添花。反代没起 → 选择器拿不到目录 → 只能手写 `model.name`。
- 请求的模型最终由 `hermes_cli/models.py:4844-4899` `validate_requested_model` 校验：
  不在目录里、又没静态声明时会被拒或告警。

## 6. 启停反代

### 6.1 前台（调试首选，Ctrl+C 停）

```powershell
& "C:\Program Files\nodejs\node.exe" D:\Hermes\skills\workbuddy-reverse-proxy\server\workbuddy-proxy.mjs
```

看到一行 `{"ts":"...","event":"listening","host":"127.0.0.1","port":8788,...}` 即成功。
若 Bearer 是自动生成的，stderr 会打印 `已生成 Bearer：<token>`，同时写入状态文件。

**状态文件位置**（找不到 bearer 时最常卡在这）：

| 环境 | 路径 |
|---|---|
| 设了 `DSH_HOME` | `%DSH_HOME%\.workbuddy-proxy.json` |
| **没设 `DSH_HOME`**（默认情况） | `%USERPROFILE%\.dsh\.workbuddy-proxy.json` |

即默认落在用户目录下的 `.dsh` 文件夹里，**不是** `D:\Hermes`，也不是 `server\`。
文件里存明文 `bearer`、实际 `port`、`host`（mode 600）。

**端口被占用**：进程会直接退出，`EADDRINUSE` → **退出码 `2`**。换 `config.json` 的
`port`，或按 6.2.1 找出占用者。

### 6.2 后台（推荐：Hermes 状态栏开关）

装好 `workbuddy-switch` 插件后，启停就在 Hermes 状态栏右侧的「反代 开/关」按钮上，
不需要命令行。等价的手工验证：

```powershell
# 需要 X-Hermes-Session-Token，见 web_server.py:368-385
Invoke-RestMethod -Uri 'http://127.0.0.1:14492/api/plugins/workbuddy-switch/status' `
  -Headers @{ 'X-Hermes-Session-Token' = $token }
```

插件契约见 SKILL.md 的「在 Hermes 里开关反代」。

### 6.2.1 后台（无界面时兜底）

```powershell
cmd /c "D:\Hermes\skills\workbuddy-reverse-proxy\server\autostart.cmd"
```

停止（按端口找进程）：

```powershell
# 不要用 Get-NetTCPConnection —— 它漏报跨权限层监听，必须用 netstat 原始输出
netstat -ano | findstr ":8788" | findstr LISTENING
taskkill /PID <上面的PID> /T /F
```

### 6.3 端口/配置覆盖

- 端口：`server\config.json` 的 `port`（默认 8788，只监听 `127.0.0.1`）
- 配置路径：环境变量 `WORKBUDDY_PROXY_CONFIG` 指向另一个 json
- 端口或 base_url 变了，记得同步改 `config.yaml` 里**两处** `base_url`

## 7. 自检

### 7.0 先拿到 Bearer（四个来源，按优先级）

反代的 Bearer 取值顺序（`workbuddy-proxy.mjs` 启动段）：

| 顺序 | 来源 | 备注 |
|---|---|---|
| 1 | 环境变量 `WORKBUDDY_PROXY_BEARER` | 启动进程时用的那个值，优先级最高 |
| 2 | `server\config.json` 的 `bearerToken` | 写死在配置里 |
| 3 | 状态文件里上一次的 `bearer` | **重启会复用它**，不会变更 |
| 4 | 自动生成 32 字节 hex | 只在上面三个都没有时发生，生成后同样写回状态文件 |

由此得到两条关键推论：

- **正常重启 Bearer 不变**。所以「重启后突然 401 invalid_bearer」几乎只可能是
  `.env` 里写的是旧值、或你改了 `config.json`/环境变量、或删过状态文件——
  不是"重启导致的"。
- 反代校验是严格字符串比较，任何不是同一个字节序列的值（包括 Hermes 兜底的
  `no-key-required`）都返回 `401 invalid_bearer`。

读状态文件的 Bearer：

```powershell
$sf = Join-Path ($(if($env:DSH_HOME){$env:DSH_HOME}else{"$env:USERPROFILE\.dsh"})) ".workbuddy-proxy.json"
$b  = (Get-Content $sf -Raw | ConvertFrom-Json).bearer
$b
```

期望：一段 64 位 hex。`Test-Path $sf` 为 `False` → 反代还没启动过，或启动时用了
1/2 两个来源（那样不写状态文件的 Bearer 也可以工作，但请自己记住值）。

### 7.1 `/healthz`（不要 Bearer）

```powershell
Invoke-RestMethod http://127.0.0.1:8788/healthz
```

期望：`{ ok: true, status: "ok", uptime_s: <秒> }`。这个端点只证明**进程活着**，
不证明登录态有效。

### 7.2 `/v1/auth/status`（要 Bearer，脱敏）

```powershell
$b = "<你的 Bearer>"
Invoke-RestMethod http://127.0.0.1:8788/v1/auth/status -Headers @{ Authorization = "Bearer $b" }
```

期望字段：`source`（凭证来源）、`has_uid`、`domain`、`expiresAtMs`、`remainingMs`、
`has_refresh_token`、`upstream`。`remainingMs` 接近 0 说明登录态快过期。

### 7.3 `/v1/models`（要 Bearer）

```powershell
Invoke-RestMethod http://127.0.0.1:8788/v1/models -Headers @{ Authorization = "Bearer $b" } |
  Select-Object -ExpandProperty data | Select-Object id, context_window, max_tokens, supports_images
```

返回 OpenAI 形状 `{ object: "list", data: [ { id, object, created, owned_by, name,
context_window, max_tokens, supports_images } ] }`。这里的 `id` 就是 `model.name`
该写的值。

### 7.4 冒烟一发

```powershell
$body = @{ model = "<model-id>"; messages = @(@{ role = "user"; content = "ping" }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod http://127.0.0.1:8788/v1/chat/completions -Method Post `
  -Headers @{ Authorization = "Bearer $b" } -ContentType "application/json" -Body $body
```

期望：`choices[0].message.content` 非空。`401/402/429/502` 按 §11 处置。

### 7.5 反代起不来（启动期三个失败信号）

| 现象 | 原因 | 动作 |
|---|---|---|
| stderr `监听失败：EADDRINUSE`，退出码 `2` | 端口被占用 | 换 `config.json` 的 `port`，同步改 `config.yaml` 两处 `base_url`；或按 6.2.1 杀占用者 |
| 提示「找不到 WorkBuddy 凭证」类信息后退出 | 四个凭证来源全空 | 登录 App，或设 `WORKBUDDY_PROXY_TOKEN` / `WORKBUDDY_AUTH_FILE` |
| 进程在但 `/v1/models` 502「模型目录不可用」 | 凭证在但上游拒绝/目录拉不下来 | 回到 §7.0 核对 Bearer，再按 §11 的 session_dead 处置 |

### 7.6 诊断：为什么系统读不到登录态

表现是反代启动就退出、提示「找不到 WorkBuddy 凭证」，但 App 里明明登录着。这时先跑
诊断脚本定位，再决定处置。

```powershell
& "C:\Program Files\nodejs\node.exe" D:\Hermes\skills\workbuddy-reverse-proxy\server\inspect-vault.mjs
```

**这是只读诊断**：只读取并分类各凭证来源，不打印 token 内容（只输出长度与 4 位前缀）。
不改文件、不发网络请求。

预期输出：`{ "active": "<命中的来源名或 null>", "sources": [ ... ] }`，
`sources` 里**每个凭证来源一行**，对应反代的四级优先级：

| `name` | 对应来源 |
|---|---|
| `env-token` | 环境变量 `WORKBUDDY_PROXY_TOKEN` |
| `own-copy` | `D:\dsh\.workbuddy-auth.json` |
| `env-auth-file` | 环境变量 `WORKBUDDY_AUTH_FILE` 指向的文件 |
| `desktop-app-local` / `desktop-app-roaming` | App 登录态 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info` |

每行的 `kind` 是四种分类之一：

| `kind` | 含义 |
|---|---|
| `absent` | 该来源不存在（文件没有 / 变量没设） |
| `plaintext` | 明文凭证，可直接用 |
| `encrypted-envelope-version` | 5.6+ 信封加密态，脚本会尝试解密并报 `decrypt` 结果 |
| `unrecognized` | 存在但形状不认识（例如版本号不是 1） |

信封态那一行还会带 `decrypt: { ok: bool, ... }`。`ok: false` 时 `error` 给出**原因类别**，
对照下表：

| 原因类别（`error` 里的措辞） | 含义 |
|---|---|
| `找不到 Electron 可执行文件` | 找不到 WorkBuddy 的 Electron 二进制，守护密钥无从取得 |
| `binding 不为对象` / `binding 输出不是 JSON 对象` | 二进制能跑但取密钥的 binding 没返回预期结构 |
| `payload 校验失败：...` | 取回了密钥容器但内容不合法（version 不是 1 / `atRestSecretKey` 非规范 32 字节 base64 / 全零） |
| `AES-GCM 认证失败` | 拿到了密钥但解不开密文（格式不匹配或密钥不对） |

**处置：命中「`encrypted-envelope-version` + 解不出」时，这是环境限制，不是配置错误。**

信封态的守护密钥只能从 WorkBuddy 的 Electron 二进制里取：

```
process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()
```

二进制不可读（ACL / 沙箱 / 安装形态不同）就取不到密钥，也就解不开信封。此时改
`config.json`、改 `.env`、重装反代都没用——这跟"配置写错了"是两回事。

**绕行路径**（唯一有效的一条）：直接给反代 token，让它绕开全部文件探测。

```powershell
$env:WORKBUDDY_PROXY_TOKEN = "<从 WorkBuddy App 内取的 accessToken>"
& "C:\Program Files\nodejs\node.exe" D:\Hermes\skills\workbuddy-reverse-proxy\server\workbuddy-proxy.mjs
```

`WORKBUDDY_PROXY_TOKEN` 是反代凭证优先级**最高**的一级（高于 `D:\dsh\.workbuddy-auth.json`、
`WORKBUDDY_AUTH_FILE`、App 登录态），所以设了它就不再触碰信封解密路径。取 token 的
位置视 App 版本而定，本文不臆测具体入口。

绕行后的验证：回到 §7.2 `/v1/auth/status`，`source` 应显示为环境变量来源。

## 8. 在 Hermes 里切换

- 运行时：`/model` → 选 `custom:workbuddy` → 再选具体模型 id。
- 永久：把 `config.yaml` 的 `model.name` 改掉（或把整个 `model:` 段指到 workbuddy）。
- 切回去：把 `model.provider` / `model.base_url` / `model.name` 恢复成原来的
  bundled 值（本机当前是 `provider: deepseek`、`base_url: https://api.deepseek.com`、
  `name: deepseek-v4-flash`）。

## 9. 回滚

1. 停反代（见 6.2 / 6.2.1）。
2. `config.yaml`：删掉 `providers.workbuddy` 整段，`model` 恢复原值。
   （改前先 `Copy-Item D:\Hermes\config.yaml D:\Hermes\config.yaml.bak.<时间戳>`。）
3. `.env`：删掉 `WORKBUDDY_API_KEY=` 那一行（`env_loader.py:488` 是 `override=True`，
   留着会污染同名变量）。
4. 可选：删 `$DSH_HOME\.workbuddy-proxy.json` 让下次启动重新生成 Bearer
   （删了就要同步更新 `.env`）。
5. 可选：删 `D:\Hermes\provider_models_cache.json` 里 workbuddy 相关缓存条目。

## 10. 代理没起时会怎样

| 位置 | 现象 |
|---|---|
| Hermes 启动 | 正常启动。没有 provider 插件，就不会有 import 期失败；`custom:workbuddy` 只是发请求时失败 |
| 发消息 | 连接被拒（`ECONNREFUSED`），请求失败，提示连不上 `127.0.0.1:8788` |
| `/model` | 目录探测失败 → 列表为空或退回静态声明 → 手写 `model.name` 仍可发请求 |
| context_length | 探测不到 → 退回 `context_length_cache.yaml` → 再退回 `128000` 并告警（`model_metadata.py:282`） |
| `/healthz` | 连接被拒 |
| Hermes doctor | 本方案不装 profile，`supports_health_check` 不参与；不会因反代没起而被 doctor 报死 |

## 11. 故障处置表

| 症状 | 真实原因 | 处置 |
|---|---|---|
| `401 invalid_bearer` | Hermes 发的 Bearer 与反代持有的不一致。**反代正常重启会复用状态文件里上次的 bearer**（见 §7.0），所以「重启后就 401」基本不是重启的锅，而是：`.env` 里是旧值 / 改过 `WORKBUDDY_PROXY_BEARER` 或 `config.bearerToken` / 删过状态文件导致重新生成 | 按 §7.0 读当前 bearer（默认在 `%USERPROFILE%\.dsh\.workbuddy-proxy.json`），把 `.env` 的 `WORKBUDDY_API_KEY` 更新成同一个值，重启 Hermes 会话 |
| `401 workbuddy_session_dead` | 上游登录态失效（App 退出登录 / 被踢 / 刷新失败） | 打开 WorkBuddy 桌面 App 重新登录，再打一次 `/v1/auth/status` 看 `has_refresh_token` 与 `remainingMs`；仍失败则检查 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info` 是否存在 |
| `402 workbuddy_credit_exhausted` | 订阅额度/积分耗尽 | 去 App 里看额度；这不是接线问题，改配置没用 |
| `429` | 上游限频 | 降并发/加退避重试；持续则换模型或换时段。Hermes 侧可加大 `providers.workbuddy.rate_limit_delay` |
| `502 workbuddy_upstream` | 反代→上游链路问题（连不上、返回不可解析、流中断、模型目录不可用） | 看反代 stdout/stderr 日志；核对 `server\config.json` 的 `upstreamBase`；`/v1/models` 也 502 说明是凭证/上游整体不可用而非单个模型 |
| `502` 且日志写「模型目录不可用」 | `/v1/models` 拉目录失败 | 多半是登录态问题，回到 `401 workbuddy_session_dead` 的处置 |
| 反代进程启动即退出，stderr `监听失败：EADDRINUSE`，**退出码 `2`** | 端口 8788 被占用（常见于上一次的后台实例没杀干净） | 改 `config.json` 的 `port`（并同步 `config.yaml` 两处 `base_url`），或按 §6.2.1 的 `netstat -ano | findstr ":8788"` 找出 PID 后 `taskkill /PID <pid> /T /F` |
| 反代进程启动即退出，提示找不到凭证 | `WORKBUDDY_PROXY_TOKEN` / `D:\dsh\.workbuddy-auth.json` / `WORKBUDDY_AUTH_FILE` / App 登录态四个来源全空，或 App 登录态是解不开的信封加密态 | 登录 App；或直接 `$env:WORKBUDDY_PROXY_TOKEN="<token>"` 绕开信封解密 |
| 请求超时 | 反代在等上游首字节 | 先 `/healthz` 确认进程在；再 `/v1/auth/status` 确认凭证；必要时提高 `providers.workbuddy.request_timeout_seconds`（这是 Hermes 侧配置项，反代 config.json **没有**这个键） |
| **`502` 且响应体为空**（`content-length: 0`、`connection: close`），反代日志里**没有**对应记录 | **Windows 系统代理回环**：客户端（`httpx`/`openai`/Node）`trust_env` 默认开启，读的是**系统代理**（注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyServer`，而不仅是 `HTTP_PROXY` 环境变量），把发往 `127.0.0.1:8788` 的请求交给代理，代理再回环到本机 | **判别**：同一条请求用 `Invoke-WebRequest` / `curl` 成功、用 Python/Node 客户端 502 → 就是它。**修**：在 `D:\Hermes\.env` 追加 `NO_PROXY=127.0.0.1,localhost` 与 `no_proxy=127.0.0.1,localhost`。`ProxyOverride` 里的 `127.*` 只对 WinINET 客户端生效，Python 侧不读，所以必须设 `NO_PROXY` |
| **回复 `content` 为空字符串**，`finish_reason` 仍是 `stop`，`usage.completion_tokens` 恰好等于请求的 `max_tokens` | 该上游模型先产出思考过程再产出正文，预算过小（如 `max_tokens=64`）时令牌被思考过程吃光；上游不返回 `reasoning_content` 字段 | 提高 `max_tokens` 重试（实测 `200` 即可产出正文）。判定式：`content == "" && completion_tokens == max_tokens` |
| 诊断（`inspect-vault.mjs`）说「找不到 WorkBuddy 可执行文件」，但反代实际运行正常 | 两者定位主程序的方式不同：反代走 `reg.exe` 查 `DisplayIcon`（`reg.exe` 可用时能找到非默认盘符的安装，如 `D:\wkb\WorkBuddyAI\WorkBuddyAI.exe`）；受限沙箱下 `spawnSync reg.exe` 会 `EPERM`，此时诊断应报「无法探测」而非「找不到」 | 设 `WORKBUDDY_EXE=<主程序完整路径>`，两份脚本都支持，直接跳过全部自动探测 |
| `内容` 乱码但文件本身正常 | 仅是 PowerShell 控制台按 GBK 解码的显示假象 | 用 UTF-8 方式读取复核（文件是无 BOM 的 UTF-8），不要因此改写文件 |

## 12. 为什么不用 provider 插件（形态 1）

本方案**不**往 `plugins\model-providers\workbuddy\` 放 profile，理由：

1. **base_url 优先级错了**：插件 profile 的 `base_url` 只排在 `providers.<key>.base_url`
   之后、`model.base_url` 之前（`runtime_provider.py` 约 `1040-1160`）。插件能做的
   事，`providers.<key>.base_url` 都能做，而且优先级更高——插件在这个维度上没有额外收益。
2. **api_key 优先级更弱**：profile 的 `env_vars` 只排第 3（`auth.py:605-610`），
   仍然要为它准备环境变量；与其同时维护插件目录 + 环境变量，不如只维护 `key_env`。
3. **发现顺序脆弱**：`providers/__init__.py:140-191` 依次加载
   `hermes-agent/plugins/model-providers` → `$HERMES_HOME/plugins/model-providers`
   → 旧式 `providers/<name>.py`，last-writer-wins。任何一次 `hermes update`、一次
   同名内置 profile 新增，都可能改变最终生效的对象；而且加载失败只 `logger.warning`，
   provider 会**静默消失**，排查成本高。
4. **多一个 import 期故障面**：插件模块在 Hermes 启动链上被 exec，任何异常都会吞掉；
   `custom:` + config.yaml 没有这个风险。
5. **`reasoning_effort` 映射不需要插件**：如果确实需要改写 reasoning 形状，优先用量最小
   的方式验证（`extra_body` 配置项），而不是为了一个字段值的换算去装插件。

结论：`custom:workbuddy` 一条 config.yaml 路径已经覆盖全部需求，插件版没有剩余价值。

## 13. 安全边界

- 反代只监听 `127.0.0.1`，不对外暴露。
- `.env` 里的 Bearer 是**本机反代的**口令，不是 WorkBuddy 账号密码；但它足以让人在
  本机调用你的订阅额度——不要提交到 git、不要贴进聊天。
- `$DSH_HOME\.workbuddy-proxy.json` 明文保存 Bearer，注意文件权限。
- 反代不做多用户隔离：任何能访问 127.0.0.1 的本机进程（只要拿到 Bearer）都能用你的号。
