#!/usr/bin/env node
// Zero-dependency TypeScript static site generator for PneumaSpace Official Website & Docs Hub.
// Run directly with Node.js >= 24: node site/build.ts
// Outputs pure static HTML/CSS/JS/SVG/PNG/WOFF2 into site/dist/ for GitHub Pages (pandazki.im/pneuma-space).

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { ADR_CATALOG, renderAdrPage } from './content-adr.ts';
import { renderArchitecturePage, renderContractPage } from './content-arch.ts';
import { renderCapabilitiesPage, renderPlanesPage, renderRuntimesPage } from './content-deep.ts';
import { renderOverviewPage, renderQuickstartPage } from './content-home.ts';
import { bi, esc, ICONS, REPO_URL } from './helpers.ts';
import { STYLES } from './styles.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DIST_DIR = join(__dirname, 'dist');
const ASSETS_DIR = join(DIST_DIR, 'assets');

type PageSpec = {
  readonly slug: string;
  readonly file: string;
  readonly num: string;
  readonly group: 'overview' | 'spec' | 'deep';
  readonly titleEn: string;
  readonly titleZh: string;
  readonly descEn: string;
  readonly descZh: string;
  readonly render: () => { html: string; toc: { id: string; en: string; zh: string }[] };
};

const PAGES: readonly PageSpec[] = [
  {
    slug: 'index',
    file: 'index.html',
    num: '00',
    group: 'overview',
    titleEn: 'Overview & Blueprint Atlas',
    titleZh: '总览与交互架构蓝图',
    descEn: 'Agent-native stateful micro-app runtime: 6.9 s publish, 62–87 ms isolate wake, live topology, and interactive manifest workbench.',
    descZh: '专为 Agent 构建的有状态微应用运行时：6.9s 免构建发布、62–87ms 唤醒、动态拓扑与交互式清单工作台。',
    render: renderOverviewPage,
  },
  {
    slug: 'quickstart',
    file: 'quickstart.html',
    num: '01',
    group: 'overview',
    titleEn: 'Quickstart, CLI & Examples',
    titleZh: '快速上手、CLI 与七大示例',
    descEn: 'Run with Docker Compose, scaffold with appctl init, publish in 6.9 s, test locally without Docker, and explore 7 example apps.',
    descZh: '一条 Compose 命令启动平台，appctl 初始化与发布、本地无 Docker 直接调试，以及覆盖三大运行时的 7 个官方示例。',
    render: renderQuickstartPage,
  },
  {
    slug: 'architecture',
    file: 'architecture.html',
    num: '02',
    group: 'spec',
    titleEn: 'Architecture & 12 Invariants',
    titleZh: '顶层架构与 12 条不变量',
    descEn: 'Component ownership boundaries, single-writer entities, 4 CAS state machines, 12 source-verified invariants, and 5 built-in wire protocol clients.',
    descZh: '11 大组件职责与禁区边界、单写者领域模型、4 大状态机、12 条源码级架构不变量与 5 个内置零依赖线协议客户端。',
    render: renderArchitecturePage,
  },
  {
    slug: 'contract',
    file: 'contract.html',
    num: '03',
    group: 'spec',
    titleEn: 'App Contract & SDK',
    titleZh: '应用契约、SDK 与管理 API',
    descEn: 'Complete pneuma-space.json grammar, PNEUMA_SPACE_* env vars, X-Pneuma-Space-* headers, access vs identity, triggers, portable SQL, Admin API, and Contract 2.',
    descZh: '完整的 pneuma-space.json 文法、环境变量、转发请求头、访问范围与身份矩阵、触发器、可移植 SQL 子集、8081 管理 API 与云端契约 2。',
    render: renderContractPage,
  },
  {
    slug: 'capabilities',
    file: 'capabilities.html',
    num: '04',
    group: 'deep',
    titleEn: '10 Capabilities & Providers',
    titleZh: '十大能力与线协议供应',
    descEn: 'How ensure, inject, suspend, and destroy work over raw PostgreSQL, Redis RESP2 ACL, SigV4 S3 + Argon2id madmin, and S3BundleStore.',
    descZh: '深入剖析 10 项能力与 Provider 的 ensure/inject/suspend/destroy 幂等实现：PG 线协议建库、Redis ACL、SigV4 与 madmin 加密管理。',
    render: renderCapabilitiesPage,
  },
  {
    slug: 'runtimes',
    file: 'runtimes.html',
    num: '05',
    group: 'deep',
    titleEn: 'Runtimes, Runner & Guard',
    titleZh: '运行时车道、Runner 与 Guard',
    descEn: 'Isolate worker_threads runner, isolate-shim.ts protections, 3 s lag-compensated watchdog, DockerDriver vs PodDriver, zero-IO fast path, and AppGuard quarantine.',
    descZh: '深入剖析 Isolate worker_threads 运行时、isolate-shim 沙箱垫片、3s 防抖看门狗、Docker/Pod 驱动对比、零 IO 快路径与 AppGuard 熔断器。',
    render: renderRuntimesPage,
  },
  {
    slug: 'planes',
    file: 'planes.html',
    num: '06',
    group: 'deep',
    titleEn: 'Docker, K8s & Hosted SaaS',
    titleZh: '单机、K8s 与托管 SaaS 平面',
    descEn: 'The 4 plane seams in main.ts, multi-replica PostgreSQL advisory locks & LISTEN/NOTIFY, Kubernetes two-namespace NetworkPolicies, M3 hosted OAuth, and Caddy origin TLS.',
    descZh: '组合根 main.ts 的 4 个平面接缝、多副本 PG 咨询锁与 LISTEN/NOTIFY、K8s 双命名空间网络策略、M3 托管账户与 Caddy 源站 TLS。',
    render: renderPlanesPage,
  },
  {
    slug: 'adr',
    file: 'adr.html',
    num: '07',
    group: 'deep',
    titleEn: 'ADR Codex (0001–0037)',
    titleZh: '37 篇 ADR 架构决策全集',
    descEn: 'Complete unabridged collection of all 37 Architecture Decision Records with bilingual summaries, category filter, and implementing source code citations.',
    descZh: '收录全部 37 篇架构决策记录（ADR 0001–0037）的完整原文、中英双语摘要、分类检索与对应 TypeScript 源码实现引用。',
    render: () => renderAdrPage(REPO_ROOT),
  },
];

