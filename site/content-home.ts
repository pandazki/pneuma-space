// Content for index.html (00 Overview & Blueprint Atlas) and quickstart.html (01 Quickstart, CLI & 7 Examples).
import { bi, biBlock, codePlate, srcRef } from './helpers.ts';

export function renderOverviewPage(): { html: string; toc: { id: string; en: string; zh: string }[] } {
  const toc = [
    { id: 'atlas', en: 'Blueprint Atlas & Telemetry', zh: '架构蓝图与实测指标' },
    { id: 'workbench', en: 'Manifest & SDK Workbench', zh: '交互式清单与代码工作台' },
    { id: 'simulator', en: '9-Step Request & CAS Simulator', zh: '9 步请求与 CAS 状态机推演' },
    { id: 'tradeoffs', en: 'Compared with Vercel & Supabase', zh: '与 Vercel / Supabase 的取舍对照' },
    { id: 'editions', en: 'Three Progressive Editions', zh: 'M1 / M2 / M3 三层演进架构' },
  ];

  const html = `
<div class="page-head" id="atlas">
  <div id="atlas-thesis" style="display:grid;gap:14px">
    <div class="page-head-row">
      <h1>${bi('No agent inside. Built for what agents build.', '内核无 Agent，专为 Agent 构建的有状态微应用而生')}</h1>
      <div class="chips">
        <span class="st green">${bi('Contract 1 & 2 Verified', '契约 1 与 2 已交叉核验')}</span>
        ${srcRef('gateway/src/main.ts', 'L1-L247')}
        ${srcRef('shared/catalog.ts', 'L22-L56')}
      </div>
    </div>
    <p class="lead">
      ${bi(
        'PneumaSpace deploys many small stateful web apps on one trusted machine you own (M1) or your organization’s Kubernetes cluster (M2/M3). An app is a directory whose manifest, <code>pneuma-space.json</code>, declares the infrastructure capabilities it needs. Publishing is an upload, not a build; the first request wakes the app, idleness puts it to sleep, and its data outlives every sleep, crash, and release.',
        'PneumaSpace 在你拥有的一台可信机器（M1）或组织的 Kubernetes 集群（M2/M3）上高密度运行大量有状态微应用。一个应用就是一个目录，用 <code>pneuma-space.json</code> 声明所需的基础设施能力。发布是上传而非镜像构建；首请求按需唤醒，闲置自动休眠（Scale-to-Zero），而持久数据跨越每一次休眠、崩溃与版本发布。'
      )}
    </p>

    <div class="actions" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:2px">
      <a class="btn primary" id="primary-cta" href="./quickstart.html">${bi('Quickstart in 30s', '30 秒快速上手')}</a>
      <a class="btn ghost" href="#workbench">${bi('Interactive Manifest Workbench', '交互式清单与代码生成')}</a>
      <a class="btn ghost" href="#simulator">${bi('Trace Request & CAS Lifecycle', '请求与 CAS 状态机推演')}</a>
      <a class="btn ghost" href="./architecture.html">${bi('12 Invariants & Source Map', '12 条架构不变量与源码图谱')}</a>
      <a class="btn ghost" href="./adr.html">${bi('Read All 37 ADRs', '精读全部 37 篇 ADR')}</a>
    </div>
  </div>

  <!-- 4 Tabular Telemetry Ledger Strips (No nested cards, dashed cell structure) -->
  <div class="ledger-strip" style="margin-top:12px">
    <div>
      <div class="metric-label">
        <span>${bi('Isolate Publish', 'Isolate 免构建发布')}</span>
        ${srcRef('cli/appctl.ts', 'L129-L157', 'appctl.ts:L129')}
      </div>
      <div class="metric-val">6.9 s</div>
      <div class="metric-sub">${bi('Upload bundle with pure-JS node_modules; zero Docker build (AC-ISO-1).', '打包源码与纯 JS 依赖直传对象存储，无需 Docker 镜像构建 (AC-ISO-1)。')}</div>
    </div>
    <div>
      <div class="metric-label">
        <span>${bi('Wake Latency', '按需唤醒耗时')}</span>
        ${srcRef('gateway/src/isolate.ts', 'L207-L240', 'isolate.ts:L207')}
      </div>
      <div class="metric-val">62–87 ms</div>
      <div class="metric-sub">${bi('Isolate wake after sleep (460–700 ms first wake; ~260 ms container; 0 ms static).', 'Isolate 休眠后热唤醒（首次 460–700 ms；容器 ~260 ms；静态站点 0 ms）。')}</div>
    </div>
    <div>
      <div class="metric-label">
        <span>${bi('Worker Memory', '单 Worker 内存开销')}</span>
        ${srcRef('gateway/src/runner.ts', 'L49-L50', 'runner.ts:L49')}
      </div>
      <div class="metric-val">17–18 MiB</div>
      <div class="metric-sub">${bi('One worker_threads Worker per awake isolate app; 0 MiB when asleep (G2).', '每个醒着的 Isolate 应用独占一个 worker_threads 线程，休眠时为 0 MiB (G2)。')}</div>
    </div>
    <div>
      <div class="metric-label">
        <span>${bi('Guard Quarantine', '死循环看门狗与熔断')}</span>
        ${srcRef('gateway/src/runtimes.ts', 'L168-L244', 'runtimes.ts:L168')}
      </div>
      <div class="metric-val">3.5–4 s</div>
      <div class="metric-sub">${bi('3 s watchdog + 250 ms poll terminates hung worker; 3 failures quarantine (AC-ISO-2).', '3 秒心跳超时 + 250 ms 轮询强杀卡死线程；连续 3 次失败自动隔离 (AC-ISO-2)。')}</div>
    </div>
  </div>

  <!-- Tab-Switched Live Blueprint Atlas Stage -->
  <div class="atlas-frame">
    <div class="atlas-bar">
      <div class="seg" role="tablist" aria-label="Architecture Blueprint Views">
        <button type="button" data-atlas-tab="hero" aria-pressed="true">${bi('1. End-to-End Pulse (Hero)', '1. 全链路脉冲全景 (Hero)')}</button>
        <button type="button" data-atlas-tab="lanes" aria-pressed="false">${bi('2. Three Runtime Lanes', '2. 三大运行时泳道 (Lanes)')}</button>
        <button type="button" data-atlas-tab="graph" aria-pressed="false">${bi('3. Capability Topology Graph', '3. 五列能力拓扑图 (Graph)')}</button>
        <button type="button" data-atlas-tab="console" aria-pressed="false">${bi('4. Live Console (:8081) Views', '4. 真实控制台 (:8081) 视图')}</button>
      </div>
      <div class="chips">
        ${srcRef('docs/assets/render.ts', 'L1-L610', 'render.ts')}
        ${srcRef('gateway/src/console.html', 'L1-L120', 'console.html')}
      </div>
    </div>

    <div class="atlas-stage" data-atlas-pane="hero">
      <img class="theme-light-only" src="./assets/hero-light.svg" alt="PneumaSpace Hero Architecture Diagram (Light)">
      <img class="theme-dark-only" src="./assets/hero-dark.svg" alt="PneumaSpace Hero Architecture Diagram (Dark)">
    </div>

    <div class="atlas-stage" data-atlas-pane="lanes" hidden>
      <img class="theme-light-only" src="./assets/lanes-light.svg" alt="PneumaSpace Runtime Lanes Diagram (Light)">
      <img class="theme-dark-only" src="./assets/lanes-dark.svg" alt="PneumaSpace Runtime Lanes Diagram (Dark)">
    </div>

    <div class="atlas-stage" data-atlas-pane="graph" hidden>
      <img class="theme-light-only" src="./assets/graph-light.svg" alt="PneumaSpace Capability Graph Diagram (Light)">
      <img class="theme-dark-only" src="./assets/graph-dark.svg" alt="PneumaSpace Capability Graph Diagram (Dark)">
    </div>

    <div class="atlas-stage" data-atlas-pane="console" hidden>
      <div class="console-subtabs">
        <div class="seg">
          <button type="button" data-shot-tab="overview" aria-pressed="true">${bi('Overview (0 Docker calls)', '总览页 (0 Docker 调用)')}</button>
          <button type="button" data-shot-tab="realtime" aria-pressed="false">${bi('Realtime Stream', '实时请求与事件流')}</button>
          <button type="button" data-shot-tab="lanes" aria-pressed="false">${bi('Topology: Lanes', '拓扑：运行时泳道')}</button>
          <button type="button" data-shot-tab="graph" aria-pressed="false">${bi('Topology: Graph', '拓扑：能力连线图')}</button>
          <button type="button" data-shot-tab="cluster" aria-pressed="false">${bi('Kubernetes Cluster', 'K8s 集群与实例运维')}</button>
        </div>
      </div>
      <div data-shot-pane="overview">
        <img class="theme-light-only" src="./assets/console/overview-light.png" alt="Console Overview Light">
        <img class="theme-dark-only" src="./assets/console/overview-dark.png" alt="Console Overview Dark">
      </div>
      <div data-shot-pane="realtime" hidden>
        <img class="theme-light-only" src="./assets/console/realtime-light.png" alt="Console Realtime Light">
        <img class="theme-dark-only" src="./assets/console/realtime-dark.png" alt="Console Realtime Dark">
      </div>
      <div data-shot-pane="lanes" hidden>
        <img class="theme-light-only" src="./assets/console/lanes-light.png" alt="Console Topology Lanes Light">
        <img class="theme-dark-only" src="./assets/console/lanes-dark.png" alt="Console Topology Lanes Dark">
      </div>
      <div data-shot-pane="graph" hidden>
        <img class="theme-light-only" src="./assets/console/graph-light.png" alt="Console Topology Graph Light">
        <img class="theme-dark-only" src="./assets/console/graph-dark.png" alt="Console Topology Graph Dark">
      </div>
      <div data-shot-pane="cluster" hidden>
        <img class="theme-light-only" src="./assets/console/cluster-light.png" alt="Console Cluster Light">
        <img class="theme-dark-only" src="./assets/console/cluster-dark.png" alt="Console Cluster Dark">
      </div>
    </div>

    <div class="atlas-caption">
      <span>${bi(
        'Every diagram above is drawn from real state by the console at :8081 (ADR 0014–0018). Polling /api/metrics, /api/apps, and /api/requests reads gateway memory only and makes 0 Docker or Kubernetes calls.',
        '以上架构图与 :8081 控制台拓扑页同源（ADR 0014–0018）。控制台轮询 /api/metrics、/api/apps 与 /api/requests 仅读取网关副本内存，热路径上产生 0 次 Docker 或 Kubernetes 调用。'
      )}</span>
      <span class="chips">
        ${srcRef('gateway/src/metrics.ts', 'L163-L178', 'metrics.ts:L163')}
        ${srcRef('docs/adr/0018-topology-page.md', undefined, 'ADR 0018')}
      </span>
    </div>
  </div>
</div>

<!-- Interactive Manifest & Starter Code Workbench -->
<section class="doc-section" id="workbench">
  <div class="sec-head">
    <h2>${bi('Interactive Manifest & Starter Code Workbench', '交互式 pneuma-space.json 清单与全栈代码工作台')}</h2>
    <div class="chips">
      ${srcRef('shared/catalog.ts', 'L22-L56')}
      ${srcRef('gateway/src/model.ts', 'L38-L113')}
      ${srcRef('templates/app/AGENTS.md', 'L1-L84')}
    </div>
    <p>${bi(
      'Click any official example preset or toggle capabilities and runtime lanes below to inspect the exact validated pneuma-space.json manifest, starter TypeScript server code, injected PNEUMA_SPACE_* variables, and under-the-hood Provider wire protocol commands.',
      '点击下方任意官方示例预设，或自由组合运行时车道与 9 项显式能力，实时生成经过 parseManifest() 校验的 pneuma-space.json、可直接运行的 TypeScript 服务端代码、注入的环境变量以及底层 Provider 线协议供应动作。'
    )}</p>
  </div>

  <div class="workbench" id="manifest-workbench">
    <div class="wb-controls">
      <div class="wb-group">
        <div class="wb-group-title">
          <span>${bi('Official Example Presets (examples/)', '官方七大示例预设 (examples/)')}</span>
          ${srcRef('examples/README.md', 'L1-L15', 'examples/')}
        </div>
        <div class="preset-list">
          <button type="button" class="preset-btn" data-wb-preset="survey" aria-pressed="true">survey</button>
          <button type="button" class="preset-btn" data-wb-preset="ttt" aria-pressed="false">ttt</button>
          <button type="button" class="preset-btn" data-wb-preset="widget" aria-pressed="false">widget</button>
          <button type="button" class="preset-btn" data-wb-preset="chat" aria-pressed="false">chat</button>
          <button type="button" class="preset-btn" data-wb-preset="notes-py" aria-pressed="false">notes-py</button>
          <button type="button" class="preset-btn" data-wb-preset="pulse-go" aria-pressed="false">pulse-go</button>
          <button type="button" class="preset-btn" data-wb-preset="site-docs" aria-pressed="false">site-docs</button>
        </div>
      </div>

      <div class="wb-group">
        <div class="wb-group-title">
          <span>${bi('Runtime Lane (ADR 0017)', '运行时车道 (ADR 0017)')}</span>
          ${srcRef('gateway/src/runtimes.ts', 'L48-L76', 'Runtimes')}
        </div>
        <div class="seg" style="width:100%;justify-content:space-between">
          <button type="button" data-wb-runtime="isolate" aria-pressed="true">isolate (worker)</button>
          <button type="button" data-wb-runtime="container" aria-pressed="false">container (:8000)</button>
          <button type="button" data-wb-runtime="static" aria-pressed="false">static (no proc)</button>
        </div>
      </div>

      <div class="wb-group">
        <div class="wb-group-title">
          <span>${bi('Declarative Capabilities (route is implicit)', '声明式能力 (route 隐式提供，无需声明)')}</span>
        </div>
        <div class="cap-toggles">
          <button type="button" class="cap-tog" data-wb-cap="files" aria-pressed="true"><span>files</span><span class="cap-kind">/data</span></button>
          <button type="button" class="cap-tog" data-wb-cap="db" aria-pressed="true"><span>db</span><span class="cap-kind">SQL</span></button>
          <button type="button" class="cap-tog" data-wb-cap="kv" aria-pressed="false"><span>kv</span><span class="cap-kind">Redis</span></button>
          <button type="button" class="cap-tog" data-wb-cap="object" aria-pressed="false"><span>object</span><span class="cap-kind">S3</span></button>
          <button type="button" class="cap-tog" data-wb-cap="static" aria-pressed="true"><span>static</span><span class="cap-kind">bundle</span></button>
          <button type="button" class="cap-tog" data-wb-cap="ws" aria-pressed="false"><span>ws</span><span class="cap-kind">WS/SSE</span></button>
          <button type="button" class="cap-tog" data-wb-cap="cron" aria-pressed="true"><span>cron</span><span class="cap-kind">trigger</span></button>
          <button type="button" class="cap-tog" data-wb-cap="identity" aria-pressed="true"><span>identity</span><span class="cap-kind">headers</span></button>
          <button type="button" class="cap-tog" data-wb-cap="rtc" aria-pressed="false"><span>rtc</span><span class="cap-kind">TURN</span></button>
        </div>
      </div>
    </div>

    <div class="wb-output">
      <div class="wb-output-head">
        <div class="seg">
          <button type="button" data-wb-tab="manifest" aria-pressed="true">1. pneuma-space.json</button>
          <button type="button" data-wb-tab="code" aria-pressed="false">2. src/server.ts (SDK)</button>
          <button type="button" data-wb-tab="env" aria-pressed="false">${bi('3. Env & Headers', '3. 环境变量与请求头')}</button>
          <button type="button" data-wb-tab="ops" aria-pressed="false">${bi('4. Providers & CLI', '4. 底层供应与 CLI')}</button>
        </div>
        <button type="button" class="copy-btn" data-copy-target="#wb-code-pre"><span class="copy-label">${bi('Copy', '复制')}</span></button>
      </div>
      <div class="wb-pane">
        <div style="font:500 12px/18px var(--mono);color:var(--ink-2);margin-bottom:8px" id="wb-file-label">pneuma-space.json</div>
        <pre class="raw-pre" id="wb-code-pre" style="padding:0"></pre>
      </div>
    </div>
  </div>
</section>

<!-- Interactive 9-Step Request & CAS Lifecycle Simulator -->
<section class="doc-section" id="simulator">
  <div class="sec-head">
    <h2>${bi('Interactive 9-Step Request & CAS Lifecycle Simulator', '9 步请求流水线与 CAS 实例状态机交互推演')}</h2>
    <div class="chips">
      ${srcRef('gateway/src/ingress.ts', 'L251-L405')}
      ${srcRef('gateway/src/lifecycle.ts', 'L154-L200')}
      ${srcRef('gateway/src/runtimes.ts', 'L168-L244')}
    </div>
    <p>${bi(
      'Walk through the exact code path a request takes through port 8080, or switch to the Hung Worker & Guard Quarantine scenario to see how an infinite loop is stopped in 3.5–4 s and quarantined after 3 failures without a global lock.',
      '逐步推演一个请求到达 8080 端口后的 9 个真实代码阶段，或切换到「死循环看门狗与 Guard 隔离」场景，直观理解网关如何在无全局锁的架构下用 CAS 条件更新完成按需唤醒、零 IO 快路径转发与 3.5–4 秒故障熔断。'
    )}</p>
  </div>

  <div class="sim-frame" id="lifecycle-simulator">
    <div class="sim-top">
      <div class="seg">
        <button type="button" data-sim-scenario="isolate-wake" aria-pressed="true">${bi('Scenario A: Cold Request → Isolate Wake → Idle Sleep', '场景 A：冷请求到达 → Isolate 唤醒 → 闲置休眠')}</button>
        <button type="button" data-sim-scenario="guard-quarantine" aria-pressed="false">${bi('Scenario B: Hung Worker (3.5s) → Guard Quarantine (3x)', '场景 B：Worker 死循环 (3.5s 强杀) → Guard 熔断隔离')}</button>
      </div>
      <div class="chips">
        <button type="button" class="btn ghost small" data-sim-nav="prev">${bi('Prev Step', '上一步')}</button>
        <button type="button" class="btn ghost small" data-sim-nav="next">${bi('Next Step', '下一步')}</button>
      </div>
    </div>

    <div class="sim-steps" role="tablist">
      <button type="button" class="sim-step-btn" data-sim-step="0" aria-selected="true"><span class="s-num">STEP 01</span><span class="s-name">Locate</span></button>
      <button type="button" class="sim-step-btn" data-sim-step="1" aria-selected="false"><span class="s-num">STEP 02</span><span class="s-name">Strip Headers</span></button>
      <button type="button" class="sim-step-btn" data-sim-step="2" aria-selected="false"><span class="s-num">STEP 03</span><span class="s-name">RouteView</span></button>
      <button type="button" class="sim-step-btn" data-sim-step="3" aria-selected="false"><span class="s-num">STEP 04</span><span class="s-name">Access & Auth</span></button>
      <button type="button" class="sim-step-btn" data-sim-step="4" aria-selected="false"><span class="s-num">STEP 05</span><span class="s-name">Static Bypass</span></button>
      <button type="button" class="sim-step-btn" data-sim-step="5" aria-selected="false"><span class="s-num">STEP 06</span><span class="s-name">CAS & Guard</span></button>
      <button type="button" class="sim-step-btn" data-sim-step="6" aria-selected="false"><span class="s-num">STEP 07</span><span class="s-name">Driver Start</span></button>
      <button type="button" class="sim-step-btn" data-sim-step="7" aria-selected="false"><span class="s-num">STEP 08</span><span class="s-name">Lease & Stream</span></button>
      <button type="button" class="sim-step-btn" data-sim-step="8" aria-selected="false"><span class="s-num">STEP 09</span><span class="s-name">Idle Sleep</span></button>
    </div>

    <div class="sim-body">
      <div class="sim-explain">
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px">
          <h3 style="margin:0;font-size:16px;font-weight:600" id="sim-step-title">1. Locate</h3>
          <span class="chips">
            <span class="chip accent" id="sim-step-inv">INV-1</span>
            <a class="src-ref" id="sim-step-src" href="https://github.com/pandazki/pneuma-space/blob/main/gateway/src/ingress.ts#L251-L270" target="_blank" rel="noopener"><span>gateway/src/ingress.ts:L251-L270</span></a>
          </span>
        </div>

        <p style="margin:0;font-size:13.5px;line-height:21px;color:var(--ink-2)" id="sim-step-desc"></p>

        <div style="display:grid;gap:6px;margin-top:4px">
          <div style="font-size:12px;font-weight:600;color:var(--ink-2)">${bi('Instance CAS State Machine (DESIGN.md §1.4 / ADR 0020):', '实例 CAS 状态机 (DESIGN.md §1.4 / ADR 0020)：')}</div>
          <div class="state-strip">
            <span class="state-node" data-state-node="asleep">asleep</span>
            <span class="mono" style="font-size:12px;color:var(--ink-3)">→</span>
            <span class="state-node" data-state-node="waking">waking</span>
            <span class="mono" style="font-size:12px;color:var(--ink-3)">→</span>
            <span class="state-node" data-state-node="awake">awake</span>
            <span class="mono" style="font-size:12px;color:var(--ink-3)">→</span>
            <span class="state-node" data-state-node="draining">draining</span>
            <span class="mono" style="font-size:12px;color:var(--ink-3)">→</span>
            <span class="state-node" data-state-node="stopping">stopping</span>
            <span class="mono" style="font-size:12px;color:var(--ink-3)">·</span>
            <span class="state-node" data-state-node="quarantined">quarantined (Guard)</span>
          </div>
        </div>

        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;padding:8px 0;font-size:12.5px">
          <span style="font-weight:600;color:var(--ink-2);white-space:nowrap">${bi('Active Replica Lease Tally:', '当前副本活跃租约计数 (Lease Tally)：')}</span>
          <span class="mono" id="sim-step-lease" style="color:var(--ink);white-space:nowrap">request: 0 · channel: 0 · trigger: 0</span>
        </div>
      </div>

      <div class="sim-code">
        <div style="font:500 12px/18px var(--mono);color:var(--ink-3);margin-bottom:8px">${bi('Verified Source Excerpt', '真实源码切片')}</div>
        <pre class="raw-pre" id="sim-step-code" style="padding:0"></pre>
      </div>
    </div>
  </div>
</section>

<!-- Compared with Vercel & Supabase -->
<section class="doc-section" id="tradeoffs">
  <div class="sec-head">
    <h2>${bi('Compared with Vercel and Supabase: Honest Architectural Boundaries', '与 Vercel 和 Supabase 的对照：诚实的技术边界与取舍')}</h2>
    <div class="chips">
      ${srcRef('README.md', 'L65-L85')}
      ${srcRef('REQUIREMENTS.md', 'L17-L20')}
    </div>
    <p>${bi(
      'Vercel and Supabase run your app on their multi-tenant cloud infrastructure. PneumaSpace runs every app on a machine or Kubernetes cluster you own.',
      'Vercel 和 Supabase 在它们的基础设施上运行你的应用；PneumaSpace 在你自己拥有的一台机器或 Kubernetes 集群上运行所有应用。'
    )}</p>
  </div>

  <div class="split-ledger">
    <div>
      <h3><span class="st green">${bi('What You Gain', '你获得的能力')}</span></h3>
      <ul>
        <li>${bi('<strong>Persistent state per app that survives sleep and release:</strong> a <code>/data</code> directory, a SQL database (SQLite or PostgreSQL), a Redis key prefix, and an S3 bucket. Only <code>purge</code> after <code>remove</code> deletes data (INV-2).', '<strong>跨越休眠与版本发布的每应用持久状态：</strong>独立的 <code>/data</code> 目录、SQL 数据库（SQLite 或 PostgreSQL）、Redis 键前缀与 S3 桶。发布和下线绝不删数据，只有 <code>remove</code> 后的 <code>purge</code> 才会销毁 (INV-2)。')}</li>
        <li>${bi('<strong>Scale to zero per app with millisecond wake:</strong> a sleeping isolate wakes in <strong>62 to 87 ms</strong> (+17–18 MiB RAM while awake), a container in <strong>~260 ms</strong>, and a static site answers in <strong>&lt;50 ms</strong> without waking anything.', '<strong>毫秒级按需唤醒与缩容至零：</strong>休眠的 Isolate 应用在 <strong>62–87 ms</strong> 内唤醒（运行时仅增 17–18 MiB 内存），容器约 <strong>260 ms</strong> 唤醒，静态站点在 <strong>50 ms 内</strong>直接响应且不唤醒任何进程。')}</li>
        <li>${bi('<strong>Long-lived WebSocket &amp; SSE connections:</strong> open connections promote the Lease to <code>channel</code> and keep the app awake across replicas (INV-3, AC-COLLAB-3).', '<strong>原生保持长连接：</strong>WebSocket 与 SSE 升级后将租约转为 <code>channel</code>，在连接存续期间跨副本保持实例唤醒 (INV-3, AC-COLLAB-3)。')}</li>
        <li>${bi('<strong>Publish without an image build:</strong> an isolate directory is live <strong>6.9 s</strong> after <code>appctl publish</code>; hung workers are stopped in 3.5–4 s and quarantined by the Guard without taking neighbours down.', '<strong>免构建极速发布与故障隔离：</strong>Isolate 目录在 <code>appctl publish</code> 后 <strong>6.9 秒</strong>即上线；死循环应用在 3.5–4 秒内被看门狗强杀并由 Guard 熔断隔离，绝不拖垮相邻应用。')}</li>
        <li>${bi('<strong>Zero vendor lock-in &amp; zero gateway npm dependencies:</strong> MIT licensed, speaks Docker, Kubernetes, PostgreSQL, Redis, and S3 wire protocols directly from Node.js LTS built-in modules (ADR 0012, ADR 0025).', '<strong>零厂商锁定与网关零 npm 依赖：</strong>MIT 开源，网关仅用 Node.js LTS 内置模块直接讲 Docker、K8s、PostgreSQL、Redis 与 S3 线协议 (ADR 0012, ADR 0025)。')}</li>
      </ul>
    </div>
    <div>
      <h3><span class="st orange">${bi('What You Give Up (Explicit Non-Goals)', '你放弃的部分（明确声明的不做边界）')}</span></h3>
      <ul>
        <li>${bi('<strong>Global edge reach:</strong> runs on your own machine or cluster in one location; no built-in global CDN or edge network (though <code>PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT</code> can sit behind a CDN in M2).', '<strong>全球边缘网络：</strong>运行在你自己的单机或单集群位置，不自带全球 CDN 或边缘节点（M2 中可将公开对象存储端点放到组织 CDN 之后）。')}</li>
        <li>${bi('<strong>Hostile multi-tenant isolation in M1/M2:</strong> M1 trusts every image on one host; M2 isolates cooperative organization members against accidental cross-impact (NetworkPolicy, browser origin per app, quotas), NOT against hostile code. Hostile workload isolation is an M3 release gate.', '<strong>M1/M2 不防恶意租户代码：</strong>M1 假设单机镜像可信；M2 面向同一组织内会犯错但非恶意的成员（提供 NetworkPolicy、每应用独立浏览器源与配额），不承诺对抗性恶意租户隔离（那是 M3 的公开发布门槛）。')}</li>
        <li>${bi('<strong>Built-in identity protocol on M1/M2:</strong> M1’s <code>local</code> login asks only for a name (identifies, does not authenticate). M2’s <code>upstream</code> mode verifies signed JWTs (RS256/ES256/EdDSA) from your organization’s authenticating proxy. M3 adds <code>hosted</code> OAuth sign-in.', '<strong>M1/M2 内置密码库：</strong>M1 的 <code>local</code> 登录只问名字（仅标识身份，不认证）；M2 的 <code>upstream</code> 模式验证组织上游认证代理签发的 JWT；M3 新增 <code>hosted</code> GitHub OAuth 登录。')}</li>
        <li>${bi('<strong>Managed infrastructure operations:</strong> you run Docker Compose or Kubernetes, TLS termination, volume/database backups, and cluster upgrades.', '<strong>全托管基础设施运维：</strong>由你或你的组织自行运维 Docker Compose 或 Kubernetes、入口 TLS 证书、存储层备份与升级。')}</li>
      </ul>
    </div>
  </div>
</section>

<!-- Three Progressive Editions Matrix -->
<section class="doc-section" id="editions">
  <div class="sec-head">
    <h2>${bi('Three Progressive Editions: Same App Contract, Same Codebase', '三层演进架构（G4）：同一份应用契约，同一套代码库')}</h2>
    <div class="chips">
      ${srcRef('REQUIREMENTS.md', 'L14-L20')}
      ${srcRef('REQUIREMENTS-M2.md', 'L5-L34')}
      ${srcRef('REQUIREMENTS-M3.md', 'L1-L43')}
    </div>
    <p>${bi(
      'An app written for M1 publishes to M2 Kubernetes or M3 Hosted SaaS without changing a single line of code (G6).',
      '按 docs/app-contract.md 编写的 M1 应用，无需修改一行代码即可发布到 M2 Kubernetes 集群或 M3 托管环境 (G6)。'
    )}</p>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <caption class="table-code-strip">SPEC-TABLE 01 · EDITIONS-MATRIX · REQUIREMENTS.md / REQUIREMENTS-M2.md / REQUIREMENTS-M3.md</caption>
      <thead>
        <tr>
          <th>${bi('Dimension', '维度')}</th>
          <th>${bi('M1 · Single Trusted Host', 'M1 · 可信单机版')}</th>
          <th>${bi('M2 · Organization Edition', 'M2 · 组织集群版')}</th>
          <th>${bi('M3 · Hosted SaaS & Cloud Profile', 'M3 · 托管 SaaS 与云端契约实验')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>${bi('Plane & Store', '部署平面与平台库')}</strong></td>
          <td><code>PNEUMA_SPACE_PLANE=docker</code> · SQLite WAL (<code>/data/pneuma-space.sqlite3</code>) ${srcRef('gateway/src/store.ts', 'L1-L90', 'store.ts')}</td>
          <td><code>PNEUMA_SPACE_PLANE=kubernetes</code> · Multi-replica Gateway + PostgreSQL <code>SERIALIZABLE</code> ${srcRef('gateway/src/store-pg.ts', 'L1-L120', 'store-pg.ts')}</td>
          <td>Additive <code>hosted</code> identity on Contract 1 stack (${srcRef('docs/adr/0036-additive-hosted-platform.md', undefined, 'ADR 0036')}) + separate Contract 2 Fetch experiment (<code>cloud/</code>, ${srcRef('docs/adr/0033-hosted-fetch-profile.md', undefined, 'ADR 0033')})</td>
        </tr>
        <tr>
          <td><strong>${bi('Addressing', '应用地址形态')}</strong></td>
          <td>Path mode: <code>http://127.0.0.1:8080/apps/&lt;name&gt;/</code> (<code>X-Forwarded-Prefix: /apps/&lt;name&gt;</code>)</td>
          <td>Subdomain mode: <code>https://&lt;name&gt;.&lt;apps-domain&gt;/</code> (separate browser origin per app; <code>X-Forwarded-Prefix</code> empty)</td>
          <td>Contract 1: <code>https://&lt;name&gt;.&lt;apps-domain&gt;/</code> · Contract 2 Fetch: <code>https://&lt;name&gt;--&lt;tenant&gt;.&lt;apps-domain&gt;/</code></td>
        </tr>
        <tr>
          <td><strong>${bi('Compute Drivers', '计算驱动与池')}</strong></td>
          <td><code>DockerDriver</code> (keeps stopped container) + <code>StaticPool</code> (<code>runner:8082</code>)</td>
          <td><code>PodDriver</code> (1 Pod per awake app in <code>pneuma-space-apps</code>) + <code>StatefulSetPool</code> (pinned home runner Pod)</td>
          <td>Contract 1: full <code>container</code>, <code>isolate</code>, <code>static</code> · Contract 2: stateless ES module <code>fetch(request, app)</code></td>
        </tr>
        <tr>
          <td><strong>${bi('Identity & Authz', '身份认证与权限')}</strong></td>
          <td><code>PNEUMA_SPACE_IDENTITY=local</code> (self-reported name cookie + service tokens; loopback admin API)</td>
          <td><code>PNEUMA_SPACE_IDENTITY=upstream</code> (verifies RS256/ES256/EdDSA JWT from org proxy; Tenants, <code>admin/member</code> roles, <code>tenant/org/public</code> access)</td>
          <td><code>PNEUMA_SPACE_IDENTITY=hosted</code> (GitHub OAuth / dev accounts, personal tenant on first sign-in, CSRF, single-use app grants, scoped expiring tokens)</td>
        </tr>
        <tr>
          <td><strong>${bi('Operations & Quotas', '配额、审计与运维')}</strong></td>
          <td>Global &amp; per-app <code>Policy</code>, Guard backoff &amp; quarantine, in-memory Overview/Realtime/Topology console</td>
          <td>Per-tenant Quotas (<code>apps, awake, cpu_millis, memory_mb, storage_gb</code>), append-only <code>audit</code> table, 30-day usage heatmaps, Cluster operations page, Prometheus <code>/metrics</code></td>
          <td>Signup capacity gate (<code>PNEUMA_SPACE_HOSTED_SIGNUP_LIMIT</code>), Caddy origin TLS (${srcRef('docs/adr/0037-hybrid-origin-tls.md', undefined, 'ADR 0037')}), per-app token restrictions &amp; typed purge confirmation</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>
`;

  return { html, toc };
}

