# 总体设计（M1、M2）

PneumaSpace 把有状态的 web 应用部署到一台可信机器上，M2 起也部署到一个组织的 K8s 集群上。应用声明需要的能力，平台提供并注入；地址稳定，计算按需启动、闲置停止，数据只在清除时删除。目标、能力清单、应用类型、范围、验收数字和信任边界在 `REQUIREMENTS.md` 和 `REQUIREMENTS-M2.md`。应用看到的协议在 `docs/app-contract.md`。每个关键决定的理由在 `docs/adr/`。本文只写模型和结构。

## 1 领域模型

### 1.1 一段话

**App** 是一个名字，名字就是地址。每次发布产生一个不可变的 **Release**：镜像（静态站点没有）、**Manifest**、静态 **Bundle**（没有静态目录时没有）。Manifest 声明 **Capability**。resource 类能力由它的 **Provider** 创建 **Resource**，平台记为 **Binding**（每 App、每 kind、每 Provider 一条，带 `active / suspended` 状态；`rtc` 这种只注入配置的能力 Resource 为空）；ingress 和 schedule 类能力由一个固定组件负责，只改变网关对这个地址的处理。**Injection**（环境变量和挂载）由当前 Release 的 Binding 推导，容器创建时应用，从不存储。**Instance** 是当前 Release 的运行实例（容器、Pod 或 runner 里的 worker），只在持有 **Lease** 时保持运行。**Trigger** 是平台调用应用的入口，每次调用是一条持久的 **Delivery**。**Principal** 由 IdentityProvider 解析，以请求头注入。**Policy** 是运营者状态。**Tenant** 是 App 的归属单位，配额、统计和审计按它算；**User** 经 **Membership** 以 `admin` 或 `member` 属于租户，**Token** 也属于一个租户。平台模型里没有应用类型，没有 Agent。

### 1.2 实体

| 实体 | 键 | 字段 | 存放 | 唯一写者 |
| --- | --- | --- | --- | --- |
| App | `name`，文法 `^[a-z][a-z0-9-]{0,39}$` | `id`（不透明，首次发布生成；所有内部资源名和容器名用它，`name` 只用于地址）, `owner`, `tenant`, `access: tenant / org / public`（默认 `org`，ADR 0022）, `status`, `current`, `policy_override` | 平台库 | Registry |
| Release | `(app, number)` | `image?`（Docker 平面是镜像 id，K8s 平面是 `<registry>/<repo>@sha256:...`，ADR 0019）, `manifest`, `bundle?`, `release_key = sha256(image, manifest, bundle)`, `published_at` | 平台库 | Registry |
| Manifest | 值对象 | `contract`, `capabilities: kind -> declaration` | Release 内 | 发布边界解析一次，下游不再校验 |
| Binding | `(app, kind, provider)` | `state: active / suspended`（行是真相，后端向行收敛）, `resource`（Provider 私有：卷名、库名和口令、ACL 用户、bucket 和密钥） | 行在平台库；资源在该 Provider 的后端服务和命名卷里 | 行由 Registry 写，资源由该 Provider 写 |
| Policy | 全局一行；每 App 的 override 存在 `App.policy_override` | `idle_seconds=60`, `ready_timeout_seconds=15`, `drain_timeout_seconds=30`, `connection_idle_seconds=21600`, `trigger_timeout_seconds=600`, `db_backend=sqlite`, `cpu_millis=1000`, `memory_mb=256`（ADR 0023）；全局另有 `timezone`（cron 用，默认 UTC）和 `usage_retention_days=90`, `events_retention_days=14`, `events_max_rows=1000000`（ADR 0024） | 平台库 | Registry |
| Trigger | `(app, name)` | `schedule?`（cron，空表示只按需） | 平台库，随 Release 在同一事务重写 | Registry |
| Delivery | `id` | `app`, `trigger`, `scheduled_for`, `caller?`, `idempotency_key?`, `body`, `state`, `attempts`, `next_attempt_at` | 平台库 | Scheduler |
| Token | `id` | `tenant`, `subject`（服务令牌 `service:<tenant>.<name>`，个人令牌是签发人的 `user:<id>`，M1 迁来的保留 `service:<name>`）, `label`, `hash`（`sha256`）, `created_by`, `created_at`, `revoked_at` | 平台库 | Registry；IdentityProvider 只读 |
| Tenant | `name`，文法同 App | `display`, `quota`（`apps`, `awake`, `cpu_millis`, `memory_mb`, `storage_gb`；建租户时从 `DEFAULT_QUOTA` 拷贝，`null` 不限，ADR 0023）, `created_at` | 平台库 | Registry |
| User | `id`（主体去掉 `user:`） | `name`, `groups`（只显示）, `first_seen`, `last_seen` | 平台库，首次经过上游时登记 | Registry（认证路径经 `registry.sighted()`） |
| Membership | `(tenant, user)` | `role: admin / member`；每个租户至少一个 `admin` | 平台库 | Registry |
| Bundle | `sha256(tar)` | 文件索引 `path -> (size, etag, content_type)`；tar 内路径相对 `static.dir`（isolate 发布的代码包相对应用根，静态根为 `static.dir`，ADR 0017） | 对象存储 `pneuma-space-bundles/<sha256>/` | BundleStore |
| Stats | `app` | `last_access_at`（经过网关的请求，含静态路径；对象读不经网关，不计入。闲置判断只看 Lease） | 内存，每 10 s 以 `max(旧, 新)` 写平台库 | Ingress |
| Instance | `app` | 表 `instance`：`runtime`, `release`, `spec_hash`, `epoch`, `state`, `actor`, `handle`, `address`, `node`, `home`, `since`, `awake_at`, `cpu_millis`, `memory_mb` | 平台库，副本内有镜像和本地租约（ADR 0020） | Runtime，只经 CAS |
| Guard 状态 | `app` | 表 `guard`：`release`, `failures`, `quarantine_reason`, `quarantined_at`（ADR 0017） | 平台库，副本内有镜像 | Guard，事务里读改写 |
| Lease | 持有者的线程；跨副本按 `(app, replica)` 计 | `kind: request / channel / trigger`, `on_retire?`；表 `lease_tally`：`epoch`, `request`, `channel`, `trigger`, `released_at` | 平台库，副本内有镜像和本地租约 | Runtime（Ingress 和 Scheduler 只通过 `acquire` 和 `release` 取得和归还）；每副本只写自己的 `lease_tally` 行 |
| Replica | `id`（`PNEUMA_SPACE_REPLICA`，单机取主机名） | 表 `replica`：`started_at`, `seen_at` | 平台库 | 每副本自己心跳；领导者删死副本的行 |
| Usage | `(app, step, start, replica)`，`app` 为 `'*'` 表示整个平台 | `tenant`（写入时的）, 请求、错误、唤醒、休眠、投递结果的计数, `wake_ms`, `awake_ms`；每 App 只有 3600 s 步长，`'*'` 另有 60 s 步长 | 平台库，保留 `usage_retention_days` | Metrics，每副本只写自己的行，写绝对值（ADR 0024） |
| Event | `id`，全局递增 | `at`（库时钟）, `replica`, `ev`, `app`, `tenant`, `body` | 平台库，按 `events_retention_days` 和 `events_max_rows` 清扫；同时写 stdout | Metrics |
| Audit | `id` | `at`, `actor`, `actor_tenant`, `tenant`, `action`, `target_kind`, `target`, `result`, `details`（不含密钥） | 平台库，只追加，触发器拒绝改删 | 管理边界：路由表的每个变更路由声明 `audit` |
| InstanceLog | `app` | `release`, `ended_at`, `reason`, `tail`（最后 200 行，至多 64 KiB） | 平台库，每 App 一行覆盖 | Runtime，K8s 平面删 Pod 前写 |
| Metrics | 每副本一份 | 当前桶的累计、最近 1000 条请求记录（ADR 0016，每条同时写 stdout）、平台服务探测结果、宿主机样本 | 内存，不持久 | Metrics |
| 平台密钥 | 单文件 | cookie 签名密钥，只用于 `local` 身份 | `/data/pneuma-space.secret`，首次启动生成 | Registry |

