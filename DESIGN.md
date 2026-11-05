# 总体设计（M1）

PneumaSpace 把有状态的 web 应用部署到一台可信机器上。应用声明需要的能力，平台提供并注入；地址稳定，计算按需启动、闲置停止，数据只在清除时删除。目标、能力清单、应用类型、范围、验收数字和信任边界在 `REQUIREMENTS.md`。应用看到的协议在 `docs/app-contract.md`。每个关键决定的理由在 `docs/adr/`。本文只写模型和结构。

## 1 领域模型

### 1.1 一段话

**App** 是一个名字，名字就是地址。每次发布产生一个不可变的 **Release**：镜像（静态站点没有）、**Manifest**、静态 **Bundle**（没有静态目录时没有）。Manifest 声明 **Capability**。resource 类能力由它的 **Provider** 创建 **Resource**，平台记为 **Binding**（每 App、每 kind、每 Provider 一条，带 `active / suspended` 状态；`rtc` 这种只注入配置的能力 Resource 为空）；ingress 和 schedule 类能力由一个固定组件负责，只改变网关对这个地址的处理。**Injection**（环境变量和挂载）由当前 Release 的 Binding 推导，容器创建时应用，从不存储。**Instance** 是当前 Release 的运行中容器，只在持有 **Lease** 时保持运行。**Trigger** 是平台调用应用的入口，每次调用是一条持久的 **Delivery**。**Principal** 由 IdentityProvider 解析，以请求头注入。**Policy** 是运营者状态。平台模型里没有应用类型，没有 Agent。

### 1.2 实体

| 实体 | 键 | 字段 | 存放 | 唯一写者 |
| --- | --- | --- | --- | --- |
| App | `name`，文法 `^[a-z][a-z0-9-]{0,39}$` | `id`（不透明，首次发布生成；所有内部资源名和容器名用它，`name` 只用于地址）, `owner`, `status`, `current`, `policy_override` | 平台库 | Registry |
| Release | `(app, number)` | `image?`, `manifest`, `bundle?`, `release_key = sha256(image, manifest, bundle)`, `published_at` | 平台库 | Registry |
| Manifest | 值对象 | `contract`, `capabilities: kind -> declaration` | Release 内 | 发布边界解析一次，下游不再校验 |
| Binding | `(app, kind, provider)` | `state: active / suspended`（行是真相，后端向行收敛）, `resource`（Provider 私有：卷名、库名和口令、ACL 用户、bucket 和密钥） | 行在平台库；资源在该 Provider 的后端服务和命名卷里 | 行由 Registry 写，资源由该 Provider 写 |
| Policy | 全局一行；每 App 的 override 存在 `App.policy_override` | `idle_seconds=60`, `ready_timeout_seconds=15`, `drain_timeout_seconds=30`, `connection_idle_seconds=21600`, `trigger_timeout_seconds=600`, `db_backend=sqlite`；全局另有 `timezone`（cron 用，默认 UTC） | 平台库 | Registry |
| Trigger | `(app, name)` | `schedule?`（cron，空表示只按需） | 平台库，随 Release 在同一事务重写 | Registry |
| Delivery | `id` | `app`, `trigger`, `scheduled_for`, `caller?`, `idempotency_key?`, `body`, `state`, `attempts`, `next_attempt_at` | 平台库 | Scheduler |
| Token | `id` | `subject`（`service:<name>`）, 哈希 | 平台库 | Registry；本地 IdentityProvider 只读 |
| Bundle | `sha256(tar)` | 文件索引 `path -> (size, etag, content_type)`；tar 内路径相对 `static.dir` | 对象存储 `pneuma-space-bundles/<sha256>/` | BundleStore |
| Stats | `app` | `requests`, `errors`, `last_access_at`（经过网关的请求，含静态路径；对象读不经网关，不计入。闲置判断用的是 Instance 的 `last_release_at`，只看 Lease） | 内存，每 10 s 快照到平台库 | Ingress |
| Instance | `app` | `release`, `state`, `address`, `leases`, `last_release_at`, 每实例一把锁 | 内存，启动时从容器标签重建 | Runtime |
| Metrics | 全局一份 | 24 h 的分钟桶（请求、错误、唤醒次数和耗时、休眠、投递结果）、最近 100 条生命周期事件（每条带进程内递增的序号）、最近 1000 条请求记录（ADR 0016）、平台服务探测结果、宿主机负载、内存和 `/data` 所在文件系统 | 内存，不持久，重启清零 | Metrics |
| Lease | 持有者的线程 | `kind: request / channel / trigger`, `on_retire?` | 内存 | Runtime（Ingress 和 Scheduler 只通过 `acquire` 和 `release` 取得和归还） |
| 平台密钥 | 单文件 | cookie 签名密钥 | `/data/pneuma-space.secret`，首次启动生成 | Registry |

