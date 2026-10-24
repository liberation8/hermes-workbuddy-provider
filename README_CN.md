<!-- 顶部视觉 -->
<div align="center">

# Hermes · WorkBuddy Provider

**把 WorkBuddy AI 订阅变成任意 OpenAI 兼容客户端的标准模型后端**

[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![零依赖](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows&logoColor=white)](#-平台支持)
[![Hermes Skill](https://img.shields.io/badge/Hermes-skill-8A2BE2)](SKILL.md)
[![English](https://img.shields.io/badge/README-English-blue)](README.md)
[![Tests](https://img.shields.io/badge/tests-17%2F17%20passed-success)](server/verify-proxy.mjs)

</div>

---

## 一句话说明

WorkBuddy 桌面端把登录态加密存在本地。这个项目把它解出来，用 Node **零依赖**起一个本地 OpenAI 兼容服务（`127.0.0.1:8788`），于是 **任何**能填 `base_url` + `api_key` 的客户端——Hermes、OpenAI SDK、Cherry Studio、各类 Agent 框架——都能直接调用 WorkBuddy 的 27 个模型。凭证过期会**自动刷新**，你只需要在 App 里登录过一次。

```
   你的客户端                    本地反代                     WorkBuddy
 ┌──────────────┐          ┌──────────────┐          ┌────────────────┐
 │ OpenAI SDK   │  Bearer  │              │  Bearer  │  www.workbuddy │
 │ Hermes       │ ───────► │ 127.0.0.1    │ ───────► │  .ai           │
 │ CherryStudio │  /v1/... │   :8788      │  +会话头 │  /v2/chat/...  │
 └──────────────┘          └──────┬───────┘          └────────────────┘
                                  │ 读取并解密
                                  ▼
                     <LOCALAPPDATA>\CodeBuddyExtension\
                       Data\Public\auth\*.info   (AES-256-GCM)
```

---

<!-- 免责声明见文件末尾 -->

## ✨ 特性

| | |
|---|---|
| **零依赖** | 只用 Node 内置模块，`node_modules` 不存在，没有供应链风险 |
| **凭证自动解密** | 直接读 WorkBuddy 桌面端的加密凭证库，不用手抄 token |
| **自动刷新** | 过期前单飞刷新，多个并发请求只触发一次 |
| **OpenAI 兼容** | `/v1/chat/completions`（流式 + 非流式）、`/v1/models` |
| **27 个模型** | 含 `glm-5.3`、`deepseek-v4.1-flash`、`kimi-k3`、`gpt-6-astra` 等 |
| **错误分类** | 402 额度 / 401 掉登录 / 429 限流，各自映射成清晰的错误码 |
| **可诊断** | 一个命令告诉你「为什么读不到登录态」 |
| **17 项回归测试** | 自带 mock 上游，不需要真账号也能验证 |
| **状态栏开关** | Hermes 插件把启停做成状态栏按钮，见下文「🔘 Hermes 插件：反代开关」 |

---

## 🚀 快速开始

### 1. 前置条件

- **Node.js ≥ 22**（项目在 24.18.1 上开发）
- **WorkBuddy AI 桌面端已安装并登录**
- Windows（凭证库路径按 Windows 布局实现，见 [平台支持](#-平台支持)）

### 2. 起服务

```powershell
node server\workbuddy-proxy.mjs
```

装好 Hermes 插件之后，也可以直接点状态栏的「反代 开/关」按钮
（见下文「🔘 Hermes 插件：反代开关」）。

首次运行会：

1. 在 `$DSH_HOME`（未设则 `%USERPROFILE%\.dsh`）生成 `.workbuddy-proxy.json`，内含随机 Bearer
2. 探测并解密 WorkBuddy 凭证
3. 监听 `127.0.0.1:8788`

看到这个就成功了：

```json
{"ts":"...","event":"listening","host":"127.0.0.1","port":8788}
```

### 3. 验证

```powershell
# 免鉴权
curl http://127.0.0.1:8788/healthz

# 需要 Bearer（从 .workbuddy-proxy.json 的 bearerToken 取）
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8788/v1/models

# 真实对话
curl -X POST http://127.0.0.1:8788/v1/chat/completions ^
  -H "Authorization: Bearer <token>" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"glm-5.3\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

### 4. 接入你的客户端

把两样东西填进任何 OpenAI 兼容配置：

| 字段 | 值 |
|---|---|
| `base_url` | `http://127.0.0.1:8788/v1` |
| `api_key` | `.workbuddy-proxy.json` 里的 `bearerToken` |

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8788/v1", api_key="<token>")
r = client.chat.completions.create(
    model="glm-5.3",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)
```

> **⚠️ 如果你在 Windows 上遇到过莫名其妙的 502 空响应**，请先看 [故障：502 空响应](#-故障502-空响应)。

---

## 🔌 接入 Hermes

本项目本身就是一个 [Hermes](https://github.com/liberation8/hermes-workbuddy-provider) skill。两种装法：

### 方式 A：让 Hermes 自己读 SKILL.md

```
把 server/ 放到 D:\Hermes\skills\workbuddy-reverse-proxy\server\
SKILL.md 放同级目录，Hermes 会按技能加载
```

### 方式 B：纯配置接入（推荐，不装 skill 也能用）

在 `$HERMES_HOME/config.yaml` 加一个 provider：

```yaml
providers:
  workbuddy:
    base_url: http://127.0.0.1:8788/v1
    key_env: WORKBUDDY_API_KEY
    api_mode: chat_completions
```

在 `$HERMES_HOME/.env` 里放 token：

```
WORKBUDDY_API_KEY=<.workbuddy-proxy.json 的 bearerToken>
```

然后把默认模型指向它：

```yaml
model:
  default: deepseek-v4.1-flash
  provider: workbuddy
```

**这一行 `provider: workbuddy` 不能写成 `custom:workbuddy`**——Hermes 0.19.1 的 auth 层会拒绝 `custom:<name>` 形式，报 `custom endpoint is incomplete`。

细节与踩坑见 [references/hermes-wiring.md](references/hermes-wiring.md)。

---

## 📡 API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/healthz` | ❌ | 存活探测，返回 `{ok, status, uptime_s}` |
| GET | `/v1/models` | ✅ | 模型列表，带 `context_window` / `max_tokens` |
| POST | `/v1/chat/completions` | ✅ | 流式 + 非流式，支持 `tools` / `tool_calls` |
| GET | `/v1/auth/status` | ✅ | 凭证来源、域名、剩余有效期 |
| GET | `/v1/catalog` | ✅ | 原始模型目录（含供应商元数据） |

### 错误码

| HTTP | `error.type` | 含义 | 你该做什么 |
|---|---|---|---|
| 401 | `invalid_bearer` | 本地 Bearer 不对 | 从 `.workbuddy-proxy.json` 重新取 |
| 401 | `workbuddy_session_dead` | WorkBuddy 登录态失效 | 去 App 重新登录 |
| 402 | `workbuddy_credit_exhausted` | 额度/积分耗尽 | 去 App 查看套餐 |
| 429 | `workbuddy_rate_limited` | 上游限流 | 退避重试 |
| 400 | `workbuddy_client_error` | 上游 4xx（含「该模型不支持」） | 换模型 |

---

## 🧠 模型

`/v1/models` 返回 27 个模型，全部 `supports_images: true`。几个常用的：

| 模型 | 上下文 | 最大输出 | 实测最快 | 备注 |
|---|---|---|---|---|
| `glm-5.3` | 1,000,000 | 48,000 | 1.1s | 上下文最长的旗舰之一 |
| `deepseek-v4.1-flash` | 300,000 | 128,000 | 1.3s | **默认推荐**，最省 token |
| `kimi-k2.6` | — | — | 0.9s | 实测延迟最低 |
| `gpt-6-astra` | 400,000 | 128,000 | — | 大输出 |
| `default-model` | 176,000 | 24,000 | 2.2s | WorkBuddy 的 Auto，上游自选 |

**实测数据（同一句「回答一个字：好」，`max_tokens=300`）**

```
deepseek-v4.1-flash   1.3s   in=15   out=1   total=16     ← 最省
glm-5.3-flash         1.1s   in=24   out=3   total=27
kimi-k2.6             0.9s   in=21   out=4   total=25     ← 最快
default-model         2.2s   in=18   out=1   total=19
fast-model            1.4s   in=167  out=2   total=169    ← 输入 token 是别人的 7~11 倍，避开
```

> **注意**：`gpt-5.4` / `gpt-5.5` 在普通订阅账号下会返回
> `11158 当前账号类型暂不支持该模型`。整个 `gpt-6-*` 系列大概率同理。
> 额度也是共享的——WorkBuddy 走订阅额度池，不同模型不单独计费。

---

## 🔍 诊断

### 为什么系统读不到登录态

```powershell
node server\inspect-vault.mjs
```

成功时：

```
解出成功：长度 1306，前缀前 4 位 "eyJh"，信封解密=是，剩余 525524 分钟
```

失败时会明确告诉你卡在哪一阶段——是找不到可执行文件、读不到凭证文件、还是解密失败。

### 找不到 WorkBuddy 安装位置

如果 WorkBuddy 装在非默认盘符，脚本可能探测不到。手动指定：

```powershell
$env:WORKBUDDY_EXE = "D:\Apps\WorkBuddyAI\WorkBuddyAI.exe"
node server\inspect-vault.mjs
```

---

## 🔥 故障

### 502 空响应

**症状**：PowerShell / curl 调反代正常，但 Python `openai` SDK 报 `InternalServerError: Error code: 502`，响应体是空的 `b''`。

**原因**：系统代理回环。`httpx` 默认 `trust_env=True`，在 Windows 上会读注册表里的 WinINET 代理，**且不遵守 `ProxyOverride` 里的 `127.*` 排除规则**。于是发往 `127.0.0.1:8788` 的请求被交给代理（如 Clash 内核 `verge-mihomo` 的 7897 端口），代理回环转发后返回空的 502。

**解法**：

```powershell
$env:NO_PROXY = "127.0.0.1,localhost"
$env:no_proxy = "127.0.0.1,localhost"
```

> 只有 `httpx`/`openai` 这类读系统代理的库会中招；`Invoke-WebRequest` 和 curl 遵守 ProxyOverride，所以看起来「只有 Python 不行」。

### `content` 为空但 token 吃满了

```json
{"choices":[{"message":{"content":""},"finish_reason":"stop"}],
 "usage":{"completion_tokens":80}}
```

**原因**：不是丢内容，是 `max_tokens` 太小——模型的思考过程把预算吃光了。

**判定式**：`content == ""` 且 `completion_tokens == max_tokens`。

**解法**：`max_tokens` 调到 **200 以上**。

### 服务静默消失

反代被外部杀掉不会有任何记录。四重防护：

1. **Hermes 状态栏开关**（推荐）——见下文「🔘 Hermes 插件：反代开关」。点一下即启停，按钮上永远显示真实状态，「它到底在不在跑」不再是靠猜。
2. **只认 `/healthz`**——不要用端口表判断存活。Windows 上 `netstat` 会漏报另一个完整性层里的监听，死进程看起来像活着的。
3. **退出码记录**——`autostart.cmd` 把每次退出的 `rc` 写进 `workbuddy-proxy.exit.log`
4. **结构化崩溃日志**——`uncaughtException` / `unhandledRejection` 写成单行 JSON 到 `stderr`

> 早期推荐过用 Windows **计划任务**做开机自启，现已弃用：每次登录都会拉起（不管你用不用）、跨完整性层停不掉、卸载还要管理员权限。插件开关没有这三个问题。

---

## 🛠 开发与测试

不需要真账号——测试自带 mock 上游：

```powershell
cd server
node verify-proxy.mjs
```

```
PASS 17/17  FAIL 0       退出码 0
```

覆盖了：流式 chunk 拼接、tool_calls 分段、请求体改写（`developer`→`system`）、
四种上游错误映射、Bearer 校验、模型目录缓存、过期刷新单飞、
以及**信封 AAD 字节级比对 + AES-256-GCM 往返 + 三种篡改必须认证失败**。

---

## 📁 结构

```
hermes-workbuddy-provider/
├── SKILL.md                        # Hermes 技能定义（何时用、怎么修）
├── README.md                       # 英文说明（默认展示）
├── README_CN.md                    # 本文件
├── LICENSE                         # MIT
├── DISCLAIMER.md                   # 免责声明
├── .github/workflows/tests.yml     # CI：Ubuntu + Windows，Node 22/24
├── .gitignore
├── references/
│   ├── hermes-wiring.md            # Hermes 接入的完整优先级与踩坑
│   └── upstream-protocol.md        # 逆向出的上游协议细节
├── server/
│   ├── workbuddy-proxy.mjs         # 主体：1464 行，零依赖
│   ├── inspect-vault.mjs           # 凭证库诊断工具
│   ├── verify-proxy.mjs            # 17 项回归测试
│   ├── verify-catalog.mjs          # 模型目录校验
│   ├── mock-upstream.mjs           # 测试用假上游
│   ├── config.example.json         # 配置样例
│   ├── autostart.cmd               # 幂等启动器（带退出码记录）
│   ├── uninstall-autostart.cmd     # 清理历史计划任务
│   └── README.md                   # server 内部说明
├── plugins/workbuddy-switch/       # Hermes 后端插件 + Web 面板
│   ├── plugin.yaml                 # 插件身份（加载器必需）
│   ├── __init__.py                 # register() 占位（加载器必需）
│   ├── dashboard/
│   │   ├── manifest.json           # tab 与 api 声明
│   │   ├── plugin_api.py           # /status /start /stop /toggle
│   │   └── dist/index.js           # Web 面板 bundle
│   ├── tests/standin.mjs           # 自检用的假反代
│   └── selftest.py                 # 隔离式端到端自检
└── desktop-plugins/workbuddy-switch/
    └── plugin.js                   # 状态栏开关按钮
```

---

## 🔘 Hermes 插件：反代开关

状态栏开关是控制反代的首选方式。本仓库同时提供后端插件（`plugins/`）与桌面按钮
（`desktop-plugins/`），安装见 SKILL.md 的「安装 → 第 6 步」。

**两个目录，缺一不可：**

| 路径 | 角色 |
|---|---|
| `<HERMES_HOME>/plugins/workbuddy-switch/` | Python 后端（真正管进程）+ Web 面板 |
| `<HERMES_HOME>/desktop-plugins/workbuddy-switch/plugin.js` | 状态栏按钮 |

**外加一行白名单**——user 插件必须列入才会被加载：

```yaml
plugins:
  enabled:
    - workbuddy-switch
```

**HTTP 契约**挂在 `/api/plugins/workbuddy-switch`，四个端点全部幂等、恒返回 200：

| 端点 | 语义 |
|---|---|
| `GET /status` | 只读探测，不改状态 |
| `POST /start` | 已在跑 → 返回现状 |
| `POST /stop` | 没在跑 → 依然成功 |
| `POST /toggle` | 翻转后返回**新**状态 |

响应体九个字段：`ok / running / pid / port / uptimeS / nodePath / proxyScript / logPath / error`。

**装完必须重启 Hermes。** 插件发现发生在模块加载期并缓存在进程内，运行中的后端
根本没有 `/api/plugins/workbuddy-switch/*` 这些路由。判据：`<HERMES_HOME>/logs/gui.log`
里出现 `Mounted plugin API routes: /api/plugins/workbuddy-switch/`。

> **停止有一个硬限制。** 后端只能 `terminate()` 自己 `Popen` 出来的子进程。由别的
> 进程（另一个终端、残留的自启脚本）拉起的反代只能靠 `taskkill`，而当 Hermes 宿主
> 与反代处于不同 Windows 完整性层时 `taskkill` 会被「拒绝访问」。此时 `/stop` 返回
> `ok:false`，`error` 里写着 `failed=['<pid>: exit=1 错误: 拒绝访问']`——用管理员终端杀。

---

## 🖥 平台支持

| 平台 | 状态 |
|---|---|
| Windows | ✅ 完整支持，已在 Windows 11 + Node 24.18.1 实测 |
| macOS | ⚠️ 凭证路径已按 `~/Library/Application Support` 实现，**未实测** |
| Linux / WSL | ⚠️ 凭证路径已按 XDG 规范实现（含 `/mnt/c/Users/<profile>` 回退），**未实测** |

凭证探测顺序（`workbuddy-proxy.mjs`）：

- Windows：`%LOCALAPPDATA%\CodeBuddyExtension\...` → `%APPDATA%\CodeBuddyExtension\...`
- macOS：`~/Library/Application Support/CodeBuddyExtension/...`
- Linux：`$XDG_CONFIG_HOME/...` → `$XDG_DATA_HOME/...`

---

## ❓ 已知限制

- **模型 id 会漂移**。上游改名或下架时，`/v1/models` 会跟着变——不要在代码里硬编码模型名。
- **额度接口读不到余额**。WorkBuddy 没有开放额度查询接口，只能去 App 看。
- **加密信封格式可能变**。当前 `suite=1`、AES-256-GCM；上游改格式后需要重新逆向。
- **非默认盘符的安装路径**未被自动探测，需要 `WORKBUDDY_EXE` 环境变量。
- **插件停不掉「不是它自己拉起的」反代**。只有后端自己 `Popen` 的子进程能被 `terminate()`；其他来源的进程只能靠 `taskkill`，跨 Windows 完整性层时会失败（`ok:false`、`failed=['<pid>: exit=1 …']`）。
- **装插件必须重启 Hermes**。后端插件发现是进程内缓存，重启前 `/api/plugins/workbuddy-switch/*` 这些路由根本不存在。

---

## 免责声明

本项目仅供**个人学习与本地互操作研究**。

使用前请阅读 [DISCLAIMER.md](DISCLAIMER.md)。

---

<div align="center">

**[⬆ 回到顶部](#hermes--workbuddy-provider)**

<sub>本项目与 WorkBuddy / 腾讯 / CodeBuddy 官方无任何关联，未获其授权或认可。</sub>

</div>