有效 Policy 是全局行覆盖上 App 的 override，读时合并，不存合并结果。全局 Policy 是 Registry 持有的一个内存快照，写入时整体替换，所以全局变更立即对所有 App 生效；RouteView 只存该 App 的 override。一个 App 第一次 `ensure` `db` 时，Registry 把当时的全局 `db_backend` 写进这个 App 的 override，之后该 App 的 `db` Provider 只由 override 决定。所以改全局值只影响还没有 `db` Binding 的 App；改某个 App 的 override 才会为它 `ensure` 另一个 Provider 并退役实例；有 `db` Binding 的 App 不能清掉这个 override。一个 kind 可以有多条 Binding（`db` 切换后端时 SQLite 和 PostgreSQL 各一条）；注入时取 `active` 且 Provider 等于有效 Policy 所选的那条。`local` 模式的浏览器会话是平台密钥签名的 cookie，没有 Session 表，主体就是登录页输入的名字，`user:<name>`。`upstream` 模式没有平台会话，每个请求带上游签名的 JWT（ADR 0021）。平台管理员不落库，每个请求按 `PNEUMA_SPACE_PLATFORM_ADMINS` 判定（ADR 0022）。

### 1.3 能力与 Provider

Provider 不知道应用用哪种运行时：`inject` 给出的存储绑定是中立的（存储 id、挂载目标、带 `{dir}` 占位的环境变量模板），容器运行时落成 volume 挂载，isolate 运行时落成 runner 卷里的目录（ADR 0017）。Provider 也不知道部署平面；它只多声明一个只读的 `service`（连哪个平台服务），Registry 把它放进 Injection，K8s 平面据此给 Pod 打可达标签（ADR 0019 第 10 条）。

`CAPABILITIES` 是唯一的能力清单：每个 kind 映射到类别、声明解析器和它的 Provider 实现（`db` 有 SQLite 和 PostgreSQL 两个实现，由有效 Policy 为每个 App 选一个；其余 kind 各一个）。每条 Binding 恰好属于一个 Provider 实现。环境变量、发布时要调用的 Provider、网关读取的标志都从它推导，导入时断言枚举和表一致。

