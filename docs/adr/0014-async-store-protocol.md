# ADR 0014：Store 协议是异步的，事务通过句柄作用域

状态：**M1 决定**，修正 model.ts 里 Store 为同步接口的实现选择。

决定：`Store` 的每个方法返回 Promise；`transaction(fn)` 把一个事务作用域的句柄 `tx` 传给 `fn`，`fn` 内的读写只通过 `tx`，`fn` 的 Promise 落定即提交或回滚。M1 的 SQLite 实现内部仍是 `node:sqlite` 的同步调用，但所有公开方法经过一个串行队列，事务持有队列直到 `fn` 结束，所以别的调用不会插进打开的事务。Registry、Scheduler、Ingress 对 Store 的调用全部 `await`。内存快照（RouteView、RunSpec、Instance 状态）仍是同步读，它们不是 IO。

理由：接口形状是 M2 换 PostgreSQL 平台库的接缝（DESIGN.md 第 3 节），一个同步签名会把 SQLite 的实现细节写进每个调用方；事务用句柄而不是闭包里的隐式连接，正是连接池下事务的形状。实现里保留同步调用，是因为 SQLite 是进程内文件，一次提交 0.31 ms，没有异步的收益。

拒绝：保持同步签名到 M2 再改（30 多处调用方届时一起改，且 Registry 的事务语义要重写）；实现也改成 worker 线程里的异步 SQLite（多一层，没有收益）。

后果：事务内 `await` 的只能是 `tx` 上的调用；在事务里等待网络或 Docker 会把队列卡住，Registry 保持"先 ensure 再提交"的顺序正是为了避免这一点。
