# ADR 0010：RTC 进 M1，在 Compose profile 后面

状态：**M1 决定**，实现顺序排最后。用户 2026-11-04 的意见：不难就 M1，费时就以后，不影响架构。四个独立设计里三个建议推到 M2。

决定：`rtc` 能力在 M1 提供，coturn 在 Compose `rtc` profile 后面。Provider 是叶子：不碰网关路径，没有每 App 资源，只注入 STUN/TURN 地址和 HMAC 密钥；示例 SDK 用密钥铸造限时 TURN 凭据；信令走应用自己的 `ws`。profile 未开时，声明 `rtc` 的发布返回 409。

理由：WebRTC datachannel 是明确提出的需求之一。Provider 约 60 行，不改变任何概念。单机能验证的部分（coturn 启动、凭据被接受、本机两个页面建立 datachannel）是真实验收。

拒绝：推到 M2（理由是跨 NAT 中继无法在回环主机上验收；这是对的，但它只限制验收范围，不限制提供能力）。

后果：跨 NAT 中继依赖运营者设置 `PNEUMA_SPACE_RTC_PUBLIC_HOST` 和 UDP 端口范围，M1 不验证，文档写明。若 coturn 集成超出预期，整体移到 M2，不改任何概念。