function buildSearchIndex() {
  const items: Array<{
    titleEn: string;
    titleZh: string;
    descEn: string;
    descZh: string;
    href: string;
    tag: string;
    src?: string;
  }> = [];

  for (const p of PAGES) {
    items.push({
      titleEn: `${p.num} · ${p.titleEn}`,
      titleZh: `${p.num} · ${p.titleZh}`,
      descEn: p.descEn,
      descZh: p.descZh,
      href: `./${p.file}`,
      tag: `PAGE ${p.num}`,
    });
  }

  for (const adr of ADR_CATALOG) {
    items.push({
      titleEn: `ADR ${adr.num}: ${adr.titleEn}`,
      titleZh: `ADR ${adr.num}：${adr.titleZh}`,
      descEn: adr.summaryEn,
      descZh: adr.summaryZh,
      href: `./adr.html#adr-${adr.num}`,
      tag: `ADR ${adr.num}`,
      src: adr.sources.map((s) => s.path).join(' '),
    });
  }

  return items;
}

const BRAND_SVG = `<svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true"><rect x=".5" y=".5" width="25" height="25" rx="7" style="fill:var(--surface);stroke:var(--line-strong)"/><circle cx="13" cy="13" r="5" stroke-width="2" style="stroke:var(--accent)"/><circle cx="13" cy="13" r="1.6" style="fill:var(--accent)"/></svg>`;