有效 Policy 是全局行覆盖上 App 的 override，读时合并，不存合并结果。全局 Policy 是 Registry 持有的一个内存快照，写入时整体替换，所以全局变更立即对所有 App 生效；RouteView 只存该 App 的 override。一个 App 第一次 `ensure` `db` 时，Registry 把当时的全局 `db_backend` 写进这个 App 的 override，之后该 App 的 `db` Provider 只由 override 决定。所以改全局值只影响还没有 `db` Binding 的 App；改某个 App 的 override 才会为它 `ensure` 另一个 Provider 并退役实例；有 `db` Binding 的 App 不能清掉这个 override。一个 kind 可以有多条 Binding（`db` 切换后端时 SQLite 和 PostgreSQL 各一条）；注入时取 `active` 且 Provider 等于有效 Policy 所选的那条。浏览器会话是平台密钥签名的 cookie，没有 Session 表。本地 IdentityProvider 的主体就是登录页输入的名字，`user:<name>`。

### 1.3 能力与 Provider

`CAPABILITIES` 是唯一的能力清单：每个 kind 映射到类别、声明解析器和它的 Provider 实现（`db` 有 SQLite 和 PostgreSQL 两个实现，由有效 Policy 为每个 App 选一个；其余 kind 各一个）。每条 Binding 恰好属于一个 Provider 实现。环境变量、发布时要调用的 Provider、网关读取的标志都从它推导，导入时断言枚举和表一致。

| kind | 类别 | Resource 或负责组件 | `ensure(app)` | `inject` | `suspend` | `destroy` |
| --- | --- | --- | --- | --- | --- | --- |
| `route` | ingress，隐式 | Ingress | | 前缀头 | | |
| `files` | resource | 卷 `pneuma-space-files-<id>` | 建卷 | 挂载 `/data` | 无 | 删卷 |
| `db` | resource | SQLite：卷 `pneuma-space-db-<id>`；PostgreSQL：库和角色 `app_<id>` | 建卷，或建角色和库、`REVOKE CONNECT FROM PUBLIC` | 连接 URL | `NOLOGIN`（`ensure` 恢复 `LOGIN`） | 删卷，或删库删角色 |
| `kv` | resource | Redis ACL 用户 `app_<id>`，键和频道限 `<id>:*` | `ACL SETUSER` | 连接 URL，前缀 | ACL `off`（`ensure` 恢复 `on`） | `SCAN` + `UNLINK` 前缀，`ACL DELUSER` |
| `object` | resource | bucket `app-<id>`，限该 bucket 的密钥对，`public/*` 匿名读策略，CORS | 建 bucket、策略、密钥 | 端点、bucket、密钥 | 撤销匿名读、禁用密钥（`ensure` 恢复） | 删对象、bucket、密钥 |
| `static` | ingress | Ingress（Bundle 不是能力资源，是 Release 的制品，由 BundleStore 存取，purge 时删除） | | 无，网关直接服务 | | |
| `ws` | ingress | Ingress | | | | |
| `cron` | schedule | Scheduler（Trigger 行是 Release 的一部分，随它由 Registry 写） | | | | |
| `identity` | ingress | IdentityProvider | | | | |
| `rtc` | resource | 无每 App 资源；TURN 共享密钥是 Compose 环境变量 `PNEUMA_SPACE_RTC_SECRET`，coturn 和网关都读它 | 检查 `coturn` 服务名在 Compose 网络上可解析（profile 未开时不可解析，发布 409） | `stun:<host>:3478` 和 `turn:<host>:3478?transport=udp`，`<host>` 取 Compose 环境变量 `PNEUMA_SPACE_RTC_PUBLIC_HOST`（默认 `127.0.0.1`），加该密钥 | 无 | 无 |

