# 完整 SaaS 的下一步部署选择

2026-11-12。方案待选择，没有创建云资源或启用付费产品。功能验收见[集群验证记录](hosted-cluster-verification.md)，发布条件仍以[验收表](acceptance.md#full-platform-saas)为准。

建议让 Cloudflare 承担公网入口，在独立计算环境运行原网关、应用和持久存储。这是待确认的组合部署方案，还不是已实施的架构决定。选择后先写 ADR，再实现部署适配。

## 为什么暂不直接换成 Cloudflare Containers

Cloudflare 的[文件文档](https://developers.cloudflare.com/sandbox/files/)说明，停止 sandbox 会删除实例磁盘。R2 挂载的重命名、锁和权限语义与本地磁盘不同。[容器快照](https://developers.cloudflare.com/containers/guides/snapshots/)与生成它的镜像版本绑定，且有 30 天保留期。

据此，快照或 R2 挂载还不能作为原应用 `/data` 和 SQLite 的等价替代。需要先证明崩溃后的已确认写入、换镜像后的数据保留和文件锁语义，才能选择纯 Cloudflare 计算方案。现有 Fetch 实验也不能替代这项证明。

| 选择 | 下一步必须证明的事 | 当前结论 |
| --- | --- | --- |
| Cloudflare 入口，独立隔离计算和持久存储 | 原协议经过公网入口仍可用；恶意代码无法跨应用访问；原状态在第二套部署恢复 | 推荐继续评估，保留原契约的改动较少 |
| 全部使用 Cloudflare | Containers 上的持久文件语义、SQLite、完整网络协议和镜像更换语义；随后完成相同隔离与恢复验收 | 需要先解决持久存储和协议验证，当前不能宣称兼容 |

组合部署仍需要选择实际计算环境。普通 Kubernetes Pod、共享 Node runner 或仅增加 NetworkPolicy，都不足以证明恶意租户隔离。容器与 isolate 两条执行路径都需要可验证的隔离边界，存储和平台控制接口也必须在该边界之外。

## 上线前尚缺的输入与证据

| 项目 | 已知情况 | 下一步 |
| --- | --- | --- |
| 控制域名 | 当前账户可读取 `deepaste.ai`，区域状态为 active；Wrangler OAuth 对 DNS 记录查询返回认证错误 | 提供具备该区域 DNS 权限的认证方式后，核对 `space.deepaste.ai` 是否占用，再配置入口 |
| 应用域名 | 仅提供了控制域名 | 选择符合[身份配置](app-contract.md#hosted-identity)的独立应用站点 |
| GitHub OAuth | 生产 client ID 和 secret 未配置 | 为控制域名创建 OAuth 配置，将 secret 放进部署的 Secret；回调路径沿用身份契约 |
| 恶意代码与资源上限 | 本地集群不执行 NetworkPolicy，当前检查没有证明公开租户隔离 | 在选定的隔离计算环境执行 AC-SAAS-15 和 AC-SAAS-16 |
| 第二后端恢复 | 本轮数据库备份用于保护现有开发环境，不是跨云恢复证明 | 先冻结支持的备份清单和物理绑定重建流程，再以实际源、目标部署执行 AC-SAAS-17 |

恢复验证必须保留源数据。平台身份与拥有者、应用制品、文件与 SQLite、PostgreSQL、KV 和对象内容分别校验，不能用单一数据库备份代替整个平台迁移。存储层职责见 [M2 运营要求](../REQUIREMENTS-M2.md#运营)。

## 费用边界

目前只使用已有本地资源和云端只读接口。没有部署 Containers、创建云资源或开启新订阅。

Cloudflare [Containers 定价](https://developers.cloudflare.com/containers/platform/pricing/)要求 Workers Paid，基础计划为每月 5 美元，并另外计算超过包含额度的容器资源、流量以及相关 Workers 和 Durable Objects 使用。5 美元不是完整 SaaS 的月费报价。

组合部署的计算、持久卷、数据库、备份和出口费用取决于供应商、区域和容量。选定部署方式后，先列出资源规格、单价与总预算，再请求开通付费资源。没有预算上限和实际隔离环境前，维持本地验证和受控开发使用。
