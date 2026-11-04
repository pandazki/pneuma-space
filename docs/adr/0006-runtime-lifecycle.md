# ADR 0006：Lease、实例状态机与发布

状态：**M1 决定**。取代 ADR 0002。

决定：请求、流式响应、WebSocket 或 SSE 连接、触发执行都是 Lease。实例状态机 `asleep / waking / awake / draining / stopping` 每实例一把锁，`awake -> stopping` 只在 Lease 为空时发生，`acquire` 在同一把锁内加 Lease。客户端断开不提前释放 request Lease。只有发布、remove、purge 引起的 `draining` 会主动结束 Lease。发布是写一条不可变 Release 并移动 `App.current`，`release_key` 相同为空操作。平台状态是 `/data/pneuma-space.sqlite3` 一个文件，每张表一个写者。内部资源和容器以不透明的 `App.id` 命名，`name` 只用于地址，M3 的租户只需改 name 到 id 的查找。容器名 `pneuma-space-<id>-<release>` 确定，标签带 Injection 哈希，创建和启动可重复，启动时据标签识别过期容器；唤醒后 inspect 一次缓存 IP。

理由：INV-3 只需要一个证明。网关和调度器共用一个动词 `acquire`，所以唤醒路径只有一条。每实例锁消灭全局锁。SQLite 让发布在一个事务里写 Release、Trigger、Binding 和指针，JSON 文件做不到。缓存 IP 绕开 Docker DNS 对外部停止容器约 4 s 的失败。

拒绝：事件溯源控制面（为证明幂等多出投影机制）；每 App 一个 actor 持有全部状态（列表和触发查询变成 scatter-gather，崩溃丢内存真相）；发布时拒绝有活动请求的 App（有一个长连接的 App 永远发不了）；原型的 http.server 直接扩展（线程和锁纪律随每个能力恶化）。

后果：一个开着的 WebSocket 让 App 保持唤醒，由 `connection_idle_seconds` 兜底。发布后最多 `drain_timeout_seconds` 切断剩余请求并关闭连接，换来一个 App 只有一个进程打开 `/data`。网关重启丢失 Lease 和连接，客户端重连，触发重投。