每个操作可重复执行。`ensure` 对已存在的 Binding 也会执行，收敛后端漂移并把 `suspended` 置回 `active`；没有单独的 resume。`db` 和 `kv` 的 Provider 通过 `Runtime.run_job` 在对应的基础设施容器里执行 `psql` 和 `redis-cli`；`object` Provider 和 BundleStore 用 `node:crypto` 签名的 HTTP 直接调用对象服务的 S3 和管理接口（ADR 0013）。网关自身不带数据库驱动。平台库和平台密钥在命名卷 `gateway-data`（挂载为网关的 `/data`）；后端数据在 `rustfs-data`、`redis-data`（AOF）、`postgres-data`，以及每 App 的 `pneuma-space-files-<id>`、`pneuma-space-db-<id>`；这些卷在平台重启和 `docker compose down` 后都保留。`<id>` 是 `App.id`。

### 1.4 状态机

App：`(无) --publish--> registered --remove--> removed --publish--> registered`；`removed --purge--> purging --> (无)`。`remove` 把该 App 的所有 Binding 置 `suspended`（凭据失效，数据保留），地址 404；`publish` 把当前 Release 声明的 kind 置 `active`（`ensure`），未声明的置 `suspended`；`purge` 销毁所有 Binding 的资源，不论状态；`purging` 持久化，重启后续跑。只能从 `removed` 进入 `purging`。

Instance：`asleep --acquire--> waking --就绪--> awake`；`awake --无 Lease 且闲置到期--> stopping --> asleep`；`awake --retire--> draining --Lease 清空或到期--> stopping --> (移除)`；`asleep --retire--> (移除)`，直接删掉停止的容器。`waking` 就绪超时回到 `asleep`，等待者得到 502。所有转换在该实例自己的锁内，没有全局锁。`awake -> stopping` 要求 Lease 集合为空，`acquire` 在同一把锁内加 Lease，所以二者不会同时成立。`docker stop` 在锁外执行，期间到达的请求等待后重新唤醒，代价是一次多余的停启，不是被切断的连接。

Delivery：`due --worker 取走--> delivering --2xx--> done`；非 2xx、超时、连接丢失回到 `due` 并退避，第 5 次失败进入 `failed`；`removed` 或 Trigger 不再声明时 `cancelled`。重启时所有 `delivering` 回到 `due`。

Lease：`request` 从 acquire 到响应体最后一个字节写完，客户端断开不提前释放；响应是 WebSocket 101 或 `text/event-stream` 时改为 `channel`，直到任一端关闭；`trigger` 覆盖一次投递。闲置停止从不结束 Lease。平台进程存活期间只在三种有界、可见的情况下主动结束 Lease：`draining`（对 `channel` 发 WebSocket close 1001，对 `request` 和 `trigger` 等到 `drain_timeout_seconds`）；`channel` 超过 `connection_idle_seconds` 没有字节（close 1001，客户端重连会再唤醒）；`trigger` 超过 `trigger_timeout_seconds`（关闭连接，该次尝试记为失败并按退避重试）。平台重启丢失所有 Lease：连接断开，客户端重连，`delivering` 的投递重投。Delivery 被 `cancelled` 时正在进行的尝试跑完，不再有下一次。

### 1.5 不变量由谁保证

