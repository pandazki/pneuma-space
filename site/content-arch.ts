// Content for architecture.html (02 Top-Level Architecture, Domain Model & 12 Invariants)
// and contract.html (03 App Contract, SDK & Admin API).
import { bi, codePlate, srcRef } from './helpers.ts';

export function renderArchitecturePage(): { html: string; toc: { id: string; en: string; zh: string }[] } {
  const toc = [
    { id: 'philosophy', en: '1. Architectural Philosophy & Zero-Dep Stack', zh: '1. 顶层架构哲学与零依赖实现' },
    { id: 'components', en: '2. Component Ownership & Strict Boundaries', zh: '2. 11 大核心组件职责与禁区边界' },
    { id: 'entities', en: '3. Domain Model & Single-Writer Entities', zh: '3. 领域模型与单写者实体表' },
    { id: 'state-machines', en: '4. The Four Core State Machines', zh: '4. 四大核心状态机与 CAS 协议' },
    { id: 'invariants', en: '5. The 12 Architectural Invariants (INV-1..12)', zh: '5. 12 条架构不变量与源码证明' },
    { id: 'wire-protocols', en: '6. Built-In Wire Protocol Clients', zh: '6. 内置线协议客户端实现' },
  ];

  const html = `
<div class="page-head" id="philosophy">
  <div class="page-head-row">
    <h1>${bi('Top-Level Architecture, Domain Model & 12 Invariants', '顶层架构艺术、领域模型与 12 条不变量')}</h1>
    <div class="chips">
      ${srcRef('DESIGN.md', 'L1-L180')}
      ${srcRef('gateway/src/main.ts', 'L1-L247')}
      ${srcRef('gateway/src/model.ts', 'L1-L250')}
    </div>
  </div>
  <p class="lead">
    ${bi(
      'PneumaSpace’s gateway is a single Node.js LTS program written in TypeScript that Node executes directly with zero runtime npm dependencies (ADR 0012, AC-STORE-8). Every table in the platform store has exactly one owning component that writes to it; every instance state transition happens via lock-free conditional update (CAS) on (runtime, state, epoch); and every wake goes through a single verb: Runtime.acquire().',
      'PneumaSpace 网关是一个由 Node.js LTS 原生直接执行的 TypeScript 程序，零运行时 npm 依赖（ADR 0012, AC-STORE-8）。平台库中的每一张表都有且仅有一个唯一写者组件；每一次实例状态转换都通过 (runtime, state, epoch) 上的无全局锁条件更新（CAS）完成；每一次唤醒无论是来自 HTTP、WebSocket 还是定时触发器，都只经过同一个动词：Runtime.acquire()。'
    )}
  </p>
</div>

<section class="doc-section">
  <div class="sec-head">
    <h2>${bi('1. One Paragraph Domain Model (DESIGN.md §1.1)', '1. 一段话读懂领域模型 (DESIGN.md §1.1)')}</h2>
    <div class="chips">
      ${srcRef('DESIGN.md', 'L7-L10')}
      ${srcRef('gateway/src/model.ts', 'L139-L250')}
    </div>
  </div>
  <div class="prose">
    <p>${bi(
      '<strong>App</strong> is a name, and the name is the address. Every publish produces an immutable <strong>Release</strong>: an image (absent for static sites and isolates), a <strong>Manifest</strong>, and a <strong>Bundle</strong> (the static directory or isolate code archive). The Manifest declares <strong>Capabilities</strong>. Each <code>resource</code> capability has a <strong>Provider</strong> that provisions a backend <strong>Resource</strong> recorded as a <strong>Binding</strong> (one row per App, kind, and Provider, with state <code>active | suspended</code>). <strong>Injection</strong> (environment variables, storage mounts, and reachable service labels) is derived on the fly from the current Release’s active Bindings when creating an instance and is never stored. An <strong>Instance</strong> is the running process (Docker container, Kubernetes Pod, or worker thread inside a runner) of the current Release, kept alive only while holding a <strong>Lease</strong> (<code>request | channel | trigger</code>). A <strong>Trigger</strong> is a named entry point the platform calls on the app; each invocation is a durable <strong>Delivery</strong> row. A <strong>Principal</strong> is resolved by the <strong>IdentityProvider</strong> and injected as HTTP headers. <strong>Policy</strong> holds operator tunables. <strong>Tenant</strong> is the ownership, quota, usage, and audit boundary for Apps; <strong>Users</strong> belong to Tenants via <strong>Memberships</strong> (<code>admin | member</code>), and <strong>Tokens</strong> belong to a Tenant. There are no application archetypes and no Agents in the platform model.',
      '<strong>App</strong> 是一个名字，名字就是地址。每次发布产生一个不可变的 <strong>Release</strong>：镜像（静态站点和 Isolate 没有）、<strong>Manifest</strong> 清单、以及 <strong>Bundle</strong>（静态文件包或 Isolate 代码包）。Manifest 声明 <strong>Capability</strong>（能力）。<code>resource</code> 类能力由其 <strong>Provider</strong> 在后端创建 <strong>Resource</strong>，平台记为 <strong>Binding</strong>（每 App、每 kind、每 Provider 一条，带 <code>active / suspended</code> 状态）。<strong>Injection</strong>（环境变量、存储挂载与可达服务标签）由当前 Release 的 active Binding 在实例创建时即时推导，从不落库存储。<strong>Instance</strong> 是当前 Release 的运行实例（容器、Pod 或 runner 里的 worker 线程），只在持有 <strong>Lease</strong>（<code>request / channel / trigger</code>）时保持运行。<strong>Trigger</strong> 是平台调用应用的入口，每次调用是一条持久化的 <strong>Delivery</strong>。<strong>Principal</strong> 由 IdentityProvider 解析并以请求头注入。<strong>Policy</strong> 是运营者策略。<strong>Tenant</strong> 是应用的归属、配额、统计与审计边界；<strong>User</strong> 经 <strong>Membership</strong> 以 <code>admin</code> 或 <code>member</code> 属于租户，<strong>Token</strong> 也属于租户。平台模型里没有应用类型，也没有 Agent。'
    )}</p>
  </div>
</section>

<section class="doc-section" id="components">
  <div class="sec-head">
    <h2>${bi('2. Component Ownership & Strict Architectural Boundaries (DESIGN.md §2.1)', '2. 11 大核心组件职责与禁区边界 (DESIGN.md §2.1)')}</h2>
    <div class="chips">
      ${srcRef('DESIGN.md', 'L95-L108')}
      ${srcRef('gateway/src/main.ts', 'L70-L229')}
    </div>
    <p>${bi(
      'Architectural cleanliness in PneumaSpace comes from what each component is forbidden to do. No Docker or Kubernetes call happens outside Runtime and Infra; no table is written outside its single owner.',
      'PneumaSpace 的架构美感不仅在于组件做什么，更在于每个组件的「从不做（Never Does）」禁区：除 Runtime 与 Infra 外任何组件不调 Docker/K8s；任何组件不跨界写别人的表。'
    )}</p>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th>${bi('Component', '组件')}</th>
          <th>${bi('Source File', '源码文件')}</th>
          <th>${bi('What It Owns', '拥有状态与职责')}</th>
          <th>${bi('What It NEVER Does (Hard Boundary)', '从不做（硬性架构禁区）')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Registry</strong></td>
          <td>${srcRef('gateway/src/registry.ts', 'L106-L856')}</td>
          <td>${bi('Rows of <code>app, release, binding, policy, trigger, token, tenant, users, membership</code>; read-only in-memory <code>RouteView</code>, <code>RunSpec</code>, and <code>SchedulerView</code> per App; serializes commands per app via <code>Store.exclusive</code> and per bundle via <code>Store.exclusiveBundle</code>.', '拥有平台库中 <code>app, release, binding, policy, trigger, token, tenant, users, membership</code> 表；维护每个应用内存中的只读 <code>RouteView</code>；经 <code>Store.exclusive</code> 互斥同名应用命令、经 <code>Store.exclusiveBundle</code> 互斥同一 bundle 的提交与清除。')}</td>
          <td>${bi('<strong>Never</strong> calls Docker or Kubernetes directly (image resolution goes through <code>Infra.resolveImage</code>); <strong>never</strong> connects to an app.', '<strong>从不</strong>直接调用 Docker 或 K8s API（镜像解析走 <code>Infra.resolveImage</code>）；<strong>从不</strong>连接应用实例。')}</td>
        </tr>
        <tr>
          <td><strong>Ingress</strong></td>
          <td>${srcRef('gateway/src/ingress.ts', 'L153-L460')}<br>${srcRef('gateway/src/proxy.ts', 'L1-L210')}</td>
          <td>${bi('Port <code>8080</code> request path: extracts app name, enforces <code>access</code>, strips inbound <code>X-Pneuma-Space-*</code> and credentials, injects identity headers, serves static files from <code>BundleStore</code>, streams HTTP &amp; WebSocket chunks (64 KiB), acquires <code>request</code> and <code>channel</code> Leases, and batches <code>Stats</code>.', '<code>8080</code> 入口路径：解析应用名、检查 <code>access</code>、剥离伪造头与平台凭据、注入身份头、直出静态文件、双向流式转发 HTTP 与 WebSocket、通过 <code>acquire</code> 取得租约并每 10s 刷写 <code>Stats</code>。')}</td>
          <td>${bi('<strong>Never</strong> queries or writes the platform store on the request path (reads in-memory <code>RouteView</code> only; flushes <code>last_access_at</code> every 10 s in the background).', '<strong>从不</strong>在请求路径上读写平台库（只读内存 <code>RouteView</code> 快照，后台每 10 秒批量写 <code>last_access_at</code>）。')}</td>
        </tr>
        <tr>
          <td><strong>Runtimes &amp; Lifecycle</strong></td>
          <td>${srcRef('gateway/src/runtimes.ts', 'L48-L154')}<br>${srcRef('gateway/src/lifecycle.ts', 'L113-L819')}<br>${srcRef('gateway/src/instances.ts', 'L24-L255')}</td>
          <td>${bi('Owns <code>instance</code>, <code>lease_tally</code>, and <code>instance_log</code> rows; zero-IO in-memory replica mirrors; CAS state transitions; idle reaper; orphan reconciliation; dispatches by <code>RunSpec.runtime.kind</code> to <code>DockerRuntime / PodRuntime</code> or <code>IsolateRuntime</code>.', '拥有 <code>instance</code>、<code>lease_tally</code> 与 <code>instance_log</code> 表及本副本内存镜像；负责 CAS 状态机、闲置回收器（reaper）、孤儿清理，并由 <code>Runtimes</code> 门面按 <code>RunSpec</code> 分发到容器或 Isolate 驱动。')}</td>
          <td>${bi('<strong>Never</strong> reads a <code>Manifest</code> (receives derived <code>Injection</code> only); <strong>never</strong> counts failures or quarantines (that is the Guard’s job).', '<strong>从不</strong>解析 <code>Manifest</code>（只接收推导好的 <code>Injection</code> 集合）；<strong>从不</strong>计失败或隔离（那是 Guard 的职责）。')}</td>
        </tr>
        <tr>
          <td><strong>Guard</strong> (<code>AppGuard</code>)</td>
          <td>${srcRef('gateway/src/runtimes.ts', 'L168-L244')}</td>
          <td>${bi('Owns the <code>guard</code> table; counts wake failures, crashes, OOMs, and watchdog hangs per release within <code>failure_window_seconds</code>; enforces <code>restart_backoff_seconds</code>, quarantines at <code>max_failures</code>, and checks tenant quotas inside the wake transaction.', '拥有 <code>guard</code> 表；按版本在时间窗内统计唤醒失败、崩溃、OOM 与卡死；在唤醒 CAS 事务内统一执行隔离拦截、重启退避与租户配额准入。')}</td>
          <td>${bi('<strong>Never</strong> probes liveness or monitors sockets/threads directly (each Runtime Driver detects and reports endings; Guard alone judges and enforces).', '<strong>从不</strong>自己做探活（探活是各运行时的事；一处 Guard 实现覆盖所有运行时和所有网关副本）。')}</td>
        </tr>
        <tr>
          <td><strong>Infra</strong> (<code>DockerInfra / KubeInfra</code>)</td>
          <td>${srcRef('gateway/src/infra.ts', 'L1-L65')}<br>${srcRef('gateway/src/kube-infra.ts', 'L1-L360')}</td>
          <td>${bi('<code>resolveImage</code> for publish (local Docker image ID or OCI registry <code>HEAD /v2/&lt;repo&gt;/manifests/&lt;tag&gt;</code> digest); cluster view sampling (nodes, workloads, PVCs, Warning events) and operator actions (<code>scale</code>, <code>deletePod</code>, <code>removedBy</code>).', '发布时解析镜像（本地镜像 ID 或向 OCI 镜像仓库取 <code>Docker-Content-Digest</code>）；提供集群视图（节点、工作负载、存储卷、告警）及扩缩容、删 Pod、缩容影响计算。')}</td>
          <td>${bi('<strong>Never</strong> manages app instance lifecycle or provisions capability backends.', '<strong>从不</strong>介入应用实例生命周期，也<strong>从不</strong>执行能力资源供应。')}</td>
        </tr>
        <tr>
          <td><strong>Scheduler</strong> (<code>DeliveryScheduler</code>)</td>
          <td>${srcRef('gateway/src/scheduler.ts', 'L33-L375')}</td>
          <td>${bi('Reads <code>Trigger</code> views, owns the <code>delivery</code> table (including on-demand <code>invoke</code> from Ingress), materializes 5-field cron slots on the leader replica, reclaims dead replica claims every 5 s (ADR 0029), and delivers via <code>runtime.acquire(app, "trigger")</code>.', '读取 <code>Trigger</code>，拥有 <code>delivery</code> 表（含按需触发 <code>invoke</code>），在领导者副本上计算 5 字段 cron 槽位、每 5s 回收死副本认领 (ADR 0029)，并以 <code>trigger</code> 租约唤醒实例投递。')}</td>
          <td>${bi('<strong>Never</strong> touches anything outside <code>runtime.acquire()</code> and the app’s <code>POST /_pneuma-space/trigger/&lt;name&gt;</code> endpoint.', '<strong>从不</strong>绕过 <code>runtime.acquire()</code> 自建唤醒路径，除应用触发端点外不触碰应用的任何其他部分。')}</td>
        </tr>
        <tr>
          <td><strong>Providers &amp; BundleStore</strong></td>
          <td>${srcRef('gateway/src/providers.ts', 'L103-L681')}</td>
          <td>${bi('One Provider per resource kind (<code>volume, sqlite, postgres, redis, s3, coturn</code>) implementing idempotent <code>ensure, inject, suspend, destroy</code>; <code>S3BundleStore</code> storing content-addressed tars in <code>pneuma-space-bundles/&lt;sha256&gt;/</code>.', '每种资源能力一个 Provider（实现幂等的 <code>ensure, inject, suspend, destroy</code>）；以及 <code>S3BundleStore</code> 管理内容寻址静态包与代码包。')}</td>
          <td>${bi('<strong>Never</strong> call each other; <strong>never</strong> write to the platform store; <strong>never</strong> learn which runtime an app uses or which deployment plane runs it.', '<strong>从不</strong>互相调用；<strong>从不</strong>写平台库；<strong>从不</strong>知晓应用使用哪种运行时或跑在哪个部署平面上。')}</td>
        </tr>
        <tr>
          <td><strong>Identity &amp; Authz</strong></td>
          <td>${srcRef('gateway/src/identity.ts', 'L1-L480')}<br>${srcRef('gateway/src/identity-hosted.ts', 'L1-L390')}<br>${srcRef('gateway/src/jwt.ts', 'L1-L191')}<br>${srcRef('gateway/src/authz.ts', 'L1-L225')}</td>
          <td>${bi('<code>JwtVerifier</code> (RS256, ES256, EdDSA via <code>node:crypto</code>), <code>LocalIdentity</code>, <code>UpstreamIdentity</code>, <code>HostedIdentity</code>; <code>Authority</code> 30 s membership/token cache invalidated by <code>tenant/&lt;name&gt;</code> notice; pure table-driven <code>ACTIONS</code> &amp; <code>can(caller, action, tenant)</code>.', '内置 JWT 验签器（支持 RS256/ES256/EdDSA）、三种身份提供者、带 <code>tenant/&lt;name&gt;</code> 实时失效的 30s 权限缓存，以及管理 API 唯一授权判定表 <code>ACTIONS</code>。')}</td>
          <td>${bi('<strong>Never</strong> writes directly to the store (user sightings go through <code>registry.sighted()</code>, hosted signups through <code>registry.registerHostedIdentity()</code>).', '<strong>从不</strong>直接写平台库（用户首次/最近出现经 <code>registry.sighted()</code> 由 Registry 写入）。')}</td>
        </tr>
        <tr>
          <td><strong>Store</strong> (<code>SqliteStore / PgStore</code>)</td>
          <td>${srcRef('gateway/src/store.ts', 'L1-L380')}<br>${srcRef('gateway/src/store-pg.ts', 'L1-L540')}<br>${srcRef('gateway/src/sql.ts', 'L1-L780')}</td>
          <td>${bi('Single shared DML in <code>sql.ts</code>; <code>BEGIN IMMEDIATE</code> on SQLite, <code>SERIALIZABLE</code> with automatic <code>40001/40P01</code> retry (up to 5x) on PostgreSQL; advisory locks for <code>exclusive</code>, <code>exclusiveBundle</code>, and leader election; trigger-driven <code>NOTIFY pneuma_space</code> after commit.', '两套 Store 共用同一份 <code>sql.ts</code> DML；PostgreSQL 下提供 <code>SERIALIZABLE</code> 冲突自动重试、会话级 advisory lock 跨副本互斥，以及行触发器在事务提交时发送 <code>NOTIFY pneuma_space</code>。')}</td>
          <td>${bi('<strong>Never</strong> makes business decisions; every table’s single writer remains the owning component above.', '<strong>从不</strong>做任何业务判断；每张表的写者严格归属上述对应组件。')}</td>
        </tr>
        <tr>
          <td><strong>Metrics &amp; Requests</strong></td>
          <td>${srcRef('gateway/src/metrics.ts', 'L1-L760')}<br>${srcRef('gateway/src/requests.ts', 'L1-L210')}</td>
          <td>${bi('Owns <code>usage</code> and <code>events</code> tables plus the 1000-entry in-memory request ring with process generation cursors (ADR 0031); fan-out across <code>PNEUMA_SPACE_PEERS</code>; Prometheus text exporter on <code>PNEUMA_SPACE_METRICS_PORT</code>.', '拥有 <code>usage</code> 与 <code>events</code> 表及带进程世代游标的 1000 条内存请求环 (ADR 0031)；支持跨副本扇出归并与 Prometheus 指标暴露。')}</td>
          <td>${bi('<strong>Never</strong> makes Docker, Kubernetes, database, or network probe calls on the <code>/api/metrics</code> or <code>/api/requests</code> read path (all probing runs inside the 10 s background sampler).', '<strong>从不</strong>在 <code>/api/metrics</code> 或 <code>/api/requests</code> 请求路径上调 Docker、K8s 或网络（所有探测均在后台采样器中完成）。')}</td>
        </tr>
        <tr>
          <td><strong>Console &amp; CLI</strong></td>
          <td>${srcRef('gateway/src/console.html', 'L1-L120')}<br>${srcRef('gateway/src/admin.ts', 'L1-L820')}<br>${srcRef('cli/appctl.ts', 'L1-L521')}</td>
          <td>${bi('Port <code>8081</code> JSON admin boundary writing append-only <code>audit</code> rows (<code>started</code> before handler, <code>ok|refused|error</code> after); self-contained bilingual <code>console.html</code> and <code>appctl.ts</code>.', '<code>8081</code> 管理 API 边界（每个变更路由自动写 <code>started</code> 与最终结果到只追加 <code>audit</code> 表）、零外部资源的双语单文件控制台与 CLI。')}</td>
          <td>${bi('<strong>Never</strong> holds business logic; both are thin shells over Registry, Runtime, and Metrics.', '<strong>从不</strong>包含任何业务逻辑，它们只是管理 API 的薄壳。')}</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="doc-section" id="entities">
  <div class="sec-head">
    <h2>${bi('3. Domain Entities & Single-Writer Storage Map (DESIGN.md §1.2)', '3. 领域实体与单写者存储图谱 (DESIGN.md §1.2)')}</h2>
    <div class="chips">
      ${srcRef('DESIGN.md', 'L11-L39')}
      ${srcRef('gateway/src/sql.ts', 'L1-L260')}
    </div>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th>${bi('Entity / Table', '实体 / 表名')}</th>
          <th>${bi('Primary Key', '主键')}</th>
          <th>${bi('Core Fields & Semantics', '核心字段与设计语义')}</th>
          <th>${bi('Single Writer', '唯一写者')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>App</code> (<code>app</code>)</td>
          <td><code>name</code> (<code>^[a-z][a-z0-9-]{0,39}$</code>)</td>
          <td>${bi('<code>id</code> (12-hex opaque ID generated on first publish; all internal volumes, containers, DB roles, and buckets use <code>id</code> so <code>name</code> is for addressing only), <code>owner, tenant, access, status (registered|removed|purging), current, policy_override, version</code>.', '<code>id</code>（首次发布生成的 12 位十六进制不透明 ID；所有内部卷、容器、Pod、数据库角色与桶都用 <code>id</code> 命名，<code>name</code> 仅用于外部地址）、<code>owner, tenant, access, status, current, policy_override, version</code>。')}</td>
          <td><span class="chip accent">Registry</span></td>
        </tr>
        <tr>
          <td><code>Release</code> (<code>release</code>)</td>
          <td><code>(app, number)</code></td>
          <td>${bi('<code>image?</code> (Docker image ID or K8s <code>&lt;registry&gt;/&lt;repo&gt;@sha256:...</code>), <code>manifest</code>, <code>bundle?</code>, <code>runtime</code>, <code>release_key = sha256(image, manifest, bundle)</code>, <code>published_at</code>.', '<code>image?</code>（Docker 镜像 ID 或 K8s 仓库 digest 引用）、<code>manifest</code>、<code>bundle?</code>、<code>runtime</code>、<code>release_key</code>（规范化 JSON 的 SHA-256）、<code>published_at</code>。')}</td>
          <td><span class="chip accent">Registry</span></td>
        </tr>
        <tr>
          <td><code>Binding</code> (<code>binding</code>)</td>
          <td><code>(app, kind, provider)</code></td>
          <td>${bi('<code>state: active | suspended</code> (the row is the source of truth; backend converges to the row), <code>resource</code> (Provider-private JSON: volume name, DB role/password, Redis ACL user/prefix, S3 bucket/keys).', '<code>state: active | suspended</code>（数据库行是唯一真相，Provider 后端向行收敛）、<code>resource</code>（Provider 私有记录：卷名、库名与密码、ACL 用户、bucket 与密钥对）。')}</td>
          <td><span class="chip accent">Registry</span> (row)<br><span class="chip">Provider</span> (backend)</td>
        </tr>
        <tr>
          <td><code>Instance</code> (<code>instance</code>)</td>
          <td><code>app</code> (<code>App.id</code>)</td>
          <td>${bi('<code>runtime, release, spec_hash, epoch, state (asleep|waking|awake|draining|stopping), actor, handle, address, node, home, since, awake_at, cpu_millis, memory_mb</code>. Written only by CAS on <code>(runtime, state, epoch)</code> (ADR 0020).', '存储实例当前运行时、版本、<code>spec_hash</code>、递增世代 <code>epoch</code>、五态状态机、<code>handle</code>（容器 ID / Pod UID / worker ID）、<code>address</code>、<code>node</code> 与固定 <code>home</code> runner。只能经带 <code>(runtime, state, epoch)</code> 的 CAS 条件更新修改 (ADR 0020)。')}</td>
          <td><span class="chip green">Runtime (CAS)</span></td>
        </tr>
        <tr>
          <td><code>LeaseTally</code> (<code>lease_tally</code>)</td>
          <td><code>(app, replica)</code></td>
          <td>${bi('<code>epoch, request, channel, trigger, released_at</code>. Each gateway replica writes only its own row and never fires a <code>NOTIFY</code> on tally writes (ADR 0020 §2, ADR 0027 §1).', '每个网关副本只写自己那一行在当前 <code>epoch</code> 下的三类租约计数，且写 tally 不触发全局 NOTIFY 广播以免惊群 (ADR 0020, ADR 0027)。')}</td>
          <td><span class="chip green">Runtime (per replica)</span></td>
        </tr>
        <tr>
          <td><code>Guard</code> (<code>guard</code>)</td>
          <td><code>app</code> (<code>App.id</code>)</td>
          <td>${bi('<code>release, failures (epoch ms[]), quarantine_reason, quarantined_at</code>. Updated inside the wake/failure transaction under row lock.', '记录当前版本在时间窗内的失败时间戳数组、隔离原因与隔离时刻；在观测到失败的 CAS 事务内原子读写。')}</td>
          <td><span class="chip orange">AppGuard</span></td>
        </tr>
        <tr>
          <td><code>Trigger &amp; Delivery</code></td>
          <td><code>(app, name)</code> / <code>id</code></td>
          <td>${bi('<code>Trigger</code> is rewritten atomically with each Release. <code>Delivery</code> tracks <code>state (due|delivering|done|failed|cancelled), attempts (1..5), next_attempt_at, claim_replica</code> (ADR 0029).', '<code>Trigger</code> 随 Release 在同一事务内重写；<code>Delivery</code> 记录投递状态、尝试次数（最多 5 次）及认领身份 <code>(claim_replica, attempts)</code> (ADR 0029)。')}</td>
          <td><span class="chip accent">Registry</span> / <span class="chip">Scheduler</span></td>
        </tr>
        <tr>
          <td><code>Tenant, User, Membership, Token</code></td>
          <td><code>name</code> / <code>id</code> / <code>(tenant, user)</code></td>
          <td>${bi('Multi-tenant ownership, RBAC roles (<code>admin | member</code>, at least one admin per tenant), quota limits, and SHA-256 hashed tokens with optional M3 scopes/expiry/appIds restrictions.', '租户配额边界、用户登记、成员关系（每租户至少一名 <code>admin</code>）以及只存 SHA-256 哈希的服务/个人令牌（M3 支持有效期、权限域与指定 AppId 限制）。')}</td>
          <td><span class="chip accent">Registry</span></td>
        </tr>
        <tr>
          <td><code>Usage, Event, Audit</code></td>
          <td><code>(app, step, start, replica)</code> / <code>id</code></td>
          <td>${bi('<code>usage</code>: per-replica absolute counters summed on read (3600 s per app, 60 s &amp; 3600 s for <code>"*"</code>). <code>events</code>: lifecycle stream with 2 s settle window. <code>audit</code>: append-only with DB trigger rejecting <code>UPDATE/DELETE</code>.', '<code>usage</code>：每副本写绝对值、读时跨副本求和的分时统计；<code>events</code>：全局递增生命周期事件表；<code>audit</code>：带数据库触发器拒绝改删的只追加安全审计表 (ADR 0024)。')}</td>
          <td><span class="chip">Metrics</span> / <span class="chip">Admin Router</span></td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="doc-section" id="state-machines">
  <div class="sec-head">
    <h2>${bi('4. The Four Core State Machines (DESIGN.md §1.4)', '4. 四大核心状态机与转换协议 (DESIGN.md §1.4)')}</h2>
    <div class="chips">
      ${srcRef('DESIGN.md', 'L63-L71')}
      ${srcRef('gateway/src/lifecycle.ts', 'L154-L480')}
    </div>
  </div>

  ${codePlate(
    'State Machines — App, Instance (CAS), Delivery, and Lease',
    `1. App Registration & Data Lifecycle (gateway/src/registry.ts:L210-L350)
   (none) ──publish──► registered ──remove──► removed ──publish──► registered
                                                 │
                                               purge (ONLY from removed; destroys all Bindings & unreferenced Bundles)
                                                 ▼
                                              purging ──► (none)

2. Instance CAS State Machine (gateway/src/lifecycle.ts — lock-free CAS on (runtime, state, epoch))
   asleep ──acquire (sole waker CAS, epoch++)──► waking ──TCP/worker ready──► awake
     ▲                                             │                            │
     └──────────ready timeout / error (502)────────┘                            ├──no Lease & idle_seconds elapsed──► stopping ──► asleep
     ▲                                                                          │
     └─────────────────────────────────────────────stopping ◄──Lease empty/30s──┴──retire (new release/policy/remove)──► draining (WS 1001)

3. Trigger Delivery & Leader Reclaim (gateway/src/scheduler.ts — ADR 0029 claim identity = (replica, attempts))
   due ──claimDelivery(replica, attempts++)──► delivering ──HTTP 2xx──► done
    ▲                                              │
    ├──non-2xx / timeout / dead replica reclaim────┼──5th failure──► failed (visible in Console Attention Inbox)
    └──cancelled (when app removed or trigger dropped from new Release)

4. Lease Lifecycle (gateway/src/lifecycle.ts:L66-L90, gateway/src/proxy.ts)
   • request : held from acquire() until the last response body byte is written (client disconnect does NOT release early)
   • channel : upgraded from request on HTTP 101 WebSocket or text/event-stream; prevents idle sleep; closed with 1001 on drain or connection_idle_seconds (6h)
   • trigger : held by DeliveryScheduler across one POST /_pneuma-space/trigger/<name> attempt (up to trigger_timeout_seconds = 600s)`,
    srcRef('DESIGN.md', 'L63-L71', 'DESIGN.md §1.4')
  )}
</section>

<section class="doc-section" id="invariants">
  <div class="sec-head">
    <h2>${bi('5. The 12 Architectural Invariants & Where Code Enforces Them (DESIGN.md §1.5)', '5. 12 条架构不变量与源码级证明 (DESIGN.md §1.5)')}</h2>
    <div class="chips">
      ${srcRef('DESIGN.md', 'L72-L88')}
      ${srcRef('docs/acceptance.md', 'L1-L150')}
    </div>
    <p>${bi(
      'Every invariant in DESIGN.md §1.5 maps directly to an enforcing function in gateway/src/ and an automated acceptance gate in tests/acceptance/suite.ts.',
      'DESIGN.md §1.5 中的每一条不变量（INV-1 至 INV-12）都在 gateway/src/ 中有明确的源码守卫，并由 docs/acceptance.md 中的真实验收测试验证。'
    )}</p>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>${bi('Invariant Statement', '不变量定义')}</th>
          <th>${bi('Enforcing Source Code', '源码实现位置')}</th>
          <th>${bi('Acceptance Gate', '验收用例')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><span class="chip accent">INV-1</span></td>
          <td>${bi('An app’s URL derives solely from <code>App.name</code>. Release numbers, container IDs, nodes, and tenants never appear in URLs (except Contract 2 Fetch <code>&lt;name&gt;--&lt;tenant&gt;</code>).', '应用地址只从 <code>App.name</code> 推导。Release 号、容器名、节点与租户从不出现在契约 1 的 URL 中。')}</td>
          <td>${srcRef('gateway/src/address.ts', 'L1-L55')}<br>${srcRef('gateway/src/ingress.ts', 'L251-L270')}</td>
          <td><code>AC-P-1</code>, <code>AC-K8S-10</code></td>
        </tr>
        <tr>
          <td><span class="chip accent">INV-2</span></td>
          <td>${bi('<code>Binding</code> rows are created only by <code>publish</code> and <code>db_backend</code> switches, and deleted only by <code>purge</code>. <code>remove</code> and <code>publish</code> only change <code>Binding.state</code> (<code>active | suspended</code>). <code>purge</code> can only be entered from <code>removed</code>.', 'Binding 行只由 <code>publish</code> 和 <code>db_backend</code> 变更创建，只由 <code>purge</code> 删除；<code>remove</code> 只置 <code>suspended</code>；<code>purge</code> 只能从 <code>removed</code> 进入。')}</td>
          <td>${srcRef('gateway/src/registry.ts', 'L58-L61')}<br>${srcRef('gateway/src/registry.ts', 'L302-L349')}</td>
          <td><code>AC-P-3</code>, <code>AC-P-9</code>, <code>AC-K8S-8</code></td>
        </tr>
        <tr>
          <td><span class="chip accent">INV-3</span></td>
          <td>${bi('<code>awake → stopping</code> requires the Lease set across all replicas to be empty. Streams, WebSockets, SSE, and triggers are all Leases. Idle stop never terminates an active Lease.', '<code>awake → stopping</code> 要求全集群 Lease 为空；流、长连接与触发执行都是 Lease，闲置回收绝不切断任何活跃 Lease。')}</td>
          <td>${srcRef('gateway/src/lifecycle.ts', 'L161-L200')}<br>${srcRef('gateway/src/sql.ts', 'L410-L470')}</td>
          <td><code>AC-COLLAB-3</code>, <code>AC-WORKER-4</code>, <code>AC-K8S-3</code></td>
        </tr>
        <tr>
          <td><span class="chip accent">INV-4</span></td>
          <td>${bi('A <code>Delivery</code> is persisted before any attempt, wakes the instance via a <code>trigger</code> Lease, returns to <code>due</code> if its claiming replica dies, fails after 5 attempts, and collapses missed downtime cron slots into at most the latest one.', 'Delivery 在任何尝试前已落库持久化；以 <code>trigger</code> 租约唤醒实例；副本崩溃后由领导者放回 <code>due</code>；连续 5 次失败进 <code>failed</code>；停机错过的定时槽位最多补最近一次。')}</td>
          <td>${srcRef('gateway/src/scheduler.ts', 'L89-L260')}</td>
          <td><code>AC-WORKER-1..4</code>, <code>AC-K8S-6</code></td>
        </tr>
        <tr>
          <td><span class="chip accent">INV-5</span></td>
          <td>${bi('Ingress drops every inbound <code>X-Pneuma-Space-*</code> header, Bearer token, upstream JWT header, and listed platform session cookies. Identity headers are set exclusively from <code>IdentityProvider</code> authentication.', 'Ingress 丢弃所有入站 <code>X-Pneuma-Space-*</code>、上游 JWT 头与平台会话 Cookie；身份头只能从 <code>IdentityProvider</code> 的认证结果注入。')}</td>
          <td>${srcRef('gateway/src/ingress.ts', 'L81-L106')}<br>${srcRef('gateway/src/jwt.ts', 'L75-L111')}</td>
          <td><code>AC-FORM-2..3</code>, <code>AC-ID-1..2</code>, <code>AC-SAAS-13</code></td>
        </tr>
        <tr>
          <td><span class="chip accent">INV-6</span></td>
          <td>${bi('<code>publish</code> writes a new immutable Release and advances <code>App.current</code> without touching <code>name, id, owner</code> or any Binding’s data; publishing the same <code>release_key</code> while <code>registered</code> is a no-op.', '<code>publish</code> 写新 Release 并移动 <code>App.current</code>，不碰任何已有数据；<code>registered</code> 状态下相同 <code>release_key</code> 是空操作。')}</td>
          <td>${srcRef('gateway/src/registry.ts', 'L226-L289')}</td>
          <td><code>AC-P-2</code>, <code>AC-ISO-4</code></td>
        </tr>
        <tr>
          <td><span class="chip accent">INV-7</span></td>
          <td>${bi('All registrations, releases, policies, bindings, tokens, tenants, memberships, instances, guards, and deliveries live in the platform store and survive gateway and host restarts.', '注册、版本、策略、绑定、令牌、租户、实例行与投递均持久化在平台库中，网关或宿主机重启后完整恢复并与实际容器/Pod 对账。')}</td>
          <td>${srcRef('gateway/src/main.ts', 'L200-L207')}<br>${srcRef('gateway/src/instances.ts', 'L57-L63')}</td>
          <td><code>AC-P-10</code>, <code>AC-K8S-14</code></td>
        </tr>
        <tr>
          <td><span class="chip accent">INV-8</span></td>
          <td>${bi('The contract fixes wire protocols (SQL URL, Redis RESP, S3 HTTP, WebSocket/SSE), never cloud providers. The app never learns whether SQLite/PostgreSQL or Docker/K8s sits behind its bindings.', '应用契约固定的是标准协议（SQL 连接串、Redis 协议、S3 协议、WS/SSE），应用代码无需关心背后是单机还是 K8s 集群。')}</td>
          <td>${srcRef('gateway/src/model.ts', 'L38-L52')}<br>${srcRef('templates/app/sdk/db.ts', 'L1-L90')}</td>
          <td><code>AC-FORM-1</code>, <code>AC-SAAS-9</code></td>
        </tr>
        <tr>
          <td><span class="chip accent">INV-9</span></td>
          <td>${bi('Each Binding belongs to exactly one Provider; Registry writes Binding rows, Provider provisions backend resources, Runtime applies <code>Injection</code>, and Ingress injects headers—no other path exists.', '每条 Binding 恰好属于一个 Provider；Registry 写行、Provider 建资源、Runtime 应用 Injection、Ingress 注入请求头，不存在旁路。')}</td>
          <td>${srcRef('gateway/src/providers.ts', 'L355-L370')}<br>${srcRef('shared/catalog.ts', 'L45-L49')}</td>
          <td><code>AC-P-3</code>, <code>AC-K8S-12</code></td>
        </tr>
        <tr>
          <td><span class="chip accent">INV-10</span></td>
          <td>${bi('Object bytes move directly between browser and S3 storage via presigned URLs; static bytes move between bundle storage and gateway. Neither path calls <code>Runtime.acquire()</code> or wakes the app.', '对象字节在浏览器与 S3 存储间直传（0 字节经过应用或网关）；静态字节由网关从对象存储直出。两条路径都不经过 <code>acquire()</code>，不唤醒应用。')}</td>
          <td>${srcRef('gateway/src/static.ts', 'L1-L85')}<br>${srcRef('templates/app/sdk/objects.ts', 'L1-L95')}</td>
          <td><code>AC-MEDIA-2..4</code>, <code>AC-STATIC-1..3</code></td>
        </tr>
        <tr>
          <td><span class="chip accent">INV-11</span></td>
          <td>${bi('At most one Instance per App exists across the entire cluster at any moment, guaranteed solely by CAS on <code>(state, epoch)</code> in the <code>instance</code> table—even under split-brain leadership. A new Release’s instance starts only after the old instance finishes draining and disappears.', '每个应用在整个集群同一时刻至多一个运行实例，仅靠 <code>instance</code> 行上带 <code>(state, epoch)</code> 的条件更新保证；旧实例彻底排空销毁后才创建新版本实例。')}</td>
          <td>${srcRef('gateway/src/lifecycle.ts', 'L240-L390')}<br>${srcRef('gateway/src/pods.ts', 'L85-L130')}</td>
          <td><code>AC-K8S-2</code>, <code>AC-K8S-4</code>, <code>AC-K8S-5</code></td>
        </tr>
        <tr>
          <td><span class="chip accent">INV-12</span></td>
          <td>${bi('Quotas are enforced per Tenant in exactly two places, both under the tenant row lock (<code>SELECT ... FOR UPDATE</code>): when inserting an App or <code>files/sqlite</code> Binding row (ADR 0028), and inside the wake CAS transaction (ADR 0023). Quota refusals never count as Guard failures.', '配额按租户只在两处判定，且都在租户行锁下：发布/切库插入 App 或存储 Binding 占位行的事务内 (ADR 0028)，以及唤醒的 CAS 事务内 (ADR 0023)。超配额拒绝不计入 Guard 失败。')}</td>
          <td>${srcRef('gateway/src/registry.ts', 'L247-L264')}<br>${srcRef('gateway/src/runtimes.ts', 'L214-L219')}</td>
          <td><code>AC-OPS-1</code>, <code>AC-OPS-2</code></td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="doc-section" id="wire-protocols">
  <div class="sec-head">
    <h2>${bi('6. Zero-Dependency Wire Protocol Clients Built Into the Gateway', '6. 网关内置的五大零依赖线协议客户端')}</h2>
    <div class="chips">
      ${srcRef('docs/adr/0012-implementation-stack.md', undefined, 'ADR 0012')}
      ${srcRef('docs/adr/0013-object-provider-over-signed-http.md', undefined, 'ADR 0013')}
      ${srcRef('docs/adr/0025-platform-store-postgresql.md', undefined, 'ADR 0025')}
    </div>
    <p>${bi(
      'Why does package.json have zero dependencies? Because the gateway implements the exact subset of each infrastructure wire protocol it needs using Node.js built-in modules (node:net, node:tls, node:http, node:https, node:crypto, node:sqlite).',
      '为什么根目录 package.json 的 dependencies 为空（AC-STORE-8）？因为网关仅使用 Node.js 内置模块，自己实现了与五大底层基础设施通信所需的精确线协议客户端。'
    )}</p>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th>${bi('Protocol & Target', '协议与目标服务')}</th>
          <th>${bi('Gateway Module', '实现模块与行数')}</th>
          <th>${bi('Built-In Node Modules Used', '使用的 Node 内置模块')}</th>
          <th>${bi('Exact Wire Capabilities Implemented', '实现的线协议细节')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>PostgreSQL v3 Wire Protocol</strong></td>
          <td>${srcRef('gateway/src/pg.ts', 'L1-L501')} (501 lines)</td>
          <td><code>node:net</code>, <code>node:tls</code>, <code>node:crypto</code></td>
          <td>${bi('StartupMessage, SSLRequest + <code>verify-full</code> TLS upgrade, SASL <code>SCRAM-SHA-256</code> authentication, Extended Query Protocol (per-session statement parse cache + <code>0A000</code> recovery), Simple Query Protocol (for <code>CREATE/DROP DATABASE</code>), <code>NotificationResponse</code> (<code>LISTEN pneuma_space</code>), <code>CancelRequest</code> on timeout, and connection pooling.', 'StartupMessage、SSLRequest 与 <code>verify-full</code> TLS 握手、<code>SCRAM-SHA-256</code> 认证、扩展查询协议（每会话语句 Parse 缓存）、简单查询协议、<code>LISTEN/NOTIFY</code> 异步通知流、超时 <code>CancelRequest</code> 与连接池。')}</td>
        </tr>
        <tr>
          <td><strong>Redis RESP2 Wire Protocol</strong></td>
          <td>${srcRef('gateway/src/resp.ts', 'L1-L95')} (95 lines)</td>
          <td><code>node:net</code>, <code>node:events</code></td>
          <td>${bi('Incremental RESP2 frame parser (<code>+, -, :, $, *</code>) and command encoder for <code>AUTH</code>, <code>ACL SETUSER</code>, <code>ACL DELUSER</code>, <code>ACL SAVE</code>, and server-side Lua <code>EVAL</code> (single-round-trip <code>SCAN + UNLINK</code> on purge).', '增量式 RESP2 帧解析器与命令编码器，直接驱动 <code>AUTH</code>、<code>ACL SETUSER/DELUSER/SAVE</code> 以及清除时的服务端 Lua <code>EVAL</code>（一次往返完成 <code>SCAN + UNLINK</code>）。')}</td>
        </tr>
        <tr>
          <td><strong>S3 SigV4 &amp; MinIO madmin Encrypted API</strong></td>
          <td>${srcRef('gateway/src/providers.ts', 'L515-L681')} (~166 lines)</td>
          <td><code>node:crypto</code> (<code>argon2Sync</code>, <code>aes-256-gcm</code>, <code>hmac</code>), <code>fetch</code></td>
          <td>${bi('AWS Signature Version 4 header &amp; presigned URL signer (<code>AWS4-HMAC-SHA256</code>), plus MinIO/RustFS <code>/minio/admin/v3/</code> payload encryption (<code>salt(32) | 0x00 | nonce(8) | Argon2id + AES-256-GCM sio-go stream</code>) and custom ustar/pax/GNU tar reader <code>tarFiles()</code>.', 'AWS SigV4 请求头与预签名 URL 签名器，以及兼容 MinIO/RustFS <code>/minio/admin/v3/</code> 的 madmin 载荷加密器（<code>Argon2id + AES-256-GCM sio-go</code> 分片流）与手写 ustar/pax/GNU tar 解包器 <code>tarFiles()</code>。')}</td>
        </tr>
        <tr>
          <td><strong>Docker Engine HTTP over Unix Socket</strong></td>
          <td>${srcRef('gateway/src/docker.ts', 'L1-L220')} (220 lines)</td>
          <td><code>node:http</code> (<code>socketPath: /var/run/docker.sock</code>)</td>
          <td>${bi('Container create, start, stop, remove, inspect, demultiplexed stdout/stderr log frame reader, volume create/remove, image inspect, and streaming JSON <code>/events</code> watcher.', '通过 Unix 域套接字直调 Docker Engine API：容器创建/启动/停止/删除/inspect、多路复用日志帧解包、卷管理与 <code>/events</code> 实时事件流监听。')}</td>
        </tr>
        <tr>
          <td><strong>Kubernetes HTTPS API &amp; Watch Streams</strong></td>
          <td>${srcRef('gateway/src/kube.ts', 'L1-L350')} (350 lines)</td>
          <td><code>node:https</code>, <code>node:fs/promises</code></td>
          <td>${bi('In-cluster ServiceAccount projected token rotation on every request, CA trust from <code>/var/run/secrets/kubernetes.io/serviceaccount/ca.crt</code>, Pod/PVC/Node/Deployment/StatefulSet/Event REST verbs, and newline-delimited JSON <code>?watch=1</code> streams with automatic <code>410 Gone</code> relist recovery.', '每次请求自动重读 ServiceAccount 投射令牌、加载集群 CA 证书，支持 Pod/PVC/Node/Deployment/StatefulSet/Event 增删查改与 <code>?watch=1</code> 增量事件流（遇 <code>410 Gone</code> 自动重列恢复）。')}</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>
`;

  return { html, toc };
}

