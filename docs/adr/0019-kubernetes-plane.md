# ADR 0019：Kubernetes 部署平面

状态：**M2 决定**。用户 2026-11-08："基础多节点就是 k8s"；"container 概念用 pod 也是对的"；"镜像仓库接基建就可以了"。设计探索稿 M2-D1。

决定：

1. **K8s 是部署平面，不是运行时。** `RUNTIMES` 仍是 `container` 和 `isolate` 两行，应用、Provider 和清单看不出平面。组合根 `main.ts` 按 `PNEUMA_SPACE_PLANE=docker|kubernetes`（默认 `docker`）选一组实现：container 的 Driver（`DockerDriver` 或 `PodDriver`）、isolate 的 runner 池（单个 `runner:8082` 或 StatefulSet 的 Pod watch）、`Infra`（Docker 或 K8s）、`Store`（SQLite 或 PostgreSQL，ADR 0025）。`Lifecycle`、`Runtimes` 门面、Guard、Scheduler、Ingress、Registry、Providers 两个平面共用一份。这推翻 AGENTS.md 里"`Infra` 永远是 Docker"。
2. **K8s API 客户端 `gateway/src/kube.ts`** 只用 `node:https`：每次请求重读 ServiceAccount 投射令牌，`ca.crt` 启动时读一次，地址取 `KUBERNETES_SERVICE_HOST` 和 `_PORT`。只实现用到的调用：Pod 的 create、delete、get、list、watch、log；PVC 的 create、get、delete；Node 的 list 和 watch。watch 按行解析 JSON，410 时重新 list 再 watch。API server 不可达抛 `Unavailable`，Guard 不计数（ADR 0017 的分类）。RBAC：SA `pneuma-space-gateway` 在应用命名空间对 `pods`、`pods/log`、`persistentvolumeclaims` 增删查和 watch，在平台命名空间对 `pods`、`pods/log` 只读，集群级只读 `nodes`，不读 Secret。
3. **两个命名空间。** `pneuma-space` 放网关、runner 和集群内的平台服务；`pneuma-space-apps` 放实例 Pod 和 PVC。租户是 Pod 和 PVC 上的标签 `pneuma-space.tenant`，不是命名空间。
4. **container 实例是一个 Pod**，名字 `pneuma-space-<App.id>-<release>-<epoch>`，`epoch` 是实例行每次唤醒加一的计数（ADR 0020），崩溃留下的 Failed Pod 不挡新名字，接管方按同名创建得到 409 视为成功。标签 `pneuma-space.app`、`.release`、`.epoch`、`.tenant`、`.role=instance`、每个绑定服务一个 `pneuma-space.reach.<service>=1`、`app.kubernetes.io/managed-by=pneuma-space`；注解 `pneuma-space.spec=<specHash>`。spec：`restartPolicy: Never`（重启由唤醒决定，Guard 才数得到失败）、`automountServiceAccountToken: false`、`enableServiceLinks: false`、`serviceAccountName: pneuma-space-app`（没有任何 RBAC）、`terminationGracePeriodSeconds: 10`、`imagePullSecrets` 取 `PNEUMA_SPACE_K8S_PULL_SECRETS`（逗号分隔，Secret 由运营者建在应用命名空间）、`nodeSelector` 取 `PNEUMA_SPACE_K8S_NODE_SELECTOR`。一个容器 `app`，镜像是 digest 引用，`imagePullPolicy: IfNotPresent`，端口 8000，环境变量与 Docker 相同。资源：`limits.cpu` 和 `limits.memory` 取有效 Policy 的 `cpu_millis`、`memory_mb`（ADR 0023），`requests.memory` 等于上限，`requests.cpu` 取部署级 `PNEUMA_SPACE_CPU_REQUEST_MILLIS`（默认 100），因为只有醒着的实例有 Pod。安全上下文：`seccompProfile: RuntimeDefault`，`fsGroup` 取 `PNEUMA_SPACE_K8S_FS_GROUP`（默认 2000），`allowPrivilegeEscalation: false`，丢弃 `NET_RAW`；`PNEUMA_SPACE_K8S_RESTRICTED=1` 打开 `runAsNonRoot` 和丢弃全部能力，默认关，因为契约允许镜像以 root 运行。应用命名空间设 Pod Security `baseline`。
5. **唤醒、休眠、日志、收养。** 唤醒：按 StorageBinding 确保 PVC（409 视为已存在），创建 Pod，从本副本的 Pod watch 等 `podIP`，每 50 ms 对 `podIP:8000` 做 TCP 探测直到就绪或 `ready_timeout_seconds`；等待期间 Pod 进入 Failed 即失败，原因取 `terminated`。不用 kubelet 的 readinessProbe，它的周期至少 1 s。休眠和退役是同一个动作：取最后 200 行日志（上限 64 KiB）写进 `instance_log`，删 Pod，等 watch 送来 DELETED；K8s 没有"停止的 Pod"，handle 不跨休眠保留。日志：Pod 在时读 `pods/<name>/log`，不在时读 `instance_log`，任一副本都能答。收养：网关重启不碰 Pod，领导者按 `managed-by` 标签列出 Pod 与实例行比对 app、release、spec、epoch，不一致的删掉。`health()` 是 `['exit', 'ready', 'memory']`，`OOMKilled` 报为 memory。
6. **镜像来自组织的仓库。** `appctl publish <name> <image>` 先 `docker push` 到 `PNEUMA_SPACE_REGISTRY`，再发引用；网关 `resolveImage` 对仓库做 OCI distribution 的 `HEAD /v2/<repo>/manifests/<tag>` 取 `Docker-Content-Digest`，认证读 `PNEUMA_SPACE_REGISTRY_AUTH` 指向的 dockerconfigjson，支持 Basic 和 Bearer 换取。`Release.image` 存 `<registry>/<repo>@sha256:...`。平台不自带仓库，不发自己的镜像。
7. **`/data` 是每个 StorageBinding 一个 ReadWriteOnce PVC**，名字 `pneuma-space-files-<id>`、`pneuma-space-db-<id>`，在应用命名空间，首次唤醒创建；`storageClassName` 取 `PNEUMA_SPACE_K8S_STORAGE_CLASS`（空为集群默认），容量取 `PNEUMA_SPACE_K8S_VOLUME_SIZE`（默认 1Gi，计入租户存储总量）。调度器按 PV 的拓扑约束放 Pod，平台不记节点。`remove` 不碰 PVC；`purge` 先退役实例再删 PVC 并等它消失，30 s 内没消失抛 `Conflict`，`purging` 下次续跑重试。PV 的去留由存储类的 `reclaimPolicy` 决定。
8. **isolate 的 runner 是 StatefulSet**，副本数由运营者定，preferred `podAntiAffinity` 按节点分散，`volumeClaimTemplates` 给每个副本一个 RWO PVC 作 `/data`，内存上限和 `--permission` 参数与 compose 相同。网关 watch `pneuma-space.role=runner` 的 Pod，地址 `podIP:8082`，就绪由 runner 的 readinessProbe `GET /health` 给出。带 StorageBinding 的应用首次唤醒时选一个 runner 作 home，在 waking 的 CAS 里写进实例行，以后只在它上面跑；不带存储的选醒着 worker 最少的就绪 runner，平局按 app id 做 rendezvous hash。home 不可达抛 `Unavailable`，答 503，Guard 不计数。控制接口加 bearer 令牌 `PNEUMA_SPACE_RUNNER_TOKEN`（K8s Secret 注入 runner 和网关），worker 只拿到 runner 显式传给它的 env，看不到令牌。
9. **按子域名取应用名。** `PNEUMA_SPACE_APPS_ORIGIN`（如 `https://*.apps.example.com`）设了就是子域名模式：Ingress 从 `Host` 去端口、转小写，要求恰好 `<label>.apps.example.com`，`label` 按应用名文法解析，整条路径交给应用，`X-Forwarded-Prefix` 发空串（头存在，值为空），没有 308 补斜杠。没设就是 M1 的路径模式。一个部署只有一种模式，列表和控制台的 `address` 由同一个函数给出。`PNEUMA_SPACE_PUBLIC_APPS_ORIGIN` 可选：`access` 为 `public` 的应用同时在这个域上服务，给只有静态放行规则的上游整域放行用。组织入口把 `*.apps.example.com` 转到 Service `pneuma-space-gateway` 的 8080，控制台主机转到 8081，TLS 在入口终止；入口的读超时不小于 `connection_idle_seconds`，否则 WebSocket 和 SSE 被入口切断。
10. **网络是固定的几份 NetworkPolicy**，由部署清单提供，不随应用增删：

    | 策略 | 选中 | 允许 |
    | --- | --- | --- |
    | `apps-default-deny` | 应用命名空间全部 Pod | 入向、出向都拒绝 |
    | `apps-from-gateway` | `role=instance` | 入向只来自平台命名空间的 `role=gateway`，端口 8000 |
    | `apps-dns` | `role=instance` | 出向到 kube-dns 的 53 |
    | `apps-reach-<service>`（postgres、redis、object、coturn 各一份） | `reach.<service>=1` | 出向到该服务的 Pod 选择器或 `ipBlock`（组织托管时由运营者填） |
    | `apps-internet` | `role=instance` | 出向 `0.0.0.0/0`，`except` 集群 Pod、Service 和节点网段（`PNEUMA_SPACE_K8S_CLUSTER_CIDRS`） |
    | `runner-from-gateway` | `role=runner` | 入向只来自 gateway，控制端口和 worker 端口段 |
    | `platform-db` | 平台库 | 入向只来自 gateway |

    `reach.<service>` 标签来自 Injection：`CapabilityProvider` 多一个只读字段 `service`（`postgres`、`redis`、`object`、`coturn` 或 null），Registry 把当前 active Binding 的 service 放进 `Injection.services`。Provider 仍不知道运行时，Docker 平面忽略这个字段。