| kind | 类别 | Resource 或负责组件 | `ensure(app)` | `inject` | `suspend` | `destroy` |
| --- | --- | --- | --- | --- | --- | --- |
| `route` | ingress，隐式 | Ingress | | 前缀头 | | |
| `files` | resource | 卷 `pneuma-space-files-<id>` | 建卷 | 挂载 `/data` | 无 | 删卷 |
| `db` | resource | SQLite：卷 `pneuma-space-db-<id>`；PostgreSQL：库和角色 `app_<id>` | 建卷，或建角色和库、`REVOKE CONNECT FROM PUBLIC` | 连接 URL | `NOLOGIN`（`ensure` 恢复 `LOGIN`） | 删卷，或删库删角色 |
| `kv` | resource | Redis ACL 用户 `app_<id>`，键和频道限 `<id>:*` | `ACL SETUSER` | 连接 URL，前缀 | ACL `off`（`ensure` 恢复 `on`） | `SCAN` + `UNLINK` 前缀，`ACL DELUSER` |
| `object` | resource | bucket `app-<id>`，限该 bucket 的密钥对，`public/*` 匿名读策略，CORS | 建 bucket、策略、密钥 | 端点、bucket、密钥 | 撤销匿名读、禁用密钥（`ensure` 恢复） | 删对象、bucket、密钥 |
| `static` | ingress | Ingress（Bundle 不是能力资源，是 Release 的制品，由 BundleStore 存取；purge 时删除没有别的应用的 Release 引用的，与提交引用它的 Release 按 bundle 互斥，ADR 0028） | | 无，网关直接服务 | | |
| `ws` | ingress | Ingress | | | | |
| `cron` | schedule | Scheduler（Trigger 行是 Release 的一部分，随它由 Registry 写） | | | | |
| `identity` | ingress | IdentityProvider | | | | |
| `rtc` | resource | 无每 App 资源；TURN 共享密钥是部署环境变量 `PNEUMA_SPACE_RTC_SECRET`，coturn 和网关都读它 | 检查 `coturn` 在平台网络上并接受连接（ADR 0030；Compose 的 profile 未开时发布 409） | `stun:<host>:3478` 和 `turn:<host>:3478?transport=udp`，`<host>` 取部署环境变量 `PNEUMA_SPACE_RTC_PUBLIC_HOST`（默认 `127.0.0.1`），加该密钥 | 无 | 无 |

每个操作可重复执行。`ensure` 对已存在的 Binding 也会执行，收敛后端漂移并把 `suspended` 置回 `active`；没有单独的 resume。`db` 的 PostgreSQL Provider 用网关的线协议客户端 `pg.ts`，`kv` Provider 用网关内一个最小的 RESP 客户端，以管理角色直接连服务供应，两个平面相同，没有供应任务（ADR 0025 第 9 条）；`object` Provider 和 BundleStore 用 `node:crypto` 签名的 HTTP 直接调用对象服务的 S3 和管理接口（ADR 0013）。网关不用 npm 驱动。平台库和平台密钥在命名卷 `gateway-data`（挂载为网关的 `/data`）；后端数据在 `rustfs-data`、`redis-data`（AOF）、`postgres-data`，以及每 App 的 `pneuma-space-files-<id>`、`pneuma-space-db-<id>`；这些卷在平台重启和 `docker compose down` 后都保留。`<id>` 是 `App.id`。K8s 平面上每 App 的卷是应用命名空间里同名的 ReadWriteOnce PVC，首次唤醒时创建，`remove` 不碰，`purge` 删除（ADR 0019 第 7 条）。

### 1.4 状态机

App：`(无) --publish--> registered --remove--> removed --publish--> registered`；`removed --purge--> purging --> (无)`。`remove` 把该 App 的所有 Binding 置 `suspended`（凭据失效，数据保留），地址 404；`publish` 把当前 Release 声明的 kind 置 `active`（`ensure`），未声明的置 `suspended`；`purge` 销毁所有 Binding 的资源，不论状态；`purging` 持久化，重启后续跑。只能从 `removed` 进入 `purging`。

Instance：`asleep --acquire--> waking --就绪--> awake`；`awake --无 Lease 且闲置到期--> stopping --> asleep`；`awake --retire--> draining --Lease 清空或到期--> stopping --> asleep`（容器或 Pod 删掉，实例行留下，handle 为空，下次唤醒用新 Release）；`asleep --retire--> asleep`，直接删掉停止的容器。`waking` 就绪超时回到 `asleep`，等待者得到 502。所有转换在该实例自己的锁内，没有全局锁；多副本时这把锁是实例行上带 `state` 和 `epoch` 的条件更新（ADR 0020）。`awake -> stopping` 要求 Lease 集合为空，`acquire` 在同一把锁内加 Lease，所以二者不会同时成立。`docker stop` 在锁外执行，期间到达的请求等待后重新唤醒，代价是一次多余的停启，不是被切断的连接。

Delivery：`due --worker 取走--> delivering --2xx--> done`；非 2xx、超时、连接丢失回到 `due` 并退避，第 5 次失败进入 `failed`；`removed` 或 Trigger 不再声明时 `cancelled`。认领者已死或已重启的 `delivering` 由领导者周期地放回 `due`；只有仍在认领下的尝试，其结果才写入（ADR 0029）。

Lease：`request` 从 acquire 到响应体最后一个字节写完，客户端断开不提前释放；响应是 WebSocket 101 或 `text/event-stream` 时改为 `channel`，直到任一端关闭；`trigger` 覆盖一次投递。闲置停止从不结束 Lease。平台进程存活期间只在三种有界、可见的情况下主动结束 Lease：`draining`（对 `channel` 发 WebSocket close 1001，对 `request` 和 `trigger` 等到 `drain_timeout_seconds`）；`channel` 超过 `connection_idle_seconds` 没有字节（close 1001，客户端重连会再唤醒）；`trigger` 超过 `trigger_timeout_seconds`（关闭连接，该次尝试记为失败并按退避重试）。平台重启丢失所有 Lease：连接断开，客户端重连，`delivering` 的投递重投；一个副本退出只丢失流经它的 Lease（ADR 0020 第 6 条）。Delivery 被 `cancelled` 时正在进行的尝试跑完，不再有下一次。