function renderPageDocument(page: PageSpec, idx: number, searchJson: string): string {
  const { html, toc } = page.render();
  const prev = idx > 0 ? PAGES[idx - 1] : null;
  const next = idx < PAGES.length - 1 ? PAGES[idx + 1] : null;

  const renderNavGroup = (group: PageSpec['group'], labelEn: string, labelZh: string) => {
    const links = PAGES.filter((p) => p.group === group).map((p) => {
      const current = p.slug === page.slug ? ' aria-current="page"' : '';
      return `<a href="./${p.file}"${current}><span class="nav-num">${p.num}</span><span>${bi(esc(p.titleEn), esc(p.titleZh))}</span></a>`;
    }).join('\n        ');
    return `<div class="nav-section">
        <div class="nav-group-label">${bi(esc(labelEn), esc(labelZh))}</div>
        ${links}
      </div>`;
  };

  const tocHtml = toc.map((t) =>
    `<li><a href="#${t.id}">${bi(esc(t.en), esc(t.zh))}</a></li>`
  ).join('\n          ');

  const footNavHtml = `<nav class="page-foot-nav" aria-label="Chapter navigation">
    ${prev
      ? `<a class="page-foot-link prev" href="./${prev.file}"><small>${bi('Previous Chapter', '上一章')} · ${prev.num}</small><b>${bi(esc(prev.titleEn), esc(prev.titleZh))}</b></a>`
      : `<a class="page-foot-link prev" href="${REPO_URL}" target="_blank" rel="noopener"><small>GitHub Repository</small><b>pandazki/pneuma-space</b></a>`}
    ${next
      ? `<a class="page-foot-link next" href="./${next.file}"><small>${bi('Next Chapter', '下一章')} · ${next.num}</small><b>${bi(esc(next.titleEn), esc(next.titleZh))}</b></a>`
      : `<a class="page-foot-link next" href="./index.html"><small>${bi('Back to Overview', '返回首页总览')} · 00</small><b>${bi('Overview & Blueprint Atlas', '总览与交互架构蓝图')}</b></a>`}
  </nav>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.titleEn)} — PneumaSpace Documentation & Architecture Atlas</title>
<meta name="description" content="${esc(page.descEn)}">
<link rel="icon" type="image/svg+xml" href="./assets/favicon.svg">
<script>
(() => {
  const root = document.documentElement;
  const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const media = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => { root.dataset.theme = stored('pneuma-space-theme') ?? (media.matches ? 'dark' : 'light'); };
  apply();
  media.addEventListener('change', apply);
  const lang = stored('pneuma-space-lang') ?? navigator.language ?? 'en';
  root.lang = lang.startsWith('zh') ? 'zh' : 'en';
})();
</script>
<link rel="stylesheet" href="./assets/style.css">
</head>
<body>
<div class="frame">
  <aside class="sidebar" aria-label="Primary Documentation Navigation">
    <div class="aside-in">
      <div class="brand-row">
        <a class="brand" href="./index.html">
          ${BRAND_SVG}
          <span><b>PneumaSpace</b><small>${bi('Architecture & Docs', '技术架构与文档站')}</small></span>
        </a>
      </div>

      <button type="button" class="search-trigger" data-open-search aria-label="Search documentation and ADRs">
        <span class="search-left">${ICONS.search}<span>${bi('Search docs & 37 ADRs…', '搜索文档、源码与 37 篇 ADR…')}</span></span>
        <kbd>⌘K</kbd>
      </button>

      <nav class="doc-nav" aria-label="Documentation Chapters">
        ${renderNavGroup('overview', 'Start & Explore', '入门与全景')}
        ${renderNavGroup('spec', 'Architecture & Contract', '顶层架构与契约')}
        ${renderNavGroup('deep', 'Subsystems, Planes & ADRs', '核心子系统与决策记录')}
      </nav>

      <div class="aside-foot">
        <div class="controls">
          <div class="seg" role="group" aria-label="Language">
            <button type="button" data-set-lang="en" aria-pressed="true">EN</button>
            <button type="button" data-set-lang="zh" aria-pressed="false">中文</button>
          </div>
          <div class="seg" role="group" aria-label="Theme">
            <button type="button" data-set-theme="light" aria-pressed="true">${ICONS.sun}<span>${bi('Light', '浅色')}</span></button>
            <button type="button" data-set-theme="dark" aria-pressed="false">${ICONS.moon}<span>${bi('Dark', '深色')}</span></button>
          </div>
        </div>
        <div class="repo-links">
          <a class="btn ghost small" href="${REPO_URL}" target="_blank" rel="noopener">${ICONS.github}<span>GitHub</span></a>
          <a class="btn ghost small" href="${REPO_URL}/blob/main/DESIGN.md" target="_blank" rel="noopener">${ICONS.file}<span>DESIGN.md</span></a>
          <a class="btn ghost small" href="${REPO_URL}/blob/main/docs/acceptance.md" target="_blank" rel="noopener">${ICONS.code}<span>Acceptance</span></a>
        </div>
      </div>
    </div>
  </aside>

  <div class="workspace">
    <main class="doc-main" id="main-content">
      ${html}
      ${footNavHtml}
    </main>

    <aside class="toc-rail" aria-label="On this page">
      <div class="toc-block">
        <p class="toc-title">${bi('On this page', '本页目录')}</p>
        <ul class="toc-list">
          ${tocHtml}
        </ul>
      </div>

      <div class="toc-block">
        <p class="toc-title">${bi('Core Source Entrypoints', '核心源码直达')}</p>
        <ul class="toc-list">
          <li><a href="${REPO_URL}/blob/main/gateway/src/main.ts" target="_blank" rel="noopener"><span class="mono">gateway/src/main.ts</span></a></li>
          <li><a href="${REPO_URL}/blob/main/gateway/src/model.ts" target="_blank" rel="noopener"><span class="mono">gateway/src/model.ts</span></a></li>
          <li><a href="${REPO_URL}/blob/main/gateway/src/registry.ts" target="_blank" rel="noopener"><span class="mono">gateway/src/registry.ts</span></a></li>
          <li><a href="${REPO_URL}/blob/main/gateway/src/ingress.ts" target="_blank" rel="noopener"><span class="mono">gateway/src/ingress.ts</span></a></li>
          <li><a href="${REPO_URL}/blob/main/gateway/src/lifecycle.ts" target="_blank" rel="noopener"><span class="mono">gateway/src/lifecycle.ts</span></a></li>
          <li><a href="${REPO_URL}/blob/main/gateway/src/runtimes.ts" target="_blank" rel="noopener"><span class="mono">gateway/src/runtimes.ts</span></a></li>
          <li><a href="${REPO_URL}/blob/main/gateway/src/runner.ts" target="_blank" rel="noopener"><span class="mono">gateway/src/runner.ts</span></a></li>
          <li><a href="${REPO_URL}/blob/main/gateway/src/providers.ts" target="_blank" rel="noopener"><span class="mono">gateway/src/providers.ts</span></a></li>
          <li><a href="${REPO_URL}/blob/main/gateway/src/pg.ts" target="_blank" rel="noopener"><span class="mono">gateway/src/pg.ts</span></a></li>
          <li><a href="${REPO_URL}/blob/main/gateway/src/kube.ts" target="_blank" rel="noopener"><span class="mono">gateway/src/kube.ts</span></a></li>
          <li><a href="${REPO_URL}/blob/main/cli/appctl.ts" target="_blank" rel="noopener"><span class="mono">cli/appctl.ts</span></a></li>
        </ul>
      </div>

      <div class="toc-block">
        <p class="toc-title">${bi('Key Invariants', '关键不变量速查')}</p>
        <div class="chips">
          <a class="chip accent" href="./architecture.html#invariants" title="Address derives only from App.name">INV-1</a>
          <a class="chip accent" href="./architecture.html#invariants" title="Only purge deletes data, only from removed">INV-2</a>
          <a class="chip accent" href="./architecture.html#invariants" title="Idle stop requires empty Lease set">INV-3</a>
          <a class="chip accent" href="./architecture.html#invariants" title="Inbound X-Pneuma-Space-* always stripped">INV-5</a>
          <a class="chip accent" href="./architecture.html#invariants" title="Object bytes never pass app or gateway">INV-10</a>
          <a class="chip accent" href="./architecture.html#invariants" title="Single instance per app via CAS on (state, epoch)">INV-11</a>
          <a class="chip accent" href="./architecture.html#invariants" title="Quotas checked under tenant row lock">INV-12</a>
        </div>
      </div>
    </aside>
  </div>
</div>

<!-- Global Search Modal (Cmd+K) -->
<div class="search-backdrop" id="global-search-modal" hidden role="dialog" aria-modal="true" aria-label="Search Documentation and ADRs">
  <div class="search-dialog">
    <div class="search-head">
      ${ICONS.search}
      <input type="search" id="global-search-input" placeholder="Search chapters, capabilities, invariants, source files (e.g. pg.ts, isolate, ADR 0020)..." autocomplete="off">
      <button type="button" class="btn ghost small" data-close-search>ESC</button>
    </div>
    <div class="search-results" id="global-search-results"></div>
  </div>
</div>

<script>window.__PNEUMA_SEARCH_INDEX = ${searchJson};</script>
<script src="./assets/app.js"></script>
</body>
</html>`;
}