export function renderContractPage(): { html: string; toc: { id: string; en: string; zh: string }[] } {
  const toc = [
    { id: 'manifest-spec', en: '1. Manifest Grammar (pneuma-space.json)', zh: '1. 清单文法 (pneuma-space.json)' },
    { id: 'runtime-rules', en: '2. Runtime Rules & Lifecycle Signals', zh: '2. 运行时规则与信号语义' },
    { id: 'env-headers', en: '3. Environment Variables & HTTP Headers', zh: '3. 环境变量与转发请求头' },
    { id: 'access-identity', en: '4. Access Scope vs Identity Matrix', zh: '4. 访问范围 (access) 与身份 (identity)' },
    { id: 'triggers-objects', en: '5. Triggers & Direct Object Storage', zh: '5. 触发器协议与对象直传' },
    { id: 'sdk-sql', en: '6. Template TypeScript SDK & Portable SQL', zh: '6. 官方模板 SDK 与可移植 SQL 子集' },
    { id: 'admin-api', en: '7. Admin API (:8081) & RBAC Matrix', zh: '7. 管理 API (:8081) 与权限矩阵' },
    { id: 'contract-2', en: '8. Cloud Profile (Contract 2: Fetch & Records)', zh: '8. 云端受限契约 2 (Fetch & Records)' },
  ];

  const html = `
<div class="page-head" id="manifest-spec">
  <div class="page-head-row">
    <h1>${bi('App Contract (Contract 1, Template SDK & Cloud Contract 2)', '应用契约规范（契约 1、官方 SDK 与云端契约 2）')}</h1>
    <div class="chips">
      ${srcRef('docs/app-contract.md', 'L1-L313')}
      ${srcRef('shared/catalog.ts', 'L22-L153')}
      ${srcRef('gateway/src/model.ts', 'L38-L113')}
    </div>
  </div>
  <p class="lead">
    ${bi(
      'What an app sees from PneumaSpace, and nothing else. The contract fixes wire protocols, not infrastructure providers: db is a SQL connection URL, kv speaks Redis RESP, object speaks S3, push is WebSocket and SSE. An app that follows this contract runs unchanged across M1 Compose, M2 Kubernetes, and M3 Hosted SaaS.',
      '应用从 PneumaSpace 看到的全部接口，仅此而已。契约固定的是通信协议而非底层供应商：db 是一个 SQL 连接串，kv 讲 Redis 协议，object 讲 S3 协议，长连接推送是 WebSocket 与 SSE。遵循本契约的应用无需修改即可在 M1 单机、M2 K8s 集群与 M3 托管环境上运行。'
    )}
  </p>
</div>

<section class="doc-section">
  <div class="sec-head">
    <h2>${bi('1. Manifest Grammar: pneuma-space.json', '1. 清单文法：pneuma-space.json')}</h2>
    <div class="chips">
      ${srcRef('shared/catalog.ts', 'L22-L153')}
      ${srcRef('gateway/src/model.ts', 'L86-L113')}
    </div>
  </div>

  ${codePlate(
    'pneuma-space.json — Complete Contract 1 Schema',
    `{
  "contract": 1,
  "runtime": "isolate",
  "entry": "src/server.ts",
  "capabilities": {
    "files":    {},
    "db":       {},
    "kv":       {},
    "object":   {},
    "static":   { "dir": "public" },
    "ws":       {},
    "cron":     {
      "triggers": {
        "daily-report": { "schedule": "0 8 * * *" },
        "reindex":      {}
      }
    },
    "identity": { "required": true },
    "rtc":      {}
  }
}`,
    srcRef('gateway/src/model.ts', 'L86-L113', 'parseManifest()')
  )}

  <div class="prose">
    <ul>
      <li>${bi('<strong>Strict key validation:</strong> <code>onlyKeys()</code> in <code>shared/catalog.ts:L83-L88</code> rejects any unknown field in the manifest or inside a capability declaration with <code>ManifestError</code> (exit code 2 in <code>appctl</code>, HTTP 400 on the API).', '<strong>严格键校验：</strong><code>shared/catalog.ts:L83-L88</code> 中的 <code>onlyKeys()</code> 会拒绝清单或能力声明中的任何未知字段（<code>appctl</code> 以退出码 2 终止，API 返回 400）。')}</li>
      <li>${bi('<strong><code>route</code> is implicit:</strong> Every app gets routing, on-demand wake, idle stop, and streaming forwarding automatically. Writing <code>"route"</code> in <code>capabilities</code> throws: <em>"route is implicit for every app; remove it from the manifest"</em> (<code>shared/catalog.ts:L90-L92</code>).', '<strong><code>route</code> 隐式存在：</strong>所有应用天然具备稳定地址、按需唤醒、闲置停止与流式转发，在清单里显式写 <code>"route"</code> 会直接报错拒绝 (<code>shared/catalog.ts:L90-L92</code>)。')}</li>
      <li>${bi('<strong><code>runtime</code> and <code>entry</code>:</strong> <code>runtime</code> is optional (<code>"isolate" | "container"</code>); when omitted, publishing an image selects <code>container</code>, publishing a code bundle selects <code>isolate</code>, and a manifest declaring only <code>static</code> has <code>runtime: null</code> (no process). <code>entry</code> is valid only for <code>isolate</code> (default <code>"src/server.ts"</code>).', '<strong><code>runtime</code> 与 <code>entry</code>：</strong><code>runtime</code> 可选（<code>"isolate" | "container"</code>），缺省时按发布输入自动推断；仅声明 <code>static</code> 的清单没有运行时进程（<code>runtime: null</code>）。<code>entry</code> 仅对 <code>isolate</code> 有效（默认 <code>"src/server.ts"</code>）。')}</li>
    </ul>
  </div>
</section>

<section class="doc-section" id="runtime-rules">
  <div class="sec-head">
    <h2>${bi('2. Runtime Rules, Addressing Modes & Lifecycle Signals', '2. 运行时规则、双地址模式与生命周期信号')}</h2>
    <div class="chips">
      ${srcRef('docs/app-contract.md', 'L42-L56')}
      ${srcRef('gateway/src/proxy.ts', 'L1-L210')}
    </div>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th>${bi('Rule / Mechanism', '规则与机制')}</th>
          <th>${bi('Contract Specification', '契约行为规范')}</th>
          <th>${bi('Source Implementation', '源码实现')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Listening Port &amp; Ready Timeout</strong></td>
          <td>${bi('Listen on <code>PNEUMA_SPACE_PORT</code> (<code>8000</code> in a container; an allocated ephemeral port <code>32768..60999</code> in an isolate worker). Accept TCP connections within <code>ready_timeout_seconds</code> (default <code>15 s</code>).', '监听 <code>PNEUMA_SPACE_PORT</code>（容器内固定为 <code>8000</code>；Isolate 内由 runner 在 <code>32768..60999</code> 范围分配并由垫片拦截）。须在 <code>ready_timeout_seconds</code>（默认 15s）内就绪应答。')}</td>
          <td>${srcRef('gateway/src/runtime.ts', 'L91-L103')}<br>${srcRef('gateway/src/runner.ts', 'L53-L55')}</td>
        </tr>
        <tr>
          <td><strong>Path Mode vs Subdomain Mode</strong></td>
          <td>${bi('A deployment uses one mode: <code>/apps/&lt;name&gt;/</code> (path mode, gateway strips prefix and sends <code>X-Forwarded-Prefix: /apps/&lt;name&gt;</code>) or <code>https://&lt;name&gt;.&lt;apps-domain&gt;/</code> (subdomain mode, <code>X-Forwarded-Prefix</code> is present and empty <code>""</code>). Prefix all links, redirects, form actions, and assets with <code>X-Forwarded-Prefix</code> so the same app works in both.', '单机默认路径模式 <code>/apps/&lt;name&gt;/</code>（网关剥离前缀并通过 <code>X-Forwarded-Prefix: /apps/&lt;name&gt;</code> 传入）；集群默认子域名模式 <code>https://&lt;name&gt;.&lt;apps-domain&gt;/</code>（<code>X-Forwarded-Prefix</code> 为空串 <code>""</code>，每应用独占浏览器源）。将所有链接、重定向与静态资源拼接在 <code>X-Forwarded-Prefix</code> 之后即可无缝兼容两种模式。')}</td>
          <td>${srcRef('gateway/src/address.ts', 'L1-L55')}<br>${srcRef('gateway/src/ingress.ts', 'L251-L270')}</td>
        </tr>
        <tr>
          <td><strong>Cookie Domain Stripping</strong></td>
          <td>${bi('The gateway strips the <code>Domain</code> attribute from every <code>Set-Cookie</code> header an app sends so cookies stay scoped to the app’s own host (AC-ID-10). In hosted mode, reserved platform cookie names are also blocked.', '网关会自动剥离应用响应 <code>Set-Cookie</code> 中的 <code>Domain</code> 属性，确保 Cookie 严格留在应用自己的主机上 (AC-ID-10)。')}</td>
          <td>${srcRef('gateway/src/proxy.ts', 'L40-L85')}</td>
        </tr>
        <tr>
          <td><strong>CPU &amp; Memory Quotas</strong></td>
          <td>${bi('Policy sets <code>cpu_millis</code> (default <code>1000</code>) and <code>memory_mb</code> (default <code>512</code>). Containers exceeding <code>memory_mb</code> are OOM-killed and counted as a failure. Isolates get <code>memory_mb</code> as both V8 heap (<code>resourceLimits.maxOldGenerationSizeMb</code>) and off-heap Buffer budget (sampled on every 1 s watchdog pong). When a tenant’s quota is full, wakes receive <code>503</code> with <code>Retry-After: 30</code> (not counted as a failure).', '策略定义 <code>cpu_millis</code>（默认 1000）与 <code>memory_mb</code>（默认 512）。容器超内存会被 OOMKilled 并计一次失败；Isolate 将 <code>memory_mb</code> 同时作为 V8 堆上限与堆外 Buffer 预算（每秒心跳采样）。租户配额满时唤醒返回 <code>503 Retry-After: 30</code>，不计入失败。')}</td>
          <td>${srcRef('gateway/src/pods.ts', 'L119-L123')}<br>${srcRef('gateway/src/runner.ts', 'L49-L50')}</td>
        </tr>
        <tr>
          <td><strong>Idle Stop vs Retire Drain</strong></td>
          <td>${bi('<code>SIGTERM</code> (or worker <code>drain</code>) arrives on idle only when 0 requests, streams, WebSockets, or triggers are in flight. On retire (new release, policy change, or remove), open WebSockets receive close code <code>1001 Going Away</code> first, and in-flight requests get up to <code>drain_timeout_seconds</code> (default <code>30 s</code>). Silent WebSockets close with <code>1001</code> after <code>connection_idle_seconds</code> (default <code>6 h</code>).', '闲置休眠仅在没有任何活跃请求、流、WebSocket 或触发器时发生。版本更新或下线引起退役（draining）时，先向所有打开的 WebSocket 发送 <code>1001</code> 关闭码，在途请求有最多 <code>drain_timeout_seconds</code>（默认 30s）排空时间。静默超过 6 小时的 WebSocket 也会收到 <code>1001</code>，重连即重新唤醒。')}</td>
          <td>${srcRef('gateway/src/lifecycle.ts', 'L350-L430')}<br>${srcRef('gateway/src/proxy.ts', 'L140-L210')}</td>
        </tr>
        <tr>
          <td><strong>Runtime Affinity of Storage</strong></td>
          <td>${bi('An app’s <code>files</code> and SQLite <code>db</code> stay with the runtime lane (<code>container</code> vs <code>isolate</code>) that wrote them. Switching runtime on an app that has either returns <code>409 Conflict</code> naming both runtimes (ADR 0028, AC-ISO-7).', '带有 <code>files</code> 或 SQLite 数据库的应用，其数据存放在首次写入它的运行时车道中；在已有存储的应用上直接切换 <code>container / isolate</code> 运行时将返回 <code>409 Conflict</code> (ADR 0028, AC-ISO-7)。')}</td>
          <td>${srcRef('gateway/src/registry.ts', 'L293-L300')}</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="doc-section" id="env-headers">
  <div class="sec-head">
    <h2>${bi('3. Injected Environment Variables & Forwarded Request Headers', '3. 注入的环境变量与转发请求头精确定义')}</h2>
    <div class="chips">
      ${srcRef('gateway/src/model.ts', 'L38-L52')}
      ${srcRef('gateway/src/ingress.ts', 'L76-L106')}
    </div>
    <p>${bi(
      'Only variables for declared capabilities exist in the process environment. Inbound X-Pneuma-Space-* headers are unconditionally stripped before forwarding.',
      '只有清单中声明过的能力才会注入对应环境变量（由 ENV_BY_KIND 静态断言守卫）。所有入站 X-Pneuma-Space-* 请求头在转发前无条件丢弃。'
    )}</p>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th>${bi('Source / Capability', '来源 / 能力')}</th>
          <th>${bi('Environment Variable / HTTP Header', '环境变量 / 请求头名称')}</th>
          <th>${bi('Exact Value Format & Notes', '值格式与源码契约说明')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><span class="chip">Always Present</span></td>
          <td><code>PNEUMA_SPACE_APP</code><br><code>PNEUMA_SPACE_RELEASE</code><br><code>PNEUMA_SPACE_PORT</code></td>
          <td>${bi('App name (e.g. <code>survey</code>), current integer release number (<code>1, 2, ...</code>), and TCP port to listen on (<code>8000</code> in container, ephemeral port in isolate).', '应用名称、当前整数版本号（<code>1, 2, ...</code>）以及监听端口号（容器固定 <code>8000</code>，Isolate 为动态分配端口）。')}</td>
        </tr>
        <tr>
          <td><code>files</code></td>
          <td><code>PNEUMA_SPACE_FILES_DIR</code></td>
          <td>${bi('<code>/data</code> in a container (Docker volume or K8s RWO PVC <code>pneuma-space-files-&lt;id&gt;</code>); <code>/data/apps/&lt;id&gt;/storage/pneuma-space-files-&lt;id&gt;</code> in an isolate.', '容器内为 <code>/data</code>（挂载命名卷或 PVC）；Isolate 内指向 runner 持久卷下的独立应用目录。')}</td>
        </tr>
        <tr>
          <td><code>db</code></td>
          <td><code>PNEUMA_SPACE_DB_URL</code></td>
          <td>${bi('<code>sqlite:///pneuma/db/app.sqlite3</code> (or runner storage path in isolate) when <code>db_backend=sqlite</code>; <code>postgresql://app_&lt;id&gt;:&lt;password&gt;@postgres:5432/app_&lt;id&gt;</code> when <code>db_backend=postgres</code>.', '<code>sqlite://...</code> 或 <code>postgresql://app_&lt;id&gt;:&lt;password&gt;@postgres:5432/app_&lt;id&gt;</code>，由有效策略的 <code>db_backend</code> 决定。')}</td>
        </tr>
        <tr>
          <td><code>kv</code></td>
          <td><code>PNEUMA_SPACE_KV_URL</code><br><code>PNEUMA_SPACE_KV_PREFIX</code></td>
          <td>${bi('<code>redis://app_&lt;id&gt;:&lt;password&gt;@redis:6379</code> and prefix <code>&lt;id&gt;:</code>. Redis ACL enforces <code>~&lt;id&gt;:* &amp;&lt;id&gt;:*</code>; any key or pub/sub channel outside the prefix fails with <code>NOPERM</code> (AC-COLLAB-2).', 'Redis ACL 限制该用户只能访问以 <code>&lt;id&gt;:</code> 开头的键与发布订阅频道，任何越界访问直接返回 <code>NOPERM</code> (AC-COLLAB-2)。')}</td>
        </tr>
        <tr>
          <td><code>object</code></td>
          <td><code>PNEUMA_SPACE_OBJECT_ENDPOINT</code><br><code>PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT</code><br><code>PNEUMA_SPACE_OBJECT_BUCKET</code><br><code>PNEUMA_SPACE_OBJECT_ACCESS_KEY</code><br><code>PNEUMA_SPACE_OBJECT_SECRET_KEY</code></td>
          <td>${bi('Internal S3 endpoint (<code>http://rustfs:9000</code>), browser-reachable endpoint for presigning (<code>http://127.0.0.1:9000</code> or public object host), bucket <code>app-&lt;id&gt;</code>, and bucket-scoped IAM credentials.', '内部 S3 地址、供浏览器直传预签名的公开地址、专属桶名 <code>app-&lt;id&gt;</code> 以及仅限该桶的密钥对。')}</td>
        </tr>
        <tr>
          <td><code>rtc</code></td>
          <td><code>PNEUMA_SPACE_RTC_STUN_URLS</code><br><code>PNEUMA_SPACE_RTC_TURN_URLS</code><br><code>PNEUMA_SPACE_RTC_TURN_SECRET</code></td>
          <td>${bi('<code>stun:&lt;host&gt;:3478</code>, <code>turn:&lt;host&gt;:3478?transport=udp</code>, and the shared HMAC secret used by <code>iceServers()</code> to mint ephemeral TURN REST credentials.', 'STUN/TURN 地址与 HMAC 共享密钥，SDK 的 <code>iceServers()</code> 用其铸造短期有效的 TURN 凭据。')}</td>
        </tr>
        <tr>
          <td><span class="chip accent">Header (Always)</span></td>
          <td><code>X-Forwarded-Prefix</code></td>
          <td>${bi('<code>/apps/&lt;name&gt;</code> in path mode; empty string <code>""</code> in subdomain mode.', '路径模式下为 <code>/apps/&lt;name&gt;</code>；子域名模式下存在且为空字符串 <code>""</code>。')}</td>
        </tr>
        <tr>
          <td><span class="chip accent">Header (identity)</span></td>
          <td><code>X-Pneuma-Space-Subject</code><br><code>X-Pneuma-Space-Name</code><br><code>X-Pneuma-Space-Owner</code></td>
          <td>${bi('<code>user:&lt;id&gt;</code> or <code>service:&lt;id&gt;</code>; display name with non-ASCII bytes percent-encoded UTF-8 (use <code>decodeURIComponent</code>); <code>X-Pneuma-Space-Owner: 1</code> present only when Subject equals <code>App.owner</code>.', '主体标识（<code>user:</code> 或 <code>service:</code>）、UTF-8 百分号编码的显示名（可用 <code>decodeURIComponent</code> 还原），以及仅在访问者是应用所有者时出现的 <code>X-Pneuma-Space-Owner: 1</code>。')}</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="doc-section" id="access-identity">
  <div class="sec-head">
    <h2>${bi('4. Access Scope (access) vs Manifest Identity (identity)', '4. 访问控制范围 (access) 与身份注入 (identity) 的正交矩阵')}</h2>
    <div class="chips">
      ${srcRef('docs/app-contract.md', 'L82-L93')}
      ${srcRef('gateway/src/ingress.ts', 'L273-L334')}
      ${srcRef('gateway/src/authz.ts', 'L170-L225')}
    </div>
    <p>${bi(
      'access is an app-level setting (appctl access <name> tenant|org|public, default org in M1/M2, tenant in M3 hosted) that decides whether a request may arrive (including static files). identity is a manifest capability that decides whether the app receives X-Pneuma-Space-Subject headers.',
      'access 是应用级设置（通过 appctl access <name> tenant|org|public 修改，M1/M2 默认 org，M3 托管模式默认 tenant），决定请求能否到达应用（包括静态资源）；identity 是清单声明的能力，决定应用是否拿到 X-Pneuma-Space-Subject 等身份头。两者完全正交。'
    )}</p>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th><code>access</code></th>
          <th>${bi('Who Reaches the App', '允许到达应用的调用方')}</th>
          <th>${bi('Unauthenticated Request', '未登录 / 无凭据请求')}</th>
          <th>${bi('Authenticated Outside Tenant', '已认证但非本租户成员')}</th>
          <th>${bi('Static Bundle Cache-Control', '静态资源缓存头策略')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>public</code></td>
          <td>${bi('Anyone (requires upstream proxy to allow anonymous traffic on app host)', '任何人（需上游认证代理对该应用域名放行匿名请求）')}</td>
          <td>${bi('Reaches the app, unless <code>identity</code> is declared with <code>required: true</code> (default)', '到达应用；除非声明了 <code>identity</code> 且 <code>required: true</code>')}</td>
          <td>${bi('Reaches the app', '正常到达应用')}</td>
          <td><code>public, max-age=0, must-revalidate</code> (ETag / 304)</td>
        </tr>
        <tr>
          <td><code>org</code></td>
          <td>${bi('Any authenticated organization user or valid platform token', '组织内任何已认证用户或任何有效平台令牌')}</td>
          <td>${bi('Browser: <code>303 See Other</code> to login URL; API client: <code>401 Unauthorized</code>', '浏览器 <code>303</code> 跳转登录页；API 客户端返回 <code>401</code>')}</td>
          <td>${bi('Reaches the app (any tenant in the organization)', '正常到达应用（跨团队共享）')}</td>
          <td><code>private, no-cache</code> ${bi('(never stored by shared CDN)', '（禁止共享 CDN 缓存）')}</td>
        </tr>
        <tr>
          <td><code>tenant</code></td>
          <td>${bi('Members of the app’s tenant, that tenant’s service/personal tokens, and platform admins', '仅应用所属租户的成员、该租户的令牌与平台管理员')}</td>
          <td>${bi('Browser: <code>303 See Other</code> to login URL; API client: <code>401 Unauthorized</code>', '浏览器 <code>303</code> 跳转登录页；API 客户端返回 <code>401</code>')}</td>
          <td><code>403 Forbidden</code> (<code>404</code> in Contract 2 private cloud profile)</td>
          <td><code>private, no-cache</code></td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="doc-section" id="triggers-objects">
  <div class="sec-head">
    <h2>${bi('5. Triggers Wire Protocol & Direct Object Storage', '5. 定时/按需触发器线协议与对象存储直传')}</h2>
    <div class="chips">
      ${srcRef('docs/app-contract.md', 'L94-L120')}
      ${srcRef('gateway/src/scheduler.ts', 'L210-L320')}
    </div>
  </div>

  ${codePlate(
    'Trigger Wire Protocol — External Invocation (202) & Platform Delivery to App Port',
    `# A. External program invokes a trigger through the gateway (always authenticates, checks access, requires service: token or owner):
POST /apps/<name>/_pneuma-space/trigger/<trigger>
Authorization: Bearer <token>
Idempotency-Key: <optional; same key within 24 h returns the same delivery ID>
→ HTTP/1.1 202 Accepted
  {"delivery": "<id>"}

# B. DeliveryScheduler acquires a TRIGGER Lease (waking the app if asleep) and calls your instance port:
POST /_pneuma-space/trigger/<name>
X-Pneuma-Space-Delivery:      <stable delivery ID, identical on every retry — use for idempotency!>
X-Pneuma-Space-Attempt:       1..5
X-Pneuma-Space-Scheduled-For: 2026-11-23T08:00:00Z   (present on scheduled cron deliveries)
X-Pneuma-Space-Subject:       service:ci             (present on on-demand deliveries)
<body from on-demand caller, or empty on scheduled deliveries>
→ Any 2xx marks delivery "done"; non-2xx, timeout (>600s), or disconnect retries with backoff up to 5 attempts.`,
    srcRef('gateway/src/ingress.ts', 'L302-L312', 'ingress.ts:L302')
  )}
</section>

<section class="doc-section" id="sdk-sql">
  <div class="sec-head">
    <h2>${bi('6. Template TypeScript SDK & Portable SQL Subset', '6. 官方模板 TypeScript SDK 与跨引擎可移植 SQL 子集')}</h2>
    <div class="chips">
      ${srcRef('templates/app/AGENTS.md', 'L41-L84')}
      ${srcRef('templates/app/sdk/db.ts', 'L1-L90')}
      ${srcRef('templates/app/sdk/serve.ts', 'L1-L95')}
    </div>
  </div>

  <div class="prose">
    <p>${bi(
      'The scaffold in <code>templates/app/</code> ships a zero-build TypeScript SDK (<code>sdk/</code>) and bilingual UI kit (<code>ui/</code>) whose only npm packages are pure-JavaScript <code>pg</code> and <code>redis</code>, so the exact same source code runs in both <code>isolate</code> and <code>container</code> runtimes.',
      '<code>templates/app/</code> 脚手架内置了零构建步骤的 TypeScript SDK（<code>sdk/</code>）与双语 UI 组件（<code>ui/</code>），其仅有的两个依赖包 <code>pg</code> 与 <code>redis</code> 均为纯 JavaScript 实现，因此同一份应用代码可同时在 <code>isolate</code> 与 <code>container</code> 运行时中直接运行。'
    )}</p>
  </div>

  ${codePlate(
    'Portable SQL Subset Rules (SQLite + PostgreSQL Compatible — AC-FORM-1)',
    `// templates/app/sdk/db.ts normalizes ? placeholders across both SQLite and PostgreSQL.
// Follow these 7 rules so the operator can switch db_backend=sqlite|postgres without changing app code:
// 1. Column types: use TEXT, INTEGER, and REAL only.
// 2. Primary keys: generate IDs in app code (crypto.randomUUID()), never AUTOINCREMENT or SERIAL.
// 3. Timestamps & Booleans: store timestamps as ISO 8601 TEXT and booleans as INTEGER 0 / 1.
// 4. Aggregates: write CAST(count(*) AS INTEGER) so PostgreSQL bigint and SQLite integer return the same JS number.
// 5. Upserts: use ON CONFLICT (id) DO UPDATE SET col = excluded.col (or DO NOTHING).
// 6. Schema init: run CREATE TABLE IF NOT EXISTS at startup; there is no external migration job.
// 7. Queries: use db().query(sql, [p1, p2]) for rows and db().exec(sql, [p1, p2]) for mutations.`,
    srcRef('templates/app/AGENTS.md', 'L78-L79', 'Portable SQL Rules')
  )}
