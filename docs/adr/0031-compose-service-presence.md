# ADR 0031：Compose 服务的存在性

状态：**决定**。修订 DESIGN 第 1.3 节 RTC 的 DNS 判断，补充 ADR 0019、0026。

证据：真实 Compose 上，停止 coturn 和 runner 后，AC-GAME-1、AC-ISO-5 仍允许发布。宿主机的 DNS 代理把不存在的 `coturn` 解析成 `198.18.5.241`，TCP 代理也会接受连接。未修改的主分支同样复现。DNS 可解析和 TCP 握手均不能证明 Compose 服务存在。

决定：

1. `DockerInfra.serviceAddress(service)` 通过 Docker 列表 API 查找正在运行、带精确 `com.docker.compose.service` 标签且连接到 `PNEUMA_SPACE_NETWORK` 的容器，返回该网络的 IP。没有符合条件的容器或地址时返回 null。网络名必须精确匹配，不接受 Docker 过滤器的子串匹配结果。不缓存结果，API 错误向上传递。
2. Compose 的服务探针直接连接这个 IP。可选服务不存在时为 `off`，存在但端口不通时为 `down`，端口可达时为 `up`。发布只接受 `up`。必需服务不存在仍为 `down`。发布和观测使用同一组探针。
3. `main.ts` 注入探针，Provider 和 Registry 不再默认查询 DNS。Docker API 调用留在 Infra，Provider 不知道平面或运行时。`Infra` 的跨平面接口和 Kubernetes 的既有探针不变。

拒绝：排除某个假 IP 网段，代理地址并不固定；只做 TCP 探测，同样会误报；为所有服务另写协议探针，它不能区分未启用的 profile 和无响应的服务。容器存在性不等于协议健康，保留已有端口就绪检查，不增加新的健康承诺。

验证：[AC-P-16、AC-GAME-1、AC-ISO-5](../acceptance.md)；真实 Compose 的 Provider 测试覆盖启用、停止、移除后的状态。DNS 不再参与存在性判断，runner 的离线测试使用已关闭的本地监听端口。

信任边界仍由 [M1](../../REQUIREMENTS.md#信任边界) 和 [M2](../../REQUIREMENTS-M2.md#信任边界) 定义。服务标签和网络选择不构成对抗性租户隔离。
