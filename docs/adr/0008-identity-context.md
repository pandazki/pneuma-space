# ADR 0008：身份上下文

状态：**M1 决定**。

决定：网关丢弃所有入站 `X-Pneuma-*`，由 `IdentityProvider.authenticate` 产生 Principal，写成三个平面头：`X-Pneuma-Subject`（`user:<id>` 或 `service:<id>`）、`X-Pneuma-Name`、`X-Pneuma-Owner`（主体等于 `App.owner` 时为 `1`）。M1 的提供者是本地桩：浏览器会话 cookie 加控制台签发的服务令牌。M2 换 OIDC 实现，头不变。

理由：三个平面头让不用 SDK 的应用用 `headers.get` 就能做所有者判断。主体前缀携带种类，应用能分辨人和程序。提供者是 Protocol，SSO 是替换不是重写。

拒绝：一个 JSON 头（非 SDK 应用要解析 JSON 才能比一个字符串）；应用自带登录（所有者判断可伪造，违背 INV-5）；签名身份头（需要给容器分发密钥，M1 信任边界内不必要）。

后果：INV-5 只对浏览器成立；共享网络上的容器可以互相伪造头，这在 `REQUIREMENTS.md` 信任边界里写明。本地桩是自报姓名，M1 的"所有者"只在可信机器上有意义。
