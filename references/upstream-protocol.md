# 上游协议速查（WorkBuddy AI）

本文件是**权威对照表**：`server/workbuddy-proxy.mjs` 实现与 Hermes 接线都以此为基准。
数值必须一字不差；发现实现与本表冲突时，以本表为准并修实现。

> 状态图例：`[契约]` = 任务书给定的既定事实；`[待实测]` = 尚未在本机跑通验证。

---

## 1. 端点与服务面

| 项 | 值 |
|---|---|
| 服务监听 | `127.0.0.1`（仅本机） |
| 默认端口 | `8788` |
| 启动 | `"C:\Program Files\nodejs\node.exe" server\workbuddy-proxy.mjs` |
| 配置来源 | 环境变量 `WORKBUDDY_PROXY_CONFIG` 指定 json 路径；否则 `server\config.json`（由 `config.example.json` 复制） |
| 服务 node | `C:\Program Files\nodejs\node.exe`，版本 `24.18.1` |

### 对外路由

| 方法 | 路径 | 需要 Bearer | 说明 |
|---|---|---|---|
| `POST` | `/v1/chat/completions` | 是 | 支持 `stream` 与非流式 |
| `GET` | `/v1/models` | 是 | OpenAI 形状模型目录 |
| `GET` | `/healthz` | **否** | 存活探针 |
| `GET` | `/v1/auth/status` | 是 | 凭证状态（脱敏） |

`/healthz` 返回 `{ ok: true, status: "ok", uptime_s: <int> }`，只证明进程存活，
不证明上游登录态有效。`/v1/models` 的每条含 `id / object / created / owned_by /
name / context_window / max_tokens / supports_images`，其中 `context_window` 由上游的
`contextWindow`（或 `maxInputTokens`）映射而来。

---

## 2. 鉴权

### 2.1 本机 Bearer（Hermes → 反代）

| 项 | 值 |
|---|---|
| 头 | `Authorization: Bearer <token>` |
| 取值优先级 | 环境变量 `WORKBUDDY_PROXY_BEARER` → `config.bearerToken` → 状态文件里上一次的 Bearer → 自动生成（32 字节 hex） |
| 自动生成时落盘 | `$DSH_HOME\.workbuddy-proxy.json`（同时记录随机端口）；`DSH_HOME` 未设置时用 `%USERPROFILE%\.dsh` |
| 校验失败 | `401 invalid_bearer` |
| 不受保护 | `/healthz` |

### 2.2 上游凭证（反代 → WorkBuddy）

优先级（第一个命中即用）：

