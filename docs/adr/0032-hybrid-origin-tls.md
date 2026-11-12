# ADR 0032：组合部署的源站 TLS

状态：已接受，2026-11-12。用户允许组合部署，优先保留全部应用能力。

## 背景

[G14](../../REQUIREMENTS-M3.md#目标) 的首个云后端需要保留 [契约 1](../app-contract.md)。Cloudflare 普通 HTTP 代理的上传上限与源站超时不能承载全部既有请求。DNS-only 流量直接到源站，不经过 Cloudflare 的代理、WAF 或缓存。[代理行为](https://developers.cloudflare.com/dns/proxy-status/)、[连接限制](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)。

现有托管 Ingress 示例依赖社区 ingress-nginx。该项目已于 2026-03-24 退役，不再接收安全更新。[Kubernetes 说明](https://kubernetes.io/blog/2026/03/30/kubernetes-v1-36-sneak-peek/)。

## 决策

1. 先交付 Cloudflare DNS-only 与源站 TLS 的兼容性单元。控制台、应用和对象域名直接解析到源站。真实 Cloudflare 边缘转发仍待付费四层方案验证，不能据此关闭 G14 或公开发布门槛。
2. 一份 Caddyfile 定义控制台到网关 8081、应用到网关 8080、对象到 S3 9000 的路由。它读取现有公开 origin；部署配置提供三个内部 upstream。Kubernetes 用 ConfigMap 装载同一文件，替换已有 Ingress。本地独立 Compose 环境装载同一文件做协议验证。不给网关添加依赖或厂商接口。
3. 保留外部 Host、原路径、查询和 Origin。不开缓存、压缩、请求体缓冲或体积上限。响应使用正数刷新间隔，保留客户端断开后的上游取消。未知主机不能落到应用路由。证书由运营者提供，DNS-only 必须使用浏览器信任的证书，不能使用仅供 Cloudflare 回源的证书。
4. TURN 的监听端口与 UDP 中继范围独立公开。镜像仓库保持既有推送、摘要查询和节点拉取接口。二者不能被 HTTP 入口替代。
5. 计算、卷与平台服务保留既有拥有者。M3 的恶意代码隔离、后端资源预算与第二后端恢复仍按 [SaaS 验收](../acceptance.md#full-platform-saas) 分别验收。

## 取舍与验证

选择源站直达会公开源站地址，并需要独立维护证书。Cloudflare HTTP 代理、Worker 与 Tunnel 会收窄原契约；付费四层代理需要先取得协议、端口范围和报价证据。普通 Pod、共享 runner 与前缀权限不能证明恶意租户隔离。

Caddy 配置更新默认关闭 WebSocket，按入口维护处理，不承诺更新期间连接无损。负数刷新间隔会改变客户端断开时的取消行为，因此不用。[Caddy 流式代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)。

实际 HTTPS 验证覆盖登录与跨账户拒绝、静态鉴权、CLI 发布、WS/SSE、超过普通边缘阈值的请求及直传对象。有限时长测试证明配置行为，不证明无限连接或公网容量。证书、DNS、公开 TURN、生产身份、集群与迁移仍须在各自真实环境验收。