export function renderQuickstartPage(): { html: string; toc: { id: string; en: string; zh: string }[] } {
  const toc = [
    { id: 'run-platform', en: '1. Start the Platform Stack', zh: '1. 启动平台服务栈' },
    { id: 'init-publish', en: '2. Scaffold & Publish an App', zh: '2. 初始化与发布应用' },
    { id: 'local-dev', en: '3. Local Dev & Testing Without Docker', zh: '3. 本地直接运行与调试' },
    { id: 'cli-reference', en: '4. Complete appctl CLI Reference', zh: '4. appctl 命令行全集参考' },
    { id: 'examples', en: '5. The 7 Official Example Apps', zh: '5. 七大官方示例应用与原型' },
  ];

  const html = `
<div class="page-head">
  <div class="page-head-row">
    <h1>${bi('Quickstart, CLI (appctl) & 7 Official Examples', '快速上手、appctl 命令行与七大官方示例')}</h1>
    <div class="chips">
      ${srcRef('README.md', 'L8-L32')}
      ${srcRef('cli/appctl.ts', 'L29-L180')}
      ${srcRef('templates/app/AGENTS.md', 'L19-L32')}
    </div>
  </div>
  <p class="lead">
    ${bi(
      'Requirements: Docker with Compose v2, and Node.js 24 or newer on the host (Node runs TypeScript directly with zero build step, ADR 0012).',
      '环境要求：Docker（含 Compose v2）以及宿主机 Node.js 24 或更高版本（Node 原生直接执行 TypeScript，无需编译步骤，见 ADR 0012）。'
    )}
  </p>
</div>

<section class="doc-section" id="run-platform">
  <div class="sec-head">
    <h2>${bi('1. Start the Platform Stack (Compose Profiles)', '1. 启动平台服务栈（按需启用 Compose Profile）')}</h2>
    <div class="chips">
      ${srcRef('compose.yaml', 'L1-L160')}
      ${srcRef('docs/adr/0030-compose-service-presence.md', undefined, 'ADR 0030')}
    </div>
    <p>${bi(
      'By default, every port binds to 127.0.0.1 loopback: ingress on :8080, management console on :8081, and RustFS S3 object storage on :9000.',
      '默认配置下所有宿主机端口仅绑定 127.0.0.1 回环地址：应用入口 :8080、管理控制台 :8081、RustFS 对象存储 :9000。'
    )}</p>
  </div>

  ${codePlate(
    'Terminal: Start PneumaSpace on One Trusted Machine (M1)',
    `# Recommended: Gateway (:8080/:8081), RustFS (:9000), Redis, and the Isolate Runner service
docker compose --profile isolate up -d

# Container apps only (without the isolate runner)
docker compose up -d

# Full stack: also start PostgreSQL (for db_backend=postgres) and coturn (for WebRTC rtc capability)
docker compose --profile isolate --profile postgres --profile rtc up -d

# Or launch the M3 full hosted development stack with operator/alice/bob accounts on :58081
npm run dev:hosted`,
    srcRef('compose.yaml', 'L1-L90', 'compose.yaml')
  )}

  <div class="notice info">
    <span class="st green">${bi('Service Presence Probe', '服务在线判定')}</span>
    <div>
      ${bi(
        '<strong>How the gateway knows a profiled service is up (ADR 0030):</strong> <code>addressOnNetwork()</code> in <code>gateway/src/providers.ts:L73-L81</code> resolves the service name with a bounded 500 ms c-ares DNS resolver and verifies the IPv4 address falls inside one of the gateway’s own container network interfaces before testing a 1 s TCP connect. Publishing an app whose runtime or capability profile is not started immediately returns <code>409 Conflict</code> naming the <code>--profile</code> flag.',
        '<strong>网关如何判断可选服务已启动 (ADR 0030)：</strong><code>gateway/src/providers.ts:L73-L81</code> 中的 <code>addressOnNetwork()</code> 使用 500 ms 有界 DNS 解析器，并校验解析出的 IPv4 是否落在网关自身网卡子网内（防止宿主机 Fake-IP 代理误导），再做 1 秒 TCP 连接探测。若对应 profile 未开启，发布将立即返回 <code>409 Conflict</code> 并提示所需的 <code>--profile</code> 参数。'
      )}
    </div>
  </div>
</section>

<section class="doc-section" id="init-publish">
  <div class="sec-head">
    <h2>${bi('2. Scaffold & Publish Your First Stateful Micro-App', '2. 初始化并发布你的第一个有状态微应用')}</h2>
    <div class="chips">
      ${srcRef('cli/appctl.ts', 'L129-L180')}
      ${srcRef('templates/app/src/server.ts', 'L1-L22')}
    </div>
    <p>${bi(
      'appctl init copies templates/app (an isolate app by default). Publishing an isolate directory installs production dependencies without scripts and uploads a tar bundle in ~6.9 s.',
      'appctl init 默认拷贝 templates/app（Isolate 运行时模板）。发布 Isolate 目录时无需构建 Docker 镜像，自动在临时副本中执行 npm ci --omit=dev --ignore-scripts 并上传代码包，约 6.9 秒即可访问。'
    )}</p>
  </div>

  ${codePlate(
    'Terminal: Initialize, Publish & Open',
    `# 1. Scaffold an isolate app (use --container to add a Dockerfile, or --static for a static site)
node cli/appctl.ts init myapp
cd myapp

# 2. Inspect pneuma-space.json and src/server.ts (templates/app/AGENTS.md is the complete guide)
cat pneuma-space.json

# 3. Publish to the gateway; --owner is required on first publish (or export PNEUMA_SPACE_OWNER=user:me)
node ../cli/appctl.ts publish myapp . --owner user:me

# 4. Visit the app (wakes on first request in 460-700 ms; subsequent wakes after sleep take 62-87 ms)
open http://127.0.0.1:8080/apps/myapp/
open http://127.0.0.1:8081/`,
    srcRef('cli/appctl.ts', 'L29-L52', 'cli/appctl.ts')
  )}

  <div class="prose">
    <p>${bi(
      '<strong>What happens during <code>appctl publish</code>:</strong>',
      '<strong><code>appctl publish</code> 在底层依次完成了什么：</strong>'
    )}</p>
    <ul>
      <li>${bi(
        '<strong>Client-side bundling (<code>cli/appctl.ts:L107-L157</code>):</strong> For an isolate app, <code>codeBundle()</code> copies the directory following symlinks that stay inside the root, excludes <code>.git</code>, <code>node_modules</code>, <code>data/</code>, <code>.env*</code>, <code>.npmrc</code>, and <code>*.test.*</code>, runs <code>npm ci --omit=dev --ignore-scripts</code>, packs a deterministic ustar archive, and uploads it via <code>POST /api/bundles</code>.',
        '<strong>客户端安全打包 (<code>cli/appctl.ts:L107-L157</code>)：</strong>对于 Isolate 应用，<code>codeBundle()</code> 跟随目录内软链并跳过越界软链，自动剔除 <code>.git</code>、<code>node_modules</code>、<code>data/</code>、<code>.env*</code>、<code>.npmrc</code> 与测试文件，执行 <code>npm ci --omit=dev --ignore-scripts</code> 后打包上传至 <code>POST /api/bundles</code>。'
      )}</li>
      <li>${bi(
        '<strong>Idempotent release key (<code>gateway/src/model.ts:L119-L135</code>):</strong> The gateway computes <code>release_key = sha256(canonicalJson({ image, manifest, bundle }))</code>. If the app is already <code>registered</code> with the same <code>release_key</code>, publish returns the current release immediately with zero side effects (INV-6, AC-P-2).',
        '<strong>幂等版本摘要 (<code>gateway/src/model.ts:L119-L135</code>)：</strong>网关计算 <code>release_key = sha256(canonicalJson({ image, manifest, bundle }))</code>。若应用处于 <code>registered</code> 且 <code>release_key</code> 未变，重复发布直接返回当前 Release，不产生任何冗余操作 (INV-6, AC-P-2)。'
      )}</li>
      <li>${bi(
        '<strong>Quota reservation &amp; Provider convergence (<code>gateway/src/registry.ts:L247-L289</code>):</strong> Under the tenant row lock (ADR 0028), missing <code>files</code> and <code>sqlite</code> bindings are reserved as <code>suspended</code> and checked against <code>storage_gb</code>. Then each declared resource Provider runs <code>ensure()</code> outside the DB transaction, followed by the atomic commit of <code>Release</code>, <code>Trigger</code>, and <code>Binding</code> state.',
        '<strong>配额预留与 Provider 收敛 (<code>gateway/src/registry.ts:L247-L289</code>)：</strong>在租户行锁下（ADR 0028）先插入 <code>suspended</code> 占位行并校验 <code>storage_gb</code> 与 <code>apps</code> 配额；随后在数据库事务外对每项资源能力执行幂等的 <code>provider.ensure()</code>，最后在单事务中原子提交 <code>Release</code>、<code>Trigger</code> 与 <code>Binding</code> 状态。'
      )}</li>
    </ul>
  </div>