### 1.5 不变量由谁保证

| ID | 保证 |
| --- | --- |
| INV-1 | 地址只从 `App.name` 推导。Release 号、容器名、节点、租户从不出现在 URL 里；子域名和路径两种地址都只由名字决定。 |
| INV-2 | Binding 行只由 `publish` 和 `db_backend` 变更创建，只由 `purge` 删除；`remove` 和 `publish` 只改它的 `state`；资源只由 `purge` 销毁；`purge` 只能从 `removed` 进入。 |
| INV-3 | `awake -> stopping` 要求 Lease 为空；流、长连接、触发执行都是 Lease。平台进程存活期间只有 1.4 列出的三种有界情况会由平台结束 Lease，它们都不是闲置停止；重启是例外，1.4 写明了后果。 |
| INV-4 | Delivery 在任何尝试前已持久；投递通过 `trigger` Lease 唤醒实例；重启后 `delivering` 回到 `due`。上限：连续 5 次失败后 `failed` 并在控制台可见，停机期间错过的槽位只补最近一个。 |
| INV-5 | Ingress 丢弃所有入站 `X-Pneuma-Space-*`；`upstream` 模式另丢弃上游身份头（值是 JWT 时）和 `PNEUMA_SPACE_IDENTITY_STRIP_COOKIES` 列出的 cookie，应用拿不到能在控制台重放的凭据。身份头只从 `IdentityProvider.authenticate` 的结果设置。主体本身可信到什么程度由 Provider 决定：本地桩是自报姓名，只在可信机器上有意义；`upstream` 的主体来自验签的 JWT，K8s 平面上只有网关能到达实例，身份头因此不可伪造（ADR 0021）。 |
| INV-6 | `publish` 写新 Release 并移动 `App.current`，不碰 `name`、`id`、`owner` 和任何 Binding 的资源，只改 Binding 的 `state`；`registered` 时相同 `release_key` 是空操作。 |
| INV-7 | 注册、版本、策略、Binding 行、Token、租户和成员在平台库里（单机是 `/data` 的 SQLite，集群是 PostgreSQL）；每个 Provider 的数据在它的服务和卷里（1.3 节）；Instance 行在平台库，启动时与按标签列出的容器或 Pod 比对；Delivery 从库恢复；Stats 从库加载。 |
| INV-8 | 契约固定的是协议：`db` 是一个 SQL 连接 URL，`kv` 是 Redis 协议，`object` 是 S3 协议，推送是 WebSocket 和 SSE。应用看不到谁在哪里提供它们。残留只在 `db`：URL 的 scheme 决定应用要带哪个驱动，SQL 要写两种数据库共有的子集；示例 SDK 两者都处理。 |
| INV-9 | 每条 Binding 恰好属于一个 Provider 实现，每个 ingress 和 schedule kind 恰好有一个负责组件（1.3 节）；Registry 写 Binding 行，Provider 写资源，Runtime 应用 Injection（环境变量和挂载），Ingress 注入请求头，没有别的路径。 |
| INV-10 | 对象字节在浏览器和对象服务之间移动，静态字节在对象存储和网关之间移动，两条路径都不经过 `acquire`。 |
| INV-11 | 每个 App 在整个集群同一时刻至多一个 Instance，只靠实例行上带 `state` 和 `epoch` 的条件更新保证，领导者错位或两个副本同时自认领导都不产生第二个（ADR 0020）。新 Release 的实例在旧实例 `draining` 结束、旧容器或 Pod 消失后才创建，所以两个进程不会同时打开一个 `/data` 或 SQLite 文件。 |
| INV-12 | 配额按租户，只在两处判定，都在租户行锁下：插 App 行或 files、SQLite 的 Binding 行的事务里（发布和 `db_backend` 变更，判定和插行同一事务，Binding 行先于 `ensure`，ADR 0028），唤醒的 CAS 事务里。用量取自平台库的计数和已供应的卷容量，不存计数器（ADR 0023）。超额是带原因的拒绝，不是失败，Guard 不计数。 |

## 2 架构

### 2.1 组件

网关进程（Node.js LTS，只用内置模块：`http` 和 `net` 做代理和字节中继，`node:sqlite`，`net` 和 `tls` 上的 PostgreSQL 线协议，`https` 上的 K8s API，`crypto`，`child_process`；TypeScript 由 Node 原生执行，没有构建步骤，没有运行时依赖），下列组件各自拥有不同的状态。单机一个进程；集群上多个副本，任一副本处理任一请求。单机的平台服务由 Compose 启动，应用容器在 `pneuma-space` 网络上，不发布端口。

