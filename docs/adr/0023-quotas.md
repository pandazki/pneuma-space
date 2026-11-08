# ADR 0023：配额与资源

状态：**M2 决定**。设计探索稿 M2-D4 第 1 节。

决定：

1. **每实例两个 Policy 字段**，全局和按应用覆盖，合并规则同现有字段。

   | 字段 | 单位 | 默认 | container | isolate |
   | --- | --- | --- | --- | --- |
   | `cpu_millis` | 千分之一核 | 1000 | Pod `limits.cpu`；`requests.cpu` 是部署级 `PNEUMA_SPACE_CPU_REQUEST_MILLIS`（默认 100）；Docker `NanoCpus` | 不适用，worker 共享 runner 的 CPU，3 s 心跳是它的上界；记 0 |
   | `memory_mb` | MiB | 256 | Pod `requests.memory = limits.memory`；Docker `Memory` | 启动消息带 `heapMb`，`maxOldGenerationSizeMb` 用它，堆外预算同值；runner 的 `PNEUMA_SPACE_RUNNER_WORKER_HEAP_MB` 和 `_OFFHEAP_MB` 变成上限，超出时按上限起并记 `memory-clamped` 事件 |

   两个字段改变实例的形状：改它们和改 Injection 一样触发退役，`pneuma-space.spec` 的哈希算进它们。按应用覆盖不得超过本租户的 `cpu_millis` 和 `memory_mb` 总额，否则设置时 400。
2. **每租户 `Tenant.quota`**，建租户时从常量 `DEFAULT_QUOTA` 拷贝并存储（改常量不影响已有租户，与 `db_backend` 写进 override 同一模式），`null` 表示不限，只有平台管理员能改。

   | 字段 | 默认 | 计什么 | 在哪拒绝 |
   | --- | --- | --- | --- |
   | `apps` | 100 | 本租户状态不是 `purging` 的 App 行（`removed` 仍占名字和数据） | 首次发布，插 App 行的事务里 |
   | `awake` | 20 | 本租户 `waking`、`awake`、`draining`、`stopping` 的实例行，任何运行时 | 唤醒的 CAS 事务里（ADR 0020） |
   | `cpu_millis` | 20000 | 上述实例行上记下的 `cpu_millis` 之和 | 同上 |
   | `memory_mb` | 8192 | 上述实例行上记下的 `memory_mb` 之和 | 同上 |
   | `storage_gb` | 20 | 本租户全部 Binding 的实测字节之和 | 发布将要新建 Binding 行时；同样能力的重新发布照常通过，超额的团队仍能发修复 |

3. **平台库计数，在租户行锁下。** 唤醒事务先 `SELECT ... FROM tenant WHERE name=$1 FOR UPDATE`，再对本租户的实例行 `count` 和两个 `sum`，与 `quota` 比较，通过则把实例行置 `waking` 并写入这次的 `cpu_millis`、`memory_mb`（取自有效 Policy，之后改 Policy 不改在跑实例的占用）。锁只串行化同一租户的唤醒，持有时间是一次索引扫描，事务里没有网络和 K8s 调用。判定是 `model.ts` 里的纯函数 `admits(quota, used, ask) -> Refusal | null`，发布和唤醒两处调用。
4. **存储实测**由领导者每 15 min 采样一次写 `storage_usage(app, kind, provider, bytes, measured_at)`，每行覆盖：files 和 SQLite 在 K8s 读 kubelet `stats/summary` 里卷的 `usedBytes`，单机一次 Docker `GET /system/df`；PostgreSQL 查 `pg_database_size`；object 读对象服务的按 bucket 用量。kv 不计。
5. **拒绝的形状。** 新错误 `QuotaExceeded extends Conflict`，带 `{tenant, resource, used, limit, ask}`。发布答 409，体带 `quota` 字段，`appctl` 原样打印；唤醒答 503 加 `Retry-After: 30`，请求记录 `refused` 为真，与 Backoff、Quarantined 同族，不算唤醒失败，Guard 不计数；投递的配额拒绝不消耗 `attempts`，`next_attempt_at` 后移 30 s。事件 `quota-refused {tenant, resource, used, limit, action}` 同一 `(tenant, resource)` 每分钟至多一条。`GET /api/tenants/<t>/quota` 返回 `{quota, used, storageMeasuredAt}`，团队页画已用对上限的条。

理由：ResourceQuota 做不了执行点：runner Pod 是共享的，isolate 实例逃过它；单机版没有它；应用数和对象存储量表达不了；它的拒绝发生在 Pod 创建时，已经在唤醒中途，而且只是一个 403。平台库计数无论如何都要有，ResourceQuota 只会成为第二个真相源。锁下 `count` 和 `sum` 比租户上的计数器列便宜且永远正确，计数器在崩溃和重试下会漂移。`requests.cpu` 不等于上限，因为每个醒着但空闲的实例预留整份 CPU 会让四核节点只放得下四个默认实例，违背 G2；内存不可压缩，超卖会让无辜的 Pod 被 OOM，所以 request 等于 limit。

拒绝：K8s ResourceQuota 做租户配额（运营者自己加的 ResourceQuota 或 LimitRange 拒绝了 Pod，就是一次带 K8s 原文的唤醒失败，平台不创建它）；Guaranteed QoS；cpu 和 memory 各拆成 request 和 limit 四个字段（三个没人会调）；用计数器列增减；配额满时驱逐本租户最久没有 Lease 的实例（reaper 在 `idle_seconds` 内本来就让出位置，503 窗口被抱怨再做）。

后果：租户行锁在 PostgreSQL 上加在唤醒的热路径上，同一租户的大量同时冷唤醒被串行，每个只等毫秒级，进 `tests/bench/runtimes.ts` 量。存储配额是 15 min 前的实测值，可以超；kind 和许多本地存储类不强制 PVC 大小，单个应用写满节点盘只能靠存储类挡；kv 不计入存储，大量写 Redis 的应用不受存储配额约束。