</section>

<section class="doc-section" id="local-dev">
  <div class="sec-head">
    <h2>${bi('3. Run & Test Your App Locally Without Docker', '3. 在本地无需网关直接运行与调试应用')}</h2>
    <div class="chips">
      ${srcRef('templates/app/AGENTS.md', 'L85-L100')}
      ${srcRef('templates/app/sdk/serve.ts', 'L1-L90')}
    </div>
    <p>${bi(
      'Because the app contract is pure environment variables and HTTP headers, any app runs directly on your machine with node src/server.ts.',
      '由于 PneumaSpace 的应用契约完全由标准环境变量与 HTTP 请求头组成，你可以在本机直接用 node src/server.ts 启动并测试任何应用。'
    )}</p>
  </div>

  ${codePlate(
    'Terminal: Local Execution & Simulated Identity / Trigger Headers',
    `npm ci && npm test
mkdir -p data

# Run your app directly on port 8000 with SQLite and /data bindings
PNEUMA_SPACE_APP=dev \\
PNEUMA_SPACE_RELEASE=0 \\
PNEUMA_SPACE_FILES_DIR=./data \\
PNEUMA_SPACE_DB_URL=sqlite://$PWD/data/app.sqlite3 \\
  node src/server.ts

# In another terminal: simulate an authenticated owner request through the gateway
curl -H 'X-Forwarded-Prefix: /apps/dev' \\
     -H 'X-Pneuma-Space-Subject: user:ann' \\
     -H 'X-Pneuma-Space-Name: Ann' \\
     -H 'X-Pneuma-Space-Owner: 1' \\
     http://127.0.0.1:8000/

# Simulate a scheduled or on-demand trigger delivery
curl -X POST \\
     -H 'X-Pneuma-Space-Delivery: d-local-1' \\
     -H 'X-Pneuma-Space-Attempt: 1' \\
     http://127.0.0.1:8000/_pneuma-space/trigger/tick`,
    srcRef('templates/app/AGENTS.md', 'L87-L95', 'templates/app/AGENTS.md')
  )}