| 顺序 | 来源 |
|---|---|
| 1 | 环境变量 `WORKBUDDY_PROXY_TOKEN` |
| 2 | `D:\dsh\.workbuddy-auth.json` |
| 3 | 环境变量 `WORKBUDDY_AUTH_FILE` 指向的文件 |
| 4 | WorkBuddy 桌面 App 登录态：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info` |

第 4 项在 App 5.6+ 可能是**信封加密态**，服务负责自行解密。
四个来源都拿不到 → 启动即失败（不发请求）。

---

## 3. 请求体改写规则

Hermes 侧 body 保持**干净**的 OpenAI Chat Completions 形状；所有上游私有的改写与
私有头（`X-Conversation-*` 等）全部由反代负责，Hermes 不得发送。

| 字段 | 规则 |
|---|---|
| `reasoning_effort` | **只接受顶层字段**，取值 `low` / `medium` / `high` / `xhigh` / `max` |
| 不接受的写法 | `extra_body.reasoning` 形状（上游不认）；`"off"` → **400**；`"none"` 不是文档值，**不安全**，不要发 |
| 缺省 | 省略该字段，让上游用默认值 |
| 更高级别 | `ultra` / `xhigh` / `max` 统一由调用方收敛为 `"max"` |

> 本方案不装 provider 插件，因此 Hermes 侧的 `reasoning_config` 不会被二次映射；
> 如果发现 Hermes 发出了 `"off"`/`"none"`，视为接线错误，按本节纠正或在 Hermes 侧
> 关掉 reasoning 开关。（`[待实测]`：具体由谁在 Hermes 0.19.1 里生成该字段。）

---

## 4. 模型目录

| 项 | 值 |
|---|---|
| 上游真实 id 来源 | `GET /v3/config` |
| 稳定性 | **会漂移**，随时新增/下线 |
| 反代对外 | 透出为 `/v1/models`，Hermes 用它做 `/model` 选择与校验 |

近期实测过的 id（**仅作兜底参考，不是权威列表**）：

```
default-model, fast-model, balanced-model, primary-model, hy4-preview, hy3,
step-5-preview, deepseek-v4.1-flash, deepseek-v4.1-flash-sg, gpt-6-astra,
gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna,
gpt-5.5, gpt-5.4, grok-4.7, gemini-3.8-flash, gemini-3.5-flash, glm-5.3-flash,
glm-5.3, glm-5.2, kimi-k3, kimi-k2.6, kimi-k2.8-preview
```

---

## 5. 错误分类

反代对外统一错误形状，`type` 是判据：

| HTTP | `type` | 含义 | 处置方向 |
|---|---|---|---|
| `401` | `workbuddy_session_dead` | 上游登录态失效 | 去 WorkBuddy App 重新登录 |
| `402` | `workbuddy_credit_exhausted` | 订阅额度/积分耗尽 | 额度问题，改配置无用 |
| `429` | —（上游限频） | 触发限频 | 退避重试、降并发 |
| `502` | `workbuddy_upstream` | 反代→上游链路问题：连不上、返回不可解析、**流中断**、模型目录不可用、代理内部错误 | 看反代日志；先分清是「目录不可用」还是单次生成失败 |
| `401` | `invalid_bearer` | 本机 Bearer 不对 | 同步 `.env` 的 `WORKBUDDY_API_KEY` 与状态文件里的 bearer |

流式场景特例：SSE 里会推 `data: {"error":{"type":"workbuddy_upstream","message":...}}`
表示上游流中断；客户端应据此判定失败而不是当成正常结束。

---

## 6. 刷新契约（`[待实测]`）

| 项 | 规则 |
|---|---|
| 触发时机 | 收到登录态失效信号（401 `workbuddy_session_dead`）时反代尝试刷新一次 |
| 刷新成功 | 重放原请求，对 Hermes 透明 |
| 刷新失败 | 返回 `401 workbuddy_session_dead`，要求人工重登 |
| 刷新凭证来源 | 与 §2.2 同源；刷新后的 token 回写同一处 |

> `[待实测]`：具体的过期判定窗口、刷新端点、以及是否对并发请求合并刷新。
> 实现落定后在此补实测数值。

---

## 7. 信封加密（5.6+）

| 项 | 值 |
|---|---|
| 文件 | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info` |
| 形态 | 可能是**信封加密态**（App 5.6+） |
| 责任方 | 反代自行解密，Hermes 与用户不感知 |

> `[待实测]`：信封结构、密钥来源、解密失败时的错误码。

---

## 8. 服务启动期约定

| 场景 | 行为 |
|---|---|
| 配置损坏/缺失 | 用内置默认值继续（`port=8788`、`host=127.0.0.1`） |
| 无任何凭证 | 启动即终止并提示先登录 App 或设 `WORKBUDDY_PROXY_TOKEN` / `WORKBUDDY_AUTH_FILE` |
| 端口被占用 | `EADDRINUSE` → 退出码 `2` |
| Bearer 自动生成 | stderr 打印 `已生成 Bearer：<token>`，并写入状态文件 |
| 停服 | `SIGINT` / `SIGTERM` → 优雅关闭，1.5s 后强制退出 |

---

## 9. 未验证清单

- 上游 `/v3/config` 的真实响应形状与字段名
- `reasoning_effort` 各档位在上游的实际行为（只确认了 `"off"` → 400）
- 刷新端点与过期窗口
- 信封加密的解密实现
- 流式 SSE 的分段语义（是否与 OpenAI 完全一致：`[DONE]`、`finish_reason`、`usage` 位置）