11. **单机 Compose 用同一份代码。** 第一个实现单元的完成标准是 M1 的全部验收行加 `test:runner`、`test:docker` 在 Compose 上不变地通过。

理由：平面而不是运行时，因为 container 和 isolate 在 K8s 上还是那两种东西，变的只是谁起容器和状态放哪里，第三行运行时会让 Provider 和清单无端看见部署形态。Pod 而不是 Deployment，因为平台自己决定唤醒和休眠，控制器的 reconcile 会和休眠判断打架（已定取舍 6）。两个命名空间而不是每租户一个，因为 `App.tenant` 可以移动而 PVC 不能跨命名空间，配额要在发布和唤醒时以可读的原因拒绝、平台自己算（ADR 0023），实例间隔离本来按 Pod 做，RBAC 和 NetworkPolicy 因此是固定几份 YAML。RWO 而不是 RWX，因为一个 App 同时只有一个实例，SQLite 的 WAL 和文件锁在 NFS 一类存储上不可靠。StatefulSet 而不是 DaemonSet，因为 DaemonSet 不能每个 Pod 一个 PVC。网关自己探 TCP，因为 kubelet 探测把就绪推迟到秒级。digest 引用，因为 tag 会动而 Release 不能动。

拒绝：每租户一个命名空间（见理由，留给 M3 的对抗性隔离）；每应用一个 Deployment 或 StatefulSet；runner 用 DaemonSet 加 hostPath（数据绑死节点）；默认 RWX；K8s readinessProbe 和 `restartPolicy: Always`（kubelet 在 Guard 看不到的地方重启）；每应用一份 NetworkPolicy（上万个对象）；平台自带镜像仓库（已定取舍 5）；exec 进常驻工具 Pod 做供应（要用内置模块实现 exec 的 WebSocket 子协议；供应怎么做见 ADR 0025）。

后果和已知限制：云块存储在 Pod 换节点时先卸载再挂载，常见 10 到 60 s，可能破掉首请求 5 s 的目标，bench 量出来超了再加"偏好上次节点"的软亲和。节点本地存储把带 `/data` 的应用钉在节点上，US-O-4 以能跨节点移动的存储类为前提（`REQUIREMENTS-M2.md`）。K8s 的新卷不继承镜像目录的属主，靠 `fsGroup`，契约加一句。某副本镜像过期时请求可能落到复用了 Pod IP 的别的应用，窗口由 ADR 0020 的快路径条件缩小，没有消除。同一 runner 里的 isolate 应用共用 Pod 网络，出向隔离到 runner 为止。网关能在应用命名空间建任意 Pod，网关失守即命名空间失守，Pod Security `baseline` 是边界，符合 M2 的信任边界。缩容 runner 会让 home 在被删副本上的应用不可用，M2 只支持扩容。
