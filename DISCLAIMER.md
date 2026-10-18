# 免责声明 / :isclaimer

> **请在使用前完整阅读本文件。**

## 中文

### 1. 性质

本项目（`hermes-workbuddy-provider`，下称"本项目"）是一个**本地互操作研究工具**。它的作用是把用户自己电脑上、由用户自己安装并登录的 WorkBuddy 桌面端的登录凭证读取出来，并按照公开可见的客户端行为，在**本机回环地址**上提供一个 OpenAI 兼容的转发服务。

本项目**不是** WorkBuddy、CodeBuddy 或腾讯的官方产品，**未获其授权、认可或赞助**。项目作者与上述公司无任何隶属或合作关系。

### 2. 不包含的内容

本项目**不包含、不分发、不导出**以下任何内容：

- 任何他人的账号、凭证、令牌或会话信息
- 任何绕过付费、突破配额限制或伪造身份的功能
- 任何 WorkBuddy 服务端代码、私有密钥或未公开的数据
- 任何用于批量注册、账号共享或对外转售服务的能力

本项目只读取**运行它的本机用户自己的**登录态。请勿将本服务暴露到公网，或使用他人的凭证运行它。

### 3. 使用风险由你承担

使用本项目所产生的一切后果——包括但不限于账号被限制、订阅被终止、凭证泄露、数据丢失、服务条款违约——**完全由使用者自行承担**。作者不对任何直接或间接损失负责。

WorkBuddy 的用户协议可能禁止此类非官方客户端接入。**在决定使用前，请自行确认你的使用方式是否符合你所在地区的法律和你与 WorkBuddy 之间的协议。** 如果你不确定，请不要使用。

### 4. 无担保

本项目按"现状"（AS IS）提供，不附带任何明示或暗示的担保。加密信封格式、上游接口、模型列表都可能随时变更，导致本项目失效。作者没有义务维护或修复。

### 5. 许可

以 MIT 许可证发布，详见 [LICENSE](LICENSE)。

MIT 只授予你**使用这份代码**的权利，不授予你**使用 WorkBuddy 服务**的任何权利——后者完全由你与 WorkBuddy 之间的协议决定。

---

## English

### 1. Nature

This project is a **local interoperability research tool**. It reads the login credential of the *user's own* locally installed WorkBuddy desktop app and exposes an OpenAI-compatible forwarding service **on the loopback address only**.

It is **NOT** an official product of WorkBuddy, CodeBuddy, or Tencent, and is **not authorized, endorsed, or sponsored** by them.

### 2. What it does not contain or provide

- Other people's accounts, credentials, tokens, or sessions
- Any mechanism to bypass payment, exceed quotas, or forge identity
- Any server-side code, private keys, or unpublished data of the upstream service
- Any ability to bulk-register, share accounts, or resell access

It only reads the **local user's own** login state. :o not expose this service to the public internet, and do not run it with someone else's credential.

### 3. Use at your own risk

Any and all consequences — account restrictions, subscription termination, credential leakage, data loss, or terms-of-service violations — are **solely the user's responsibility**. The author accepts no liability for direct or indirect damages.

The upstream provider's terms of service may prohibit unofficial client access. **Before using, verify that your usage complies with the law in your jurisdiction and with your agreement with WorkBuddy.** If you are unsure, do not use it.

### 4. No warranty

Provided **AS IS**, without warranty of any kind. The encrypted envelope format, upstream API, and model list may change at any time and break this project. The author has no obligation to maintain or fix it.

### 5. License

Released under the MIT License — see [LICENSE](LICENSE).

MIT grants you the right to **use this code**. It grants you **no right to use the WorkBuddy service**, which is governed entirely by your own agreement with WorkBuddy.
