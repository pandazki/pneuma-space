# ADR 0003：两种数据库与有界关系型接口

状态：**原型实现及指定业务场景已验证**；通用数据库平台和部署隔离方案未决定。

决定：SQLite 与 PostgreSQL 同时支持两种接口：`RecordStore` 提供 JSON 记录 CRUD 和修订号；`RelationalDatabase` 以相同的参数化 SQL 调用及事务上下文支持多记录操作。订单示例在同一业务代码中执行库存与订单事务、服务端过滤、连接和聚合。切换配置不会迁移数据。

验证：两种真实数据库下测试了 12 个并发订单竞争 5 件库存、重复请求、并发取消、异常回滚和条件查询聚合；还通过真实网关执行相同订单 HTTP 业务，并验证数据库与应用重启。证据：`prototype/02-storage/result-relational.txt`、`prototype/02-storage/result-compose-business.txt`。

边界：SQL 文本仍须采用两种数据库共有的语法，适配器仅统一裸 `{}` 值占位符，不能承诺所有 SQL 方言、类型和错误一致。SQLite 写事务使用 `BEGIN IMMEDIATE`，PostgreSQL 使用其默认隔离；锁和隔离语义不同。`RecordStore` 自身仍无多记录事务。SQLite 不适合多节点共享文件；PostgreSQL schema/search_path 不提供租户安全。自动迁移、跨数据库事务、查询规划和复杂故障尚未实现或验证。
