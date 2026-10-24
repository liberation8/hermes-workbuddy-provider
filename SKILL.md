---
name: workbuddy-reverse-proxy
description: "Turn the WorkBuddy AI desktop app's login state into a local OpenAI-compatible endpoint (127.0.0.1:8788) and wire it into Hermes as a custom provider. Use when you want Hermes (or any OpenAI client) to run on WorkBuddy AI subscription models without an API key."
version: 1.2.0
author: Hermes Agent
license: MIT
platforms: [windows]
metadata:
  hermes:
    tags: [WorkBuddy, reverse-proxy, provider, OpenAI-compatible, local]
    related_skills: []
prerequisites:
  commands: [node]
---

# WorkBuddy 反代（本机 OpenAI 兼容端点）

把 WorkBuddy AI 桌面 App 的登录态逆向成本机 OpenAI 兼容端点，供 Hermes 使用。
上游没有公开 API、没有 API key——鉴权就是桌面 App 的登录态；本 skill 用一个本地
Node 服务把它包成 `POST /v1/chat/completions`，再把 Hermes 的 `custom:workbuddy`
provider 指向它。

- 反代服务：`server\workbuddy-proxy.mjs`（Node，监听 `127.0.0.1:8788`）
- 契约细节：`references/upstream-protocol.md`
- Hermes 侧接线（唯一的接线主线）：`references/hermes-wiring.md`
- 启停：Hermes 状态栏右侧的「反代 开/关」按钮（插件 `workbuddy-switch`，见下文
  「在 Hermes 里开关反代」）；无界面时用 `server\autostart.cmd` 兜底

读法约定：本文命令后面写「预期」的是**输出形状**，不是保证值。若实际输出与预期
不符，一律按本文「故障处置」→ `references/hermes-wiring.md` §11 故障处置表查。

## 本 skill 不做的事

- 不实现反代本身（那是 `server/` 的职责，本 skill 只负责安装与接线）
- 不写 WorkBuddy 的私有协议细节到 Hermes 里（`X-Conversation-*` 等头全部由反代负责）
- 不动 `D:\Hermes\hermes-agent`（Hermes 自身源码只读）

## 安装（6 步）

### 1. 落地 server 目录并跑自检

把交付物里的 `server\` 整个复制到 `D:\Hermes\skills\workbuddy-reverse-proxy\server\`，
然后运行端到端自检（自带 mock 上游，不需要真登录态，不产生外网调用）：

```powershell
& "C:\Program Files\nodejs\node.exe" D:\Hermes\skills\workbuddy-reverse-proxy\server\verify-proxy.mjs
```

预期：逐行打印 `PASS  <检查项名>` / `FAIL  <检查项名>  → <细节>`，末尾一行汇总
`PASS <n>/<N>  FAIL <k>`，进程退出码为 `0`（全 PASS）或 `1`（有 FAIL）。
判定标准：**`FAIL 0`**，且退出码 `0`。

- 退出码 `1` 或有 `FAIL` 行 → 先看该行的 `→` 后细节，再按
  `references/hermes-wiring.md` §11 查。
- 报 `Cannot find module` → 第 1 步的复制没做全，`server\` 目录不完整。
- 自检不碰真上游，所以它全绿**只证明反代代码本身正常**，不证明你的登录态可用；
  登录态要看第 3 步的 `/v1/auth/status`。

### 2. 准备配置

```powershell
Copy-Item D:\Hermes\skills\workbuddy-reverse-proxy\server\config.example.json `
          D:\Hermes\skills\workbuddy-reverse-proxy\server\config.json
```

预期：命令无输出，`Test-Path ...\server\config.json` 返回 `True`。

最小可跑配置只需要「配置能解析」这一件事——所有键都有内置默认值
（`port` 默认 `8788`、`host` 固定 `127.0.0.1`、`upstreamBase` 有默认值），
配置缺失或 JSON 损坏时会回落默认值继续运行，**不会因为 config.json 报错**。
字段全集见 `references/upstream-protocol.md`。
配置也可用环境变量 `WORKBUDDY_PROXY_CONFIG` 指向别的 json。

### 3. 启动反代并确认健康

前台（调试首选，Ctrl+C 停）：

```powershell
& "C:\Program Files\nodejs\node.exe" D:\Hermes\skills\workbuddy-reverse-proxy\server\workbuddy-proxy.mjs
```