| 组件 | 拥有 | 从不做 |
| --- | --- | --- |
| Registry | 平台库里 App、Release、Binding、Policy、Trigger、Token、Tenant、User、Membership 的行；每 App 的只读 RouteView，在任何改变该 App 行的命令后重建，其他副本经变更通知重建；publish、remove、purge、policy、owner、access、tenant、token、member、quota 命令，同一应用名的命令经 `Store.exclusive` 互斥，同一 bundle 的提交和删除经 `Store.exclusiveBundle` 互斥 | 直接调 Docker 或 K8s（镜像引用的解析走 `Infra.resolveImage`）；连应用 |
| Ingress | 8080 请求路径：取应用名、访问范围检查、身份头、静态服务、流式和 WebSocket 转发、通过 `acquire` 取得 request 和 channel Lease、Stats | 写平台库（只读 RouteView，只写 Stats） |
| Runtime | Instance 行、本副本的 Lease、三张表的镜像、reaper；`Runtimes` 门面按 RunSpec 分发到 `RUNTIMES` 表里的实现：`container`（Docker 容器或 Pod）和 `isolate`（runner 服务，`--profile isolate` 或 StatefulSet）（ADR 0017、0019） | 读 Manifest（只接收 Injection 集合）；计失败或隔离（那是 Guard 的事） |
| Guard | 订阅生命周期事件，按 Policy 计失败、退避和隔离，状态在 `guard` 行，acquire 前被问；一处实现覆盖所有运行时和副本 | 探活（那是各运行时的事） |
| Infra | 只有 `resolveImage`，供发布用，与应用的运行时无关（ADR 0025 第 9 条） | 应用生命周期；供应 |
| Scheduler | 读 Trigger，写 Delivery（包括 Ingress 转来的按需 `invoke`），cron 计算，投递 worker；集群上只在领导者跑 | 除 `acquire` 和应用触发端点外的一切 |
| Providers | 每种资源 kind 一个；`ensure`、`inject`、`suspend`、`destroy`；BundleStore；IdentityProvider（`local` 或 `upstream`） | 互相调用；写平台库 |
| 认证与授权 | `jwt.ts` 验上游 JWT（只用 `node:crypto` 和 `fetch`，ADR 0021）；每请求至多认证一次，得到 `Caller`；`authz.ts` 的 `ACTIONS` 表和纯函数 `can(caller, action, tenant)` 是管理 API 唯一的授权判定；成员和令牌缓存，按 `tenant/<name>` 通知失效（ADR 0022） | 写库（User 行经 `registry.sighted()` 由 Registry 写） |
| Store | `SqliteStore` 或 `PgStore`（`pg.ts`），DML 只写一次，在 `sql.ts`；`transaction`（PostgreSQL 上 `SERIALIZABLE`，冲突重跑）、`exclusive`（按应用名互斥）、`exclusiveBundle`（按 bundle 互斥，在命令里先应用名后 bundle）、行触发器在提交时向通道 `pneuma_space` 发变更通知（ADR 0025） | 业务判断；每张表的写者仍是 1.2 节那一列 |
| Metrics | 1.2 节的 Usage、Event 和 Metrics 行。订阅生命周期事件流（每行 JSON 日志同时发给订阅者），批量写 `events`；每 10 s 写本副本的 `usage` 行并读回总览的序列，采样 Runtime 的实例和 Lease 计数、Delivery 的状态计数、宿主机和平台服务可达性；`GET /api/metrics` 返回一份内存快照，每 App 的 Lease 计数、进入状态的时间和休眠时刻随列表返回（ADR 0015）；`GET /api/requests` 由接到请求的副本扇出到 `PNEUMA_SPACE_PEERS` 并归并，记录由 Ingress 和 Scheduler 写入内存环（ADR 0016）；`GET /api/nodes` 有人请求才采样；`/metrics` 在单独端口（ADR 0024） | 写这三张表之外的表；在请求路径上调 Docker、K8s 或网络（探测只在采样器里） |
| Console 和 CLI | 8081 管理边界；页面是总览（US-P-13 列的指标）、实时（ADR 0016）、拓扑（ADR 0018）和项目（US-P-6 列的字段，项目详情含 Release 列表、Delivery 列表和容器日志），`upstream` 模式另有团队页和租户切换器（ADR 0022 第 8 条），中英双语，明暗主题，单文件 HTML 内联 CSS、JS 和 SVG 图表，不加载外部资源；发布表单收镜像引用、manifest、可选 bundle 和首次发布时的 owner，引用由网关解析为镜像 id 或 digest；`appctl publish` 用 `--owner`（默认取环境变量 `PNEUMA_SPACE_OWNER`）；全局 Policy 和 owner 变更只有 `appctl`，`upstream` 模式的令牌只在团队页签发；`appctl` 先读 `pneuma-space.json`，需要容器时才 `docker build`（K8s 平面再 `docker push` 到 `PNEUMA_SPACE_REGISTRY`），有 `static` 时打包目录，再以 `PNEUMA_SPACE_TOKEN` 作 Bearer 调管理接口；管理接口的分发器按 `ACTIONS` 授权，按路由声明的 `audit` 在处理结束后写审计行（ADR 0024 第 6 条） | 任何业务逻辑；它们是薄壳 |

部署平面是 `PNEUMA_SPACE_PLANE`（默认 `docker`，或 `kubernetes`）。组合根 `main.ts` 按它选下表四个实现；Lifecycle、`Runtimes` 门面、Guard、Scheduler、Ingress、Registry、Providers 两个平面共用一份。K8s 是平面不是运行时，`RUNTIMES` 仍是两行（ADR 0019 第 1 条）。

| 接缝 | `docker` | `kubernetes` |
| --- | --- | --- |
| container 的 Driver | `DockerDriver` | `PodDriver`：实例是平台直接创建和删除的 Pod，经 `kube.ts`（只用 `node:https` 的 K8s API 客户端，ADR 0019 第 2、4 条） |
| isolate 的 runner 池 | 一个 `runner:8082` | runner StatefulSet，网关 watch 它的 Pod；带存储的应用固定在首次唤醒选定的 runner 上（ADR 0019 第 8 条） |
| `Infra.resolveImage` | 本地镜像 id | 组织仓库里的 digest |
| `Store` | `SqliteStore` | `PgStore` |

