# ADR 0018：拓扑页与运行时视图

状态：**M1 决定**。用户 2026-11-05 提出"对每种 runtime 配一个架构说明的图，在后台可以直接看，有点像部署图或网络拓扑图，用户一眼就能看懂服务是怎么跑起来的，包括故障也可以一眼看到，比如什么东西无法访问"，并要求沿用总览的视觉风格；随后补充"不止泳道图，用户到 gateway 再到 app，然后 app 启用了哪些 feature、中间件，可以用一张带连线的图表达"，两种都做，之后留一种或都留。

决定：后台加第四个页面"拓扑"，顶部切换两个视图，共用数据、轮询和故障规则。

**泳道视图**：一幅内联 SVG 场景，节点集固定、手工布局：左边访客和运营者，中间网关（入口 8080、管理 8081），右边按运行时分三条泳道（container：Docker 引擎和应用容器；isolate：runner 服务和每应用一个 worker；static：只有包存储），每条泳道里放当前属于它的应用（来自 `GET /api/apps` 的 `runtime`、`instance`、`quarantine`、`capabilities`），泳道下画它的持久化（`/data` 卷、runner 卷、bundle 桶），最右一列平台服务（redis、object、postgres、coturn、runner，来自 `GET /api/metrics` 的 `services`，up、down、off 三态和探测时延）。边：访客到入口；入口到每条泳道；泳道到服务按能力种类画，边上标声明该能力的应用数，不画每应用的边。故障一眼可见：不 up 的服务节点、它的边和泳道里声明该能力的应用一起变成故障色，节点旁给原因和动作（如"用 `--profile postgres` 启动"）；runner 为 off 时 isolate 泳道标为不可达；被隔离的应用显示原因并可在此解除。点一条泳道的标题打开该运行时的说明面板：请求如何到达、实例如何唤醒和睡去、状态放在哪、卡死和崩溃如何检测和处置（来自 `GET /api/health` 的 `runtimes[kind].health`），中英双语。

**连线视图**：同一套节点改成五列的分层图，每个应用一个节点、每条边都是它自己的。第一列访客、运营者和外部调用方（触发器的 Bearer 调用）；第二列网关，内部画出请求经过的中间件阶段：入口、身份（登录和会话）、静态直出、唤醒（Runtimes 和 Guard）、调度（cron 投递）、管理口；第三列应用节点，按运行时分组（container、isolate、static），带实例状态和隔离色；第四列能力节点：files、db（SQLite）、db（PostgreSQL）、kv、object、static、ws、cron、identity、rtc；第五列平台服务。边：访客到入口；入口到每个应用，途经它声明的中间件阶段（声明 `identity` 的经过身份，声明 `static` 的经过静态直出，有运行时的经过唤醒，声明 `cron` 的从调度来一条）；应用到它声明的每个能力节点（来自列表的 `capabilities`，`db` 按列表的 `dbBackend` 选 SQLite 或 PostgreSQL）；能力到服务（kv 到 redis，object 和 static 到对象存储，db（PostgreSQL）到 postgres，db（SQLite）到网关的 `/data`，rtc 到 coturn，isolate 组到 runner）。边多时靠选择读图：点一个应用只亮它从访客到服务的整条路径，其余变淡；点一个服务亮所有依赖它的应用；点一个能力亮声明它的应用；点运行时分组标题打开泳道视图同一份说明面板。应用多于 24 个时默认画最近访问的 24 个，列表上方一个过滤框按名字收窄，分组标题标"+N"。故障色沿边反向传播：服务不 up，依赖它的能力、应用、分组一起变色；runner off 时 isolate 组整组不可达。

动态沿用 ADR 0015 的规则：可见时轮询，差分驱动；边上的流动只在上一轮询以来有请求时出现（用 ADR 0016 的 `GET /api/requests?after=` 游标，按应用点亮它的芯片和它泳道的边）；主机空闲时画面静止；`prefers-reduced-motion` 下不流动只变色。

列表 `GET /api/apps` 多一个 `dbBackend`（声明 `db` 的应用在生效策略下用的引擎），这是连线视图唯一缺的字段，其余边都来自已有的 `capabilities` 和 `runtime`。`GET /api/health` 扩为 `{ok, ingressPort, runtimes, policy}`：`runtimes` 按 `RUNTIMES` 表列出每种运行时的 `service`、`profile` 和已注册实现的 `health()`（未注册的实现 `health` 为空数组）；`policy` 是生效的全局策略，拓扑页用它标 `db` 边指向 SQLite 还是 PostgreSQL。U31 已把 runner 加进 metrics 探测。

同一单元把运行时带进后台其余页面：项目列表和详情的运行时芯片，详情的隔离状态和解除按钮，总览服务条的 runner 格，`crashed`、`hung`、`quarantined`、`unquarantined` 进收件箱和事件尾。

理由：README 的三幅动画场景（`docs/assets/`）已经用同一套视觉语言解释了平台怎么跑，拓扑页是同一幅图叠上实时状态：泳道视图解释每种运行时怎么跑，连线视图解释一个应用用了什么、请求经过什么；两种都用固定列和手工布局，比任何自动布局都稳定、可读、无外部依赖；故障按依赖传播着色，运营者不用在列表里找哪个应用受影响；两种视图的边都只用列表已有的字段加一个 `dbBackend`，不加按应用的绑定查询（AC-P-8 的 500 应用列表仍是一次扫描）。`health()` 是 ADR 0017 留给运行时自述探活的接口，这页是它第一个消费者。

拒绝：图形库或自动布局（不加载外部资源，列固定、行可变）；把绑定并进列表（连线视图用声明的能力和 `dbBackend` 就够，绑定细节看详情页）；从拓扑页调 Docker 查引擎状态（这页和总览一样零 Docker 调用，引擎故障通过运行时事件和唤醒失败可见）；把说明文字做成单独文档（说明就在图旁边，中英两份字典）。

后果：`/api/health` 多两个字段，列表多一个字段；后台多一个入口、两个视图和一本 zh/en 字典；验收加 AC-P-16；DESIGN 的 Console 行多一页。
