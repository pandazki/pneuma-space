// Content for adr.html (07 Architecture Decision Records — All 37 ADRs with source code traceability & full rendered markdown).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bi, esc, renderMarkdown, srcRef } from './helpers.ts';

export type AdrMeta = {
  readonly num: string;
  readonly file: string;
  readonly cat: 'm1-core' | 'runtime-console' | 'm2-k8s-store' | 'identity-tenant' | 'm3-cloud';
  readonly statusEn: string;
  readonly statusZh: string;
  readonly statusColor: 'green' | 'orange' | '';
  readonly titleEn: string;
  readonly titleZh: string;
  readonly summaryEn: string;
  readonly summaryZh: string;
  readonly sources: readonly { readonly path: string; readonly lines?: string }[];
};

export const ADR_CATALOG: readonly AdrMeta[] = [
  {
    num: '0001', file: '0001-local-trust-boundary.md', cat: 'm1-core',
    statusEn: 'Active (M1)', statusZh: 'M1 沿用', statusColor: 'green',
    titleEn: 'Single Trusted Host Prototype & Evolution Boundary',
    titleZh: '可信单机原型与演进边界',
    summaryEn: 'M1 serves one trusted machine, operator, and app images over loopback ports; tenant isolation and SSO are deferred to M2/M3.',
    summaryZh: 'M1 服务单台可信机器与可信镜像，网关控制 Docker socket，端口绑定回环地址；明确区分单机命名空间与多租户安全边界。',
    sources: [{ path: 'REQUIREMENTS.md', lines: 'L17-L20' }, { path: 'compose.yaml', lines: 'L1-L90' }],
  },
  {
    num: '0002', file: '0002-application-lifecycle.md', cat: 'm1-core',
    statusEn: 'Superseded by 0006', statusZh: '已被 ADR 0006 取代', statusColor: 'orange',
    titleEn: 'Stable Path, On-Demand Start & Idle Stop (Prototype Input)',
    titleZh: '稳定路径、按需运行与闲置停止',
    summaryEn: 'Prototype validation of /apps/<name>/, caching started state to avoid hot-path Docker calls, and pre-request connection retry.',
    summaryZh: '原型阶段对稳定路径、按需启动、缓存启动状态消除热路径 Docker 调用及连接失败前重试的实验验证。',
    sources: [{ path: 'gateway/src/ingress.ts', lines: 'L336-L347' }],
  },
  {
    num: '0003', file: '0003-storage-contract.md', cat: 'm1-core',
    statusEn: 'Superseded in part by 0005', statusZh: '部分被 ADR 0005 取代', statusColor: 'orange',
    titleEn: 'Dual Databases & Portable Relational SQL Subset',
    titleZh: '两种数据库与有界关系型接口',
    summaryEn: 'Establishes the portable SQL subset shared by SQLite and PostgreSQL and the rule that switching db_backend never migrates data.',
    summaryZh: '确立 SQLite 与 PostgreSQL 共用的可移植 SQL 子集、切换数据库后端不迁移数据以及 schema 不是安全边界三条持久原则。',
    sources: [{ path: 'templates/app/sdk/db.ts', lines: 'L1-L90' }, { path: 'docs/app-contract.md', lines: 'L5-L8' }],
  },
  {
    num: '0004', file: '0004-agent-templates-and-progression.md', cat: 'm1-core',
    statusEn: 'Superseded', statusZh: '已取代', statusColor: 'orange',
    titleEn: 'Treating Coding Agents as Platform Users, Not Platform Model Entities',
    titleZh: '把 Agent 视为平台使用者',
    summaryEn: 'No Agent or template selector exists inside the platform model; coding agents read templates/app/AGENTS.md and publish via appctl like human developers.',
    summaryZh: '平台领域模型中不出现 Agent 或模板选择器；编码 Agent 作为平台使用者阅读 templates/app/AGENTS.md 并通过 appctl 发布应用。',
    sources: [{ path: 'templates/app/AGENTS.md', lines: 'L1-L130' }, { path: 'cli/scaffold.ts', lines: 'L1-L25' }],
  },
  {
    num: '0005', file: '0005-capabilities-and-providers.md', cat: 'm1-core',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'CAPABILITIES Table, Idempotent Providers & Runtime Injection',
    titleZh: '能力清单、Provider 与注入',
    summaryEn: 'CAPABILITIES is the single source of truth; each resource kind maps to a Provider with ensure, inject, suspend, destroy; bindings belong to App, not Release.',
    summaryZh: 'CAPABILITIES 是唯一能力表，推导环境变量与 Provider；资源按 App 而非 Release 绑定，ensure 幂等收敛且兼具恢复功能，Injection 在实例创建时即时推导。',
    sources: [{ path: 'shared/catalog.ts', lines: 'L22-L50' }, { path: 'gateway/src/providers.ts', lines: 'L103-L370' }],
  },
  {
    num: '0006', file: '0006-runtime-lifecycle.md', cat: 'm1-core',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'Leases, Per-Instance 5-State Lifecycle & Atomic Release Publish',
    titleZh: 'Lease、实例状态机与发布',
    summaryEn: 'Unifies HTTP requests, streams, WebSockets, SSE, and triggers as Leases; per-instance lock over asleep/waking/awake/draining/stopping; opaque App.id.',
    summaryZh: '将请求、流、长连接与触发统一抽象为 Lease；定义五态实例状态机与单写者平台库；内部资源一律使用不透明的 App.id 命名。',
    sources: [{ path: 'gateway/src/lifecycle.ts', lines: 'L66-L200' }, { path: 'gateway/src/model.ts', lines: 'L21-L23' }],
  },
  {
    num: '0007', file: '0007-bytes-never-pass-the-app.md', cat: 'm1-core',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'Direct Object Storage via Presigned URLs & Gateway-Served Static Bundles',
    titleZh: '对象由对象服务提供，静态由网关提供',
    summaryEn: 'Object bytes go straight between browser and S3 storage (RustFS) via presigned URLs or public/*; static bundle bytes stream from gateway without waking compute.',
    summaryZh: '对象字节通过预签名 URL 或 public/* 在浏览器与 S3 存储间直传，0 字节经过应用和网关；静态 bundle 由网关从对象存储直接流式响应，不起容器。',
    sources: [{ path: 'gateway/src/static.ts', lines: 'L1-L85' }, { path: 'templates/app/sdk/objects.ts', lines: 'L1-L95' }],
  },
  {
    num: '0008', file: '0008-identity-context.md', cat: 'identity-tenant',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'Three Flat Identity Headers & Pluggable IdentityProvider',
    titleZh: '身份上下文',
    summaryEn: 'Drops all inbound X-Pneuma-Space-* headers and injects X-Pneuma-Space-Subject (user:<id> or service:<id>), X-Pneuma-Space-Name, and X-Pneuma-Space-Owner: 1.',
    summaryZh: '网关剥离所有入站 X-Pneuma-Space-* 头，经 IdentityProvider 认证后注入 Subject、Name 与 Owner 三个平面请求头，无需 SDK 也能做所有者判断。',
    sources: [{ path: 'gateway/src/ingress.ts', lines: 'L76-L106' }, { path: 'gateway/src/identity.ts', lines: 'L1-L180' }],
  },
  {
    num: '0009', file: '0009-triggers.md', cat: 'm1-core',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'At-Least-Once Scheduled & On-Demand Triggers',
    titleZh: '触发至少一次',
    summaryEn: 'Persists Delivery row before calling POST /_pneuma-space/trigger/<name> with trigger Lease; retries up to 5 times with identical X-Pneuma-Space-Delivery ID.',
    summaryZh: '定时和按需触发先落库持久化 Delivery 再以 trigger 租约唤醒应用；最多退避重试 5 次并携带相同的 X-Pneuma-Space-Delivery 供应用幂等去重；停机最多补发最近一个槽位。',
    sources: [{ path: 'gateway/src/scheduler.ts', lines: 'L58-L260' }],
  },
  {
    num: '0010', file: '0010-rtc-in-m1.md', cat: 'm1-core',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'WebRTC STUN/TURN Capability Behind Compose rtc Profile',
    titleZh: 'RTC 进 M1，在 Compose profile 后面',
    summaryEn: 'Leaf CoturnProvider injects STUN/TURN URLs and HMAC secret; SDK mints time-limited TURN credentials while signaling uses the app’s own ws capability.',
    summaryZh: '作为叶子 Provider 注入 coturn STUN/TURN 地址与 HMAC 共享密钥；SDK 铸造限时 TURN 凭据，信令走应用自己的 ws 长连接。',
    sources: [{ path: 'gateway/src/providers.ts', lines: 'L315-L351' }, { path: 'templates/app/sdk/rtc.ts', lines: 'L1-L55' }],
  },
  {
    num: '0011', file: '0011-publish-input.md', cat: 'm1-core',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'Publish Input Is Pre-Built Image or Code Bundle Plus Manifest',
    titleZh: '发布输入是预构建镜像加清单',
    summaryEn: 'The platform has no server-side Docker build service; appctl builds or bundles on the developer machine and commits content-hashed Releases.',
    summaryZh: '平台不包含服务端构建服务；appctl 在开发者本地完成构建或代码打包，以内容哈希 release_key 标识不可变 Release。',
    sources: [{ path: 'cli/appctl.ts', lines: 'L129-L260' }, { path: 'gateway/src/model.ts', lines: 'L133-L135' }],
  },
  {
    num: '0012', file: '0012-implementation-stack.md', cat: 'm1-core',
    statusEn: 'Active (M1/M2/M3)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'Zero-Dependency Node.js LTS & Direct TypeScript Execution',
    titleZh: '实现语言与依赖',
    summaryEn: 'Gateway runs on Node.js LTS using built-in modules only (http, net, tls, node:sqlite, crypto) with zero runtime dependencies and native TypeScript execution.',
    summaryZh: '网关采用 Node.js LTS 原生直接执行 TypeScript，只使用内置模块（http、net、tls、node:sqlite、crypto），零运行时 npm 依赖，无编译构建步骤。',
    sources: [{ path: 'package.json', lines: 'L1-L23' }, { path: 'gateway/src/main.ts', lines: 'L1-L35' }],
  },
  {
    num: '0013', file: '0013-object-provider-over-signed-http.md', cat: 'm1-core',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'Object Provider & BundleStore Over SigV4 HTTP & Encrypted madmin API',
    titleZh: '对象 Provider 用签名 HTTP 管理对象服务',
    summaryEn: 'Speaks S3 and MinIO-compatible /minio/admin/v3/ directly from node:crypto using SigV4 and Argon2id + AES-256-GCM encrypted admin payloads.',
    summaryZh: '用 node:crypto 直接向 RustFS 发送 SigV4 签名 HTTP 请求与 Argon2id + AES-256-GCM 加密的 madmin 管理请求，为每应用创建限 bucket 的密钥对与公开读策略。',
    sources: [{ path: 'gateway/src/providers.ts', lines: 'L253-L313' }, { path: 'gateway/src/providers.ts', lines: 'L515-L665' }],
  },
  {
    num: '0014', file: '0014-console-overview.md', cat: 'runtime-console',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'Zero-IO In-Memory Console Overview & Telemetry Sampler',
    titleZh: '管理后台的平台总览',
    summaryEn: 'Metrics component samples services, fleet seats, wake latencies, deliveries, and host load every 10 s; GET /api/metrics answers from memory with 0 Docker calls.',
    summaryZh: 'Metrics 组件每 10 秒后台采样服务状态、并发席位、唤醒耗时、投递与宿主机负载；GET /api/metrics 纯内存响应，0 Docker 调用。',
    sources: [{ path: 'gateway/src/metrics.ts', lines: 'L163-L360' }, { path: 'gateway/src/console.html', lines: 'L1-L360' }],
  },
  {
    num: '0015', file: '0015-live-overview.md', cat: 'runtime-console',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'Diff-Driven Live Overview, Awake Timeline & sleepsAt',
    titleZh: '活的总览',
    summaryEn: 'Adds sleepsAt countdown and event sequence numbers; diff-driven seat ignition, awake instance timeline, synchronized crosshair charts, and pause-on-hover event stream.',
    summaryZh: '以醒睡周期为主角：列表增加 sleepsAt 倒计时，通过快照差分驱动席位点亮、实例状态时间线、三图联动十字线与悬停暂存的事件流。',
    sources: [{ path: 'gateway/src/console.html', lines: 'L205-L360' }, { path: 'gateway/src/lifecycle.ts', lines: 'L114-L116' }],
  },
  {
    num: '0016', file: '0016-realtime-page.md', cat: 'runtime-console',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'Realtime Page & 1000-Entry In-Memory Request Ring',
    titleZh: '实时页与请求记录',
    summaryEn: 'Records request, static, ws, and trigger durations, cold-start flag, and waitMs in a 1000-entry ring; unified filter bar over request and lifecycle event streams.',
    summaryZh: '网关内存维护 1000 条请求记录环（含 request/static/ws/trigger 耗时、冷启动标记与等待时间），在控制台实时页提供统一语法的请求流与事件流双栏视图。',
    sources: [{ path: 'gateway/src/requests.ts', lines: 'L1-L210' }, { path: 'gateway/src/console.html', lines: 'L370-L430' }],
  },
  {
    num: '0017', file: '0017-pluggable-runtimes.md', cat: 'runtime-console',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'Pluggable Runtimes, Isolate Worker Service & The Guard',
    titleZh: '可插拔运行时与 isolate 运行时',
    summaryEn: 'Introduces RUNTIMES table, Runtimes facade, neutral storage bindings, the standalone worker_threads runner service with 3 s watchdog, and AppGuard quarantine.',
    summaryZh: '确立可插拔 RUNTIMES 表与 Runtimes 门面、存储绑定中立化、独立部署的 worker_threads runner 服务（含 1s 心跳/3s 看门狗与垫片防护）以及统一熔断隔离的 AppGuard。',
    sources: [{ path: 'gateway/src/runtimes.ts', lines: 'L48-L244' }, { path: 'gateway/src/runner.ts', lines: 'L1-L486' }, { path: 'gateway/src/isolate-shim.ts', lines: 'L1-L180' }],
  },
  {
    num: '0018', file: '0018-topology-page.md', cat: 'runtime-console',
    statusEn: 'Active (M1/M2)', statusZh: 'M1 决定', statusColor: 'green',
    titleEn: 'Live Topology Page: Runtime Lanes View & 5-Column Capability Graph',
    titleZh: '拓扑页与运行时视图',
    summaryEn: 'Inline SVG topology views (Lanes and 5-column Graph) drawn from live gateway state, with reverse fault-color propagation and inline unquarantine.',
    summaryZh: '控制台内置泳道视图（Lanes）与五列分层连线图（Graph），实时展示网关阶段、三条运行时车道、十大能力与后端服务的依赖关系及反向故障染色。',
    sources: [{ path: 'docs/assets/render.ts', lines: 'L1-L610' }, { path: 'gateway/src/console.html', lines: 'L430-L680' }],
  },
  {
    num: '0019', file: '0019-kubernetes-plane.md', cat: 'm2-k8s-store',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'Kubernetes Deployment Plane: PodDriver, StatefulSetPool & NetworkPolicies',
    titleZh: 'Kubernetes 部署平面',
    summaryEn: 'Kubernetes is a deployment plane selected by PNEUMA_SPACE_PLANE=kubernetes; 1 Pod per awake container app, runner StatefulSet with pinned home, zero-dep kube.ts client.',
    summaryZh: '将 K8s 定义为部署平面而非运行时：main.ts 按平面切换四个组件，内置零依赖 kube.ts 客户端、双命名空间与 NetworkPolicy、单实例 PodDriver 与固定 home 的 runner StatefulSet。',
    sources: [{ path: 'gateway/src/kube.ts', lines: 'L1-L350' }, { path: 'gateway/src/pods.ts', lines: 'L1-L511' }, { path: 'deploy/kubernetes/60-network-policies.yaml', lines: 'L1-L200' }],
  },
  {
    num: '0020', file: '0020-instance-state-in-store.md', cat: 'm2-k8s-store',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'Store-Backed Instance State, CAS Transitions & Multi-Replica Gateway',
    titleZh: '实例状态进平台库，网关多副本',
    summaryEn: 'Moves instance, lease_tally, guard, and replica tables to the store; enforces single-instance invariant via CAS on (runtime, state, epoch) with zero-IO local mirrors.',
    summaryZh: '将 instance、lease_tally、guard 与 replica 四张表迁入平台库，仅靠 (runtime, state, epoch) 上的条件更新（CAS）保证全集群单实例，并在副本内维护零 IO 镜像。',
    sources: [{ path: 'gateway/src/instances.ts', lines: 'L1-L255' }, { path: 'gateway/src/lifecycle.ts', lines: 'L109-L360' }],
  },
  {
    num: '0021', file: '0021-trusted-upstream-identity.md', cat: 'identity-tenant',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'Trusted Upstream JWT Identity Verifier & Separate Console Audience',
    titleZh: '可信上游身份',
    summaryEn: 'Verifies RS256, ES256, and EdDSA JWTs from an authenticating proxy using node:crypto with JWKS caching, audience separation, and cookie Domain stripping.',
    summaryZh: '内置零依赖 JwtVerifier（支持 RS256/ES256/EdDSA 与 JWKS 缓存），验证组织上游认证代理注入的签名 JWT，并通过独立控制台 audience 防止应用泄漏的令牌重放管理接口。',
    sources: [{ path: 'gateway/src/jwt.ts', lines: 'L1-L191' }, { path: 'gateway/src/identity.ts', lines: 'L180-L420' }],
  },
  {
    num: '0022', file: '0022-tenants-and-access.md', cat: 'identity-tenant',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'Tenants, Memberships, Service/Personal Tokens & App Access Scopes',
    titleZh: '租户、成员、令牌与访问范围',
    summaryEn: 'Defines Tenant, User, Membership (admin | member), Token, and Access (tenant | org | public), plus the pure ACTIONS authorization table and Team console page.',
    summaryZh: '引入租户、成员角色（admin 管全租户，member 仅读写自己为 owner 的应用）、服务与个人令牌、三档应用访问范围（tenant/org/public）以及 ACTIONS 集中授权表。',
    sources: [{ path: 'gateway/src/authz.ts', lines: 'L1-L225' }, { path: 'gateway/src/registry.ts', lines: 'L424-L540' }],
  },
  {
    num: '0023', file: '0023-quotas.md', cat: 'identity-tenant',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'Per-Instance CPU/Memory Shape & Per-Tenant Resource Quotas',
    titleZh: '配额与资源',
    summaryEn: 'Adds cpu_millis and memory_mb policy fields and per-tenant quotas (apps, awake, cpu_millis, memory_mb, storage_gb) checked under the tenant row lock.',
    summaryZh: '新增每实例 cpu_millis 与 memory_mb 策略，以及按租户行锁串行判定的五项配额（应用数、并发唤醒数、CPU 总量、内存总量、卷存储容量）。',
    sources: [{ path: 'gateway/src/model.ts', lines: 'L197-L200' }, { path: 'gateway/src/runtimes.ts', lines: 'L41-L46' }],
  },
  {
    num: '0024', file: '0024-observability-persisted.md', cat: 'm2-k8s-store',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'Persisted Usage Heatmaps, Lifecycle Events, Append-Only Audit & Prometheus',
    titleZh: '观测落库、热力图、审计、指标、节点与日志',
    summaryEn: 'Persists per-replica usage buckets, global events with 2 s settle window, append-only audit log, fan-out request stream across peers, and Prometheus /metrics.',
    summaryZh: '实现每副本写绝对值读时求和的 usage 热力图表、带 2s 沉淀期的全局递增 events 表、触发器保护的只追加 audit 审计表、跨副本请求流扇出以及 Prometheus 指标端点。',
    sources: [{ path: 'gateway/src/metrics.ts', lines: 'L1-L760' }, { path: 'gateway/src/admin.ts', lines: 'L1-L220' }],
  },
  {
    num: '0025', file: '0025-platform-store-postgresql.md', cat: 'm2-k8s-store',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'PostgreSQL Platform Store, Built-In pg.ts Wire Client & Direct Provisioning',
    titleZh: '平台库上 PostgreSQL，内置线协议客户端，供应直接说协议',
    summaryEn: 'Built-in PostgreSQL wire client (pg.ts) and Redis RESP2 client (resp.ts); shared sql.ts DML; SERIALIZABLE retries; advisory locks; trigger-driven NOTIFY pneuma_space.',
    summaryZh: '内置零依赖 PostgreSQL 线协议客户端 pg.ts 与 Redis 客户端 resp.ts；SQLite 与 PG 共用一份 sql.ts DML；SERIALIZABLE 自动重试、会话咨询锁与行触发器 NOTIFY。',
    sources: [{ path: 'gateway/src/pg.ts', lines: 'L1-L501' }, { path: 'gateway/src/store-pg.ts', lines: 'L1-L540' }, { path: 'gateway/src/resp.ts', lines: 'L1-L95' }],
  },
  {
    num: '0026', file: '0026-cluster-page-and-operations.md', cat: 'm2-k8s-store',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'Cluster Console Page & Day-2 Operator Actions (Scale, Drain, Restart, Kill)',
    titleZh: '集群页与运维操作',
    summaryEn: 'Adds Cluster/Host page backed by 15 s cached /api/cluster snapshot and operator controls to scale gateway/runner, restart Pods, drain nodes, and stop/restart/kill instances.',
    summaryZh: '控制台新增集群/主机页（基于 15s 采样缓存的 /api/cluster），支持扩缩网关与 runner、重启平台 Pod、排空节点上的全部实例，以及对单实例执行 stop、restart 与 grace 0 强制 kill。',
    sources: [{ path: 'gateway/src/nodes.ts', lines: 'L1-L160' }, { path: 'gateway/src/kube-infra.ts', lines: 'L100-L360' }],
  },
  {
    num: '0027', file: '0027-replica-memory-and-shared-rows.md', cat: 'm2-k8s-store',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'What a Replica May Deduce From Memory: Committed Tally & Worker Ownership',
    titleZh: '副本凭内存能断定什么',
    summaryEn: 'Fast-path acquire trusts only a committed >0 lease_tally with no queued 0 write; isolate worker ownership is judged from store rows; every replica follows awake workers.',
    summaryZh: '修正多副本内存竞态：快路径只信任已落库提交的正数 lease_tally；isolate worker 的归属唯一以数据库 instance 行为准；每个副本跟随所有醒着的 isolate worker 的结束事件。',
    sources: [{ path: 'gateway/src/lifecycle.ts', lines: 'L71-L90' }, { path: 'gateway/src/isolate.ts', lines: 'L140-L167' }],
  },
  {
    num: '0028', file: '0028-registry-resources-between-check-and-commit.md', cat: 'm2-k8s-store',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'Pre-Ensure Quota Reservation & Bundle Exclusion Between Publish and Purge',
    titleZh: '发布、策略和清除在检查与提交之间对资源的假定',
    summaryEn: 'Inserts suspended placeholder Binding rows under the tenant lock before provider.ensure() so concurrent publishes cannot exceed storage_gb; adds Store.exclusiveBundle.',
    summaryZh: '在 provider.ensure() 之前先在租户行锁事务内插入 suspended 占位 Binding 行以防并发发布穿透 storage_gb 配额；新增 Store.exclusiveBundle 互斥 bundle 提交与清除。',
    sources: [{ path: 'gateway/src/registry.ts', lines: 'L185-L290' }],
  },
  {
    num: '0029', file: '0029-delivery-claims.md', cat: 'm2-k8s-store',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'Authenticated Delivery Claims (replica, attempts) & Periodic Leader Reclaim',
    titleZh: '投递的认领有身份，领导者周期回收',
    summaryEn: 'Each delivery attempt records (claim_replica, attempts); completion writes are conditional on that claim, and the leader reclaims orphaned delivering rows every 5 s.',
    summaryZh: '每次触发投递认领写入 (replica, attempts) 身份，结果写回必须带该条件更新以防迟到尝试覆盖新尝试；领导者每 5 秒周期回收死副本或旧进程遗留的 delivering 行。',
    sources: [{ path: 'gateway/src/scheduler.ts', lines: 'L98-L165' }],
  },
  {
    num: '0030', file: '0030-compose-service-presence.md', cat: 'm1-core',
    statusEn: 'Active (M1/M2)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'Compose Service Presence: Same-Subnet DNS Resolution + TCP Connect',
    titleZh: 'Compose 上的平台服务，在网关的网络上且接受连接才算在',
    summaryEn: 'Verifies a Compose service DNS answer falls within the gateway’s own IPv4 interface subnets (defeating host Fake-IP proxies) and accepts TCP connections within 1 s.',
    summaryZh: '使用 500ms 有界 DNS 解析器并校验解析地址位于网关自身网卡 IPv4 子网内（抵御宿主机 Fake-IP 合成地址干扰），再通过 1 秒 TCP 连接区分 off、down 与 up。',
    sources: [{ path: 'gateway/src/providers.ts', lines: 'L59-L88' }, { path: 'gateway/src/metrics.ts', lines: 'L50-L120' }],
  },
  {
    num: '0031', file: '0031-request-cursor-generation.md', cat: 'runtime-console',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'Process Generation in Request Cursors (<replica>:<seq>@<generation>)',
    titleZh: '请求游标带进程世代',
    summaryEn: 'Tags each replica’s request ring cursor with process start timestamp so a restarted replica whose seq caught up to the old cursor is still detected and reported as reset.',
    summaryZh: '在跨副本请求流游标中加入进程启动毫秒世代 <replica>:<seq>@<generation>，即使重启后新进程 seq 追上旧游标也能准确识别并渲染副本重启分割行。',
    sources: [{ path: 'gateway/src/requests.ts', lines: 'L1-L160' }],
  },
  {
    num: '0032', file: '0032-runner-scale-down-keeps-homes.md', cat: 'm2-k8s-store',
    statusEn: 'Active (M2/M3)', statusZh: 'M2 决定', statusColor: 'green',
    titleEn: 'Refusing Runner Scale-Down When Any App Is Homed on Removed Replicas',
    titleZh: '缩 runner 不改派 home，删掉有 home 的副本时拒绝',
    summaryEn: 'Scaling pneuma-space-runner to M replicas checks Runtimes.homes() first and answers 409 Conflict with the stranded app list if any app is homed on ordinal >= M.',
    summaryZh: '缩容 runner StatefulSet 至 M 个副本前，先从平台库核对所有 instance 行的 home，只要存在序号 >= M 的绑定应用即在 K8s 调用前返回 409 Conflict 并列出受困应用。',
    sources: [{ path: 'gateway/src/runtimes.ts', lines: 'L136-L144' }, { path: 'gateway/src/kube-infra.ts', lines: 'L250-L320' }],
  },
  {
    num: '0033', file: '0033-hosted-fetch-profile.md', cat: 'm3-cloud',
    statusEn: 'Accepted (Contract 2 Experiment)', statusZh: '接受 (独立契约 2 实验)', statusColor: 'green',
    titleEn: 'Standalone Cloud Entry & Portable Fetch Contract 2 (pneuma-space.fetch/1)',
    titleZh: '独立云入口与可迁移的 Fetch 契约',
    summaryEn: 'Defines Contract 2 (pneuma-space.fetch/1) with Web standard fetch(request, app) and optimistic-concurrency JSON Records for serverless isolate adapters (cloud/).',
    summaryZh: '为无状态 Worker 云后端定义独立的契约 2（pneuma-space.fetch/1）：采用标准 ES Module fetch(request, app) 与乐观并发 JSON Records 接口，支持应用级归档导出与迁移。',
    sources: [{ path: 'cloud/README.md', lines: 'L1-L90' }, { path: 'docs/app-contract.md', lines: 'L227-L313' }],
  },
  {
    num: '0034', file: '0034-personal-tenants-and-private-origins.md', cat: 'm3-cloud',
    statusEn: 'Accepted (M3)', statusZh: '接受 (M3)', statusColor: 'green',
    titleEn: 'Personal Tenants, Idempotent Self-Service Signup & Private App Origins',
    titleZh: '个人租户、自助注册与私有应用源',
    summaryEn: 'Maps each verified immutable external identity to a deterministic internal User and personal Tenant; isolates private app browser origins with single-use grants.',
    summaryZh: '将外部认证提供者的不可变主体确定性映射为内部 User 与个人私有 Tenant（幂等注册、不按邮箱或显示名合并）；通过单次浏览器绑定 Grant 实现私有应用源访问。',
    sources: [{ path: 'gateway/src/registry.ts', lines: 'L50-L53' }, { path: 'gateway/src/registry.ts', lines: 'L456-L474' }, { path: 'gateway/src/identity-hosted.ts', lines: 'L1-L260' }],
  },
  {
    num: '0035', file: '0035-terminal-artifact-fences.md', cat: 'm3-cloud',
    statusEn: 'Accepted (Contract 2 Experiment)', statusZh: '接受 (契约 2 实验)', statusColor: 'green',
    titleEn: 'Terminal Artifact Fences Against Late Object Writes After Purge',
    titleZh: '制品清除的终态栅栏',
    summaryEn: 'Registers artifact keys in a per-app Durable Object before conditional R2 writes and overwrites all keys with terminal tombstones on purge so delayed writes cannot resurrect code.',
    summaryZh: '在写 R2 对象前先在每应用独立的 SQLite Durable Object 中登记制品键，清除时原子封闭登记并将所有 R2 键覆盖为不含代码的终态标记，防止迟到写入导致已清除代码复活。',
    sources: [{ path: 'cloud/core/', lines: undefined }],
  },
  {
    num: '0036', file: '0036-additive-hosted-platform.md', cat: 'm3-cloud',
    statusEn: 'Active (M3 Baseline)', statusZh: '接受 (M3 核心基线)', statusColor: 'green',
    titleEn: 'Full SaaS Preserves Complete Contract 1 Platform & Original Console',
    titleZh: 'SaaS 保留完整平台',
    summaryEn: 'Full SaaS runs the original Node gateway, Registry, Store, Runtimes, Providers, Scheduler, Metrics, and Console with PNEUMA_SPACE_IDENTITY=hosted added.',
    summaryZh: '明确完整 SaaS 必须保留全部 M1、M2 应用能力（契约 1）与原控制台监控诊断功能：在原 Node 网关上新增 hosted 身份模式，而将 Fetch 契约 2 保留为独立实验。',
    sources: [{ path: 'REQUIREMENTS-M3.md', lines: 'L1-L43' }, { path: 'gateway/src/main.ts', lines: 'L45-L50' }, { path: 'gateway/src/identity-hosted.ts', lines: 'L1-L390' }],
  },
  {
    num: '0037', file: '0037-hybrid-origin-tls.md', cat: 'm3-cloud',
    statusEn: 'Active (M3 Deploy)', statusZh: '已接受 (M3 部署)', statusColor: 'green',
    titleEn: 'Hybrid Deployment Origin TLS With Dedicated Caddy & Cloudflare DNS-Only',
    titleZh: '组合部署的源站 TLS',
    summaryEn: 'Replaces retired ingress-nginx and avoids Cloudflare HTTP proxy upload/timeout limits by using DNS-only records routed to a dedicated Caddy TLS LoadBalancer Service.',
    summaryZh: '为避免 Cloudflare 普通 HTTP 代理收窄契约 1 的无限流式上传与长连接超时，并替代已退役的 ingress-nginx，采用 Cloudflare DNS-only 直连集群内专用 Caddy 服务在源站终止三域 TLS。',
    sources: [{ path: 'deploy/hosted/README.md', lines: 'L34-L57' }, { path: 'deploy/hosted/verify-tls.ts', lines: 'L1-L110' }],
  },
];

