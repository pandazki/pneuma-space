# ADR 0005：能力清单、Provider 与注入

状态：**M1 决定**。取代 ADR 0003 的数据库供给部分。

决定：应用在 `pneuma-space.json` 里声明能力。`CAPABILITIES` 是唯一的能力表，每个 kind 映射到一个 Provider，导入时断言枚举和表一致。有数据的能力由 Provider 创建资源，平台记为每 App 每 kind 一条 Binding；注入由当前 Release 的 Binding 推导，容器创建时应用，不存储。发布先 `ensure` 再提交，资源属于 App 而非 Release。PostgreSQL 每 App 一库一角色，`REVOKE CONNECT FROM PUBLIC`；Redis 每 App 一个 ACL 用户，键和频道都限前缀。Provider 通过在基础设施容器里执行 `psql`、`redis-cli` 和对象服务的管理命令供给，网关不带驱动。`remove` 时 Provider `suspend`（角色 NOLOGIN、ACL off、撤销匿名读），重新发布时 `ensure` 恢复。

理由：一个表推导环境变量、要调用的 Provider 和网关标志，消灭手工同步的列表。资源按 App 而非 Release 存在，让 ensure 可重复，于是不需要 `pending` 状态和启动时的全量核对。ACL 而不是 Redis 库编号，因为 pub/sub 跨库全局。`docker exec` 供给让网关不依赖任何数据库或存储驱动。

拒绝：每 App 一个 Redis 或 PostgreSQL 实例（空闲也占内存，违背 G2）；应用自带驱动直连后端（后端泄漏进应用代码，违背 INV-8）；Binding 存 `pending` 状态并在提交后核对（每次重启要扫全部 Binding）；网关内置 PostgreSQL 线协议客户端（代码最多，M2 换 Provider 实现时再考虑）。

后果：`PNEUMA_SPACE_DB_URL` 的 scheme 仍暴露后端，SQL 方言差异由示例 SDK 的可移植子集吸收。切换 `db_backend` 不迁移数据。
