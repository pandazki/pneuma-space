# ADR 0020：实例状态进平台库，网关多副本

状态：**M2 决定**。设计探索稿 M2-D1 第 D8 节。

决定：

1. **一个 App 最多一个实例，只靠实例行上的条件更新保证。** 领导者只为省事，不为正确：领导者错位或两个副本同时自认领导，都不会产生第二个实例。
2. **四张表**（`Store` 提供读写和 CAS）：

   | 表 | 键 | 列 | 写者 |
   | --- | --- | --- | --- |
   | `replica` | `id`（Pod 名，`PNEUMA_SPACE_REPLICA`；单机取 `os.hostname()`） | `started_at`, `seen_at`（库时钟） | 自己每 2 s 心跳；领导者删 `seen_at` 超过 10 s 的行 |
   | `instance` | `app` | `runtime`, `release`, `spec_hash`, `epoch`, `state`, `actor`（正在做暂态转换的副本）, `handle`, `address`, `node`, `home`, `since`, `awake_at`, `cpu_millis`, `memory_mb` | Lifecycle，只经 CAS |
   | `lease_tally` | `(app, replica)` | `epoch`, `request`, `channel`, `trigger`, `released_at` | 该副本自己；领导者删死副本的行 |
   | `guard` | `app` | `release`, `failures`（时间数组）, `quarantine_reason`, `quarantined_at` | Guard，事务里读改写 |

   一把会话级 advisory lock `pneuma-space.leader`；行锁 `FOR SHARE` 和 `FOR UPDATE`；`instance` 和 `guard` 的每次写由行触发器在提交时发通知，通道 `pneuma_space`，载荷 `instance/<app id>`（ADR 0025）。`lease_tally` 不发通知：PostgreSQL 把所有发过 NOTIFY 的事务的提交串在一把全局锁上，租约边沿不能排进去；正确性从不读租约镜像，只在事务里读行。Registry 的变更走同一通道，其他副本据此重建 RouteView。每个 CAS 的谓词都带 `runtime`：一个 App 只有一行，container 和 isolate 两个 Lifecycle 都读它。
3. **每个副本在内存里维护三张表的镜像。** `instance` 和 `guard` 收到通知就重读那一行；`lease_tally` 每 5 s 重读一次只供显示；监听连接重连后全量重读；每 30 s 全量重读一次兜底。`Runtime` 的同步读接口 `state`、`since`、`leases`（本副本的实时计数加其他副本最近一次读到的计数）、`sleepsAt` 和 Guard 的 `quarantine` 都读镜像，列表仍然零 IO（AC-P-8）。
4. **流程。** 每个 CAS 带 `WHERE app=$1 AND state=<预期> AND epoch=<预期>`，然后发通知。
   - acquire 快路径：镜像里实例 `awake`，本副本对当前 epoch 最近一次已提交或已排队的 tally 大于 0，本副本的 watch 没报这个 handle 结束：内存里加租约，零 IO。热请求都走这里。一个副本对一个 App 的所有 tally 写经一条本地队列，入队时就记下计数，所以"排队中的 0 写"和新租约不会交错出一个被回收器误判的 0。
   - acquire 慢路径，实例醒着：一个事务 `SELECT ... FOR SHARE`，`awake` 则 upsert 本副本的 `lease_tally` 使计数大于 0。这是 0 到大于 0 的边沿，同步写库，和回收器的 `FOR UPDATE` 互斥，所以不会被睡掉。
   - 唤醒：一个事务里先读 `app` 行的 `version`、`status`、`current`（ADR 0025：Registry 的每次写都把 `version` 加一）。本副本 RunSpec 的 `version` 落后就放弃唤醒、刷新视图再来，`status` 不是 `active` 就按 M1 答 404，所以过期的视图唤不醒旧版本，也唤不醒已移除的应用。然后 `UPDATE instance SET state='waking', epoch=epoch+1, actor=$me, runtime=$runtime ... WHERE state='asleep'`（没有行时先 `INSERT ... ON CONFLICT DO NOTHING`），读 `guard` 行做准入（隔离和退避答 503），锁租户行做配额准入并写入这次的 `cpu_millis`、`memory_mb`（ADR 0023）。准入是 Lifecycle 拿到的一个回调 `admit(tx, spec)`，由 Guard 持有，Guard 仍是唯一计失败和隔离的地方。赢家调用 `driver.start`，再 CAS 到 `awake`，写 address、awake_at 和自己的计数。输家和其他副本等这个 app 的通知，每 500 ms 轮询一次行兜底。启动失败 CAS 回 `asleep` 并发失败事件。事务体可能被重跑（ADR 0025 第 3 条），所以事件只在提交后发。
   - release：只改本地。计数降到 0 或分类计数变化时，最多 1 s 后写一次 `lease_tally`（写 `released_at`）；`draining` 时立即写。
   - 回收（领导者）：每 `min(idle_seconds, 10)` s 扫镜像里 `awake` 的行；候选行开事务 `FOR UPDATE`，确认当前 epoch 没有计数大于 0 的行且 `now - max(released_at, awake_at) >= idle_seconds`，CAS 到 `stopping`；锁外 `driver.sleep`，再 CAS 到 `asleep`。
   - 退役：由执行发布、改策略或 remove 的副本在提交后直接做。CAS `awake→draining` 并发通知；每个副本看到 `draining` 就对本地 channel 调 `onRetire` 并立即写计数；退役方等计数之和为 0 或 `drain_timeout_seconds`，然后 CAS `stopping`、`driver.remove`、回 `asleep`。新 Release 的 Pod 在旧 Pod DELETED 之后才创建，"两个进程不同时打开一个 `/data`"仍然成立。
   - 实例自己结束：每个副本都 watch Pod、轮询它看得到的 runner，观察到结束就 CAS `awake→asleep WHERE epoch AND handle`，只有赢家发 `crashed` 或 `hung` 事件，Guard 每次失败只记一次。
   - 接管：启动时每个副本先删自己旧的 `replica` 和 `lease_tally` 行（新进程不持有任何租约），再接管 `actor` 是自己的 `waking`、`stopping`、`draining` 行；领导者每 5 s 接管 `actor` 的 `seen_at` 超过 10 s 的行。接管按确定的名字删 handle，CAS 到 `asleep`；`draining` 行接着排空。晚到的原唤醒者 CAS 失败，它创建的 Pod epoch 不匹配，由孤儿清理删掉。副本 id 是 Pod 名，容器重启后不变，所以 actor 活着不等于那次转换还有人管，启动接管补这个缺口。
   - 孤儿清理（领导者，取得领导权时和之后每 60 s）：驱动列出的实例，若列出后读到的行既不指向它的 handle 也不是 `waking`，就删掉；isolate 不参与，它的孤儿 worker 由 recovery poll 停掉。
   - 领导者：一个专用连接持有 advisory lock，会话设 `tcp_keepalives_idle=10`、`interval=5`、`count=3`，每 2 s `SELECT 1`，带 3 s 的客户端超时，超时或失败即卸任并停下领导者的循环，所以半开连接上的旧领导者在服务端释放锁之前就已经停手。领导者跑回收器、Scheduler、接管、孤儿 Pod 和 worker 清理、死副本行清理、Provider 收敛、ADR 0024 的采样和清扫。Scheduler 的认领是条件更新 `UPDATE delivery SET state='delivering', replica=$me WHERE id=$1 AND state='due'` 并检查行数；取得领导权时只把 `replica` 已死的 `delivering` 行放回 `due`，不是全部。
