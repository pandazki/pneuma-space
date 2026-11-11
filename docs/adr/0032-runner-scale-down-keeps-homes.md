# ADR 0032：缩 runner 不改派 home，删掉有 home 的副本时拒绝

状态：**M2 决定**。取代 ADR 0026 第 3 项里的一句"缩 runner 时 RunnerPool 按既有规则改派 home（ADR 0019 第 8 项）"：没有这样的规则，也没有代码改派。ADR 0019 第 8 项"首次唤醒选定 home，以后只在它上面跑；一条规则，不分有没有存储"不变，它后果里"缩容 runner 会让 home 在被删副本上的应用不可用"由本决定在 API 上拒绝。对应 issue #28。

决定：

1. **M2 不改派 home。** `PUT /api/cluster/workloads/pneuma-space-runner/scale` 要 M 个副本时，StatefulSet 只留序号 0 到 M-1，从 N 缩到 M 删掉序号 M 到 N-1。只要有一条 instance 行的 `home` 是这个 StatefulSet 序号不小于 M 的副本，就答 409（`Conflict`），不发任何 K8s 调用，副本数不变。home 是 runner Pod 的名字 `pneuma-space-runner-<序号>`：`StatefulSetPool` 以 Pod 名作 runner 的 id，`place()` 写进行里的就是它。从 home 推出"会不会被删"只在 `KubeInfra` 一处。
2. **一条规则。** 只看行的 `home`，不分有没有存储、醒着还是睡着、`registered` 还是 `removed`；instance 行只在 purge 时删除。409 的消息写明工作负载、副本数、home 在被删副本上的应用名和各自的副本（列前 10 个，其余写出个数）和出路：先 remove 再 purge 这些应用，或保留这些副本。响应体另带 `stranded`，控制台据此用两种语言写出原因。拒绝和别的被拒命令一样审计为 `refused`，带请求的副本数（ADR 0024 第 6 项）。
3. **两半各归其主，管理路由只是壳。** 谁的 home 在哪是 Runtime 的知识：`Runtimes.homes()` 在请求时从平台库读 instance 行，再读 app 行，app 行已经没有的行属于正在收尾的 purge，不算；不读本副本的镜像，别的副本刚写下的 home 也看得到。哪些副本会被删是 Infra 的知识：`Infra.removedBy(name, replicas)` 给出对一个 home 的判定，网关 Deployment、不可伸缩的名字和单机平面给 null，这时不读 home。`Registry.scale` 先问这两半，通过了才调 `Infra.scale`；路由只校验 `replicas` 的范围再转交。扩容和网关的伸缩照旧。
4. **判定只用请求的 M，不读现有的 N。** 读 N 要多一次 K8s 调用，拒绝就不再发生在任何 K8s 调用之前；采样器里的 N 最多旧 15 s，另一个网关副本刚扩过容时会漏掉新副本上的 home。代价见后果。

理由：改派就是换目录。带 files 或 SQLite 的 isolate 应用，数据在它 home 副本的 PVC 里（ADR 0017 第 4 条，ADR 0019 第 8 项），改派后应用看到空目录；ADR 0028 第 3 项因为同样的原因拒绝一次发布换运行时。没有存储的应用改派是安全的，但 ADR 0019 第 8 项让 home 只有一种语义，为它开例外要在放置、缩容和控制台上各多一条分支。拒绝发生在任何 K8s 调用之前，失败的操作不留成功提示，也不留半截状态。运营者要缩掉一个副本，先清除 home 在它上面的应用，这是 M2 对数据的承诺：只有 purge 删除。

拒绝：缩容时改派 home 并搬 PVC 里的数据（停机、拷贝、校验，还要有一方知道另一方的落地位置）；只改派没有存储的应用（两条规则）；StatefulSet 只许扩容（先 purge 再缩容是合理的运维）；按采样器缓存的副本数判断是不是缩容；先读 StatefulSet 的副本数再判定（见第 4 项）。

后果：

- 检查与 Pod 删除之间的窗口不关。检查通过后、StatefulSet 删掉副本之前，一个首次唤醒的应用可能被放到将删的副本上：`pick` 选醒着 worker 最少的就绪 runner，将删的副本在 Pod 被标记删除前仍然就绪。运营者看到的是这个应用答 503（"no runner Pod of the pneuma-space-runner StatefulSet answered"），Guard 不计数，直到把副本数扩回去。接受，因为它是首次唤醒才落在那里，那个副本上没有它更早的数据；扩回去后同名 PVC 重新挂上，应用恢复。关这个窗口要在放置和缩容之间加跨副本的互斥，或让 pool 提前排除将删的副本，M2 不做。
- `kubectl scale` 绕过检查，照旧让 home 在被删副本上的应用答 503，直到扩回去（`deploy/kubernetes/README.md`）。
- 因为不读 N，home 已经落在不存在的副本上时（`kubectl` 缩过，或上一条的窗口），任何仍不包含那个副本的请求都被拒绝，扩容也一样；消息列出这些应用和副本，扩到包含它的副本数或 purge 这些应用才放行。
- 缩容要先 purge：home 在被删副本上的应用连同它在那个 PVC 里的数据都要清除，副本缩掉后 PVC 仍然保留。
