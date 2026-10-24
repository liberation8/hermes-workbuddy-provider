# WorkBuddy 反代（OpenAI 兼容）

把 WorkBuddy AI（国际版）上游逆向成本地 OpenAI 兼容端点。纯 Node 24 标准库，零第三方依赖，全 ESM。

## 文件

| 文件 | 作用 |
| --- | --- |
| `workbuddy-proxy.mjs` | 反代服务：`POST /v1/chat/completions`、`GET /v1/models`、`GET /v1/auth/status`、`GET /healthz` |
| `mock-upstream.mjs` | 假上游（OpenAI 形状 SSE），无网络自测用；第一行打印 `MOCK_PORT=xxxxx` |
| `verify-proxy.mjs` | 端到端验证：起 mock + provider，跑 18 项断言，退出码 0/1 |
| `inspect-vault.mjs` | 只读诊断：报告各凭证来源的分类与解密失败阶段，绝不打印 token |
| `config.example.json` | 配置样例，首次运行复制成 `config.json` |

## 快速开始

```powershell
cd server
Copy-Item config.example.json config.json
node inspect-vault.mjs        # 看凭证来源能否解出 accessToken
node workbuddy-proxy.mjs      # 默认 127.0.0.1:8788
```

首次启动若 `config.json` 与 `WORKBUDDY_PROXY_BEARER` 都没给 Bearer，会生成 32 字节随机 hex，写到
`$DSH_HOME\.workbuddy-proxy.json`（未设 `DSH_HOME` 则 `%USERPROFILE%\.dsh`，mode 600），**只在生成的那一次**把内容打到 stderr。
重启会复用该文件里上次的 Bearer。

自测（不联网，全程走 mock）：

```powershell
node verify-proxy.mjs
```

## 配置

查找顺序：`WORKBUDDY_PROXY_CONFIG` → 服务目录下 `config.json` → 内置默认值（8788、无需额外配置即可跑）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `8788` | `0` 表示随机端口 |
| `bearerToken` | 空 | 本地鉴权用；`WORKBUDDY_PROXY_BEARER` 优先 |
| `upstreamBase` | `https://www.workbuddy.ai` | 上游基址 |
| `appVersion` | `5.8.4` | 写进 UA / `X-IDE-Version` |
| `productName` | `WorkBuddy AI` | 国际版 product 名 |
| `catalogPath` | `D:\dsh\.workbuddy-ai-catalog.json` | 模型目录缓存，与既有文件兼容 |
| `credential` | 无 | 可选内联凭证 |

`host` 固定 `127.0.0.1`，不提供配置项；反代不接受 `request_timeout_seconds` 之类的键（写了也被忽略）。
坏配置（JSON 解析失败、字段类型不对）逐字段回落默认值继续跑，不会启动失败。

## 凭证来源（优先级从高到低）

1. `WORKBUDDY_PROXY_TOKEN`（直接给 accessToken）
2. `D:\dsh\.workbuddy-auth.json`（插件自有副本，`version` 必须为 1；刷新后会回写这里）
3. `WORKBUDDY_AUTH_FILE` 指定的文件
4. 桌面 App 登录态：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info`，
   再回落 `%APPDATA%\...`。5.6+ 是信封加密态（`$wbEncrypted`），需要 WorkBuddy 的 Electron 可执行文件取守护密钥才能解。
   本仓库**只读不写**这个文件。

都没有 → 启动时可诊断报错、退出码 `2`。

## 鉴权与错误码

除 `/healthz` 外全部要求 `Authorization: Bearer <config 里的 bearer>`，严格相等（`timingSafeEqual`），
不匹配回 `401 {"error":{"type":"invalid_bearer"}}`。方法不对回 `405 invalid_request_error`。

| 情形 | 客户端看到 |
| --- | --- |
| 上游 401 / `Offline user session not found` / `12153` | `401 workbuddy_session_dead`（提示去 App 重新登录） |
| 上游 402 / 各种额度不足文案 | `402 workbuddy_credit_exhausted` |
| 上游 429 | `429` |
| 上游其余 4xx | 透传状态码 + 可读 message |
| 上游 5xx / 网络失败 | `502 workbuddy_upstream` |

刷新只在「有 refreshToken **且** 知道 expiresAtMs **且** 剩余 < 120s」时发生，并发单飞；成功回写自有副本（先写临时文件再 rename）。
无 refreshToken 或无到期信息时不主动刷新，交给上游 401 去触发。

## 退出

`SIGINT` / `SIGTERM` 关监听后退出（最多等 1.5s）；端口被占用 → 退出码 `2`。