| ID | 保证 |
| --- | --- |
| INV-1 | 地址只从 `App.name` 推导。Release 号、容器名、节点从不出现在 URL 里。 |
| INV-2 | Binding 行只由 `publish` 和 `db_backend` 变更创建，只由 `purge` 删除；`remove` 和 `publish` 只改它的 `state`；资源只由 `purge` 销毁；`purge` 只能从 `removed` 进入。 |
| INV-3 | `awake -> stopping` 要求 Lease 为空；流、长连接、触发执行都是 Lease。平台进程存活期间只有 1.4 列出的三种有界情况会由平台结束 Lease，它们都不是闲置停止；重启是例外，1.4 写明了后果。 |
| INV-4 | Delivery 在任何尝试前已持久；投递通过 `trigger` Lease 唤醒实例；重启后 `delivering` 回到 `due`。上限：连续 5 次失败后 `failed` 并在控制台可见，停机期间错过的槽位只补最近一个。 |
| INV-5 | Ingress 丢弃所有入站 `X-Pneuma-Space-*`，只从 `IdentityProvider.authenticate` 的结果设置身份头。主体本身可信到什么程度由 Provider 决定：M1 本地桩是自报姓名，只在可信机器上有意义，M2 的 SSO 才给出经认证的主体。 |
| INV-6 | `publish` 写新 Release 并移动 `App.current`，不碰 `name`、`id`、`owner` 和任何 Binding 的资源，只改 Binding 的 `state`；`registered` 时相同 `release_key` 是空操作。 |
| INV-7 | 注册、版本、策略、Binding 行和 Token 在 `/data` 的平台库里；每个 Provider 的数据在命名卷里（1.3 节）；Instance 从容器标签重建；Delivery 从库恢复；Stats 从最近一次快照加载。 |
| INV-8 | 契约固定的是协议：`db` 是一个 SQL 连接 URL，`kv` 是 Redis 协议，`object` 是 S3 协议，推送是 WebSocket 和 SSE。应用看不到谁在哪里提供它们。残留只在 `db`：URL 的 scheme 决定应用要带哪个驱动，SQL 要写两种数据库共有的子集；示例 SDK 两者都处理。 |
| INV-9 | 每条 Binding 恰好属于一个 Provider 实现，每个 ingress 和 schedule kind 恰好有一个负责组件（1.3 节）；Registry 写 Binding 行，Provider 写资源，Runtime 应用 Injection（环境变量和挂载），Ingress 注入请求头，没有别的路径。 |
| INV-10 | 对象字节在浏览器和对象服务之间移动，静态字节在对象存储和网关之间移动，两条路径都不经过 `acquire`。 |

内部不变量：每个 App 至多一个 Instance，新 Release 的容器在旧实例 `draining` 结束后才创建，所以两个进程不会同时打开一个 `/data` 或 SQLite 文件。

## 2 架构

### 2.1 组件

一个网关进程（Node.js LTS，只用内置模块：`http` 和 `net` 做代理和字节中继，`node:sqlite`，`crypto`，`child_process`；TypeScript 由 Node 原生执行，没有构建步骤，没有运行时依赖），五个组件各自拥有不同的状态。平台服务由 Compose 启动，应用容器在 `pneuma-space` 网络上，不发布端口。

| 组件 | 拥有 | 从不做 |
| --- | --- | --- |
| Registry | 平台库和除 Delivery、Stats 外的所有行；每 App 的只读 RouteView，在任何改变该 App 行的命令后重建；publish、remove、purge、policy、owner、token 命令 | 直接调 Docker（镜像引用的解析走 `Runtime.resolve_image`）；连应用 |
| Ingress | 8080 请求路径：路由、身份头、静态服务、流式和 WebSocket 转发、通过 `acquire` 取得 request 和 channel Lease、Stats | 写平台库（只读 RouteView，只写 Stats 快照） |
| Runtime | Instance、Lease、reaper、Docker 驱动；`Runtime` Protocol 是 M2 多节点接缝 | 读 Manifest（只接收 Injection 集合） |
| Scheduler | 读 Trigger，写 Delivery（包括 Ingress 转来的按需 `invoke`），cron 计算，投递 worker | 除 `acquire` 和应用触发端点外的一切 |
| Providers | 每种资源 kind 一个；`ensure`、`inject`、`suspend`、`destroy`；BundleStore；本地 IdentityProvider | 互相调用；写平台库 |
| Metrics | 1.2 节的 Metrics 行。订阅生命周期事件流（每行 JSON 日志同时发给订阅者），每 10 s 采样 Ingress 的 Stats 快照、Runtime 的实例和 Lease 计数、Delivery 的状态计数、宿主机和平台服务可达性；`GET /api/metrics` 返回一份快照，每 App 的 Lease 计数、进入状态的时间和休眠时刻随列表返回（ADR 0015）；`GET /api/requests?after=<seq>` 返回游标之后的请求记录，由 Ingress 和 Scheduler 写入内存环（ADR 0016） | 写任何表；在请求路径上调 Docker 或网络（探测只在采样器里） |
| Console 和 CLI | 8081 管理边界；页面是总览（US-P-13 列的指标）和项目（US-P-6 列的字段，项目详情含 Release 列表、Delivery 列表和容器日志），中英双语，明暗主题，单文件 HTML 内联 CSS、JS 和 SVG 图表，不加载外部资源；发布表单收镜像引用、manifest、可选 bundle 和首次发布时的 owner，引用由网关解析为镜像 id；`appctl publish` 用 `--owner`（默认取环境变量 `PNEUMA_SPACE_OWNER`）；全局 Policy、令牌和 owner 变更只有 `appctl`；`appctl` 先读 `pneuma-space.json`，需要容器时才 `docker build`，有 `static` 时打包目录，再调管理接口 | 任何逻辑；它们是薄壳 |

