# ADR 0012：实现语言与依赖

状态：**M1 决定**。用户 2026-11-04 提出走 JS 体系。

决定：网关用 Node.js LTS，只用内置模块（`http`、`net`、`node:sqlite`、`crypto`、`child_process`），没有运行时依赖；用 TypeScript，由 Node 原生执行，没有构建步骤；所有做 IO 的接口（Store、Runtime、Provider、BundleStore）签名一律异步，实现内部是否同步不影响签名。示例 SDK 和模板用 TypeScript。应用自己用什么运行时不受限制。原型里的 Python 网关、模板和测试在 M1 实现时整体替换。

理由：网关的核心是流式代理、WebSocket 原始字节中继、SSE、SQLite 和 unix socket 上的 Docker API。Node 的 `http` 服务器在 `upgrade` 事件里交出原始 socket，中继是几行代码；SQLite、哈希、子进程都是内置的。JS 生态也是应用作者和编码 Agent 最常用的。

拒绝：Bun 做网关（HTTP 服务器不暴露 upgrade 后的原始 socket，透传要自己解析 HTTP；内置 SQLite 和速度的优势对网关不关键）；继续用 Python（原型约束，不是产品决定）。

后果：网关镜像基于 Node 官方镜像。M2 多节点时同样的内置模块够用。
