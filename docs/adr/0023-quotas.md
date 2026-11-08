# ADR 0023：配额与资源

状态：**M2 决定**。设计探索稿 M2-D4 第 1 节。

决定：

1. **每实例两个 Policy 字段**，全局和按应用覆盖，合并规则同现有字段。

   | 字段 | 单位 | 默认 | container | isolate |
   | --- | --- | --- | --- | --- |
   | `cpu_millis` | 千分之一核 | 1000 | Pod `limits.cpu`；`requests.cpu` 是部署级 `PNEUMA_SPACE_CPU_REQUEST_MILLIS`（默认 100）；Docker `NanoCpus` | 不适用，worker 共享 runner 的 CPU，3 s 心跳是它的上界；记 0 |
   | `memory_mb` | MiB | 512 | Pod `requests.memory = limits.memory`；Docker `Memory` | 启动消息带 `heapMb`，`maxOldGenerationSizeMb` 用它，堆外预算同值；runner 的 `PNEUMA_SPACE_RUNNER_WORKER_HEAP_MB` 和 `_OFFHEAP_MB` 变成上限，超出时按上限起并记 `memory-clamped` 事件 |

   两个字段改变实例的形状：spec 哈希算 Injection 加这两个值；按应用的覆盖变化触发退役，全局默认的变化在下次唤醒生效。按应用覆盖不得超过本租户的 `cpu_millis` 和 `memory_mb` 总额，否则设置时 400。M1 的容器没有内存上限，`memory_mb` 的默认值是 G6"应用不改"的唯一例外：超过 512 MiB 的应用要在策略里声明，否则被 OOM 计为失败。
2. **每租户 `Tenant.quota`**，建租户时从常量 `DEFAULT_QUOTA` 拷贝并存储（改常量不影响已有租户，与 `db_backend` 写进 override 同一模式），`null` 表示不限，只有平台管理员能改。迁移建出的 `default` 租户每项都是 `null`：单机版和 M1 的验收行（AC-P-8 发 500 个应用、唤醒 20 个）不受配额约束，平台管理员要限它就显式设。

   | 字段 | 默认 | 计什么 | 在哪拒绝 |
   | --- | --- | --- | --- |
   | `apps` | 100 | 本租户状态不是 `purging` 的 App 行（`removed` 仍占名字和数据） | 首次发布，插 App 行的事务里 |
   | `awake` | 20 | 本租户 `waking`、`awake`、`draining`、`stopping` 的实例行，任何运行时 | 唤醒的 CAS 事务里（ADR 0020） |
   | `cpu_millis` | 20000 | 上述实例行上记下的 `cpu_millis` 之和 | 同上 |
   | `memory_mb` | 10240（20 个默认实例） | 上述实例行上记下的 `memory_mb` 之和 | 同上 |
   | `storage_gb` | 20 | 本租户 files 和 SQLite 的 StorageBinding 数乘以已供应容量（K8s 是 `PNEUMA_SPACE_K8S_VOLUME_SIZE`，单机是同名的标称值 `PNEUMA_SPACE_VOLUME_SIZE`，默认 1Gi，不强制）；PostgreSQL 库和 bucket 不计 | 发布将要新建 StorageBinding 行时；同样能力的重新发布照常通过，超额的团队仍能发修复 |

3. **平台库计数，在租户行锁下。** 唤醒事务先 `SELECT ... FROM tenant WHERE name=$1 FOR UPDATE`，再对本租户的实例行 `count` 和两个 `sum`，与 `quota` 比较，通过则把实例行置 `waking` 并写入这次的 `cpu_millis`、`memory_mb`（取自有效 Policy，之后改 Policy 不改在跑实例的占用）。锁只串行化同一租户的唤醒，持有时间是一次索引扫描，事务里没有网络和 K8s 调用。判定是 `model.ts` 里的纯函数 `admits(quota, used, ask) -> Refusal | null`，发布和唤醒两处调用。
4. **存储按已供应容量计，不实测。** 四个采样器（kubelet、Docker、`pg_database_size`、bucket 用量）和 15 min 的陈旧值都省掉，`storage_usage` 表不建。代价是 PostgreSQL 库、bucket 和 Redis 不受存储配额约束，运营者在服务层限制。
5. **拒绝的形状。** 新错误 `QuotaExceeded extends Conflict`，带 `{tenant, resource, used, limit, ask}`。发布答 409，体带 `quota` 字段，`appctl` 原样打印；唤醒答 503 加 `Retry-After: 30`，请求记录 `refused` 为真，与 Backoff、Quarantined 同族，不算唤醒失败，Guard 不计数；投递的配额拒绝不消耗 `attempts`，`next_attempt_at` 后移 30 s。事件 `quota-refused {tenant, resource, used, limit, action}` 同一 `(tenant, resource)` 每分钟至多一条。`GET /api/tenants/<t>/quota` 返回 `{quota, used}`，团队页画已用对上限的条。

理由：ResourceQuota 做不了执行点：runner Pod 是共享的，isolate 实例逃过它；单机版没有它；应用数和对象存储量表达不了；它的拒绝发生在 Pod 创建时，已经在唤醒中途，而且只是一个 403。平台库计数无论如何都要有，ResourceQuota 只会成为第二个真相源。锁下 `count` 和 `sum` 比租户上的计数器列便宜且永远正确，计数器在崩溃和重试下会漂移。`requests.cpu` 不等于上限，因为每个醒着但空闲的实例预留整份 CPU 会让四核节点只放得下四个默认实例，违背 G2；内存不可压缩，超卖会让无辜的 Pod 被 OOM，所以 request 等于 limit。

拒绝：K8s ResourceQuota 做租户配额（运营者自己加的 ResourceQuota 或 LimitRange 拒绝了 Pod，就是一次带 K8s 原文的唤醒失败，平台不创建它）；Guaranteed QoS；cpu 和 memory 各拆成 request 和 limit 四个字段（三个没人会调）；用计数器列增减；配额满时驱逐本租户最久没有 Lease 的实例（reaper 在 `idle_seconds` 内本来就让出位置，503 窗口被抱怨再做）。

后果：`quota-refused` 的每分钟节流是每副本一份，N 个副本最多 N 条；存储准入在租户锁下判定而 Binding 行在 Provider 的 IO 之后才写，同一租户并发发布可能一起通过；把 `db_backend` 切到 sqlite 新建的 SQLite Binding 不经存储准入。租户行锁在 PostgreSQL 上加在唤醒的热路径上，同一租户的大量同时冷唤醒被串行，每个只等毫秒级，进 `tests/bench/runtimes.ts` 量。存储配额是供应量不是用量：许多本地存储类不强制 PVC 大小，单个应用写满节点盘只能靠存储类挡。
