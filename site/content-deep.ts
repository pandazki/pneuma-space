// Content for capabilities.html (04 Capabilities & Wire Providers),
// runtimes.html (05 Runtime Lanes, Isolate Runner & Guard),
// and planes.html (06 Docker, Kubernetes & Hosted SaaS Planes).
import { bi, codePlate, srcRef } from './helpers.ts';

export function renderCapabilitiesPage(): { html: string; toc: { id: string; en: string; zh: string }[] } {
  const toc = [
    { id: 'rule', en: '1. The One-Row Provider Rule', zh: '1. 一行定义与 Provider 幂等准则' },
    { id: 'matrix', en: '2. Complete 10-Capability Lifecycle Table', zh: '2. 十大能力与四步生命周期总表' },
    { id: 'storage-db', en: '3. Storage & Relational DB (SQLite / PG)', zh: '3. 存储绑定与关系数据库供应' },
    { id: 'kv-s3', en: '4. Redis RESP2 ACL & SigV4 S3 + madmin', zh: '4. Redis ACL 与 SigV4 对象存储供应' },
    { id: 'ingress-schedule', en: '5. Static BundleStore, WS, Cron & RTC', zh: '5. 静态包、长连接、定时器与 WebRTC' },
  ];

  const html = `
<div class="page-head" id="rule">
  <div class="page-head-row">
    <h1>${bi('Capabilities, Providers & Wire-Protocol Provisioning', '十大基础设施能力与 Provider 线协议供应机制')}</h1>
    <div class="chips">
      ${srcRef('shared/catalog.ts', 'L22-L50')}
      ${srcRef('gateway/src/providers.ts', 'L1-L681')}
      ${srcRef('docs/adr/0005-capabilities-and-providers.md', undefined, 'ADR 0005')}
    </div>
  </div>
  <p class="lead">
    ${bi(
      'In PneumaSpace, a new capability is one row in CAPABILITIES and one Provider implementing four idempotent operations: ensure, inject, suspend, and destroy. There are no provisioning Jobs, no docker exec scripts, and no third-party npm database drivers in the gateway.',
      '在 PneumaSpace 中，新增一项基础设施能力只需在 CAPABILITIES 表中加一行，并实现一个包含 ensure、inject、suspend、destroy 四个幂等动作的 Provider。网关内没有任何外部供应任务（Job）、没有 docker exec 脚本，也不引入任何第三方 npm 数据库驱动。'
    )}
  </p>
</div>

<section class="doc-section">
  <div class="sec-head">
    <h2>${bi('1. Runtime-Neutral & Plane-Neutral Providers (ADR 0005, ADR 0017, ADR 0019)', '1. 对运行时与部署平面完全无感的 Provider 设计')}</h2>
    <div class="chips">
      ${srcRef('gateway/src/providers.ts', 'L103-L138')}
      ${srcRef('gateway/src/providers.ts', 'L355-L370')}
    </div>
  </div>
  <div class="prose">
    <ul>
      <li>${bi(
        '<strong>Providers never learn which runtime an app uses:</strong> <code>StorageProvider.inject()</code> returns an abstract storage binding <code>{ id: "pneuma-space-files-<id>", target: "/data", env: { PNEUMA_SPACE_FILES_DIR: "{dir}" } }</code>. <code>DockerDriver</code> realizes it as a Docker volume mount, <code>PodDriver</code> realizes it as a Kubernetes ReadWriteOnce PVC mount, and <code>IsolateDriver</code> realizes it as a directory inside the runner volume (<code>/data/apps/&lt;id&gt;/storage/&lt;storage-id&gt;</code>).',
        '<strong>Provider 不知道应用用哪种运行时：</strong><code>StorageProvider.inject()</code> 只给出中立的存储绑定描述（存储 ID、挂载目标与带 <code>{dir}</code> 占位符的环境变量模板）。容器驱动将其落地为 Docker Volume 或 K8s PVC 挂载，Isolate 驱动将其落地为 runner 持久卷内的子目录。'
      )}</li>
      <li>${bi(
        '<strong>Providers never learn which deployment plane runs the platform:</strong> Each Provider declares a read-only <code>service</code> property (<code>"postgres" | "redis" | "object" | "coturn" | null</code>). <code>Registry</code> puts it into <code>Injection.services</code>, and on the Kubernetes plane <code>PodDriver</code> turns each service into a Pod label <code>pneuma-space.reach.&lt;service&gt;=1</code> enforced by <code>NetworkPolicy</code> (ADR 0019 §10, AC-K8S-9).',
        '<strong>Provider 不知道当前是 Docker 还是 K8s 平面：</strong>每个 Provider 仅声明一个只读的 <code>service</code> 属性（连哪个后端服务）。K8s 平面的 <code>PodDriver</code> 据此为实例 Pod 打上 <code>pneuma-space.reach.&lt;service&gt;=1</code> 标签，由 NetworkPolicy 精确放行该应用已声明的数据服务（未声明的数据库或 Redis 在网络层直接不可达，AC-K8S-9）。'
      )}</li>
      <li>${bi(
        '<strong><code>ensure</code> is both create and resume:</strong> Every operation is safe to run twice. When an app is removed, <code>remove()</code> sets its bindings to <code>suspended</code> and calls <code>provider.suspend()</code>. When the app is republished, <code>provider.ensure()</code> converges backend drift and re-enables the binding.',
        '<strong><code>ensure</code> 既是创建也是恢复：</strong>所有四个方法均可重复执行。应用 <code>remove</code> 下线时，所有绑定置为 <code>suspended</code>（禁用凭据但保留数据）；重新发布时再次调用 <code>ensure</code> 即可恢复为 <code>active</code>，无需单独的 resume 方法。'
      )}</li>
    </ul>
  </div>
</section>

<section class="doc-section" id="matrix">
  <div class="sec-head">
    <h2>${bi('2. Complete 10-Capability & Provider Lifecycle Matrix (DESIGN.md §1.3)', '2. 十大能力与 Provider 生命周期动作总表 (DESIGN.md §1.3)')}</h2>
    <div class="chips">
      ${srcRef('DESIGN.md', 'L47-L60')}
      ${srcRef('shared/catalog.ts', 'L22-L34')}
    </div>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th><code>kind</code></th>
          <th>${bi('Class & Provider', '类别与 Provider')}</th>
          <th>${bi('Backend Resource', '后端资源命名 (<id> = App.id)')}</th>
          <th><code>ensure(app, current)</code></th>
          <th><code>inject(app, res)</code></th>
          <th><code>suspend(app)</code></th>
          <th><code>destroy(app)</code></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>route</code></td>
          <td><code>ingress</code> (implicit)</td>
          <td><code>Ingress</code></td>
          <td>—</td>
          <td><code>X-Forwarded-Prefix</code></td>
          <td>—</td>
          <td>—</td>
        </tr>
        <tr>
          <td><code>files</code></td>
          <td><code>resource</code> · <code>volume</code></td>
          <td>Volume / PVC <code>pneuma-space-files-&lt;id&gt;</code></td>
          <td>${bi('Records volume ID &amp; <code>/data</code> target', '记录卷名与 <code>/data</code> 目标')}</td>
          <td><code>PNEUMA_SPACE_FILES_DIR</code></td>
          <td>${bi('No-op (instance retired)', '无（实例已退役）')}</td>
          <td><code>runtime.destroyStorage</code></td>
        </tr>
        <tr>
          <td><code>db</code> (sqlite)</td>
          <td><code>resource</code> · <code>sqlite</code></td>
          <td>Volume / PVC <code>pneuma-space-db-&lt;id&gt;</code></td>
          <td>${bi('Records volume ID &amp; <code>/pneuma/db</code>', '记录卷名与 <code>/pneuma/db</code>')}</td>
          <td><code>sqlite://{dir}/app.sqlite3</code></td>
          <td>${bi('No-op', '无')}</td>
          <td><code>runtime.destroyStorage</code></td>
        </tr>
        <tr>
          <td><code>db</code> (postgres)</td>
          <td><code>resource</code> · <code>postgres</code></td>
          <td>Role &amp; DB <code>app_&lt;id&gt;</code></td>
          <td><code>CREATE ROLE/DATABASE</code>, <code>ALTER ROLE LOGIN</code>, <code>REVOKE CONNECT FROM PUBLIC</code></td>
          <td><code>postgresql://app_&lt;id&gt;:&lt;pw&gt;@postgres:5432/app_&lt;id&gt;</code></td>
          <td><code>ALTER ROLE app_&lt;id&gt; NOLOGIN</code></td>
          <td><code>DROP DATABASE WITH (FORCE)</code>, <code>DROP ROLE</code></td>
        </tr>
        <tr>
          <td><code>kv</code></td>
          <td><code>resource</code> · <code>redis</code></td>
          <td>Redis ACL user <code>app_&lt;id&gt;</code> (<code>~&lt;id&gt;:* &amp;&lt;id&gt;:*</code>)</td>
          <td><code>ACL SETUSER app_&lt;id&gt; reset on &gt;&lt;pw&gt; ~&lt;id&gt;:* &amp;&lt;id&gt;:* +@all -@admin -@dangerous</code> + <code>ACL SAVE</code></td>
          <td><code>PNEUMA_SPACE_KV_URL</code>, <code>PNEUMA_SPACE_KV_PREFIX=&lt;id&gt;:</code></td>
          <td><code>ACL SETUSER app_&lt;id&gt; off</code> + <code>ACL SAVE</code></td>
          <td>Lua <code>EVAL</code> (<code>SCAN + UNLINK &lt;id&gt;:*</code>) + <code>ACL DELUSER</code></td>
        </tr>
        <tr>
          <td><code>object</code></td>
          <td><code>resource</code> · <code>s3</code></td>
          <td>Bucket <code>app-&lt;id&gt;</code>, IAM user <code>app-&lt;id&gt;</code>, policy <code>pneuma-space-app-&lt;id&gt;</code></td>
          <td>SigV4 <code>PUT /app-&lt;id&gt;</code>, madmin <code>add-canned-policy</code>, <code>add-user</code>, <code>public/*</code> anonymous read policy, CORS</td>
          <td><code>PNEUMA_SPACE_OBJECT_*</code> (5 vars)</td>
          <td><code>DELETE ?policy</code> (revokes public read) + madmin <code>status=disabled</code></td>
          <td>Delete all objects, bucket, madmin user &amp; canned policy</td>
        </tr>
        <tr>
          <td><code>static</code></td>
          <td><code>ingress</code></td>
          <td><code>S3BundleStore</code> (<code>pneuma-space-bundles/&lt;sha256&gt;/</code>)</td>
          <td>—</td>
          <td>${bi('Served directly by Ingress', '由网关直接响应')}</td>
          <td>—</td>
          <td>${bi('Purge deletes bundle if unreferenced (ADR 0028)', 'purge 删除无其他应用引用的 bundle')}</td>
        </tr>
        <tr>
          <td><code>ws</code></td>
          <td><code>ingress</code></td>
          <td><code>Ingress</code> + <code>Proxy.tunnel</code></td>
          <td>—</td>
          <td>${bi('101 WebSocket &amp; SSE pass-through', 'WS 升级与 SSE 流透传')}</td>
          <td>—</td>
          <td>—</td>
        </tr>
        <tr>
          <td><code>cron</code></td>
          <td><code>schedule</code></td>
          <td><code>DeliveryScheduler</code> (<code>trigger</code> &amp; <code>delivery</code> tables)</td>
          <td>—</td>
          <td><code>POST /_pneuma-space/trigger/&lt;name&gt;</code></td>
          <td>—</td>
          <td>—</td>
        </tr>
        <tr>
          <td><code>identity</code></td>
          <td><code>ingress</code></td>
          <td><code>LocalIdentity / UpstreamIdentity / HostedIdentity</code></td>
          <td>—</td>
          <td><code>X-Pneuma-Space-Subject / Name / Owner</code></td>
          <td>—</td>
          <td>—</td>
        </tr>
        <tr>
          <td><code>rtc</code></td>
          <td><code>resource</code> · <code>coturn</code></td>
          <td>Shared TURN service (<code>coturn:3478</code>)</td>
          <td>${bi('Verifies <code>PNEUMA_SPACE_RTC_SECRET</code> &amp; probes <code>coturn:3478</code> (409 if off)', '校验密钥并探测 <code>coturn:3478</code> 在线')}</td>
          <td><code>PNEUMA_SPACE_RTC_STUN_URLS / TURN_URLS / TURN_SECRET</code></td>
          <td>${bi('No-op', '无')}</td>
          <td>${bi('No-op', '无')}</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="doc-section" id="storage-db">
  <div class="sec-head">
    <h2>${bi('3. Storage & Relational DB Provisioning: Pinning db_backend & Wire SQL', '3. 存储与关系数据库供应：db_backend 锁定规则与线协议建库')}</h2>
    <div class="chips">
      ${srcRef('gateway/src/providers.ts', 'L103-L199')}
      ${srcRef('gateway/src/registry.ts', 'L242-L246')}
    </div>
  </div>

  <div class="prose">
    <p>${bi(
      'When an app declares <code>db</code> for the first time, <code>Registry.publish</code> pins the current global <code>policy.db_backend</code> (default <code>"sqlite"</code>) into that app’s <code>policyOverride.db_backend</code> (<code>gateway/src/registry.ts:L243</code>). Changing the global <code>db_backend</code> later affects only newly created apps; switching an existing app’s database engine requires an explicit per-app policy update (<code>appctl policy &lt;name&gt; db_backend=postgres</code>), which provisions the new Binding, suspends the old one, and retires the running instance without migrating data (INV-2, AC-FORM-1).',
      '当应用首次声明 <code>db</code> 能力时，<code>Registry.publish</code> 会将当时的全局 <code>policy.db_backend</code>（默认 <code>"sqlite"</code>）写入该应用的 <code>policyOverride.db_backend</code>（<code>gateway/src/registry.ts:L243</code>）。此后修改全局默认引擎只影响尚未绑定数据库的新应用；要为已有应用切换引擎，必须显式执行 <code>appctl policy &lt;name&gt; db_backend=postgres</code>，此时平台会供应新引擎的 Binding、将旧引擎置为 <code>suspended</code> 并退役实例（两套数据各自保留，不自动迁移数据，见 AC-FORM-1）。'
    )}</p>
  </div>

  ${codePlate(
    'gateway/src/providers.ts:L162-L198 — PostgresProvider Provisioning Over Built-In pg.ts Wire Client',
    `async ensure(app: AppId, current: Resource | null): Promise<Resource> {
  await requireService(this.#probe, 'postgres', 'postgres', this.kind);
  const role = \`app_\${app}\`;
  const password = current?.password ?? secret();
  await this.#sql(async (session) => {
    if (!(await exists(session, 'SELECT FROM pg_roles WHERE rolname = $1', role)))
      await session.simple(\`CREATE ROLE \${quoted(role)}\`);
    await session.simple(\`ALTER ROLE \${quoted(role)} LOGIN PASSWORD \${literal(password)}\`);
    if (!(await exists(session, 'SELECT FROM pg_database WHERE datname = $1', role)))
      await session.simple(\`CREATE DATABASE \${quoted(role)} OWNER \${quoted(role)}\`);
    await session.simple(\`REVOKE CONNECT ON DATABASE \${quoted(role)} FROM PUBLIC\`);
  });
  return { role, database: role, password };
}`,
    srcRef('gateway/src/providers.ts', 'L162-L198', 'PostgresProvider')
  )}
</section>

<section class="doc-section" id="kv-s3">
  <div class="sec-head">
    <h2>${bi('4. Redis RESP2 ACL & SigV4 S3 + MinIO madmin Encryption', '4. Redis RESP2 ACL 隔离与对象存储 SigV4 / madmin 加密供应')}</h2>
    <div class="chips">
      ${srcRef('gateway/src/providers.ts', 'L201-L313')}
      ${srcRef('gateway/src/providers.ts', 'L599-L617')}
      ${srcRef('docs/adr/0013-object-provider-over-signed-http.md', undefined, 'ADR 0013')}
    </div>
  </div>

  ${codePlate(
    'gateway/src/providers.ts:L202-L250 & L601-L617 — Redis Lua Unlink & RustFS Argon2id + AES-256-GCM Admin Payload',
    `// 1. RedisProvider: server-side Lua script unlinks all keys under <id>:* in one round trip on purge
const UNLINK_PREFIX =
  "local c = '0' repeat local r = redis.call('SCAN', c, 'MATCH', ARGV[1], 'COUNT', 1000) c = r[1] " +
  "for _, k in ipairs(r[2]) do redis.call('UNLINK', k) end until c == '0' return 1";

// 2. S3Provider: MinIO/RustFS /minio/admin/v3/add-user payload encryption using node:crypto only (ADR 0013)
// Format: salt(32) | 0x00 (Argon2id + AES-256-GCM) | nonce(8) | sio-go authenticated stream
function sealAdminPayload(secretKey: string, plaintext: string): Buffer {
  const salt = randomBytes(32);
  const nonce = randomBytes(8);
  const key = argon2Sync('argon2id', { message: secretKey, nonce: salt, parallelism: 4, tagLength: 32, memory: 65536, passes: 1 });
  // Seals header tag under seq 0 and final fragment under seq 1 with flag 0x80
  ...
}`,
    srcRef('gateway/src/providers.ts', 'L599-L617', 'sealAdminPayload()')
  )}
</section>

<section class="doc-section" id="ingress-schedule">
  <div class="sec-head">
    <h2>${bi('5. Content-Addressed S3BundleStore & Bundle Exclusion Lock (ADR 0028)', '5. 内容寻址 S3BundleStore 与并发清除互斥锁 (ADR 0028)')}</h2>
    <div class="chips">
      ${srcRef('gateway/src/providers.ts', 'L374-L513')}
      ${srcRef('docs/adr/0028-registry-resources-between-check-and-commit.md', undefined, 'ADR 0028')}
    </div>
  </div>
  <div class="prose">
    <p>${bi(
      'Both static sites and isolate code bundles are stored in the <code>pneuma-space-bundles</code> bucket under their full tar SHA-256 digest (<code>&lt;sha256&gt;/</code>). <code>S3BundleStore.put()</code> unpacks regular files from ustar/pax/GNU tar archives via the built-in generator <code>tarFiles()</code>, uploads each file with its MD5 ETag and MIME Content-Type, stores the raw archive at <code>&lt;sha256&gt;/_pneuma-space/bundle.tar</code> (so the isolate runner can fetch it via a 600 s presigned GET URL without holding S3 credentials), and writes <code>&lt;sha256&gt;/_pneuma-space/index.json</code> last as the commit marker.',
      '静态站点产物与 Isolate 代码包均以整个 tar 包的 SHA-256 摘要为键存储在 <code>pneuma-space-bundles</code> 桶中。<code>S3BundleStore.put()</code> 通过内置的 <code>tarFiles()</code> 生成器解析 ustar/pax/GNU tar 归档，逐个写入静态文件并记录 ETag 与 Content-Type，将原始归档存于 <code>&lt;sha256&gt;/_pneuma-space/bundle.tar</code>（供 Isolate runner 通过 600s 预签名 GET URL 直接拉取，无需让 runner 持有对象存储凭据），并在最后写入 <code>index.json</code> 作为完整落盘标记。'
    )}</p>
    <p>${bi(
      '<strong>Preventing publish/purge races across replicas (ADR 0028 §2):</strong> Committing a Release that references a bundle ID and deleting that bundle during another app’s <code>purge</code> both acquire <code>Store.exclusiveBundle(bundleId, fn)</code> (PostgreSQL session advisory lock <code>pg_advisory_lock(3, hashtext(bundle))</code>, ordered strictly after the app-name lock).',
      '<strong>跨副本防竞态互斥 (ADR 0028 §2)：</strong>提交引用某 bundle 的 Release 与在另一应用 <code>purge</code> 时删除该 bundle，均通过 <code>Store.exclusiveBundle(bundleId, fn)</code>（在 PostgreSQL 上取会话级咨询锁 <code>pg_advisory_lock(3, hashtext(bundle))</code>，锁序严格遵循「先应用名、后 bundle」）互斥，彻底杜绝并发发布期间 bundle 被误删。'
    )}</p>
  </div>
</section>
`;

  return { html, toc };
}

export function renderRuntimesPage(): { html: string; toc: { id: string; en: string; zh: string }[] } {
  const toc = [
    { id: 'lanes-overview', en: '1. Pluggable Runtimes & The Driver Seam', zh: '1. 可插拔运行时与 Driver 抽象接缝' },
    { id: 'isolate-lane', en: '2. Isolate Lane: Runner, Shim & Watchdog', zh: '2. Isolate 车道：Runner、垫片与看门狗' },
    { id: 'container-lane', en: '3. Container Lane: DockerDriver vs PodDriver', zh: '3. Container 车道：Docker 与 K8s Pod 驱动' },
    { id: 'fast-path-cas', en: '4. Zero-IO Fast Path & Replica Tally Rules', zh: '4. 零 IO 快路径与多副本租约一致性' },
    { id: 'guard-deep', en: '5. AppGuard: Failure Window, Backoff & Quarantine', zh: '5. AppGuard：失败计数、退避与熔断隔离' },
  ];

  const html = `
<div class="page-head" id="lanes-overview">
  <div class="page-head-row">
    <h1>${bi('Runtime Lanes, Isolate Runner & The Guard', '三大运行时车道、Isolate Runner 内部机制与 Guard 熔断器')}</h1>
    <div class="chips">
      ${srcRef('gateway/src/runtimes.ts', 'L48-L244')}
      ${srcRef('gateway/src/lifecycle.ts', 'L37-L200')}
      ${srcRef('gateway/src/runner.ts', 'L1-L486')}
      ${srcRef('gateway/src/isolate-shim.ts', 'L1-L180')}
    </div>
  </div>
  <p class="lead">
    ${bi(
      'A new runtime is one row in RUNTIMES and one class implementing Runtime (ADR 0017). The Runtimes facade dispatches by RunSpec; Lifecycle<S, H> implements the shared state machine, lease accounting, and reaper over a pluggable Driver<S, H>; and AppGuard alone counts failures and quarantines across all runtimes.',
      '在 PneumaSpace 中，新增一种运行时只需在 RUNTIMES 表加一行并实现一个 Runtime 类（ADR 0017）。Runtimes 门面按 RunSpec 分发；Lifecycle<S, H> 在底层 Driver<S, H> 之上统一实现五态 CAS 状态机、租约记账与闲置回收器；AppGuard 则在单一位置统管所有运行时的失败退避与隔离熔断。'
    )}
  </p>
</div>

<section class="doc-section">
  <div class="sec-head">
    <h2>${bi('1. Comparison of the Three Runtime Lanes', '1. 三大运行时车道全方位工程对比')}</h2>
    <div class="chips">
      ${srcRef('shared/catalog.ts', 'L52-L56')}
      ${srcRef('README.md', 'L33-L48')}
    </div>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th>${bi('Attribute', '对比维度')}</th>
          <th><span class="chip accent">isolate</span> (${bi('Default Scaffold', '默认脚手架')})</th>
          <th><span class="chip green">container</span> (<code>--container</code>)</th>
          <th><span class="chip">static</span> (<code>--static</code>)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>${bi('Publish Input', '发布输入制品')}</strong></td>
          <td>${bi('Source directory + pure-JS <code>node_modules</code> tar bundle (~6.9 s upload, 0 Docker build)', '源码目录 + 纯 JS <code>node_modules</code> 代码包（~6.9 秒直传，无需 Docker 构建）')}</td>
          <td>${bi('OCI container image listening on port <code>8000</code> (local image ID on Docker, registry digest on K8s)', '监听 <code>8000</code> 端口的任意容器镜像（单机为本地镜像 ID，K8s 为仓库 sha256 digest）')}</td>
          <td>${bi('Static directory tar bundle only (<code>"runtime": null</code>)', '仅静态文件目录 tar 包（无运行时进程）')}</td>
        </tr>
        <tr>
          <td><strong>${bi('Execution Unit', '底层执行单元')}</strong></td>
          <td>${bi('<code>node:worker_threads</code> Worker inside <code>pneuma-space-runner</code> service (:8082 control API)', '<code>pneuma-space-runner</code> 服务内的独立 <code>worker_threads</code> 线程（控制口 :8082）')}</td>
          <td>${bi('Docker container (<code>DockerDriver</code>) or Kubernetes Pod (<code>PodDriver</code>, <code>restartPolicy: Never</code>)', '独立 Docker 容器（<code>DockerDriver</code>）或 K8s Pod（<code>PodDriver</code>）')}</td>
          <td>${bi('None — streamed by <code>Ingress</code> from <code>S3BundleStore</code>', '无进程 — 由 <code>Ingress</code> 从对象存储直出')}</td>
        </tr>
        <tr>
          <td><strong>${bi('Wake Latency &amp; RAM', '唤醒延迟与内存')}</strong></td>
          <td>${bi('<strong>62–87 ms</strong> after sleep (460–700 ms first wake); <strong>+17–18 MiB</strong> RSS per awake worker', '休眠后唤醒 <strong>62–87 ms</strong>（首次 460–700 ms）；每个醒着的 worker 仅占 <strong>17–18 MiB</strong> 内存')}</td>
          <td>${bi('<strong>~260 ms</strong> on Docker (restarts stopped container); <strong>&lt;2 s</strong> on K8s with cached image (&lt;5 s cold)', 'Docker 单机约 <strong>260 ms</strong>（重启已停止容器）；K8s 节点已缓存镜像时 <strong>&lt;2 s</strong>')}</td>
          <td>${bi('<strong>&lt;50 ms</strong> first byte, 0 ms wake, 0 MiB instance RAM', '首字节 <strong>&lt;50 ms</strong>，0 唤醒开销')}</td>
        </tr>
        <tr>
          <td><strong>${bi('Health &amp; Hang Detection', '健康与死循环检测')}</strong></td>
          <td><code>['exit', 'ready', 'hung', 'memory']</code> ${bi('(1 s ping / 3 s silence watchdog stops infinite loops in 3.5–4 s)', '（1s 心跳 / 3s 超时看门狗，3.5–4s 强杀同步死循环并采样堆外内存）')}</td>
          <td>Docker: <code>['exit', 'ready']</code><br>K8s: <code>['exit', 'ready', 'memory']</code> (<code>OOMKilled</code>)</td>
          <td>—</td>
        </tr>
        <tr>
          <td><strong>${bi('When to Choose', '适用场景')}</strong></td>
          <td>${bi('TypeScript / JavaScript apps using pure JS dependencies (<code>pg</code>, <code>redis</code>); high-density agent micro-apps', '使用纯 JS 依赖的 TS/JS 全栈微应用、Agent 高频生成的业务工具与实时协作应用')}</td>
          <td>${bi('Any language (Python, Go, Rust) or Node apps requiring native C++ addons or child processes', 'Python / Go / Rust 等任意语言应用，或依赖原生 C/C++ 扩展与子进程的 Node 应用')}</td>
          <td>${bi('Documentation sites, SPAs, landing pages with no server compute', '纯前端站点、文档站、无需服务端计算的页面')}</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="doc-section" id="isolate-lane">
  <div class="sec-head">
    <h2>${bi('2. Inside the Isolate Runner & isolate-shim.ts (ADR 0017 §5–6)', '2. Isolate Runner 与 isolate-shim.ts 沙箱垫片内部机制 (ADR 0017 §5–6)')}</h2>
    <div class="chips">
      ${srcRef('gateway/src/runner.ts', 'L1-L260')}
      ${srcRef('gateway/src/isolate-shim.ts', 'L1-L180')}
      ${srcRef('gateway/src/isolate.ts', 'L170-L350')}
    </div>
    <p>${bi(
      'How does PneumaSpace run untrusted-for-stability worker threads inside a shared runner process without one bad app crashing or hanging the runner?',
      '多个 Isolate 应用共享同一个 runner 进程的主线程，PneumaSpace 是如何在源码层面确保单个应用的死循环、内存爆炸、日志洪泛或恶意消息绝不会拖垮 runner 的？'
    )}</p>
  </div>

  <div class="prose">
    <ul>
      <li>${bi(
        '<strong>Port allocation &amp; 30 s cooldown (<code>gateway/src/runner.ts:L53-L55, L101-L106</code>):</strong> The runner allocates each worker a TCP port from <code>32768..60999</code> (starting at a random offset on boot so a restarted runner does not hand out ports its predecessor just freed). When a worker exits, its port enters a <code>PORT_COOLDOWN_MS = 30_000</code> cooldown map so delayed requests never reach a different app.',
        '<strong>端口分配与 30 秒冷却期 (<code>gateway/src/runner.ts:L53-L55, L101-L106</code>)：</strong>runner 在 <code>32768..60999</code> 范围内为每个 worker 分配独立端口（启动时随机选起点，防止 runner 重启后立即复用刚释放的端口）。worker 退出后端口进入 30 秒冷却期（<code>PORT_COOLDOWN_MS = 30_000</code>），杜绝迟到连接串入其他应用。'
      )}</li>
      <li>${bi(
        '<strong><code>isolate-shim.ts</code> bootstrap protections (<code>gateway/src/isolate-shim.ts</code>):</strong> Loaded before the app’s <code>entry</code> module, the shim captures and hides <code>parentPort</code>, disables <code>v8.setFlagsFromString</code> (so an app cannot pass <code>--allow-natives-syntax</code> and abort the runner), replaces <code>process.stdout</code> / <code>stderr</code> with rate-limited 4 KiB line streams, and replies to the runner’s 1 s heartbeat pings with <code>process.memoryUsage().external</code>.',
        '<strong><code>isolate-shim.ts</code> 启动垫片防护 (<code>gateway/src/isolate-shim.ts</code>)：</strong>在加载应用入口前，垫片先接管并清空 <code>parentPort</code>，禁用 <code>v8.setFlagsFromString</code>（防止应用通过 V8 进程级标志终止整个 runner），将 <code>stdout/stderr</code> 替换为按行截断（4 KiB）且限速的消息流，并每秒响应主线程心跳同时上报堆外内存 <code>external</code>。'
      )}</li>
      <li>${bi(
        '<strong>Lag-compensated watchdog &amp; stuck thread abandonment (<code>gateway/src/runner.ts:L128-L148</code>):</strong> Every <code>PING_MS = 1000</code>, the runner checks each worker’s ping deadline (<code>SILENCE_MS = 3000</code>). If the runner’s own event loop was delayed by <code>lag</code>, deadlines are extended by <code>lag</code> so host load spikes never trigger false-positive kills. When a worker misses its deadline, <code>thread.terminate()</code> interrupts synchronous JS loops via V8 <code>TerminateExecution</code>. If <code>terminate()</code> takes longer than <code>TERMINATE_MS = 5000</code> (e.g. blocked in a native syscall), the worker is abandoned as <code>stuck</code> and the app can immediately start a new worker; only if total stuck threads exceed <code>STUCK_LIMIT = 3</code> does the runner call <code>process.abort()</code> to let Compose/K8s restart it.',
        '<strong>防抖看门狗与 Stuck 线程遗弃机制 (<code>gateway/src/runner.ts:L128-L148</code>)：</strong>主线程每秒检查一次心跳（超时阈值 <code>SILENCE_MS = 3000</code>），若主线程自身发生事件循环迟滞，自动按迟滞量顺延所有未答心跳期限，绝不因宿主机瞬时高负载误杀。超时后调用 <code>thread.terminate()</code> 打断死循环；若 5 秒内未退出则将其标记为 <code>stuck</code> 并立即从活跃表移除，允许该应用开启新 worker，仅当残留 stuck 线程超过 <code>STUCK_LIMIT = 3</code> 时才由 <code>process.abort()</code> 触发容器级自愈。'
      )}</li>
      <li>${bi(
        '<strong>Pinned Home Runner &amp; Safe Scale-Down (ADR 0019 §8, ADR 0032):</strong> On Kubernetes, an isolate app is placed on the ready runner Pod with the fewest awake workers on its very first wake (<code>pick()</code> in <code>gateway/src/isolate.ts:L40-L48</code>) and keeps its <code>files</code> and SQLite data on that runner’s PVC (<code>instance.home</code>). Scaling down <code>pneuma-space-runner</code> checks <code>Runtimes.homes()</code> and <code>KubeInfra.removedBy()</code> first—refusing with <code>409 Conflict</code> and listing the stranded apps before making any Kubernetes API call!',
        '<strong>固定 Home Runner 与安全缩容保护 (ADR 0019 §8, ADR 0032)：</strong>在 K8s 平面上，Isolate 应用在首次唤醒时通过负载均衡选定一个 <code>pneuma-space-runner-&lt;n&gt;</code> Pod 作为永久 <code>home</code>（其 <code>files</code> 与 SQLite 数据落在该 runner 的 PVC 上）。当管理员缩容 runner StatefulSet 时，网关先通过 <code>Runtimes.homes()</code> 与 <code>KubeInfra.removedBy()</code> 核对，只要被删副本上还有任何应用的 home，就在发起 K8s 调用前直接返回 <code>409 Conflict</code> 并列出受影响的应用名单！'
      )}</li>
    </ul>
  </div>
</section>

<section class="doc-section" id="container-lane">
  <div class="sec-head">
    <h2>${bi('3. Container Lane: DockerDriver vs Kubernetes PodDriver', '3. Container 车道：DockerDriver 与 Kubernetes PodDriver 实现对比')}</h2>
    <div class="chips">
      ${srcRef('gateway/src/runtime.ts', 'L41-L214')}
      ${srcRef('gateway/src/pods.ts', 'L85-L511')}
    </div>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th>${bi('Lifecycle Hook', 'Driver 接口方法')}</th>
          <th><code>DockerDriver</code> (${srcRef('gateway/src/runtime.ts', 'L41-L189', 'runtime.ts')})</th>
          <th><code>PodDriver</code> (${srcRef('gateway/src/pods.ts', 'L170-L511', 'pods.ts')})</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>start(slot, spec)</code></td>
          <td>${bi('Creates volumes and container <code>pneuma-space-&lt;id&gt;-&lt;release&gt;</code> (if <code>slot.handle</code> is missing or <code>specHash</code> changed), calls <code>docker start</code>, caches container IP from <code>docker inspect</code> (bypassing Docker DNS’s 4 s negative cache), and polls TCP :8000 every 50 ms while verifying <code>stillRunning()</code>.', '按需创建卷与容器 <code>pneuma-space-&lt;id&gt;-&lt;release&gt;</code>，调用 <code>docker start</code>，通过 <code>inspect</code> 缓存容器 IP（绕开 Docker DNS 对外部停止容器的 4s 失败延迟），并每 50 ms 探测 :8000 TCP 就绪同时核对容器未退出。')}</td>
          <td>${bi('Ensures RWO PVCs, deletes any leftover Failed Pod (capturing its log first), creates Pod <code>pneuma-space-&lt;id&gt;</code> with <code>pneuma-space.epoch</code> and <code>pneuma-space.reach.*</code> labels, waits on the Pod watch for Running (up to <code>pendingSeconds = 60</code>), then polls TCP <code>podIP:8000</code> every 50 ms.', '确保 RWO PVC 存在，清理同名残留 Pod（先保存日志），创建带 <code>epoch</code> 与 <code>reach.*</code> 网络策略标签的 Pod <code>pneuma-space-&lt;id&gt;</code>，经 Pod watch 等待进入 Running 后每 50 ms 探测 <code>podIP:8000</code>。')}</td>
        </tr>
        <tr>
          <td><code>sleep(app, slot)</code></td>
          <td>${bi('Runs <code>docker stop</code> and <strong>keeps</strong> <code>slot.handle</code> (the stopped container) so the next wake skips container creation and wakes in ~260 ms.', '执行 <code>docker stop</code> 并<strong>保留</strong>已停止的容器句柄，使下次唤醒无需重建容器，耗时仅约 260 ms。')}</td>
          <td>${bi('Kubernetes has no stopped Pod concept: captures last 200 log lines (up to 64 KiB) into <code>instance_log</code>, deletes the Pod with <code>preconditions.uid = handle</code>, and clears <code>slot.handle</code>.', 'K8s 没有「已停止的 Pod」：先抓取最后 200 行日志（至多 64 KiB）写入平台库 <code>instance_log</code>，再带 <code>preconditions.uid</code> 安全删除 Pod。')}</td>
        </tr>
        <tr>
          <td><code>serves(handle, address)</code></td>
          <td>—</td>
          <td>${bi('Before handing out a warm lease from memory, verifies in the local Pod watch cache that <code>address</code> (<code>podIP:8000</code>) still belongs to Pod UID <code>handle</code>, preventing Pod IP reuse races.', '在走内存快路径发放租约前，先在本地 Pod watch 缓存中核对该 <code>podIP</code> 对应的 Pod UID 仍等于 <code>handle</code>，缩小 Pod IP 复用窗口。')}</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="doc-section" id="fast-path-cas">
  <div class="sec-head">
    <h2>${bi('4. Multi-Replica Zero-IO Fast Path & ADR 0027 Memory Rules', '4. 多副本零 IO 快路径与 ADR 0027 内存断定准则')}</h2>
    <div class="chips">
      ${srcRef('gateway/src/lifecycle.ts', 'L154-L240')}
      ${srcRef('docs/adr/0020-instance-state-in-store.md', undefined, 'ADR 0020')}
      ${srcRef('docs/adr/0027-replica-memory-and-shared-rows.md', undefined, 'ADR 0027')}
    </div>
  </div>
  <div class="prose">
    <p>${bi(
      'How can a multi-replica gateway achieve under 5 ms overhead on warm requests (<code>gateway/src/lifecycle.ts:L161-L171</code>) while keeping instance state in PostgreSQL? By enforcing ADR 0027’s exact rule on what a replica may deduce from its own memory:',
      '多副本网关把实例状态放在 PostgreSQL 中，如何同时做到热请求网关开销低于 5 ms 且零数据库 IO（<code>gateway/src/lifecycle.ts:L161-L171</code>）？靠的是 ADR 0027 对「副本凭内存能断定什么」的严密证明：'
    )}</p>
    <ul>
      <li>${bi(
        '<strong>The 0 → &gt;0 Edge Gate (<code>Lifecycle.#covered</code>):</strong> A replica may hand out a Lease from memory with <strong>zero database IO</strong> if and only if its mirror shows the row <code>awake</code> at <code>epoch</code>, its most recently <strong>committed</strong> <code>lease_tally</code> row in the store for that <code>epoch</code> is <code>&gt; 0</code>, and no queued write in <code>local.pending</code> lowers that count to <code>0</code>. Because the reaper’s <code>SELECT ... FOR UPDATE</code> sees that replica’s committed <code>&gt; 0</code> tally, the reaper is guaranteed not to put the instance to sleep while the replica hands out warm leases in memory!',
        '<strong>0 → &gt;0 边沿门控 (<code>Lifecycle.#covered</code>)：</strong>当且仅当本副本对当前 <code>epoch</code> 最近一次<strong>已提交落库</strong>的 <code>lease_tally</code> 计数大于 0，且本地发送队列中没有将其降为 0 的写操作时，本副本才能在内存中以<strong>零数据库 IO</strong> 直接发放新租约。因为领导者回收器（reaper）在 <code>FOR UPDATE</code> 锁下必然看到该副本已提交的正数租约，所以实例绝不会在快路径转发期间被并发休眠！'
      )}</li>
      <li>${bi(
        '<strong>Coalesced Edge Waiters (<code>local.edge</code>):</strong> When the first request arrives at a replica whose local tally is <code>0</code> for an already-awake instance, that replica runs one slow-path transaction (<code>#slow</code>) to bump its <code>lease_tally</code> from <code>0 → 1</code> while verifying the instance row is still <code>awake</code>. Concurrent requests on the same replica await <code>local.edge.done</code> and then immediately take the zero-IO fast path.',
        '<strong>冷边沿合并等待 (<code>local.edge</code>)：</strong>当某个副本收到对已唤醒实例的第 1 个请求（本地 tally 从 0 变 1）时，只发起一笔慢路径事务（<code>#slow</code>）将库里的 tally 抬升为正数；同副本并发到达的其他请求共享等待 <code>local.edge.done</code>，一旦提交成功即全部走零 IO 快路径。'
      )}</li>
    </ul>
  </div>
</section>

<section class="doc-section" id="guard-deep">
  <div class="sec-head">
    <h2>${bi('5. AppGuard: Unified Failure Counting, Backoff & Quarantine', '5. AppGuard：跨运行时统一的失败计数、退避与熔断隔离')}</h2>
    <div class="chips">
      ${srcRef('gateway/src/runtimes.ts', 'L168-L244')}
      ${srcRef('gateway/src/model.ts', 'L193-L196')}
    </div>
  </div>

  ${codePlate(
    'gateway/src/model.ts:L212-L228 — Default Guard & Instance Policy Tunables',
    `export const DEFAULT_POLICY: Policy = {
  idle_seconds: 60,               // Idle time with 0 leases before awake -> stopping -> asleep
  ready_timeout_seconds: 15,      // Max time to accept TCP on port 8000 / worker port during wake
  drain_timeout_seconds: 30,      // Max grace for in-flight requests after retire (WS gets 1001 immediately)
  connection_idle_seconds: 21600, // 6 hours: silent WebSocket/SSE channel lease timeout (closes with 1001)
  trigger_timeout_seconds: 600,   // 10 minutes: max duration of one POST /_pneuma-space/trigger/<name> attempt
  db_backend: 'sqlite',           // Default database provider pinned on an app's first db binding
  max_failures: 3,                // Failures within failure_window_seconds before quarantine (503)
  failure_window_seconds: 60,     // Sliding window for counting wake timeouts, crashes, OOMs, and hangs
  restart_backoff_seconds: 5,     // Cooldown after a failure before another wake is admitted (503 Retry-After)
  cpu_millis: 1000,               // 1.0 vCPU limit per container/Pod instance
  memory_mb: 512,                 // 512 MiB container limit / isolate V8 heap + off-heap budget
  timezone: 'UTC',                // Global 5-field cron evaluation timezone
  usage_retention_days: 90,       // Hourly usage heatmap retention
  events_retention_days: 14,      // Persisted lifecycle events retention
  events_max_rows: 1_000_000,     // Max rows in events table
};`,
    srcRef('gateway/src/model.ts', 'L212-L228', 'DEFAULT_POLICY')
  )}
</section>
`;

  return { html, toc };
}

export function renderPlanesPage(): { html: string; toc: { id: string; en: string; zh: string }[] } {
  const toc = [
    { id: 'plane-seam', en: '1. Kubernetes Is a Plane, Not a Runtime', zh: '1. K8s 是部署平面而非运行时 (ADR 0019)' },
    { id: 'multi-replica', en: '2. Multi-Replica PostgreSQL Store & Leader Election', zh: '2. 多副本 PostgreSQL 协同与领导者选举' },
    { id: 'k8s-deploy', en: '3. Deploying on Kubernetes & NetworkPolicies', zh: '3. Kubernetes 生产部署与网络策略' },
    { id: 'hosted-saas', en: '4. M3 Full Hosted SaaS & Caddy Origin TLS', zh: '4. M3 完整托管 SaaS 与 Caddy 源站 TLS' },
    { id: 'acceptance-gates', en: '5. Acceptance Suite & Benchmark Thresholds', zh: '5. 验收测试矩阵与性能门槛' },
  ];

  const html = `
<div class="page-head" id="plane-seam">
  <div class="page-head-row">
    <h1>${bi('Deployment Planes: M1 Docker, M2 Kubernetes & M3 Hosted SaaS', '三大部署平面与演进：M1 Docker、M2 Kubernetes 与 M3 托管 SaaS')}</h1>
    <div class="chips">
      ${srcRef('gateway/src/main.ts', 'L96-L126')}
      ${srcRef('deploy/kubernetes/README.md', 'L1-L76')}
      ${srcRef('deploy/hosted/README.md', 'L1-L71')}
    </div>
  </div>
  <p class="lead">
    ${bi(
      'Kubernetes is a deployment plane, not a runtime (ADR 0019). Setting PNEUMA_SPACE_PLANE=kubernetes swaps exactly four seams in main.ts while Lifecycle, Runtimes, AppGuard, DeliveryScheduler, Ingress, PlatformRegistry, and all CapabilityProviders remain 100% shared.',
      'Kubernetes 是部署平面，而不是运行时（ADR 0019）。在组合根 gateway/src/main.ts 中，切换 PNEUMA_SPACE_PLANE=docker|kubernetes 仅替换四个底层适配器接缝，而 Lifecycle、Runtimes、AppGuard、DeliveryScheduler、Ingress、PlatformRegistry 与全部 Provider 实现 100% 共用同一份代码。'
    )}
  </p>
</div>

<section class="doc-section">
  <div class="sec-head">
    <h2>${bi('1. The Four Plane Seams in gateway/src/main.ts', '1. 组合根 main.ts 中的四个部署平面接缝 (DESIGN.md §2.1)')}</h2>
    <div class="chips">
      ${srcRef('gateway/src/main.ts', 'L70-L125')}
      ${srcRef('docs/adr/0019-kubernetes-plane.md', undefined, 'ADR 0019')}
    </div>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th>${bi('Seam in main.ts', '架构接缝')}</th>
          <th><code>PNEUMA_SPACE_PLANE=docker</code> (M1 Default)</th>
          <th><code>PNEUMA_SPACE_PLANE=kubernetes</code> (M2 / M3 Cluster)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>1. Container Driver</strong></td>
          <td><code>DockerRuntime</code> / <code>DockerDriver</code> (${srcRef('gateway/src/runtime.ts', 'L41-L214')}) — talks to <code>/var/run/docker.sock</code></td>
          <td><code>PodRuntime</code> / <code>PodDriver</code> (${srcRef('gateway/src/pods.ts', 'L170-L511')}) — creates/watches Pods &amp; PVCs in namespace <code>pneuma-space-apps</code> via <code>kube.ts</code></td>
        </tr>
        <tr>
          <td><strong>2. Isolate Runner Pool</strong></td>
          <td><code>StaticPool("http://runner:8082")</code> (${srcRef('gateway/src/isolate.ts', 'L51-L65')})</td>
          <td><code>StatefulSetPool</code> (${srcRef('gateway/src/isolate.ts', 'L71-L113')}) — watches Pods labelled <code>pneuma-space.role=runner</code> in namespace <code>pneuma-space</code></td>
        </tr>
        <tr>
          <td><strong>3. Infra &amp; Cluster View</strong></td>
          <td><code>DockerInfra</code> (${srcRef('gateway/src/infra.ts', 'L1-L65')}) — resolves local image IDs, probes Compose services</td>
          <td><code>KubeInfra</code> (${srcRef('gateway/src/kube-infra.ts', 'L1-L360')}) — resolves OCI registry digests (<code>HEAD /v2/&lt;repo&gt;/manifests/&lt;tag&gt;</code>), samples Nodes/Workloads/PVCs/Warnings, scales gateway &amp; runner</td>
        </tr>
        <tr>
          <td><strong>4. Platform Store</strong></td>
          <td><code>SqliteStore("/data/pneuma-space.sqlite3")</code> (${srcRef('gateway/src/store.ts', 'L1-L380')})</td>
          <td><code>PgStore(PNEUMA_SPACE_STORE_URL)</code> (${srcRef('gateway/src/store-pg.ts', 'L1-L540')}) — built-in <code>pg.ts</code> wire client with <code>SERIALIZABLE</code> retries, advisory locks &amp; <code>LISTEN pneuma_space</code></td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="doc-section" id="multi-replica">
  <div class="sec-head">
    <h2>${bi('2. Multi-Replica Coordination, Advisory Locks & Leader Duties', '2. 多副本 PostgreSQL 协同、咨询锁与领导者职责 (ADR 0020, ADR 0025)')}</h2>
    <div class="chips">
      ${srcRef('gateway/src/store-pg.ts', 'L1-L240')}
      ${srcRef('gateway/src/instances.ts', 'L1-L255')}
      ${srcRef('docs/adr/0025-platform-store-postgresql.md', undefined, 'ADR 0025')}
    </div>
  </div>
  <div class="prose">
    <ul>
      <li>${bi(
        '<strong>Connection budget per gateway replica (ADR 0025 §6):</strong> Each replica opens an 8-session query pool, up to 4 on-demand command sessions (<code>PNEUMA_SPACE_STORE_COMMANDS=4</code>) for <code>Store.exclusive(appName)</code> and <code>Store.exclusiveBundle(bundleId)</code> advisory locks, and 1 dedicated session that executes <code>LISTEN pneuma_space</code> and holds the leader advisory lock. Three replicas use at most 39 PostgreSQL connections (require session-level connections, never transaction-mode PgBouncer).',
        '<strong>每副本确定性连接预算 (ADR 0025 §6)：</strong>每个网关副本维护一个 8 会话查询池、至多 4 个按需命令会话（承载 <code>Store.exclusive</code> 应用名锁与 <code>Store.exclusiveBundle</code> 包锁）以及 1 个专用常驻会话（负责 <code>LISTEN pneuma_space</code> 变更通知与领导者锁）。3 副本总计最多使用 39 条 PostgreSQL 连接（需会话级连接，不经过事务模式 PgBouncer）。'
      )}</li>
      <li>${bi(
        '<strong>Trigger-driven cache invalidation (ADR 0025 §5):</strong> Database row triggers fire <code>NOTIFY pneuma_space</code> on commit with four payload shapes: <code>app/&lt;name&gt;</code> (rebuilds <code>RouteView</code> if <code>app.version</code> is newer), <code>policy</code> (reloads global Policy), <code>instance/&lt;appId&gt;</code> (refreshes <code>instance</code> and <code>guard</code> mirror rows), and <code>tenant/&lt;name&gt;</code> (clears the 30 s membership &amp; token cache in <code>Authority</code>).',
        '<strong>数据库行触发器驱动的实时失效 (ADR 0025 §5)：</strong>数据库行级触发器在事务提交时向 <code>pneuma_space</code> 通道发送四种通知：<code>app/&lt;name&gt;</code>（按版本号递增重建内存 <code>RouteView</code>）、<code>policy</code>（刷新全局策略）、<code>instance/&lt;appId&gt;</code>（刷新实例与 Guard 镜像）以及 <code>tenant/&lt;name&gt;</code>（立即清空 <code>Authority</code> 的 30s 成员与令牌缓存）。'
      )}</li>
      <li>${bi(
        '<strong>Correctness never depends on the leader (INV-11):</strong> The replica holding <code>pg_try_advisory_lock</code> on <code>pneuma-space.leader</code> runs periodic background chores: the idle reaper, <code>DeliveryScheduler.tick()</code>, takeover of transitions started by replicas not seen for <code>DEAD_MS = 10_000</code>, orphan Pod/worker cleanup, provider convergence, and retention sweeps. Even if two replicas briefly think they lead, every transition is a CAS on <code>(runtime, state, epoch)</code>.',
        '<strong>正确性绝不依赖领导者 (INV-11)：</strong>持有 <code>pneuma-space.leader</code> 咨询锁的副本负责执行周期性后台任务：闲置回收、定时触发调度、接管失联超过 10 秒（<code>DEAD_MS</code>）的死副本转换、孤儿 Pod/worker 清理与观测数据清扫。即便发生领导权切换或脑裂，单实例不变量仍由 <code>instance</code> 行上的 CAS 条件更新严格保证。'
      )}</li>
    </ul>
  </div>
</section>

<section class="doc-section" id="k8s-deploy">
  <div class="sec-head">
    <h2>${bi('3. Kubernetes Manifests, Two-Namespace Layout & NetworkPolicies', '3. Kubernetes 双命名空间架构、NetworkPolicy 与一键校验部署')}</h2>
    <div class="chips">
      ${srcRef('deploy/kubernetes/README.md', 'L1-L76')}
      ${srcRef('deploy/kubernetes/check.mjs', 'L1-L120')}
      ${srcRef('deploy/kubernetes/60-network-policies.yaml', 'L1-L200')}
    </div>
  </div>

  ${codePlate(
    'Terminal — Validate Tokens & Apply Kubernetes Manifests (deploy/kubernetes/)',
    `# 1. Build and push the zero-dependency gateway image to your organization's registry
docker build -f gateway/Dockerfile -t <registry>/pneuma-space-gateway:<tag> .
docker push <registry>/pneuma-space-gateway:<tag>

# 2. Check all REPLACE_ME_* tokens and verify CIDR agreement between ConfigMap and NetworkPolicies
node deploy/kubernetes/check.mjs

# 3. Apply Kustomize manifests (creates namespaces pneuma-space and pneuma-space-apps, RBAC, store, services, gateway, runner, NetworkPolicies)
kubectl apply -k deploy/kubernetes
kubectl -n pneuma-space rollout status statefulset/pneuma-space-store
kubectl -n pneuma-space rollout status deployment/pneuma-space-gateway`,
    srcRef('deploy/kubernetes/README.md', 'L34-L42', 'deploy/kubernetes/README.md')
  )}

  <div class="prose">
    <p>${bi(
      '<strong>Two-namespace boundary (<code>deploy/kubernetes/00-namespaces.yaml</code> &amp; <code>60-network-policies.yaml</code>):</strong> Platform components (3 gateway replicas, runner StatefulSet, platform store, Redis, RustFS, coturn) run in namespace <code>pneuma-space</code>. Container app Pods and their PVCs run in <code>pneuma-space-apps</code> with ExternalName Services resolving short names (<code>postgres</code>, <code>redis</code>, <code>rustfs</code>). NetworkPolicies guarantee that only the gateway can reach instance Pods on port 8000, an instance Pod can reach a platform data service only if it carries <code>pneuma-space.reach.&lt;service&gt;: "1"</code>, and no app Pod can ever reach another app Pod, the platform database, or the Kubernetes API (AC-K8S-9).',
      '<strong>双命名空间与网络隔离 (<code>deploy/kubernetes/00-namespaces.yaml</code> &amp; <code>60-network-policies.yaml</code>)：</strong>平台组件（3 副本网关、runner StatefulSet、平台库、Redis、RustFS、coturn）运行在 <code>pneuma-space</code> 命名空间；应用实例 Pod 与 PVC 运行在 <code>pneuma-space-apps</code> 命名空间。<code>NetworkPolicy</code> 强制保证：只有网关能连应用实例的 8000 端口；实例只有带 <code>pneuma-space.reach.&lt;service&gt;: "1"</code> 标签才能访问自己声明的数据服务；实例之间不可互访，且绝不可达平台数据库与 K8s API (AC-K8S-9)。'
    )}</p>
  </div>
</section>

<section class="doc-section" id="hosted-saas">
  <div class="sec-head">
    <h2>${bi('4. M3 Full Hosted SaaS Profile & Hybrid Origin TLS (ADR 0036, ADR 0037)', '4. M3 完整托管 SaaS 模式与 Caddy 源站 TLS 架构 (ADR 0036, ADR 0037)')}</h2>
    <div class="chips">
      ${srcRef('deploy/hosted/README.md', 'L1-L71')}
      ${srcRef('gateway/src/identity-hosted.ts', 'L1-L220')}
      ${srcRef('docs/adr/0037-hybrid-origin-tls.md', undefined, 'ADR 0037')}
    </div>
  </div>
  <div class="prose">
    <p>${bi(
      'With <code>PNEUMA_SPACE_IDENTITY=hosted</code> (ADR 0036), PneumaSpace adds self-service GitHub OAuth sign-in, automatic personal tenant provisioning (default quota: 5 apps, 2 awake instances, 2000 CPU millis, 1024 MiB RAM, 5 GiB storage), host-only HttpOnly session cookies with CSRF verification, single-use browser-bound private-app grants, and scoped expiring deployment tokens (<code>read, publish, invoke, remove, manage</code>) on top of the full Contract 1 platform.',
      '启用 <code>PNEUMA_SPACE_IDENTITY=hosted</code>（ADR 0036）后，平台在完整保留契约 1 全部能力与原控制台的基础上，新增 GitHub OAuth 登录、首次登录幂等创建个人私有空间（默认配额：5 个应用、2 个并发唤醒实例、2 核 CPU、1024 MiB 内存、5 GiB 存储）、带 Origin 与 CSRF 校验的 HttpOnly 会话、单次绑定浏览器的私有应用访问凭据（Grant），以及支持过期时间、权限域与指定 AppId 限制的程序令牌。'
    )}</p>
    <p>${bi(
      '<strong>Why Hybrid Origin TLS uses DNS-only + Caddy instead of Cloudflare HTTP Proxy (ADR 0037):</strong> Ordinary Cloudflare HTTP proxying imposes request body upload caps and origin read timeouts that break Contract 1’s unbounded streaming bodies and 6-hour WebSocket idle leases. The Kubernetes hosted overlay (<code>deploy/hosted/kubernetes/</code>) therefore uses Cloudflare DNS-only records pointing to a dedicated Caddy LoadBalancer Service that terminates TLS at the origin for the control host (:8081), wildcard apps host (:8080), and direct object storage host (:9000).',
      '<strong>为什么采用 DNS-only + Caddy 源站终止 TLS (ADR 0037)：</strong>Cloudflare 普通橙云 HTTP 代理对上传请求体大小和源站超时有限制，会破坏契约 1「无上限流式请求体」与「6 小时 WebSocket 长连接」的承诺。因此托管 K8s 叠加层（<code>deploy/hosted/kubernetes/</code>）使用 Cloudflare DNS-only 记录直指集群负载均衡器，由 전용 Caddy Deployment 在源站终止控制域名（转 8081）、通配应用域名（转 8080）与对象存储域名（直转 rustfs 9000）的 TLS。'
    )}</p>
  </div>
</section>

<section class="doc-section" id="acceptance-gates">
  <div class="sec-head">
    <h2>${bi('5. Quantitative Acceptance Thresholds & Test Suites', '5. 量化验收门槛与分层自动化测试体系')}</h2>
    <div class="chips">
      ${srcRef('docs/acceptance.md', 'L56-L71')}
      ${srcRef('package.json', 'L11-L22')}
      ${srcRef('AGENTS.md', 'L52-L67')}
    </div>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <thead>
        <tr>
          <th>${bi('Metric / Acceptance Gate (4-core, 8 GB Host)', '量化指标与验收门槛（4 核 8 GB 主机基线）')}</th>
          <th>${bi('Required Threshold', '硬性通过门槛')}</th>
          <th>${bi('Verification Command & Suite', '验证命令与测试套件')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Registered Cold Apps / Simultaneously Awake Apps</strong></td>
          <td><code>500</code> registered / <code>20</code> awake</td>
          <td><code>npm run test:acceptance</code> (<code>AC-P-8</code>, <code>AC-P-14</code>)</td>
        </tr>
        <tr>
          <td><strong>Admin Listing &amp; Telemetry Latency</strong> (<code>GET /api/apps</code>, <code>/api/metrics</code>, <code>/api/requests</code>, <code>/api/health</code>)</td>
          <td><code>&lt; 100 ms</code> (<code>/api/apps</code>), <code>&lt; 50 ms</code> (others), <strong>0 Docker/K8s calls</strong></td>
          <td><code>AC-P-8</code>, <code>AC-P-13</code>, <code>AC-P-15</code>, <code>AC-P-16</code></td>
        </tr>
        <tr>
          <td><strong>Cold Start / Warm Request / WebSocket Relay Overhead</strong></td>
          <td>Cold start <code>&lt; 3 s</code> median (isolate 62–87 ms); warm gateway overhead <code>&lt; 5 ms</code>; WS relay <code>&lt; 5 ms</code></td>
          <td><code>node tests/bench/runtimes.ts</code> · <code>AC-ISO-1</code></td>
        </tr>
        <tr>
          <td><strong>Direct Object Transfer &amp; Static First Byte</strong></td>
          <td>500 MB upload: <strong>0 bytes</strong> through app or gateway; 1 GB read: app stays asleep, <strong>0 RSS growth</strong>; static first byte <code>&lt; 50 ms</code></td>
          <td><code>AC-MEDIA-2</code>, <code>AC-MEDIA-4</code>, <code>AC-STATIC-2</code></td>
        </tr>
        <tr>
          <td><strong>Zero Runtime Dependencies Gate</strong></td>
          <td>Root <code>package.json</code> declares no <code>dependencies</code></td>
          <td><code>npm run test:unit</code> (<code>AC-STORE-8</code> in <code>gateway/src/catalog.test.ts</code>)</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>
`;

  return { html, toc };
}