</section>

<section class="doc-section" id="cli-reference">
  <div class="sec-head">
    <h2>${bi('4. Complete appctl CLI Command Reference', '4. appctl 命令行工具完整参考')}</h2>
    <div class="chips">
      ${srcRef('cli/appctl.ts', 'L29-L52')}
      ${srcRef('cli/appctl.test.ts', 'L1-L120')}
    </div>
    <p>${bi(
      'appctl talks to PNEUMA_SPACE_ADMIN (default http://127.0.0.1:8081) and sends PNEUMA_SPACE_TOKEN as Authorization: Bearer. Exit codes: 1 = usage, 2 = manifest error, 3 = admin API error, 4 = build/bundle/push failure.',
      'appctl 访问 PNEUMA_SPACE_ADMIN（默认 http://127.0.0.1:8081），并将 PNEUMA_SPACE_TOKEN 作为 Authorization: Bearer 发送。退出码固定为：1 = 参数用法错误，2 = 清单语法错误，3 = API 错误，4 = 本地打包或镜像构建/推送失败。'
    )}</p>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <caption class="table-code-strip">SPEC-TABLE 01 · EDITIONS-MATRIX · REQUIREMENTS.md / REQUIREMENTS-M2.md / REQUIREMENTS-M3.md</caption>
      <thead>
        <tr>
          <th>${bi('Command', '命令语法')}</th>
          <th>${bi('Admin API Endpoint', '对应管理 API')}</th>
          <th>${bi('Behavior & Source Invariant', '行为说明与源码依据')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>appctl init &lt;dir&gt; [--container|--static]</code></td>
          <td><em>${bi('Local filesystem', '本地文件系统')}</em></td>
          <td>${bi('Copies <code>templates/app</code> (isolate), adds <code>Dockerfile</code> + <code>"runtime": "container"</code> with <code>--container</code>, or copies <code>templates/static</code> with <code>--static</code>.', '拷贝 <code>templates/app</code>（默认 Isolate）；<code>--container</code> 增加 <code>Dockerfile</code> 并设 <code>container</code> 运行时；<code>--static</code> 拷贝纯静态站点模板。')} ${srcRef('cli/scaffold.ts', 'L1-L25')}</td>
        </tr>
        <tr>
          <td><code>appctl publish &lt;name&gt; &lt;dir|image&gt; [--owner &lt;subj&gt;] [--tenant &lt;t&gt;] [--registry &lt;host&gt;]</code></td>
          <td><code>POST /api/bundles</code><br><code>PUT /api/apps/&lt;name&gt;/release</code></td>
          <td>${bi('Bundles isolate/static dirs or runs <code>docker build</code> (and <code>docker push</code> by digest when <code>--registry</code> or <code>PNEUMA_SPACE_REGISTRY</code> is set). Preserves all existing volumes, databases, KV keys, and buckets (INV-6).', '打包 Isolate/静态目录或执行 <code>docker build</code>（在 K8s 平面下自动推送到 <code>PNEUMA_SPACE_REGISTRY</code> 并以 sha256 digest 发布）。保留全部既有数据 (INV-6)。')} ${srcRef('cli/appctl.ts', 'L159-L260')}</td>
        </tr>
        <tr>
          <td><code>appctl list</code> / <code>appctl show &lt;name&gt;</code></td>
          <td><code>GET /api/apps</code><br><code>GET /api/apps/&lt;name&gt;</code></td>
          <td>${bi('Shows runtime, instance state (<code>asleep/waking/awake/draining/stopping</code>), active leases, quarantine reason, bindings, releases, and last 50 trigger deliveries in &lt;100 ms with 0 Docker calls (AC-P-8).', '展示运行时、实例状态、活跃租约、隔离原因、资源绑定、历史版本与最近 50 条触发投递记录（0 Docker 调用，耗时 &lt;100 ms，AC-P-8）。')}</td>
        </tr>
        <tr>
          <td><code>appctl logs &lt;name&gt; [--tail 200]</code></td>
          <td><code>GET /api/apps/&lt;name&gt;/logs</code></td>
          <td>${bi('Streams recent stdout/stderr from the active container/worker, or from <code>instance_log</code> persisted in the platform store before a K8s Pod went to sleep (AC-K8S-13).', '获取当前实例或 K8s Pod 休眠销毁前持久化在 <code>instance_log</code> 表中的最近 200 行（64 KiB）标准输出与错误日志 (AC-K8S-13)。')}</td>
        </tr>
        <tr>
          <td><code>appctl state &lt;name&gt; [--json]</code></td>
          <td><code>GET /api/apps/&lt;name&gt;/state</code></td>
          <td>${bi('Lists every binding’s storage location (volume name, database name, Redis prefix, S3 bucket, bundle sha256) with zero credentials exposed, for storage-layer backup (AC-OPS-9).', '列出应用所有绑定的底层存储位置（卷名、数据库名、Redis 前缀、S3 桶名与 bundle 摘要），不含任何密钥凭据，供存储层备份使用 (AC-OPS-9)。')}</td>
        </tr>
        <tr>
          <td><code>appctl unquarantine &lt;name&gt;</code></td>
          <td><code>POST /api/apps/&lt;name&gt;/unquarantine</code></td>
          <td>${bi('Deletes the app’s <code>guard</code> row across all replicas so the next request wakes the app again (ADR 0017, AC-ISO-2).', '跨所有网关副本清除该应用的 <code>guard</code> 失败隔离记录，使下一次请求重新唤醒实例 (ADR 0017, AC-ISO-2)。')}</td>
        </tr>
        <tr>
          <td><code>appctl policy [&lt;name&gt;] key=value ...</code></td>
          <td><code>PUT /api/policy</code><br><code>PUT /api/apps/&lt;name&gt;/policy</code></td>
          <td>${bi('Updates global policy or per-app overrides (<code>idle_seconds</code>, <code>db_backend</code>, <code>cpu_millis</code>, <code>memory_mb</code>, <code>max_failures</code>). Pass <code>key=null</code> on an app to clear an override (AC-P-7).', '修改全局策略或单应用覆盖策略（如 <code>idle_seconds=5</code>、<code>db_backend=postgres</code>、<code>memory_mb=512</code>）。传 <code>key=null</code> 可清除单应用覆盖项 (AC-P-7)。')}</td>
        </tr>
        <tr>
          <td><code>appctl access &lt;name&gt; tenant|org|public</code><br><code>appctl owner &lt;name&gt; &lt;subject&gt;</code></td>
          <td><code>PUT /api/apps/&lt;name&gt;/access</code><br><code>PUT /api/apps/&lt;name&gt;/owner</code></td>
          <td>${bi('Sets who may reach the app (orthogonal to <code>identity</code>) or transfers ownership (<code>X-Pneuma-Space-Owner: 1</code> and member management rights, ADR 0022).', '设置谁能访问该应用（与清单中的 <code>identity</code> 正交）或转移应用所有者（决定 <code>X-Pneuma-Space-Owner: 1</code> 与普通成员的读写权，ADR 0022）。')}</td>
        </tr>
        <tr>
          <td><code>appctl remove &lt;name&gt;</code></td>
          <td><code>POST /api/apps/&lt;name&gt;/remove</code></td>
          <td>${bi('Retires any running instance and suspends every Binding (<code>ALTER ROLE NOLOGIN</code>, <code>ACL SETUSER off</code>, revokes S3 public policy &amp; disables access key). Address answers 404; all data stays (AC-P-9).', '退役运行中实例并将所有 Binding 置为 <code>suspended</code>（禁用数据库登录、关闭 Redis ACL、撤销 S3 匿名读与密钥）。应用地址返回 404，但所有数据完整保留 (AC-P-9)。')}</td>
        </tr>
        <tr>
          <td><code>appctl purge &lt;name&gt; [--yes|-y]</code></td>
          <td><code>POST /api/apps/&lt;name&gt;/purge</code></td>
          <td>${bi('Allowed <strong>only</strong> from <code>removed</code> state. Permanently destroys volumes/PVCs, drops PostgreSQL database &amp; role, unlinks Redis keys, deletes S3 objects &amp; bucket, and removes unreferenced bundles (INV-2).', '<strong>仅允许对已 <code>removed</code> 的应用执行。</strong>彻底销毁卷/PVC、删除 PostgreSQL 库与角色、清理 Redis 键、清空并删除 S3 桶及无其他应用引用的 bundle (INV-2)。')}</td>
        </tr>
        <tr>
          <td><code>appctl whoami</code> · <code>tenant</code> · <code>member</code> · <code>token</code> · <code>quota</code> · <code>audit</code></td>
          <td><code>/api/me</code> · <code>/api/tenants/*</code> · <code>/api/audit</code></td>
          <td>${bi('M2/M3 multi-tenant administration: manage tenants, memberships (<code>admin|member</code>), service/personal tokens, tenant quotas, and query the append-only audit log in TSV or JSON (AC-OPS-6).', 'M2/M3 多租户与治理命令：查看当前身份、创建租户、管理成员角色、签发/吊销令牌、调整配额，以及按租户/时间/动作查询只追加审计日志 (AC-OPS-6)。')}</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="doc-section" id="examples">
  <div class="sec-head">
    <h2>${bi('5. The 7 Official Example Apps Across All 3 Runtimes', '5. 覆盖三大运行时的七个官方示例应用')}</h2>
    <div class="chips">
      ${srcRef('examples/README.md', 'L1-L15')}
      ${srcRef('examples/publish.ts', 'L1-L95')}
      ${srcRef('REQUIREMENTS.md', 'L40-L51')}
    </div>
    <p>${bi(
      'Publish any example with node examples/publish.ts <name> --owner user:<you>. Isolate and static examples are clean business overlays assembled onto templates/app or templates/static; container examples are standalone Python and Go apps speaking the raw wire contract without an SDK.',
      '使用 node examples/publish.ts <name> --owner user:<you> 即可一键组装并发布任意示例。Isolate 与静态示例是叠加在 templates/app 或 templates/static 脚手架上的纯净业务层；容器示例则是完全不用 SDK、直接读取环境变量与请求头契约的 Python 和 Go 应用。'
    )}</p>
  </div>

  <div class="table-wrap">
    <table class="spec-table">
      <caption class="table-code-strip">SPEC-TABLE 01 · EDITIONS-MATRIX · REQUIREMENTS.md / REQUIREMENTS-M2.md / REQUIREMENTS-M3.md</caption>
      <thead>
        <tr>
          <th>${bi('Example', '示例目录')}</th>
          <th>${bi('Archetype', '应用类型')}</th>
          <th>${bi('Runtime Lane', '运行时车道')}</th>
          <th>${bi('Capabilities Declared', '声明的能力组合')}</th>
          <th>${bi('Architectural Patterns Demonstrated', '核心架构示范与代码亮点')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${srcRef('examples/survey', undefined, 'examples/survey')}</td>
          <td><code>T-FORM</code></td>
          <td><span class="chip accent">isolate</span></td>
          <td><code>files, db, cron, identity, static</code></td>
          <td>${bi('One answer per subject via portable SQL upsert (<code>ON CONFLICT DO UPDATE</code>), owner-only results view (<code>identity.owner</code>), nightly CSV export to <code>/data</code> with spreadsheet-injection-safe quoting.', '基于可移植 SQL Upsert 实现每人一份问卷、仅应用所有者可见的统计结果页，以及每日凌晨定时导出防公式注入的 CSV 报表到 <code>/data</code> 持久卷。')}</td>
        </tr>
        <tr>
          <td>${srcRef('examples/ttt', undefined, 'examples/ttt')}</td>
          <td><code>T-GAME</code></td>
          <td><span class="chip accent">isolate</span></td>
          <td><code>kv, ws, identity, static</code></td>
          <td>${bi('Real-time Tic-Tac-Toe stored in Redis KV, atomic moves via compare-and-set, one Redis pub/sub subscription per game ID fanned out to local WebSockets, graceful reconnect after release close code <code>1001</code>, AI bot player authenticating via a <code>service:</code> token.', '状态存于 Redis KV 的实时井字棋对战：CAS 原子落子、按棋局 ID 聚合 Redis Pub/Sub 扇出到本地 WebSocket、版本更新收到 <code>1001</code> 关闭码后自动重连恢复、以及通过 <code>service:</code> 服务令牌接入的对弈机器人。')}</td>
        </tr>
        <tr>
          <td>${srcRef('examples/widget', undefined, 'examples/widget')}</td>
          <td><code>T-WORKER</code> / <code>T-CRUD</code></td>
          <td><span class="chip accent">isolate</span></td>
          <td><code>db, cron, identity (optional), static</code></td>
          <td>${bi('Idempotent cron trigger upserting one row by scheduled slot so at-least-once redelivery is harmless; public <code>card.json</code> with <code>Cache-Control: max-age</code> and CORS; optional login (<code>"required": false</code>) with owner-only write controls.', '按计划时间槽位幂等 Upsert 的定时触发器（天然免疫至少一次投递的重复调用）、带缓存头与 CORS 的公开负一屏卡片 <code>card.json</code>，以及 <code>"required": false</code> 可选登录下的所有者写保护。')}</td>
        </tr>
        <tr>
          <td>${srcRef('examples/chat', undefined, 'examples/chat')}</td>
          <td><code>T-COLLAB</code></td>
          <td><span class="chip accent">isolate</span></td>
          <td><code>kv, ws, identity, static</code></td>
          <td>${bi('The minimal real-time collaborative app: Redis pub/sub + WebSocket broadcast + platform-injected identity in ~100 lines of TypeScript.', '极简实时协作应用典范：仅百余行 TypeScript 串联 Redis 发布订阅、WebSocket 广播与平台注入的真实访问者身份。')}</td>
        </tr>
        <tr>
          <td>${srcRef('examples/notes-py', undefined, 'examples/notes-py')}</td>
          <td><code>T-CRUD</code></td>
          <td><span class="chip green">container</span></td>
          <td><code>files, db, cron, identity, static</code></td>
          <td>${bi('Python container app (needs <code>container</code> because <code>psycopg</code> ships a native C library). Reads <code>PNEUMA_SPACE_*</code> and <code>X-Pneuma-Space-*</code> directly without an SDK, supports both SQLite and PostgreSQL, runs as non-root user owning <code>/data</code> and <code>/pneuma/db</code>.', 'Python 容器应用（因 <code>psycopg</code> 含原生 C 扩展而选用 container 车道）。不依赖任何平台 SDK，直接读取环境变量与请求头，同时兼容 SQLite 与 PostgreSQL，并以非 root 用户安全读写 <code>/data</code> 与 <code>/pneuma/db</code>。')}</td>
        </tr>
        <tr>
          <td>${srcRef('examples/pulse-go', undefined, 'examples/pulse-go')}</td>
          <td><code>T-COLLAB</code></td>
          <td><span class="chip green">container</span></td>
          <td><code>kv, ws, identity (optional), static</code></td>
          <td>${bi('Go compiled binary in a distroless container image: speaks Redis RESP with key prefixing and streams Server-Sent Events (<code>text/event-stream</code>) through the <code>ws</code> capability (which promotes SSE responses to a <code>channel</code> Lease).', '编译为单二进制并运行在 distroless 镜像中的 Go 容器应用：直接操作带命名空间前缀的 Redis，并通过 <code>ws</code> 能力流式推送 SSE (<code>text/event-stream</code> 自动持有 <code>channel</code> 租约防止休眠)。')}</td>
        </tr>
        <tr>
          <td>${srcRef('examples/site-docs', undefined, 'examples/site-docs')}</td>
          <td><code>T-STATIC</code></td>
          <td><span class="chip">static (none)</span></td>
          <td><code>static</code></td>
          <td>${bi('Pure static site built on <code>templates/static</code>: no container, no worker thread, first byte under 50 ms directly from <code>S3BundleStore</code> (AC-STATIC-1, AC-STATIC-2).', '基于 <code>templates/static</code> 的纯静态站点：不起任何容器或线程，由网关直接从对象存储 Bundle 桶响应，首字节耗时 &lt;50 ms (AC-STATIC-1, AC-STATIC-2)。')}</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>
`;

  return { html, toc };
}
