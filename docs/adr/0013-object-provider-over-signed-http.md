# ADR 0013：对象 Provider 用签名 HTTP 管理对象服务

状态：**M1 决定**，修正 ADR 0007 的风险项和 DESIGN.md 1.3 的供给方式。

决定：`object` Provider 和 BundleStore 从网关进程直接向对象服务发 SigV4 签名的 HTTP：S3 接口建 bucket、设策略、读写 bundle；MinIO 兼容的管理接口（`/minio/admin/v3/`，请求体按 madmin 格式用 argon2id 加 AES-256-GCM 加密）建用户、绑策略、禁用和删除。签名和加密只用 `node:crypto`。`db` 和 `kv` 仍通过 `Runtime.run_job` 在各自容器里执行 `psql` 和 `redis-cli`。

理由：RustFS 镜像里没有管理 CLI（spike S1），`run_job` 无路可走；网关为了提供静态 bundle 本来就要对对象服务签名读取，签名器已经在进程里；S3 是契约固定的协议（INV-8），对它讲 HTTP 不是引入"驱动"。

拒绝：往基础设施容器里塞一个 `mc` 二进制（多一个镜像构建步骤，版本和 RustFS 解耦）；网关持有唯一凭据代应用签发 URL（ADR 0007 的退路，失去每 App 限 bucket 的密钥，spike 已证明不需要）。

后果：管理接口是 MinIO 兼容面而非 S3 标准，换对象服务时只改 Provider 的几个管理调用，不改实体和契约；被禁用的密钥返回 400 `ErrAccessKeyDisabled` 而非 403，Provider 和测试按此判断。
