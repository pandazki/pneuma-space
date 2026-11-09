# ADR 0026：集群页与运维操作

状态：**M2 决定**。补充 ADR 0024 第 8 项的节点视图，REQUIREMENTS-M2「运营」表的「集群」行是它的要求。

决定：

1. **控制台新增「集群」页**，平台管理员专属的导航项；Compose 平面上同一页叫「主机」。拓扑页的「节点」视图移进来并删除。页面五段：节点、平台组件、实例、存储、告警。数据来自一个端点 `GET /api/cluster`（动作 `cluster.read`，平台管理员），返回 `ClusterView = { plane, sampledAt, nodes, workloads, instances, volumes, warnings }`。读都走采样器的缓存：ADR 0024 第 8 项的采样器每 15 s 多采工作负载、PVC 和告警事件，请求路径上没有 K8s 调用。
2. **类型**（`model.ts`）：
   - `Workload = { name, role, kind: 'Deployment' | 'StatefulSet' | 'service', desired, ready, scalable, image, pods }`。`PlatformPod` 加 `node`、`startedAt`、`leading`（网关副本是否领导者，来自 replica 表的 `leads` 列）。Compose 平面上 `kind: 'service'`，`desired`/`ready` 由现有探针给 1/0，`pods` 为空，`scalable: false`。
   - `InstanceRow = { app, tenant, runtime, state, since, actor, node, pod, leases, requests, restarts }`：ADR 0020 的实例行与采样到的 Pod 按 app 连接；`pod` 在 Compose 上是容器 id，`node` 为 null。
   - `VolumeRow = { app, name, sizeGb, storageClass, phase, node }`：apps 命名空间里带 `pneuma-space.app` 标签的 PVC；Compose 上是卷名和大小。
   - `Warning = { at, kind: 'Pod' | 'Node' | 'PersistentVolumeClaim', object, reason, message, count }`：两个平台命名空间里 `type=Warning` 的 Event，最近 1 h。Compose 上为空。
3. **操作**，都审计（ADR 0024 第 6 项，`target_kind` 加 `workload | pod | node`），都要 `Sec-Fetch-Site: same-origin`，都幂等：
   - `PUT /api/cluster/workloads/<name>/scale {replicas}`（`cluster.scale`，平台管理员）：只对 `scalable` 的两项，网关 Deployment 和 runner StatefulSet；`replicas` 在 1 到 `PNEUMA_SPACE_SCALE_MAX`（默认 10）之间，越界 400；不可伸缩的名字 409。缩 runner 时 RunnerPool 按既有规则改派 home（ADR 0019 第 8 项），被缩掉副本的 PVC 保留。
   - `POST /api/cluster/pods/<name>/restart`（`cluster.restart`，平台管理员）：删除平台命名空间里 `pneuma-space.role` 为 `gateway` 或 `runner` 的 Pod，带 uid 前置条件，控制器重建；其他角色 409。删网关副本就是一次正常滚动：SIGTERM 排空（ADR 0020），领导权重选。
   - `POST /api/apps/<name>/stop`（`app.stop`，应用的 owner、租户管理员或平台管理员，只接受 JWT，ADR 0022 第 5 项）：`Runtime.retire`，排空后删实例，下次请求唤醒。`POST /api/apps/<name>/restart`（`app.stop`）：`retire` 后 `acquire('trigger')` 再立即 `release`。
   - `POST /api/apps/<name>/kill`（`app.kill`，平台管理员），强制释放：新的 `Runtime.kill(app)`，不排空，直接删 Pod 或容器（宽限 0），实例行无条件置 `asleep`（不看 actor 是否存活），删该 app 在所有副本名下的租约计数，释放唤醒认领。ADR 0020 第 4 项的接管只认死 actor；这是运营者对「卡住」的兜底，所以它不进应用的命令锁（卡在排空或唤醒里的命令正握着锁），其他命令在下一次条件更新失败时放弃。
   - `POST /api/cluster/nodes/<name>/drain`（`cluster.drain`，平台管理员）：对采样里跑在该节点上的每个实例执行 `stop`；节点本身不改。
   - 每实例的 CPU 和内存上限在实例表里就地编辑，走已有的 `PUT /api/apps/<name>/policy`。
4. **`Infra` 扩展**：`workloads()`、`volumes()`、`warnings()`（Compose 平面分别返回服务探针结果、卷清单、空数组），`scale(name, replicas)`、`deletePod(name)`（Compose 平面抛 NotOnThisPlane，409）。K8s 调用仍只在 `Infra` 和 `Runtime` 里。
5. **RBAC**（`deploy/kubernetes/10-rbac.yaml`，平台命名空间）：`deployments`、`statefulsets` get/list/watch；`deployments/scale` 与 `statefulsets/scale` get/patch 限 `resourceNames: [pneuma-space-gateway, pneuma-space-runner]`；`pods` delete（RBAC 不能按动态名限制，代码按角色标签限）；两个命名空间 `events` list/watch。网关因此能改自己的副本数和重启自己的 Pod：平台管理员就是平台在集群里的 owner（REQUIREMENTS-M2 信任边界），每一次都在审计表里。
6. **Compose 平面**上这一页没有节点段和告警段，平台组件只读，实例的 stop/restart/kill 照样可用。

理由：一个端点而不是五个，页面一次加载、一次刷新，采样器已经是唯一碰 K8s 列表接口的地方。操作只覆盖平台自己起的东西：网关和 runner 是平台的进程，实例是平台的实例；节点、有状态服务和集群的其他对象归运营者的 kubectl，页面只展示。`kill` 作为单独动作而不是 `stop` 的参数，因为它绕过 ADR 0020 的所有权规则，权限和审计都要单独看得见。副本数上限是配置项，防止一次误输入把集群填满。

拒绝：每应用多实例的扩缩（REQUIREMENTS-M2 不做）；cordon、uncordon 和污点（集群级操作，不是平台的东西）；缩放 postgres、redis、对象存储、coturn、store（有状态单副本，启动后不该改）；接 metrics-server 显示实际用量（机器级看板归组织的 Prometheus 和 Grafana，ADR 0024 第 7 项）；一个通用的 K8s 仪表盘（只展示平台自己的对象，不展示命名空间里的一切）。
