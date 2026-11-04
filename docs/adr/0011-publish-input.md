# ADR 0011：发布输入是预构建镜像加清单

状态：**M1 决定**。

决定：发布输入是镜像 id（静态站点为空）、`pneuma-space.json` 和可选的静态 bundle。`appctl` 在宿主机 `docker build`、解析镜像 id、打包静态目录、调管理接口。平台没有构建服务。Release 由内容哈希 `release_key` 标识。

理由：构建服务意味着构建日志、缓存、并发限制、在持有 Docker socket 的组件里执行任意 Dockerfile，M2 多节点时又需要镜像仓库。清单作为发布输入而不是放在镜像里，静态站点才不需要镜像，读清单也不需要从镜像层里取文件。

拒绝：平台从源码目录构建；清单放在镜像内 `/space.json`（静态站点要一个 `FROM scratch` 镜像，读清单要额外 Docker 调用）。

后果：M2 的镜像仓库是 `image` 字段从本地 id 变为仓库引用，Release 不变。
