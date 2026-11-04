# 原型验收与验证记录

本次先完成运行、定位和修复，再整理证据。以下三个目标在明确的本机实验范围内均跑通；prototype/demo 不等同于生产或多租户服务。

## 1. 独立 Agent 开发并运行

新的 Agent 以 `fork_turns="none"` 接收任务，从整理后的脚手架指南出发，独立实现任务清单。它实际运行了 3 项应用测试，并获准在独立临时网关中构建、发布、创建和完成任务，观察闲置停止后唤醒，验证完成状态保留；本次资源已清理。[成功运行记录](prototype/04-agent-recheck/SUCCESS.md)保留成功执行与清理的命令和输出；它摘录自 Agent 手工记录，不是完整轨迹或系统审计日志。最初它在默认沙箱中不能访问 Docker socket 或绑定端口；之后使用获准的升级执行完成 Docker 测试。

网关热路径修复后，主任务又用该 Agent 的同一应用在独立网关重跑，通过结果见 [parent-retest.txt](prototype/04-agent-recheck/parent-retest.txt)。首次独立 Agent 的问卷也已验证 SQLite/PostgreSQL，证据在 [01-agent-app](prototype/01-agent-app/README.md)。任务清单本身尚未进行 PostgreSQL 端到端测试。

## 2. 两种数据库上的同一业务接口

`RelationalDatabase` 在 SQLite 和 PostgreSQL 上提供相同的参数化 SQL 调用与事务上下文；[order_service.py](prototype/02-storage/order_service.py) 是同一份订单业务实现。真实两种数据库的隔离测试覆盖 12 个并发订单竞争 5 件库存、重复订单、并发取消、回滚、服务端过滤与聚合，输出见 [result-relational.txt](prototype/02-storage/result-relational.txt)。通过真实网关的两个后端再次执行订单 HTTP API，验证同一 URL、独立数据、数据库及应用重启，见 [result-compose-business.txt](prototype/02-storage/result-compose-business.txt)。

这不是通用 SQL 方言兼容：调用者仍须编写两种数据库共同支持的 SQL，SQLite 和 PostgreSQL 的锁、隔离、错误及类型仍有差别。JSON `RecordStore` 与新增关系型事务接口是两套不同能力；前者本身没有多记录事务或服务端字段查询。切换后端不会迁移数据。完整限制和复现命令见 [数据库实验](prototype/02-storage/README.md)。

## 3. 有界冷应用与热请求

最初受限测试中观测到热请求变慢。分阶段复现发现其中一类慢请求主要耗在网关对已运行容器重复调用 Docker start；已改为缓存已启动状态，闲置停止清除缓存，连接失败时仅在请求送达应用之前尝试恢复。修复后的同一冷应用并发请求、外部停止恢复和正常闲置唤醒均通过。

在 24 个冷注册、最多 3 个活动测试应用、最多 9 个并发请求的三轮客户端分段复测中，仍有一轮热请求达到约 201 ms；该请求网关内处理约 17 ms，其余主要发生在客户端等待响应头阶段，现有证据不足以确定根因。人工从 Docker 外部停止容器后，停止状态的 Docker DNS 解析约等待 4 秒，首次请求最终恢复但仍较慢。所有数字、时间线、前后样本及资源快照见 [冷应用实验](prototype/03-cold-apps/README.md)。这些是少量单机样本，不是规模或延迟承诺。

## 最终测试与剩余风险

- `python3 -m unittest discover -s tests -v`：18 项通过；`python3 -m unittest discover -s prototype/04-agent-recheck -p 'test_*.py' -v`：3 项通过。
- `python3 tests/compose_smoke.py`：网关发布、双后端切换、并发冲突、版本发布与重启通过，见 [compose-last-result.txt](tests/compose-last-result.txt)。
- 独立应用隔离网关重测、两数据库关系型测试及真实网关订单测试均通过。测试数据库和凭据为一次性资源，正常结束后清理。
- 身份认证、多租户隔离、备份迁移、持续后台任务、定时调度、故障恢复保证、长时间／大规模负载、云成本及许可证仍未完成或未验证。此原型只运行可信本机镜像。
- 完整离线构建尚未实现；普通构建通过，但无缓存时需要可访问的包源或预先准备离线依赖。