集群上周期性工作归领导者，即持有 advisory lock `pneuma-space.leader` 的副本：回收器、Scheduler、接管、孤儿 Pod 和 worker 清理、死副本行清理、Provider 收敛、`awake_ms` 和存储采样、观测数据清扫。正确性不靠领导者（INV-11），它失联只让回收和投递延迟（ADR 0020 第 4 条）。单机是 N=1 的特例。

单机平台库是 `/data/pneuma-space.sqlite3`（WAL），集群是一个独立的 PostgreSQL（`PNEUMA_SPACE_STORE_URL`），不与应用的 `db` 后端共用（ADR 0025）。每张表一个写者。`ensure` 和 `suspend` 的结果由 Registry 写回 Binding 行。发布在一个事务里写 Release、Trigger、Binding 和 `App.current`，这是用数据库而不是 JSON 文件的原因。列出 500 个 App 是一次查询加一次内存读，没有 Docker 或 K8s 调用。

Compose 服务：`gateway`、`rustfs`（S3 兼容对象服务）、`redis`（AOF）；`postgres` 和 `coturn` 在 profile 后面。M1 所有宿主机端口只绑定回环：8080、8081、RustFS 的 9000，以及 `rtc` profile 下 coturn 的 3478 和中继端口 49160 到 49200，所以访问者都在这台机器上；改绑定和 `PNEUMA_SPACE_RTC_PUBLIC_HOST` 是运营者在信任边界内的决定。

K8s 平面：命名空间 `pneuma-space` 放网关、runner 和集群内的平台服务，`pneuma-space-apps` 放实例 Pod 和 PVC；租户是 Pod 和 PVC 上的标签，不是命名空间。部署清单里固定几份 NetworkPolicy：只有网关能到达实例，实例只到得了自己 Binding 的服务（ADR 0019 第 3、10 条）。组织入口把 `*.<apps-domain>` 转到 8080，控制台主机和 API 主机转到 8081，三类主机都经上游，TLS 在入口终止（ADR 0019 第 9 条，ADR 0021 第 5 条）。

### 2.2 请求处理

每个请求先经过同一个前奏：

1. 取应用名。子域名模式（设了 `PNEUMA_SPACE_APPS_ORIGIN`）从 `Host` 取 `<name>.<apps-domain>` 的标签，整条路径是 `<rest>`；路径模式解析 `/apps/<name>/<rest>`，缺尾斜杠 308。一个部署只有一种模式（ADR 0019 第 9 条）。App 不存在或 `removed` 返回 404。
2. 转发的头里丢弃所有入站 `X-Pneuma-Space-*`；`upstream` 模式另丢弃上游身份头和 `PNEUMA_SPACE_IDENTITY_STRIP_COOKIES` 列出的 cookie（INV-5）。
3. 读 `<name>` 的 RouteView 快照：status、owner、声明的 kind、bundle 索引、Policy override（有效值读时与全局快照合并）。
4. `<rest>` 以 `_pneuma-space/` 开头是平台端点，见 D。
5. `access` 检查（ADR 0022 第 6 条），不够的请求得到 Challenge 或 403；`local` 模式跳过。认证每请求至多一次，结果复用给第 7 步和触发端点。
6. bundle 索引命中（含目录的 `index.html`）走 C。静态优先于容器，动态应用的前端资源不唤醒它。
7. 声明了 `identity` 时调用 `authenticate`。Challenge 直接回给客户端（浏览器 303 到 `/_pneuma-space/login`，`upstream` 模式到 `PNEUMA_SPACE_IDENTITY_LOGIN_URL`；其他 401）；声明为 `{"required": false}` 时不发 Challenge，未登录的请求以匿名转发、没有身份头，应用需要登录时自己 303 到 `/_pneuma-space/login?next=`。Principal 变成身份头。本地 IdentityProvider 的登录页只要一个名字，设置平台密钥签名的 cookie；服务令牌由 `appctl`（`local`）或团队页（`upstream`）签发，`Authorization: Bearer` 携带。
8. 没有镜像的 App 到这里返回 404。
9. `runtime.acquire(name, REQUEST)`，实例在睡则等待唤醒。

收尾：`runtime.release(lease)`，计数，记 `last_access_at`。

| 路径 | 处理 |
| --- | --- |
| A 普通请求和流式请求体 | 连到实例地址，发请求行、过滤后的头和 `X-Forwarded-Prefix`，64 KiB 块双向复制，`Range` 原样透传，没有大小上限。请求行发出前的连接失败可重试一次唤醒；发出后不重试，所以写操作不会重放。响应是 `text/event-stream` 时 Lease 改为 `channel`。响应的 `Set-Cookie` 去掉 `Domain` 属性，cookie 只落在应用自己的主机（ADR 0021 第 6 条）。 |
| B WebSocket | 未声明 `ws` 返回 426。原样转发升级请求，101 后两个线程双向复制字节直到任一端关闭。Lease 是 `channel`。超过 `connection_idle_seconds` 无字节时平台发 close 1001，客户端重连会再次唤醒。 |
| C 静态文件 | 无 Lease。按索引回 `ETag`、304、`Range`，从对象存储复制。静态站点没有冷启动。 |
| D 平台端点 | `POST _pneuma-space/trigger/<name>`：无论是否声明 `identity` 都先 `authenticate`，过 `access`，再要求 `service:` 主体或 owner；读最多 64 KiB 请求体，调用 `scheduler.invoke`（由 Scheduler 插入 `due` Delivery；带 `Idempotency-Key` 时同键在 24 h 内返回同一条），返回 202 和 id。其余 404。网关根下（子域名模式下每个应用主机的根下）的 `/_pneuma-space/login`、`/_pneuma-space/logout` 属于 IdentityProvider，`upstream` 模式下它们只是跳转（ADR 0021 第 3 条）。 |
| 触发投递 | worker 取 `due` 行置 `delivering`，`acquire(app, TRIGGER)` 唤醒，`POST /_pneuma-space/trigger/<name>` 到实例，带 delivery id、attempt、scheduled_for、caller。等待至 `trigger_timeout_seconds`。2xx 成功，其他回 `due` 退避。每个 App 同一时刻只有一个投递在飞。调度循环按 cron（5 字段，全局 `timezone`）在 `(上次完成, now]` 内插槽位，新建或改动的 Trigger 从发布时刻开始算，`(app, trigger, scheduled_for)` 唯一；停机补发最多一个槽位。 |

