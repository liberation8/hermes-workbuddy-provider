---
name: workbuddy-reverse-proxy
description: "Turn the WorkBuddy AI desktop app's login state into a local OpenAI-compatible endpoint (127.0.0.1:8788) and wire it into Hermes as a custom provider. Use when you want Hermes (or any OpenAI client) to run on WorkBuddy AI subscription models without an API key."
version: 1.0.0
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

读法约定：本文命令后面写「预期」的是**输出形状**，不是保证值。若实际输出与预期
不符，一律按本文「故障处置」→ `references/hermes-wiring.md` §11 故障处置表查。

## 本 skill 不做的事

- 不实现反代本身（那是 `server/` 的职责，本 skill 只负责安装与接线）
- 不写 WorkBuddy 的私有协议细节到 Hermes 里（`X-Conversation-*` 等头全部由反代负责）
- 不动 `D:\Hermes\hermes-agent`（Hermes 自身源码只读）

## 安装（5 步）

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

## 日常操作

- 启动/停止：见第 3 步与 `references/hermes-wiring.md` §6（含后台 `Start-Process`、
  按端口 kill）。
- 关注两个会漂的东西：
  1. **端口**：反代默认 `8788`；若被占用会以退出码 `2` 结束（EADDRINUSE），
     改 `config.json` 的 `port` 后要同步改 `config.yaml` 里**两处** `base_url`。
  2. **Bearer**：正常重启会**复用**状态文件里上一次的 bearer，不会变；只有在
     显式设置了 `WORKBUDDY_PROXY_BEARER` / `config.bearerToken`、或删掉状态文件时才会
     变。变了就要同步 `.env`。
- 看日志：前台直接看 stdout/stderr；计划任务/自启拉起的实例看
  `D:\dsh\logs\workbuddy-proxy.out.log` 与 `.err.log`。
- 换模型：`/model` 临时切，或改 `config.yaml` 的 `model.name` 永久切。

## 反代会静默退出（实测踩过，必看）

反代是**普通前台进程**，没有守护。它会以三种方式消失，而且**不会留下任何报错**：

| 消失方式 | 现象 | 判断依据 |
|---|---|---|
| 宿主/父进程被清理 | 8788 不再监听 | `Get-NetTCPConnection -LocalPort 8788 -State Listen` 为空 |
| 机器休眠/重启 | 重启后全没 | 同上 |
| 被「清理 node 进程」误伤 | 同上 | 同上 |

**最坑的地方**：Hermes 侧 `config.yaml` 和 `.env` 都还在，所以症状不是
「配置没了」，而是**每次对话都超时或 502**，很容易误判成上游挂了或额度用完了。

### 三步自诊（30 秒）

```powershell
# 1. 进程在不在
Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue

# 2. 活着就问候一下（免鉴权）
Invoke-WebRequest http://127.0.0.1:8788/healthz -TimeoutSec 5 -UseBasicParsing

# 3. 刚死是怎么死的（只在你用自启脚本拉起时有内容）
Get-Content D:\dsh\logs\workbuddy-proxy.err.log -Tail 20
```

`/healthz` 返回 `{"ok":true,...}` 而 Hermes 仍报错 → 问题不在反代，去查
`WORKBUDDY_API_KEY` 与状态文件的 bearer 是否一致。

### 一键拉起（幂等，已在跑就跳过）

```powershell
& "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\workbuddy-proxy-autostart.cmd"
```

它做了三件事：检测 8788 是否已监听（已监听则记一行 skip 直接退出）→ 超过
5 MB 的日志轮转为 `.1` → 后台拉起并把输出写进 `D:\dsh\logs\`。

### 让它开机自启（推荐）

安装：把 `server\autostart.cmd` 复制到用户启动目录

```powershell
Copy-Item "D:\Hermes\skills\workbuddy-reverse-proxy\server\autostart.cmd" `
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\workbuddy-proxy-autostart.cmd"
```

卸载：删除该文件，或运行 `server\uninstall-autostart.cmd`（**不会**停掉正在运行的实例）。

验证自启是否生效：**下次登录后**先看 `Get-NetTCPConnection -LocalPort 8788`，
再看 `D:\dsh\logs\autostart.log` 里有没有当天的 `starting workbuddy-proxy`。

> 两个实现细节，改脚本时别踩：
> 1. `autostart.cmd` **必须是纯 ASCII**。中文注释在 `.cmd` 里会按 OEM 代码页解析，
>    把后面的命令拆坏（实测报 `'rse-proxy' is not recognized`）。
> 2. 跳过记录写进**独立**的 `autostart.log`，不要写 `workbuddy-proxy.out.log`——
>    运行中的实例持有那个文件的追加句柄，再写会报
>    `The process cannot access the file because it is being used by another process`。

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