5. **Guard 跨副本。** 状态从内存 Map 搬到 `guard` 行。失败只由 CAS 赢家或唤醒者记录，在 `FOR UPDATE` 事务里过滤时间窗、追加、判定隔离。`unquarantine` 删行并发通知。规则和 Policy 字段不变。
6. **副本优雅退出。** readiness 先失败，`preStop` 等 5 s 让 Endpoints 收敛，再关连接、删自己的 `lease_tally` 和 `replica` 行。流经它的 WebSocket 断开，客户端经别的副本重连，和 M1 重启的后果相同。
7. **单机 Compose 是 N=1 的特例。** 领导锁立即取得，通知是进程内事件，SQLite 的 `transaction` 本来独占。启动时按 `pneuma-space.role` 标签列容器，与实例行比对，规则同 ADR 0019 第 5 条的收养。不保留一份内存版 Lifecycle，两份状态机迟早漂移。
8. **purge 的清理在每个副本上做。** 收到 `app/<name>` 通知而行已不在，副本丢掉本地视图和状态；拥有 `instance`、`lease_tally`、`guard`、`instance_log`、`stats` 行的组件各自删掉该 App 的行（删除幂等，多副本重复无害）。`deleteApp` 只删 Registry 自己的表。

理由：热请求零 IO 靠本地租约和镜像，正确性靠 CAS，两者分开，库上只有边沿写。领导者承担周期性工作但不承担互斥，所以领导者的任何故障都只让回收和投递延迟。

拒绝：每个实例一个属主副本、别的副本转发给属主（(N-1)/N 的请求和所有长连接多一跳，属主一死连接全断，属主迁移又是一套协议）；每个请求都在库里加减租约（每请求两次写，热应用的行成热点）；组织入口按应用名哈希粘到一个副本（不是每家入口都有一致性哈希，副本数一变两个副本会同时自认属主，库里的锁还是要有；可以作为以后的优化放在本决定之上）；给 Compose 保留内存版 Lifecycle。

后果：M1 验证过的内存 Lifecycle 要重写，是 M2 风险最大的单元，完成标准见 ADR 0019 第 11 条。通知丢失时唤醒等待最坏拉长到 500 ms。`app` 行多一列 `version`，Delivery 行多一列 `replica`，RouteView 带 `version`。领导者失联由服务端 keepalive 检测，约 25 s，托管 PostgreSQL 可能不允许会话级改这些参数，只影响回收和投递的延迟。DESIGN 1.2 里 Instance、Lease 的"内存"一列改为"平台库，副本内有镜像和本地租约"。