预期 stdout 一行 JSON：
`{"ts":"<ISO>","event":"listening","host":"127.0.0.1","port":8788,"source":"<凭证来源>"}`。
若 Bearer 是本次自动生成的，stderr 会多一行 `已生成 Bearer：<token>`。

拿到 Bearer（自动生成时在状态文件里）：

```powershell
$sf = Join-Path ($(if($env:DSH_HOME){$env:DSH_HOME}else{"$env:USERPROFILE\.dsh"})) ".workbuddy-proxy.json"
(Get-Content $sf -Raw | ConvertFrom-Json) | Select-Object bearer, port, host
```

预期：输出 `bearer`（64 位 hex）、`port`、`host`。找不到该文件 → 见
`references/hermes-wiring.md` §7.4（Bearer 的四个来源）。

存活自检（**不需要 Bearer**）：

```powershell
Invoke-RestMethod http://127.0.0.1:8788/healthz
```

预期：`{ ok: True, status: "ok", uptime_s: <整数> }`。

登录态自检（**需要** Bearer，脱敏）：

```powershell
$b = (Get-Content $sf -Raw | ConvertFrom-Json).bearer
Invoke-RestMethod http://127.0.0.1:8788/v1/auth/status -Headers @{ Authorization = "Bearer $b" }
```

预期字段：`source` / `has_uid` / `domain` / `expiresAtMs` / `remainingMs` /
`has_refresh_token` / `upstream`。`remainingMs` 很小或 `has_refresh_token` 为 `False`
→ 提前去 App 重登，别等它坏。
若返回 `401 invalid_bearer` → `$b` 取错了，回到本节第一步重新取。

### 4. 确认模型目录

```powershell
Invoke-RestMethod http://127.0.0.1:8788/v1/models -Headers @{ Authorization = "Bearer $b" } |
  Select-Object -ExpandProperty data | Select-Object id, context_window, max_tokens, supports_images
```

预期：OpenAI 形状 `{ object: "list", data: [ {id, object, created, owned_by, name,
context_window, max_tokens, supports_images} ] }`，`data` 非空。

- 这里列出的 `id` 就是 Hermes `model.name` 该写的值（也可以加 `workbuddy/` 前缀）。
- `context_window` 是上游给的上下文长度，是**你自己机器上的权威值**；需要静态锁定时
  把它抄进 `providers.workbuddy.models.<id>.context_length`（示范见
  `references/hermes-wiring.md` §4.2）。
- `data` 为空或 `502 workbuddy_upstream`（日志写「模型目录不可用」）→ 多半是登录态
  问题，回到第 3 步。
- 模型 id 会漂移，每次升级前重跑一次本节。

### 5. 接线 Hermes

照 `references/hermes-wiring.md` §1 改 `D:\Hermes\config.yaml`（`custom:workbuddy`
+ `providers.workbuddy` 段）与 `D:\Hermes\.env`（`WORKBUDDY_API_KEY=<上一步的 bearer>`），
然后用 `/model` 切换。

预期：`/model` 里能看到 `custom:workbuddy` 及其模型列表；选它之后发一条消息能正常
返回。若报 `401 invalid_bearer` → `.env` 的 key 与状态文件的 `bearer` 不是同一个值。

**必须给 `key_env` 真值**：Hermes 拿不到 key 时会发送字面量 `no-key-required`，
反代严格比较必然 401（见 `references/hermes-wiring.md` §2）。

### 6. 装 Hermes 内的开关插件（可选但推荐）

不做这步也能用，只是每次都得敲 `autostart.cmd`。做了就有状态栏按钮。

```powershell
# 1. 后端插件（管进程）+ Web 面板
Copy-Item -Recurse -Force <交付物>\workbuddy-switch\plugins\workbuddy-switch D:\Hermes\plugins\

# 2. 桌面端状态栏按钮（注意：只拷 plugin.js，test\ 与桩不需要）
New-Item -ItemType Directory -Force D:\Hermes\desktop-plugins\workbuddy-switch | Out-Null
Copy-Item -Force <交付物>\workbuddy-switch\desktop-plugins\workbuddy-switch\plugin.js `
  D:\Hermes\desktop-plugins\workbuddy-switch\plugin.js