平台库是 `/data/pneuma-space.sqlite3`（WAL）。每张表一个写者。`ensure` 和 `suspend` 的结果由 Registry 写回 Binding 行。发布在一个事务里写 Release、Trigger、Binding 和 `App.current`，这是用数据库而不是 JSON 文件的原因。列出 500 个 App 是一次查询加一次内存读，没有 Docker 调用。

Compose 服务：`gateway`、`rustfs`（S3 兼容对象服务）、`redis`（AOF）；`postgres` 和 `coturn` 在 profile 后面。M1 所有宿主机端口只绑定回环：8080、8081、RustFS 的 9000，以及 `rtc` profile 下 coturn 的 3478 和中继端口 49160 到 49200，所以访问者都在这台机器上；改绑定和 `PNEUMA_SPACE_RTC_PUBLIC_HOST` 是运营者在信任边界内的决定。

### 2.2 请求处理

每个请求先经过同一个前奏：

1. 解析 `/apps/<name>/<rest>`。App 不存在或 `removed` 返回 404；缺尾斜杠 308。
2. 丢弃所有入站 `X-Pneuma-Space-*` 头。
3. 读 `<name>` 的 RouteView 快照：status、owner、声明的 kind、bundle 索引、Policy override（有效值读时与全局快照合并）。
4. `<rest>` 以 `_pneuma-space/` 开头是平台端点，见 D。
5. bundle 索引命中（含目录的 `index.html`）走 C。静态优先于容器，动态应用的前端资源不唤醒它。
6. 声明了 `identity` 时调用 `authenticate`。Challenge 直接回给客户端（浏览器 303 到 `/_pneuma-space/login`，其他 401）；声明为 `{"required": false}` 时不发 Challenge，未登录的请求以匿名转发、没有身份头，应用需要登录时自己 303 到 `/_pneuma-space/login?next=`。Principal 变成身份头。本地 IdentityProvider 的登录页只要一个名字，设置平台密钥签名的 cookie；服务令牌由 `appctl` 签发，`Authorization: Bearer` 携带。
7. 没有镜像的 App 到这里返回 404。
8. `runtime.acquire(name, REQUEST)`，实例在睡则等待唤醒。

收尾：`runtime.release(lease)`，计数，记 `last_access_at`。

| 路径 | 处理 |
| --- | --- |
| A 普通请求和流式请求体 | 连到实例地址，发请求行、过滤后的头和 `X-Forwarded-Prefix`，64 KiB 块双向复制，`Range` 原样透传，没有大小上限。请求行发出前的连接失败可重试一次唤醒；发出后不重试，所以写操作不会重放。响应是 `text/event-stream` 时 Lease 改为 `channel`。 |
| B WebSocket | 未声明 `ws` 返回 426。原样转发升级请求，101 后两个线程双向复制字节直到任一端关闭。Lease 是 `channel`。超过 `connection_idle_seconds` 无字节时平台发 close 1001，客户端重连会再次唤醒。 |
| C 静态文件 | 无 Lease。按索引回 `ETag`、304、`Range`，从对象存储复制。静态站点没有冷启动。 |
| D 平台端点 | `POST _pneuma-space/trigger/<name>`：无论是否声明 `identity` 都先 `authenticate`，要求 `service:` 主体或 owner；读最多 64 KiB 请求体，调用 `scheduler.invoke`（由 Scheduler 插入 `due` Delivery；带 `Idempotency-Key` 时同键在 24 h 内返回同一条），返回 202 和 id。其余 404。网关根下的 `/_pneuma-space/login`、`/_pneuma-space/logout` 属于本地 IdentityProvider。 |
| 触发投递 | worker 取 `due` 行置 `delivering`，`acquire(app, TRIGGER)` 唤醒，`POST /_pneuma-space/trigger/<name>` 到实例，带 delivery id、attempt、scheduled_for、caller。等待至 `trigger_timeout_seconds`。2xx 成功，其他回 `due` 退避。每个 App 同一时刻只有一个投递在飞。调度循环按 cron（5 字段，全局 `timezone`）在 `(上次完成, now]` 内插槽位，新建或改动的 Trigger 从发布时刻开始算，`(app, trigger, scheduled_for)` 唯一；停机补发最多一个槽位。 |