function build() {
  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(ASSETS_DIR, { recursive: true });
  mkdirSync(join(ASSETS_DIR, 'console'), { recursive: true });
  mkdirSync(join(ASSETS_DIR, 'fonts'), { recursive: true });

  // 1. Copy animated SVGs and console screenshots from docs/assets/
  const svgFiles = ['hero-light.svg', 'hero-dark.svg', 'lanes-light.svg', 'lanes-dark.svg', 'graph-light.svg', 'graph-dark.svg'];
  for (const svg of svgFiles) {
    cpSync(join(REPO_ROOT, 'docs', 'assets', svg), join(ASSETS_DIR, svg));
  }
  const consoleShots = [
    'overview-light.png', 'overview-dark.png',
    'realtime-light.png', 'realtime-dark.png',
    'lanes-light.png', 'lanes-dark.png',
    'graph-light.png', 'graph-dark.png',
    'cluster-light.png', 'cluster-dark.png',
  ];
  for (const shot of consoleShots) {
    const raw = readFileSync(join(REPO_ROOT, 'docs', 'assets', 'console', shot));
    const payload = Buffer.from(`impeccable:prompt\0Pre-existing PneumaSpace live console (:8081) screenshot (${shot}) from docs/assets/console/ in repository pandazki/pneuma-space`, 'utf8');
    const typeAndData = Buffer.concat([Buffer.from('tEXt', 'ascii'), payload]);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(payload.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
    const chunk = Buffer.concat([lenBuf, typeAndData, crcBuf]);
    const iendOffset = raw.length - 12;
    const withProvenance = Buffer.concat([raw.subarray(0, iendOffset), chunk, raw.subarray(iendOffset)]);
    writeFileSync(join(ASSETS_DIR, 'console', shot), withProvenance);
  }

  // 2. Copy self-hosted WOFF2 fonts
  const fontSrcDir = join(__dirname, 'assets', 'fonts');
  if (existsSync(fontSrcDir)) {
    cpSync(fontSrcDir, join(ASSETS_DIR, 'fonts'), { recursive: true });
  }

  // 3. Write favicon, stylesheet, and client JS
  const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 26 26" fill="none"><rect x=".5" y=".5" width="25" height="25" rx="7" fill="#181920" stroke="#363945"/><circle cx="13" cy="13" r="5" stroke-width="2.2" stroke="#3b82f6"/><circle cx="13" cy="13" r="1.8" fill="#3b82f6"/></svg>`;
  writeFileSync(join(ASSETS_DIR, 'favicon.svg'), faviconSvg);
  writeFileSync(join(ASSETS_DIR, 'style.css'), STYLES);
  writeFileSync(join(ASSETS_DIR, 'app.js'), readFileSync(join(__dirname, 'client.js'), 'utf8'));

  // 4. Build search index and render all 8 pages + 404.html + .nojekyll
  const searchJson = JSON.stringify(buildSearchIndex());
  for (const [idx, page] of PAGES.entries()) {
    const html = renderPageDocument(page, idx, searchJson);
    writeFileSync(join(DIST_DIR, page.file), html);
  }
  // 404.html renders the Overview page so any unknown sub-route on GitHub Pages gracefully lands on the shell
  writeFileSync(join(DIST_DIR, '404.html'), renderPageDocument(PAGES[0], 0, searchJson));
  writeFileSync(join(DIST_DIR, '.nojekyll'), '');

  console.log(`Built ${PAGES.length} pages + 37 ADRs into ${DIST_DIR}`);
}

build();