```

3. 往 `D:\Hermes\config.yaml` **追加**白名单（先备份；已有 `plugins:` 键就只加列表项）：

```yaml
plugins:
  enabled:
    - workbuddy-switch
```

4. **重启 Hermes**。判据：`D:\Hermes\logs\gui.log` 出现
   `Mounted plugin API routes: /api/plugins/workbuddy-switch/`；界面里按
   **`Ctrl+Shift+S`** 打开状态栏（默认是收起的），右侧出现「反代 开/关」。

> 三个坑：`plugins/<name>/` **必须有 `__init__.py` 和 `plugin.yaml`**，否则插件
> 目录加载器会把整个目录当成 category 或直接抛 `FileNotFoundError`；
> `hermes plugins install` 只支持 git URL、装不了本地目录，只能手动拷；
> 装完不重启一律不生效（后端插件发现是进程内缓存）。

## 日常操作

- 启动/停止：**点 Hermes 状态栏右侧的「反代 开/关」按钮**（状态栏默认收起，
  先按 `Ctrl+Shift+S` 打开；见下文「在 Hermes 里开关反代」）。
  没有界面时用命令行兜底：`cmd /c "D:\Hermes\skills\workbuddy-reverse-proxy\server\autostart.cmd"`
  （幂等，已在跑就跳过）；手工前台跑与按端口 kill 见 `references/hermes-wiring.md` §6。
- 关注两个会漂的东西：
  1. **端口**：反代默认 `8788`；若被占用会以退出码 `2` 结束（EADDRINUSE），
     改 `config.json` 的 `port` 后要同步改 `config.yaml` 里**两处** `base_url`。
  2. **Bearer**：正常重启会**复用**状态文件里上一次的 bearer，不会变；只有在
     显式设置了 `WORKBUDDY_PROXY_BEARER` / `config.bearerToken`、或删掉状态文件时才会
     变。变了就要同步 `.env`。
- 看日志：前台直接看 stdout/stderr；由插件或 `autostart.cmd` 拉起的实例看
  `D:\dsh\logs\workbuddy-proxy.out.log` 与 `.err.log`。
- 换模型：`/model` 临时切，或改 `config.yaml` 的 `model.name` 永久切。

## 反代会静默退出（实测踩过，必看）

反代是**普通前台进程**，没有守护。它会以三种方式消失，而且**不会留下任何报错**：

| 消失方式 | 现象 | 判断依据 |
|---|---|---|
| 宿主/父进程被清理 | 8788 不再监听 | `netstat -ano \| findstr ":8788"` 里没有 LISTENING 行 |
| 机器休眠/重启 | 重启后全没 | 同上 |
| 被「清理 node 进程」误伤 | 同上 | 同上 |

**最坑的地方**：Hermes 侧 `config.yaml` 和 `.env` 都还在，所以症状不是
「配置没了」，而是**每次对话都超时或 502**，很容易误判成上游挂了或额度用完了。

### 三步自诊（30 秒）

```powershell
# 1. 进程在不在（用 netstat，不要用 Get-NetTCPConnection —— 它漏报跨权限层监听）
netstat -ano | findstr ":8788" | findstr LISTENING

# 2. 活着就问候一下（免鉴权，这才是权威判据）
Invoke-WebRequest http://127.0.0.1:8788/healthz -TimeoutSec 5 -UseBasicParsing

# 3. 刚死是怎么死的（自启脚本拉起时才有内容）
Get-Content D:\dsh\logs\workbuddy-proxy.err.log -Tail 20
```

`/healthz` 返回 `{"ok":true,...}` 而 Hermes 仍报错 → 问题不在反代，去查
`WORKBUDDY_API_KEY` 与状态文件的 bearer 是否一致。

### 一键拉起（幂等，已在跑就跳过）

```powershell
cmd /c "D:\Hermes\skills\workbuddy-reverse-proxy\server\autostart.cmd"
```

它做四件事：`/healthz` 探活（活着就记一行 skip 直接退出）→ 超过 5 MB 的日志
轮转为 `.1` → 写一个 `run-proxy.cmd` 启动器并后台拉起 → 轮询 `/healthz`
最多 30 秒确认真的起来了，起不来重试一次。**脚本自己会在 4 秒内返回**，不会
挂住调用方。

### 在 Hermes 里开关反代（推荐）

反代做成 Hermes 插件，状态栏右侧常驻一个「反代 开 / 反代 关」按钮，点一下就切换。
**这是首选方式**：开关的副作用只落在反代进程上，不碰系统级自启。

> 历史：这里曾经用 Windows **计划任务**做开机自启，实测副作用太大（登录即拉起、
> 跨权限层停不掉、卸载还得管理员），已改为插件开关。计划任务方案仅作历史保留，
> 新装不要再建。

#### 它装了什么

两处目录，缺一不可：

| 路径 | 角色 |
|---|---|
| `D:\Hermes\plugins\workbuddy-switch\` | Python 后端（`dashboard\plugin_api.py`，管进程）+ Web 面板（`dashboard\dist\index.js`） |
| `D:\Hermes\desktop-plugins\workbuddy-switch\plugin.js` | 桌面端状态栏按钮 |

外加 `D:\Hermes\config.yaml` 末尾一行白名单——**user 插件必须在 `plugins.enabled` 里才会被加载**：

```yaml
plugins:
  enabled:
    - workbuddy-switch
