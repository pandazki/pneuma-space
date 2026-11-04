# 02 · 业务查询、事务与并发实验

目的：用实际业务问题检验 SQLite 与 PostgreSQL 的抽象边界，而不是以计数器成功推断通用兼容性。代码在 [business_probe.py](business_probe.py)，结果在 [result.txt](result.txt)。

从项目根目录运行（Docker 镜像需要事先按根 README 构建）：

```sh
python3 -m unittest discover -s tests -p test_business.py -v
docker build -f tests/postgres/Dockerfile -t appbase-storage-test:local .
docker run --rm --network none appbase-storage-test:local
```

第二条路径在临时容器中初始化一个只监听本地 Unix socket 的 PostgreSQL，使用 peer 认证，容器退出后数据库随之销毁，不连接现有数据库或生成密码。`result.txt` 是 2026-11-04 的该命令输出。

## 做了什么、发现什么

- 写入 111 条问卷回复，按最多 50 条分页读取，再由 Python 过滤并计数；SQLite 和 PostgreSQL 都得到 111 条、37 条 yes。现有记录接口**没有服务端字段过滤或聚合**；此方法对大数据集的效率没有验证，也不应视为可扩展查询实现。
- 在两个后端分别建立库存和订单表，以事务执行扣库存与插订单，12 个并发订单竞争 5 件库存，恰好成功 5 笔；重复订单触发约束时库存变更回滚。
- 业务事务直接使用下层数据库连接与 SQL，并显式处理 SQLite 的 `?` 和 PostgreSQL 的 `%s` 占位符。`RecordStore` 本身没有多记录事务或通用关系查询，结果**不证明复杂业务可以不改代码任意切换数据库**。

局限：单机短时间、少量线程、一次数据模型与一次运行；未覆盖断电、网络分区、连接池、高延迟、备份迁移、租户权限、所有 SQL 类型与隔离级别。切换配置不会迁移数据。

## 补充：同一关系型业务接口

在前述记录 API 验证之外，新增 `templates/counter/relational.py`。`RelationalDatabase.transaction()` 为 SQLite 和 PostgreSQL 提供同一个参数化 SQL 入口与提交／异常回滚边界；示例业务代码 [order_service.py](order_service.py) 在数据库内执行多记录库存／订单事务、按字段过滤、连接与聚合、取消和去重。两种后端执行的是同一套业务代码。原始底层 SQL 实验仍保留，上面的历史限制是针对 `RecordStore`，不是声称新的关系型接口也只能逐条记录操作。

```sh
python3 -m unittest discover -s tests -p test_relational.py -v
docker build -f tests/postgres/Dockerfile -t appbase-storage-test:local .
docker run --rm --network none appbase-storage-test:local
python3 prototype/02-storage/compose_business_smoke.py
```

Compose 网关测试要求本机已缓存 `python:3.12.12-slim` 与 `postgres:16-alpine`；未缓存时需先按根 README 获取镜像。

前两种数据库的进程内结果见 [result-relational.txt](result-relational.txt)；最后一项在真实网关下分别访问 SQLite 与临时 Compose PostgreSQL，包含 12 个并发订单竞争 5 件库存、重复库存／订单、取消、服务端过滤与聚合、数据库和应用重启及双向配置切换，输出见 [result-compose-business.txt](result-compose-business.txt)。脚本用唯一测试名与临时数据库，正常结束会清理自己的资源；中断可能留下 `appbaseorder...` 相关资源，清理前需核对归属。

这是**窄 SQL 适配器**，不是所有 SQL 方言都能互换：SQL 文本仍须是两个数据库共同支持的语法；只支持裸 `{}` 值占位符，字面大括号写为 `{{` / `}}`，不要将占位符放进引号，也不要拼接用户输入。结果在事务上下文内读取。SQLite 写事务使用 `BEGIN IMMEDIATE`，会串行化写入；PostgreSQL 使用其默认事务隔离，两者隔离级别、锁、错误类型、类型范围和 DDL 并不完全相同。`write=False` 是 SQLite 锁策略提示，**不是强制只读权限**。没有跨数据库分布式事务、通用迁移、查询规划或自动索引。