### 2.3 唤醒、休眠、退役、重启

唤醒（`acquire` 内）：App 不是 `registered` 时拒绝（Ingress 已 404，Scheduler 据此取消投递）。实例锁下看状态。`awake` 加 Lease 返回；`waking`、`stopping`、`draining` 等条件变量后重查；`asleep` 置 `waking` 成为唯一唤醒者。按 `pneuma-space-<id>-<release>` 创建容器（已存在视为成功），标签 `pneuma-space.app`、`pneuma-space.release`、`pneuma-space.spec`（Injection 集合的哈希），注入 Injection 集合加 Runtime 自己给的 `PNEUMA_SPACE_APP` 和 `PNEUMA_SPACE_RELEASE`，`docker start`（已启动视为成功），inspect 一次取 IP 存为 `address`，避免 Docker DNS 对外部停止容器的 4 s 失败。轮询 8000 端口 TCP 直到就绪或 `ready_timeout_seconds`。

休眠（reaper 每 `min(idle_seconds, 10)` s，只遍历 awake 集合）：锁内 Lease 为空且闲置到期则置 `stopping`；锁外 `docker stop`，容器保留供下次 `docker start`；锁内置 `asleep` 并通知。

退役（Registry 在发布、改变 Injection 的 policy 变更、remove 之后调用）：`awake` 时置 `draining`，调用每个 `channel` 的 `on_retire`（WebSocket 发 close 1001，SSE 直接关闭连接），等待 Lease 清空至多 `drain_timeout_seconds`，`docker stop` 并 `docker rm`；`asleep` 时直接 `docker rm`。下一次 `acquire` 为当前 Release 建新容器。`purge` 先退役，再销毁每条 Binding 的资源和该 App 的 bundle，所以卷不会被容器占用。

重启：开平台库，`delivering` 回 `due`。先核对容器，再续跑 `purging`（续跑要退役该 App 可能还活着的容器，所以核对在前）。一次 `docker ps` 按标签 `pneuma-space.app` 列出容器：App 不存在、`pneuma-space.release` 不等于 `current`、或 `pneuma-space.spec` 不等于当前推导的 Injection 哈希的移除，其余运行中的采纳为 `awake`（`last_release_at = now`），停止的为 `asleep`。订阅 Docker 事件流，`die` 事件把实例置 `asleep`。Provider 在后台对每条 Binding 按其 `state` 重跑 `ensure` 或 `suspend`，收敛后端可能丢失或与行不一致的状态（例如重建的 Redis 容器，或 ensure 和提交之间的崩溃）。

### 2.4 发布

```
appctl publish <name> <dir | image>          Registry.publish
 ├─ 读 pneuma-space.json                            ├─ 解析 manifest，错误 400；镜像引用解析为 id，不存在 404
 ├─ 需要容器时 docker build                    ├─ 声明的 kind 没有可用 Provider（profile 未开）409
 ├─ 打包静态目录，POST /api/bundles            ├─ registered 且 release_key 等于当前，返回当前；removed 时继续，不插新 Release
                                               ├─ 首次发布：先插 App 行（id、owner，current 为空，地址 404），资源才有归属
 └─ PUT /api/apps/<name>/release               ├─ 对每个声明的资源 kind：provider.ensure（创建或收敛，置 active）
                                               ├─ 一个事务：插 Release，重写 Trigger，Binding 行置 active 或 suspended，
                                               │   设 current 和 registered；首次发布时 owner 取自请求
                                               ├─ 对刚置 suspended 的 Binding：provider.suspend（后端向行收敛，重启会重做）
                                               ├─ 重建该 App 的 RouteView
                                               └─ 发 AppChanged：Runtime.retire，Scheduler.reload
```