### 2.3 唤醒、休眠、退役、重启

下面的语义两个平面、任意副本数都成立。跨副本时实例、租约计数和 Guard 状态在平台库，副本内有镜像，热请求零 IO，每个转换是实例行上的 CAS 并发通知；快路径、慢路径、release、回收、退役、实例自己结束、接管和副本退出见 ADR 0020 第 4 到 6 条，快路径的前提、isolate worker 的归属和结束观测按 ADR 0027 修订。下文的容器操作是 Docker 平面的；K8s 平面的唤醒、休眠、日志和收养见 ADR 0019 第 5 条，休眠和退役都删 Pod。

唤醒（`acquire` 内）：App 不是 `registered` 时拒绝（Ingress 已 404，Scheduler 据此取消投递）。实例锁下看状态。`awake` 加 Lease 返回；`waking`、`stopping`、`draining` 等条件变量后重查；`asleep` 置 `waking` 成为唯一唤醒者，同一事务里做 Guard 准入和配额准入（INV-12）。按 `pneuma-space-<id>-<release>` 创建容器（已存在视为成功），标签 `pneuma-space.app`、`pneuma-space.release`、`pneuma-space.spec`（Injection 集合的哈希），注入 Injection 集合加 Runtime 自己给的 `PNEUMA_SPACE_APP` 和 `PNEUMA_SPACE_RELEASE`，`docker start`（已启动视为成功），inspect 一次取 IP 存为 `address`，避免 Docker DNS 对外部停止容器的 4 s 失败。轮询 8000 端口 TCP 直到就绪或 `ready_timeout_seconds`。

休眠（reaper 每 `min(idle_seconds, 10)` s，只遍历 awake 集合）：锁内 Lease 为空且闲置到期则置 `stopping`；锁外 `docker stop`，容器保留供下次 `docker start`；锁内置 `asleep` 并通知。

退役（Registry 在发布、改变 Injection 的 policy 变更、remove 之后调用）：`awake` 时置 `draining`，调用每个 `channel` 的 `on_retire`（WebSocket 发 close 1001，SSE 直接关闭连接），等待 Lease 清空至多 `drain_timeout_seconds`，`docker stop` 并 `docker rm`；`asleep` 时直接 `docker rm`。下一次 `acquire` 为当前 Release 建新容器。`purge` 先退役，再销毁每条 Binding 的资源和只有该 App 引用的 bundle，所以卷不会被容器占用。

重启：开平台库，加载实例行的镜像；领导者把认领者已死或已重启的 `delivering` 回 `due`（ADR 0029）。先核对实例，再续跑 `purging`（续跑要退役该 App 可能还活着的实例，所以核对在前）。领导者按标签 `pneuma-space.role=instance` 列出容器或 Pod，与实例行比对：没有对应行、或行的 `release`、`spec_hash`、`epoch` 与标签不符的删掉；行是 `awake` 而容器或 Pod 不在的，CAS 回 `asleep` 并发 `crashed`；其余保持行的状态（ADR 0019 第 5 条，ADR 0020）。每个副本订阅自己平面的结束事件（Docker `die`、Pod watch、runner 查询），观察到结束就做 CAS，赢家发事件。Provider 在后台对每条 Binding 按其 `state` 重跑 `ensure` 或 `suspend`，收敛后端可能丢失或与行不一致的状态（例如重建的 Redis 容器，或 ensure 和提交之间的崩溃）。

### 2.4 发布

运行时由清单的 `runtime` 决定，缺省按发布输入推断：镜像即 container，代码包即 isolate，只有 `static` 的清单没有运行时。isolate 应用的代码包含 `node_modules`，经 bundle 存储，和静态目录同一条路；runner 未启用时发布 isolate 应用答 409（ADR 0017，是否启用按 ADR 0030 判断）。