export function renderAdrPage(repoRoot: string): { html: string; toc: { id: string; en: string; zh: string }[] } {
  const toc = [
    { id: 'adr-overview', en: 'ADR Codex & Category Filter', zh: 'ADR 索引与分类过滤' },
    { id: 'adr-0001', en: 'ADR 0001–0013 (M1 Core & Wire)', zh: 'ADR 0001–0013 (M1 核心与协议)' },
    { id: 'adr-0014', en: 'ADR 0014–0018 (Console & Isolate)', zh: 'ADR 0014–0018 (控制台与 Isolate)' },
    { id: 'adr-0019', en: 'ADR 0019–0032 (M2 K8s & Multi-Replica)', zh: 'ADR 0019–0032 (M2 集群与多副本)' },
    { id: 'adr-0033', en: 'ADR 0033–0037 (M3 Hosted SaaS & TLS)', zh: 'ADR 0033–0037 (M3 托管与源站 TLS)' },
  ];

  const itemsHtml = ADR_CATALOG.map((adr) => {
    const fullPath = join(repoRoot, 'docs', 'adr', adr.file);
    let rawMd = '';
    try {
      rawMd = readFileSync(fullPath, 'utf8');
    } catch {
      rawMd = `File docs/adr/${adr.file} not found.`;
    }
    const renderedBody = renderMarkdown(rawMd);
    const sourceBadges = [
      srcRef(`docs/adr/${adr.file}`, undefined, `docs/adr/${adr.file}`),
      ...adr.sources.map((s) => srcRef(s.path, s.lines)),
    ].join('');

    const stClass = adr.statusColor ? `st ${adr.statusColor}` : 'st';

    return `<details class="adr-item" id="adr-${adr.num}" data-adr-cat="${adr.cat}"${adr.num === '0017' || adr.num === '0019' || adr.num === '0025' ? ' open' : ''}>
  <summary>
    <span class="adr-num">ADR ${adr.num}</span>
    <div class="adr-title-block">
      <b>${bi(esc(adr.titleEn), esc(adr.titleZh))}</b>
      <span>${bi(esc(adr.summaryEn), esc(adr.summaryZh))}</span>
    </div>
    <div class="adr-meta-right">
      <span class="${stClass}">${bi(esc(adr.statusEn), esc(adr.statusZh))}</span>
      <span class="chip">${esc(adr.sources[0]?.path.split('/').pop() ?? 'spec')}</span>
    </div>
  </summary>
  <div class="adr-body">
    <div class="adr-source-bar">
      <strong>${bi('Verified Source Files & Spec:', '交叉确认源码与规范文件：')}</strong>
      <div class="chips">${sourceBadges}</div>
    </div>
    ${renderedBody}
  </div>
</details>`;
  }).join('\n');

  const html = `
<div class="page-head" id="adr-overview">
  <div class="page-head-row">
    <h1>${bi('Architecture Decision Records (ADR 0001–0037 Full Codex)', '架构决策记录全集（ADR 0001–0037 全文与源码溯源）')}</h1>
    <div class="chips">
      <span class="chip accent"><span id="adr-visible-count">37</span> / 37 ADRs</span>
      ${srcRef('docs/adr', undefined, 'docs/adr/0001..0037')}
    </div>
  </div>
  <p class="lead">
    ${bi(
      'Every deviation or expansion in PneumaSpace is recorded as an ADR in docs/adr/ before the code lands, including the options rejected and why. Below is the complete, unabridged codex of all 37 ADRs, each cross-linked to the TypeScript source files that implement it.',
      'PneumaSpace 的每一项架构演进与取舍在代码落地前均记录为 docs/adr/ 下的 ADR，包含明确的决定、理由、拒绝的备选方案与后果。下方收录全部 37 篇 ADR 的完整原文，并逐篇标注对应的 TypeScript 源码实现位置。'
    )}
  </p>
</div>

<section class="doc-section">
  <div class="sec-head">
    <h2>${bi('Complete ADR Archive (0001–0037) & Source Traceability', '全部 37 篇架构决策记录（0001–0037）与源码实现映射')}</h2>
  </div>
  <div class="adr-toolbar">
    <div class="seg" role="tablist" aria-label="ADR Categories">
      <button type="button" data-adr-cat-btn="all" aria-pressed="true">${bi('All (37)', '全部 (37)')}</button>
      <button type="button" data-adr-cat-btn="m1-core" aria-pressed="false">${bi('M1 Core & Wire (13)', 'M1 核心与协议 (13)')}</button>
      <button type="button" data-adr-cat-btn="runtime-console" aria-pressed="false">${bi('Runtimes & Console (6)', '运行时与控制台 (6)')}</button>
      <button type="button" data-adr-cat-btn="m2-k8s-store" aria-pressed="false">${bi('M2 K8s & Multi-Replica (10)', 'M2 集群与多副本 (10)')}</button>
      <button type="button" data-adr-cat-btn="identity-tenant" aria-pressed="false">${bi('Identity & Quotas (4)', '身份、租户与配额 (4)')}</button>
      <button type="button" data-adr-cat-btn="m3-cloud" aria-pressed="false">${bi('M3 SaaS & TLS (5)', 'M3 托管与源站 TLS (5)')}</button>
    </div>
    <input type="search" class="adr-search-input" id="adr-filter-input" placeholder="Filter ADRs by keyword, table, or file (e.g. isolate, CAS, pg.ts, 0017)..." aria-label="Filter ADRs">
    <div class="chips">
      <button type="button" class="btn ghost small" data-adr-toggle-all="open">${bi('Expand All', '全部展开')}</button>
      <button type="button" class="btn ghost small" data-adr-toggle-all="close">${bi('Collapse All', '全部收起')}</button>
    </div>
  </div>

  <div class="adr-list" id="adr-codex-list">
    ${itemsHtml}
  </div>
</section>
`;

  return { html, toc };
}