先 ensure 再提交。资源属于 App 而不是 Release，`ensure` 可重复，所以 ensure 和提交之间崩溃留下的资源会被下一次发布采纳，不需要 `pending` 状态和启动时的全量核对。首次发布后的 `owner` 字段被忽略，owner 只能用 owner 命令改。提交之后崩溃，重启时 `AppChanged` 的效果由 Runtime 重启核对和 Scheduler 重载重新得到。

### 2.5 五个决定

理由和被拒绝的方案在对应 ADR。

| 决定 | 内容 | ADR |
| --- | --- | --- |
| (a) RTC | 进 M1，在 Compose `rtc` profile 后面，实现顺序排最后；若集成超出预期就整体移到 M2，不改任何概念。coturn 用 `static-auth-secret`，Provider 注入 STUN/TURN 地址和 HMAC 密钥，示例 SDK 铸造限时凭据，信令走应用自己的 `ws`。跨 NAT 中继依赖 `PNEUMA_SPACE_RTC_PUBLIC_HOST`，M1 只验证单机能建立 datachannel。 | 0010 |
| (b) 发布输入 | 预构建镜像 id 加 `pneuma-space.json` 加可选静态 bundle。`appctl` 在宿主机构建。没有构建服务。静态站点是 `image = None` 的 Release。 | 0011 |
| (c) 数据库 | 默认 SQLite 卷；把 App 的 `db_backend` 改为 `postgres` 时 Registry 对 PostgreSQL Provider 执行 `ensure`，得到同一 kind 的第二条 Binding，注入切到它并退役实例。旧 Binding 保留到 purge。不迁移数据。 | 0005 |
| (d) 键值 | 一个 Redis，每 App 一个 ACL 用户，键和频道都限 `<id>:` 前缀。库编号不隔离 pub/sub。 | 0005 |
| (e) 字节 | 对象由对象服务在自己的端点提供，上传直传，`public/` 前缀匿名读；网关只服务静态 bundle，因为它们必须在应用地址上。对象服务的管理走签名 HTTP。 | 0007, 0013 |

## 3 M2 和 M3 的接缝

| 阶段 | 需求 | 接缝 | 加什么 | 不变 |
| --- | --- | --- | --- | --- |
| M2 | SSO | `IdentityProvider` Protocol | OIDC 实现；`App.owner` 变为 SSO 主体 | 身份头、Principal、应用 |
| M2 | 多节点 | `Runtime`、`Store` Protocol；`AppChanged` 事件 | 节点感知的 Runtime，PostgreSQL 平台库，Scheduler 领导锁，事件变为库内变更流 | Manifest、契约、Lease、Ingress |
| M2 | 配额 | `Policy` | `cpu`、`memory` 字段，Runtime 传给 `docker create` | 其他 |
| M2 | CDN | `PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT`，静态 `Cache-Control` | 把值指向 CDN，对象服务做源站 | 应用 |
| M2 | 热力图 | Stats | 分时桶的行 | 其他 |
| M2 | 密钥出环境变量 | `Injection` | 加 `files` 成员，Provider 写挂载文件 | 其他 |
| M3 | 租户、计量、计费 | 新实体 Tenant | `App.tenant`，每租户 Policy 和 Stats | 地址、Manifest、Binding |

## 4 M1 不做

不做构建服务和镜像仓库；不经网关服务对象字节；不做 TLS、公网暴露、管理端口认证（回环绑定即信任边界）；不做容器资源限制；不做回滚命令；不做静态站点的 SPA 回退；不承诺 exactly-once 触发；一个 App 只有一个容器；不做备份和后端间迁移；不做应用间认证（容器共享网络是 Docker 的事实，不是平台承诺，应用之间可以伪造身份头）；不签名身份头；不持久化观测数据，不做每应用分时统计和每容器资源用量（M2 的热力图和配额）；平台模型里没有 Agent、LLM、模板选择器或宿主集成，它们在 `templates/` 和文档里。