</section>

<section class="doc-section" id="admin-api">
  <div class="sec-head">
    <h2>${bi('7. Admin API (:8081) & RBAC Authorization Table', '7. 管理 API (:8081) 路由与 RBAC 授权矩阵')}</h2>
    <div class="chips">
      ${srcRef('docs/app-contract.md', 'L122-L190')}
      ${srcRef('gateway/src/admin.ts', 'L1-L260')}
      ${srcRef('gateway/src/authz.ts', 'L114-L165')}
    </div>
    <p>${bi(
      'In gateway/src/authz.ts, ACTIONS is the single authorization table for port 8081. Endpoints marked with * cannot be called with a token (they require a browser/console JWT or hosted session with Sec-Fetch-Site: same-origin / CSRF).',
      'gateway/src/authz.ts 中的 ACTIONS 表是 8081 管理端口唯一的授权判定源。标有 * 的端点禁止使用令牌调用（必须通过控制台 JWT 或带 CSRF 校验的托管会话调用）。'
    )}</p>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th>${bi('Method & Path', 'HTTP 方法与路径')}</th>
          <th>${bi('Required Role (authz.ts)', '所需角色 (ACTIONS)')}</th>
          <th>${bi('Audit Action', '审计动作码')}</th>
          <th>${bi('Response & Semantics', '响应与行为语义')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>GET /api/me</code> · <code>GET /api/health</code></td>
          <td><code>any</code> / <code>-</code></td>
          <td>—</td>
          <td>${bi('Caller identity, tenant roles, and <code>platformAdmin</code> flag; runtime health checks and global policy (&lt;50 ms, 0 Docker calls).', '返回调用者主体、租户角色与 <code>platformAdmin</code> 标志；运行时探活能力与全局有效策略（&lt;50 ms，0 Docker 调用）。')}</td>
        </tr>
        <tr>
          <td><code>GET /api/apps</code> · <code>GET /api/apps/&lt;name&gt;</code></td>
          <td><code>any</code> / <code>owner</code></td>
          <td>—</td>
          <td>${bi('Apps the caller may read (a member sees their own; a tenant admin/token sees the tenant’s; a platform admin sees all). Detail includes <code>may</code> (allowed actions list).', '列出调用者可读的应用（普通成员仅看自己发布的；租户管理员与服务令牌看全租户；平台管理员看全部）。详情包含允许该调用者执行的动作列表 <code>may</code>。')}</td>
        </tr>
        <tr>
          <td><code>GET /api/metrics</code> · <code>GET /api/requests</code></td>
          <td><code>platform</code></td>
          <td>—</td>
          <td>${bi('In-memory telemetry snapshot (services, fleet, wakes, deliveries, 24h minute series, 100 events) and fan-out request log ring with generation cursors (ADR 0031).', '内存观测快照（服务状态、席位、唤醒分位数、24h 分钟序列、最近 100 条事件）与带世代游标的跨副本归并请求流 (ADR 0031)。')}</td>
        </tr>
        <tr>
          <td><code>GET /api/cluster</code><br><code>PUT /api/cluster/workloads/&lt;name&gt;/scale</code><br><code>POST /api/cluster/pods/&lt;name&gt;/restart</code><br><code>POST /api/cluster/nodes/&lt;name&gt;/drain</code></td>
          <td><code>platform</code></td>
          <td><code>cluster.scale</code><br><code>cluster.restart</code><br><code>cluster.drain</code></td>
          <td>${bi('Sampled every 15 s (nodes, workloads, instances, PVCs, warnings). Scale gateway Deployment or runner StatefulSet (refuses with <code>409 stranded</code> if scaling down removes any app’s home runner, ADR 0032).', '每 15s 采样的集群全景。支持扩缩网关与 runner（若缩容会删掉任何应用绑定的 home runner，在发起 K8s 调用前直接返回 <code>409 stranded</code>，见 ADR 0032）、重启平台 Pod 与排空节点实例。')}</td>
        </tr>
        <tr>
          <td><code>PUT /api/apps/&lt;name&gt;/release</code><br><code>POST /api/bundles</code></td>
          <td><code>member</code> / <code>owner</code></td>
          <td><code>app.publish</code></td>
          <td>${bi('Uploads tar bundle and commits immutable Release, Triggers, and Bindings. Answers <code>409</code> with <code>quota</code> object on quota refusal.', '上传代码/静态包并原子提交 Release、Trigger 与 Binding；配额超限时返回 <code>409</code> 及详细 <code>quota</code> 字段。')}</td>
        </tr>
        <tr>
          <td><code>POST /api/apps/&lt;name&gt;/stop | restart | unquarantine | remove</code></td>
          <td><code>owner*</code> / <code>owner</code></td>
          <td><code>app.stop | restart | unquarantine | remove</code></td>
          <td>${bi('Drains and stops instance, restarts under a fresh container/Pod, lifts Guard quarantine, or removes app (suspending bindings while keeping data).', '排空停止实例、重启实例、解除 Guard 隔离，或下线应用（挂起所有绑定但保留全部数据）。')}</td>
        </tr>
        <tr>
          <td><code>POST /api/apps/&lt;name&gt;/kill</code><br><code>POST /api/apps/&lt;name&gt;/purge</code></td>
          <td><code>platform</code> / <code>admin*</code></td>
          <td><code>app.kill</code><br><code>app.purge</code></td>
          <td>${bi('<code>kill</code> force-deletes a stuck Pod/container with grace 0 and clears lease tallies across replicas (AC-OPS-15). <code>purge</code> permanently destroys all data (only when <code>removed</code>).', '<code>kill</code> 以 grace 0 强杀卡死在 waking 或死副本租约下的实例并清空全副本租约计数 (AC-OPS-15)；<code>purge</code> 永久销毁已下线应用的全部数据。')}</td>
        </tr>
        <tr>
          <td><code>/api/tenants/*</code> · <code>/api/usage*</code> · <code>/api/audit</code> · <code>/api/state</code></td>
          <td><code>platform* / admin* / member</code></td>
          <td><code>tenant.* / member.* / token.*</code></td>
          <td>${bi('Tenant creation, quota editing, membership RBAC, token issuance/revocation (takes effect within 30 s across replicas), hourly usage heatmaps, state inventory, and audit query.', '租户创建、配额修改、成员管理、令牌签发与吊销（30 秒内全副本生效）、分时统计热力图、无凭据状态清单与审计日志查询。')}</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="doc-section" id="contract-2">
  <div class="sec-head">
    <h2>${bi('8. Cloud Profile (Contract 2: pneuma-space.fetch/1 & Records)', '8. 独立云端受限契约实验（契约 2：pneuma-space.fetch/1 与 Records）')}</h2>
    <div class="chips">
      ${srcRef('docs/app-contract.md', 'L227-L313')}
      ${srcRef('docs/adr/0033-hosted-fetch-profile.md', undefined, 'ADR 0033')}
      ${srcRef('docs/adr/0036-additive-hosted-platform.md', undefined, 'ADR 0036')}
    </div>
    <p>${bi(
      'As recorded in REQUIREMENTS-M3.md and ADR 0036, full SaaS preserves Contract 1 above. The separate Fetch experiment in cloud/ implements Contract 2 (pneuma-space.fetch/1) for portable serverless isolates (e.g. Cloudflare Workers) with an optimistic-concurrency JSON Records store and terminal artifact fences (ADR 0035).',
      '如 REQUIREMENTS-M3.md 与 ADR 0036 所示，完整 SaaS 基线完整保留上述契约 1 的全部能力。仓库 cloud/ 目录下的独立实验实现了契约 2（pneuma-space.fetch/1），面向无状态 Worker 环境提供 Web 标准 fetch(request, app) 入口、带乐观并发修订号的 JSON Records 存储以及防旧写入复活的终态制品栅栏 (ADR 0035)。'
    )}</p>
  </div>

  ${codePlate(
    'Contract 2 — Manifest & Web Fetch Handler with Optimistic-Concurrency Records (cloud/)',
    `// 1. pneuma-space.json (Contract 2)
{
  "contract": 2,
  "runtime": "fetch",
  "abi": "pneuma-space.fetch/1",
  "entry": "app.mjs",
  "capabilities": {
    "records": {},
    "identity": {},
    "static": { "dir": "public" }
  }
}

// 2. app.mjs — Portable ES Module Handler (no process.env, no raw TCP sockets)
export default {
  async fetch(request, app) {
    const current = await app.records.get('counter:visits');
    const nextVal = (current?.value?.count ?? 0) + 1;
    const committed = await app.records.commit([
      { kind: 'put', key: 'counter:visits', expected: current?.revision ?? null, value: { count: nextVal } }
    ]);
    return Response.json({
      appId: app.id,
      viewer: app.identity?.subject ?? null,
      visits: nextVal,
      ok: committed.ok
    });
  }
};`,
    srcRef('docs/app-contract.md', 'L233-L282', 'Contract 2 Spec')
  )}
</section>
`;

  return { html, toc };
}