```

#### 接口契约

挂在 `/api/plugins/workbuddy-switch` 下，四个端点全部**幂等**、恒返回 HTTP 200：

| 端点 | 语义 |
|---|---|
| `GET /status` | 只读探测，不改状态 |
| `POST /start` | 已在跑就直接返回现状 |
| `POST /stop` | 没在跑也返回成功 |
| `POST /toggle` | 翻转后返回**新**状态 |

响应体九个字段：`ok / running / pid / port / uptimeS / nodePath / proxyScript / logPath / error`。
**存活判定一律以 `GET /healthz` 为准**，不看端口表——这台机器上 `netstat` 会漏报
跨权限层的监听（见「反代会静默退出」）。

#### 生效条件：必须重启 Hermes

后端在模块加载时就扫描插件目录并**固化在进程内缓存**里（`_get_dashboard_plugins`），
装完不重启，路由表里根本没有 `/api/plugins/workbuddy-switch/*`。判据：

```powershell
Select-String -Path D:\Hermes\logs\gui.log -Pattern "Mounted plugin API routes" |
  Select-Object -Last 5
```

出现 `Mounted plugin API routes: /api/plugins/workbuddy-switch/` 才算挂上了。

#### 状态栏默认是关的（第一次看不到按钮不是 bug）

Hermes 桌面端的整条状态栏是**opt-in**的（`store\statusbar-prefs.ts:10`
`$statusbarVisible` 默认 `false`），关着时整个栏不渲染，按钮自然也不在。
第一次打开用快捷键 **`Ctrl+Shift+S`**（动作 id `view.toggleStatusbar`，
`keybinds\actions.ts:115` 的默认值 `mod+shift+s`），或 ⌘K 里搜「切换状态栏」。
栏出来之后按钮会一直留在右下角，点击即切换。

#### 临时停用 / 卸载

- 临时停用：把 `config.yaml` 里 `workbuddy-switch` 从 `plugins.enabled` 删掉，重启 Hermes。
- 彻底卸载：删上面两个目录 + 那行白名单，重启。
- **插件开关关掉的只是反代进程**，Hermes 的 provider 配置不动——关掉后请求失败是预期行为。

### 2026-10-24 修掉的三个自启缺陷（改脚本前必读）

那天症状是「Hermes 里模型列表空了」。根因不在反代也不在模型——**进程根本不存在**：
10-18 手动 Ctrl+C 停掉后（`err.log` 只留一个 `^C`），机器一直没重启，10-24 只有一次
新登录会话，而计划任务那天返回 `0x0` 却什么都没做。三个独立缺陷叠在一起：

1. **存活检查误判**。原来用
   `netstat -ano | findstr "127.0.0.1:8788" | findstr "LISTENING"` 判断「已在跑」，
   命中就 `exit /b 0` 什么也不做。那天它判定「已监听」而实际无人监听。而且这台机器
   上 `netstat` 对跨权限层的监听会漏报（另一次实测），端口表本就不能当存活依据。
   **现在改成请求 `/healthz`，返回 200 才算活着。**
2. **日志路径是字面量**。原来写 `set "LOGDIR=$DSH_HOME\logs"`——批处理只展开
   `%VAR%`，`$DSH_HOME` 是字面量，于是日志被写到**当前工作目录**下的 `$DSH_HOME\logs\`。
   这就是「任务跑了但日志没动」的真相。**现已改为 `%DSH_HOME%`，未定义时回退
   `D:\dsh\logs`。**
3. **前台阻塞**。原来 `"%NODE%" "%PROXY%" 1>> ...` 是前台运行，注释写明当初是为了
   不丢退出码。代价是：**代理活着，脚本就永不返回**，计划任务永远处于「运行中」，
   `RestartCount` 和重试逻辑全部失效。**现在改成「写启动器 → 后台拉起 → 轮询
   `/healthz` 确认」，脚本 4 秒内返回。**

> 后台化的三种写法都实测过，只有第三种能用：
> - `Win32_Process.Create`：返回 PID，但宿主一退出子进程立刻被回收（实测 rc=255，
>   node 2.4 秒内消失）。**不可用。**
> - 启动器里直接前台跑 node：node 活着 cmd 就不退出，等于没解决。
> - 启动器里 `start "" /b`：node 独立存活，启动器立刻退出。**只有这条能过。**
>   实测任务 `State=Ready`、`LastTaskResult=0`，而 node 独立在 8788 上服务。

> 两个实现细节，改脚本时别踩：
> 1. `autostart.cmd` **必须是纯 ASCII**。中文注释在 `.cmd` 里会按 OEM 代码页解析，
>    把后面的命令拆坏（实测报 `'rse-proxy' is not recognized`）。
> 2. 跳过记录写进**独立**的 `autostart.log`，不要写 `workbuddy-proxy.out.log`——
>    运行中的实例持有那个文件的追加句柄，再写会报
>    `The process cannot access the file because it is being used by another process`。

### 模型列表为空 ≠ 模型没加载

`/v1/models` 需要本地 Bearer，**不带 `Authorization` 头会直接 401 `invalid_bearer`**，
不是返回空数组。别把 401 误读成「没加载出来」。Bearer 在
`%DSH_HOME%\.workbuddy-proxy.json` 的 `bearerToken` 字段（64 字符）。

```powershell
$j = Get-Content "$env:DSH_HOME\.workbuddy-proxy.json" -Raw | ConvertFrom-Json
$h = @{ Authorization = "Bearer " + $j.bearerToken }
(Invoke-WebRequest http://127.0.0.1:8788/v1/models -Headers $h -UseBasicParsing).Content
```

另注：这台机器上 `pwsh` 在受限沙箱里连 `'hello'` 都起不来（exit code `3221225794`），
所有 shell 探测都要先提权，否则会被误判成「命令失败」。
## 故障处置

逐条动作见 `references/hermes-wiring.md` §11，速查：

| 症状 | 一句话动作 |
|---|---|
| `401 invalid_bearer` | `.env` 的 `WORKBUDDY_API_KEY` ≠ 状态文件的 `bearer`，改成同一个值 |
| `401 workbuddy_session_dead` | 去 WorkBuddy 桌面 App 重新登录 |
| `402 workbuddy_credit_exhausted` | 额度耗尽，改配置无用 |
| `429` | 退避重试 / 降并发 / 换模型 |
| `502 workbuddy_upstream` | 看反代日志分清是「目录不可用」还是单次生成失败 |
| **`502` 且响应体为空** | **系统代理回环**，见下方「系统代理」；`curl`/`Invoke-WebRequest` 正常而 Python/Node 客户端 502 就是它 |
| **回复 `content` 为空、tokens 却吃满** | `max_tokens` 太小被思考过程吃光，见「max_tokens 预算」 |
| 启动即退出、退出码 `2` | 端口被占用（EADDRINUSE），换 `port` |
| 启动即退出、提示找不到凭证 | 先登录 App，或设 `WORKBUDDY_PROXY_TOKEN` / `WORKBUDDY_AUTH_FILE` |
| 诊断说找不到可执行文件、但反代实际能跑 | `reg.exe` 被沙箱拒绝导致探测失败，设 `WORKBUDDY_EXE` |

### 系统代理回环（实测阻塞点，必看）

Windows 开启了系统代理（Clash/verge-mihomo 等，注册表 `ProxyEnable=1`）时，
`httpx`/`openai` 默认 `trust_env=True` 会读取**系统代理**（不只是环境变量），
把发往 `127.0.0.1:8788` 的请求交给代理，代理再回环到本机，最终得到一个
**应答体为空的 502**（`connection: close` + `content-length: 0`）。

识别特征：同一条命令用 `Invoke-WebRequest` 或 `curl` 成功，用 Python/Node
客户端失败——因为前者遵守 `ProxyOverride`，后者不遵守。

修法（二选一，都在 Hermes 侧）：

```powershell
# 方案 A：进程级 NO_PROXY（推荐，改 .env 一处即可）
# 在 D:\Hermes\.env 追加：
NO_PROXY=127.0.0.1,localhost
no_proxy=127.0.0.1,localhost
```

方案 B：在系统代理的 `ProxyOverride` 里确认包含 `127.*`（多数 Clash 默认已含，
但 Python 侧不读它，所以**仍需方案 A**）。

验证：设好后再跑第 3 步的健康检查 + 一次 `chat/completions`，502 消失即生效。

### max_tokens 预算（实测阻塞点）

该上游模型会先产出思考过程再产出正文，`max_tokens` 给太小（如 `64`/`80`）
时正文为空、`finish_reason` 仍是 `stop`、`completion_tokens` 恰好等于
`max_tokens`——**令牌被思考过程吃光**。上游不返回 `reasoning_content` 字段，
这不是反代丢失内容。

判定：`content == ""` 且 `usage.completion_tokens == max_tokens` → 提高预算重试
（实测 `max_tokens=200` 时正文正常）。Hermes 侧不要为这个 provider 设很小的
`max_tokens`。

## 回滚

1. 停反代（第 3 步 Ctrl+C，后台则按端口 `Stop-Process`）。
2. `config.yaml`：删 `providers.workbuddy` 整段，`model` 恢复原值（改前先备份）。
3. `.env`：删 `WORKBUDDY_API_KEY=` 那一行（`.env` 是 `override=True` 载入，留着会污染
   同名变量）。
4. 可选：删状态文件让下次启动重新生成 Bearer（删了要同步更新 `.env`）。
5. 可选：删 `D:\Hermes\provider_models_cache.json` 里 workbuddy 相关缓存。

顺序不能反：先停服务再改配置，否则会拿旧配置发请求、报一堆误导性的 401/502。

## 已知限制

- 上游模型 id 会漂移，本文列出的任何 id 都可能失效；以 `/v1/models` 为准。
- 登录态会过期，过期后必须人工去 App 重登，本 skill 无法自动化这一步。
- 单机单用户：反代只监听 `127.0.0.1`，不做多用户隔离；任何拿到 Bearer 的本机进程
  都能用你的订阅额度。
- Bearer 明文存在 `.env` 与状态文件里，不要提交到 git、不要贴进聊天。
- 若桌面 App 的登录态是信封加密态且本机解不出来，反代会启动失败——此时用
  `WORKBUDDY_PROXY_TOKEN` 直接给 token 绕开。这是**环境限制而非配置错误**，
  诊断方法与原理详见 `references/hermes-wiring.md` §7.6。
- 信封解密需要向 WorkBuddy 主程序（Electron）询问守护密钥。主程序装在非默认
  盘符/路径（如 `D:\wkb\WorkBuddyAI\WorkBuddyAI.exe`）时靠注册表
  `DisplayIcon` 定位；若 `reg.exe` 不可用（受限沙箱、组策略），自动探测会失败，
  设环境变量 `WORKBUDDY_EXE=<可执行文件完整路径>` 直接指定即可。
- Windows 系统代理会拦截出站请求造成空的 502，见「故障处置 → 系统代理回环」。
- **插件停不掉「不是它自己拉起的」反代**。`plugin_api.py` 只能对自有 `Popen`
  句柄 `terminate()`；进程若是别的进程（另一个终端、旧的自启脚本）拉起的，就只剩
  `taskkill` 一条路，而 Hermes 宿主与反代若处在不同完整性层，`taskkill` 会被
  「拒绝访问」。此时 `/stop` 返回 `ok:false` 且 `error` 里写明
  `failed=['<pid>: exit=1 错误: 拒绝访问']` —— 用管理员终端 `taskkill /PID <pid> /T /F`，
  或先关掉那个实例再从插件里启一个「自己的」。
- 插件装完**必须重启 Hermes**才生效（后端插件发现是进程内缓存），见「在 Hermes 里开关反代 → 生效条件」。