```
appctl publish <name> <dir | image>          Registry.publish
 ├─ 读 pneuma-space.json                       ├─ 解析 manifest，错误 400；Infra.resolveImage 把引用解析为 id 或 digest，不存在 404
 ├─ 需要容器时 docker build                    ├─ 声明的 kind 没有可用 Provider（profile 未开）409
 ├─ K8s 平面再 docker push                     ├─ registered 且 release_key 等于当前，返回当前；removed 时继续，不插新 Release
 ├─ 打包静态目录，POST /api/bundles            ├─ 有 files 或 SQLite 的 Binding 行而运行时与上一个有运行时的 Release 不同 409（ADR 0028）
                                               ├─ 一个事务，租户行锁下：首次发布插 App 行（id、owner、tenant，current 为空，地址 404），
                                               │   资源才有归属，判 apps；缺的 files、SQLite Binding 行判 storage_gb 后插成 suspended；超额 409（INV-12）
 └─ PUT /api/apps/<name>/release               ├─ 对每个声明的资源 kind：provider.ensure（创建或收敛，置 active）
                                               ├─ 有 bundle 时进它的 exclusiveBundle：从对象存储重读索引，已删 409；下一步的事务也在其中（ADR 0028）
                                               ├─ 一个事务：插 Release，重写 Trigger，Binding 行置 active 或 suspended，
                                               │   设 current 和 registered；首次发布时 owner 取自请求，缺省为调用主体
                                               ├─ 对刚置 suspended 的 Binding：provider.suspend（后端向行收敛，重启会重做）
                                               ├─ 重建该 App 的 RouteView
                                               └─ 发 AppChanged：Runtime.retire，Scheduler.reload
```

先 ensure 再提交。资源属于 App 而不是 Release，`ensure` 可重复，所以 ensure 和提交之间崩溃留下的资源会被下一次发布采纳，不需要 `pending` 状态。files 和 SQLite 的 Binding 行先于 `ensure` 插入：准入之后崩溃或 `ensure` 失败，留下一条计入 `storage_gb`、后端还没有资源的 `suspended` 行，下一次发布不再申请配额，`ensure` 采纳它；启动收敛按期望状态处理它，purge 照常销毁（ADR 0028）。首次发布后的 `owner` 字段被忽略，owner 只能用 owner 命令改。首次发布的租户：令牌取 `token.tenant`，浏览器取请求体 `tenant`，调用者只在一个租户时可省略；之后只有平台管理员能移动（ADR 0022 第 3 条）。提交之后崩溃，重启时 `AppChanged` 的效果由 Runtime 重启核对和 Scheduler 重载重新得到。

### 2.5 五个决定

理由和被拒绝的方案在对应 ADR。

| 决定 | 内容 | ADR |
| --- | --- | --- |
| (a) RTC | 进 M1，在 Compose `rtc` profile 后面，实现顺序排最后；若集成超出预期就整体移到 M2，不改任何概念。coturn 用 `static-auth-secret`，Provider 注入 STUN/TURN 地址和 HMAC 密钥，示例 SDK 铸造限时凭据，信令走应用自己的 `ws`。跨 NAT 中继依赖 `PNEUMA_SPACE_RTC_PUBLIC_HOST`，M1 只验证单机能建立 datachannel。 | 0010 |
| (b) 发布输入 | 预构建镜像加 `pneuma-space.json` 加可选静态 bundle。镜像在 Docker 平面是本地 id，在 K8s 平面是组织仓库里的 digest 引用，平台不自带仓库。`appctl` 在宿主机构建。没有构建服务。静态站点是 `image = None` 的 Release。 | 0011, 0019 |
| (c) 数据库 | 默认 SQLite 卷；把 App 的 `db_backend` 改为 `postgres` 时 Registry 对 PostgreSQL Provider 执行 `ensure`，得到同一 kind 的第二条 Binding，注入切到它并退役实例。旧 Binding 保留到 purge。不迁移数据。 | 0005 |
| (d) 键值 | 一个 Redis，每 App 一个 ACL 用户，键和频道都限 `<id>:` 前缀。库编号不隔离 pub/sub。 | 0005 |
| (e) 字节 | 对象由对象服务在自己的端点提供，上传直传，`public/` 前缀匿名读；网关只服务静态 bundle，因为它们必须在应用地址上。对象服务的管理走签名 HTTP。 | 0007, 0013 |

## 3 M3 的接缝

M2 的接缝已经落定：身份在 ADR 0021，多节点在 ADR 0019、0020、0025，租户在 ADR 0022，配额在 ADR 0023，热力图和观测在 ADR 0024；CDN 和密钥见 `REQUIREMENTS-M2.md`。

| 需求 | 接缝 | 加什么 | 不变 |
| --- | --- | --- | --- |
| 计量、计费 | Tenant；`usage` 行的 `tenant` 按写入时记 | 分时统计乘以价格；`awake_ms` 改为按状态转换精确计（ADR 0024 后果） | 地址、Manifest、契约、Binding、Tenant |
| 对抗性租户隔离 | 应用命名空间、固定的 NetworkPolicy、共享的 runner | 每租户的网络、计算、数据和控制面边界 | 同上 |
| 自助注册、自定义域名 | 租户由平台管理员创建；地址由 `App.name` 推导（INV-1） | 注册流程；域名到 App 的映射 | 同上 |

## 4 M1 不做

不做构建服务和镜像仓库；不经网关服务对象字节；不做 TLS、公网暴露、管理端口认证（回环绑定即信任边界）；不做容器资源限制；不做回滚命令；不做静态站点的 SPA 回退；不承诺 exactly-once 触发；一个 App 只有一个容器；不做备份和后端间迁移；不做应用间认证（容器共享网络是 Docker 的事实，不是平台承诺，应用之间可以伪造身份头）；不签名身份头；不持久化观测数据，不做每应用分时统计和每容器资源用量（M2 的热力图和配额）；平台模型里没有 Agent、LLM、模板选择器或宿主集成，它们在 `templates/` 和文档里。

M2 不做的事在 `REQUIREMENTS-M2.md` 的"M2 不做"一节。
