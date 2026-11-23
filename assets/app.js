// Client interactivity for PneumaSpace Official Website & Technical Documentation Hub.
// Handles theme/lang switches, Blueprint Atlas tabs, Interactive Manifest & SDK Workbench,
// 9-Step Request & CAS Lifecycle Simulator, Cmd+K global search, and ADR filtering.

(() => {
  const root = document.documentElement;
  const storeSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  // 1. Theme & Language Synchronization
  const syncControls = () => {
    const theme = root.dataset.theme || 'light';
    const lang = root.lang === 'zh' ? 'zh' : 'en';
    document.querySelectorAll('[data-set-theme]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-set-theme') === theme));
    });
    document.querySelectorAll('[data-set-lang]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-set-lang') === lang));
    });
  };

  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const themeBtn = target.closest('[data-set-theme]');
    if (themeBtn) {
      const next = themeBtn.getAttribute('data-set-theme');
      if (next === 'light' || next === 'dark') {
        root.dataset.theme = next;
        storeSet('pneuma-space-theme', next);
        syncControls();
      }
      return;
    }

    const langBtn = target.closest('[data-set-lang]');
    if (langBtn) {
      const next = langBtn.getAttribute('data-set-lang');
      if (next === 'en' || next === 'zh') {
        root.lang = next;
        storeSet('pneuma-space-lang', next);
        syncControls();
        if (typeof window.__pneumaUpdateSim === 'function') window.__pneumaUpdateSim();
        if (typeof window.__pneumaUpdateWb === 'function') window.__pneumaUpdateWb();
      }
      return;
    }

    // Copy code button
    const copyBtn = target.closest('[data-copy-target]');
    if (copyBtn) {
      const sel = copyBtn.getAttribute('data-copy-target');
      const pre = sel ? document.querySelector(sel) : copyBtn.closest('.code-plate')?.querySelector('pre');
      if (pre && navigator.clipboard) {
        navigator.clipboard.writeText(pre.textContent || '').then(() => {
          const label = copyBtn.querySelector('.copy-label');
          if (label) {
            const old = label.textContent;
            label.textContent = root.lang === 'zh' ? '已复制' : 'Copied';
            setTimeout(() => { label.textContent = old; }, 1400);
          }
        });
      }
      return;
    }

    // Blueprint Atlas tabs
    const atlasTab = target.closest('[data-atlas-tab]');
    if (atlasTab) {
      const tab = atlasTab.getAttribute('data-atlas-tab');
      document.querySelectorAll('[data-atlas-tab]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-atlas-tab') === tab));
      });
      document.querySelectorAll('[data-atlas-pane]').forEach((p) => {
        if (p.getAttribute('data-atlas-pane') === tab) p.removeAttribute('hidden');
        else p.setAttribute('hidden', '');
      });
      return;
    }

    // Console Screenshot Sub-tabs inside Atlas
    const shotTab = target.closest('[data-shot-tab]');
    if (shotTab) {
      const shot = shotTab.getAttribute('data-shot-tab');
      document.querySelectorAll('[data-shot-tab]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-shot-tab') === shot));
      });
      document.querySelectorAll('[data-shot-pane]').forEach((p) => {
        if (p.getAttribute('data-shot-pane') === shot) p.removeAttribute('hidden');
        else p.setAttribute('hidden', '');
      });
      return;
    }
  });

  syncControls();

  // 2. Interactive Manifest & Starter Code Workbench (on Overview)
  const wbRoot = document.getElementById('manifest-workbench');
  if (wbRoot) {
    const state = {
      runtime: 'isolate',
      dbBackend: 'sqlite',
      caps: new Set(['files', 'db', 'cron', 'identity', 'static']),
      activeTab: 'manifest',
      preset: 'survey',
    };

    const PRESETS = {
      survey:     { runtime: 'isolate',   db: 'sqlite',   caps: ['files', 'db', 'cron', 'identity', 'static'] },
      ttt:        { runtime: 'isolate',   db: 'sqlite',   caps: ['kv', 'ws', 'identity', 'static'] },
      widget:     { runtime: 'isolate',   db: 'sqlite',   caps: ['db', 'cron', 'identity', 'static'] },
      chat:       { runtime: 'isolate',   db: 'sqlite',   caps: ['kv', 'ws', 'identity', 'static'] },
      'notes-py': { runtime: 'container', db: 'postgres', caps: ['files', 'db', 'cron', 'identity', 'static'] },
      'pulse-go': { runtime: 'container', db: 'sqlite',   caps: ['kv', 'ws', 'identity', 'static'] },
      'site-docs':{ runtime: 'static',    db: 'sqlite',   caps: ['static'] },
    };

    const CAP_INFO = {
      files: {
        decl: {},
        env: ['PNEUMA_SPACE_FILES_DIR=/data  (isolate: /data/apps/<id>/storage/pneuma-space-files-<id>)'],
        provider: 'StorageProvider ("volume") — gateway/src/providers.ts:L103-L138',
        ops: 'ensure: records pneuma-space-files-<id> · inject: mounts /data · destroy: Runtime.destroyStorage',
      },
      db: {
        decl: {},
        env: ['PNEUMA_SPACE_DB_URL=sqlite:///pneuma/db/app.sqlite3  (or postgresql://app_<id>:<pw>@postgres:5432/app_<id>)'],
        provider: 'StorageProvider ("sqlite") / PostgresProvider ("postgres") — gateway/src/providers.ts:L140-L199',
        ops: 'ensure: CREATE ROLE & DATABASE + REVOKE CONNECT FROM PUBLIC over pg.ts wire protocol · suspend: ALTER ROLE NOLOGIN · destroy: DROP DATABASE WITH (FORCE)',
      },
      kv: {
        decl: {},
        env: ['PNEUMA_SPACE_KV_URL=redis://app_<id>:<pw>@redis:6379', 'PNEUMA_SPACE_KV_PREFIX=<id>:'],
        provider: 'RedisProvider ("redis") — gateway/src/providers.ts:L206-L251',
        ops: 'ensure: ACL SETUSER app_<id> on ~<id>:* &<id>:* +@all -@admin -@dangerous over resp.ts · suspend: ACL SETUSER off · destroy: Lua SCAN+UNLINK & ACL DELUSER',
      },
      object: {
        decl: {},
        env: [
          'PNEUMA_SPACE_OBJECT_ENDPOINT=http://rustfs:9000',
          'PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT=http://127.0.0.1:9000',
          'PNEUMA_SPACE_OBJECT_BUCKET=app-<id>',
          'PNEUMA_SPACE_OBJECT_ACCESS_KEY=app-<id>',
          'PNEUMA_SPACE_OBJECT_SECRET_KEY=<24-byte-hex>',
        ],
        provider: 'S3Provider ("s3") — gateway/src/providers.ts:L253-L313',
        ops: 'ensure: SigV4 PUT bucket + Argon2id/AES-256-GCM madmin add-user + public/* policy + CORS · suspend: delete public policy & disable user · destroy: delete objects, bucket, user & policy',
      },
      static: {
        decl: { dir: 'public' },
        env: ['(None — served directly by Ingress & S3BundleStore without waking the instance)'],
        provider: 'Ingress + S3BundleStore — gateway/src/ingress.ts:L315-L321, gateway/src/providers.ts:L394-L459',
        ops: 'put: sha256(tar) into pneuma-space-bundles/<sha256>/ · serveStatic: ETag, 304 Not Modified, Range 206 Partial Content with 0 ms cold start',
      },
      ws: {
        decl: {},
        env: ['(None — upgrades pass through Ingress.tunnel and promote Lease to "channel")'],
        provider: 'Ingress + Proxy.tunnel — gateway/src/ingress.ts:L322, L407-L444',
        ops: 'Undeclared ws answers 426 Upgrade Required · 101 Switching Protocols holds channel Lease · retire sends WebSocket close 1001',
      },
      cron: {
        decl: { triggers: { 'nightly-export': { schedule: '0 3 * * *' }, 'on-demand-sync': {} } },
        env: ['(None — platform calls POST /_pneuma-space/trigger/<name> with X-Pneuma-Space-Delivery header)'],
        provider: 'DeliveryScheduler — gateway/src/scheduler.ts:L33-L120',
        ops: 'Materializes 5-field cron slots in policy.timezone · acquires TRIGGER lease · retries 5x with backoff · leader reclaims dead replica claims every 5 s (ADR 0029)',
      },
      identity: {
        decl: { required: true },
        env: ['(Injected per request as HTTP headers after stripping inbound X-Pneuma-Space-*)'],
        provider: 'LocalIdentity / UpstreamIdentity / HostedIdentity — gateway/src/identity.ts, gateway/src/jwt.ts',
        ops: 'Strips forged headers & upstream cookies (INV-5) · injects X-Pneuma-Space-Subject, X-Pneuma-Space-Name, and X-Pneuma-Space-Owner: 1',
      },
      rtc: {
        decl: {},
        env: [
          'PNEUMA_SPACE_RTC_STUN_URLS=stun:127.0.0.1:3478',
          'PNEUMA_SPACE_RTC_TURN_URLS=turn:127.0.0.1:3478?transport=udp',
          'PNEUMA_SPACE_RTC_TURN_SECRET=<HMAC-secret>',
        ],
        provider: 'CoturnProvider ("coturn") — gateway/src/providers.ts:L315-L351',
        ops: 'ensure: probes coturn:3478 on platform network (ADR 0030; 409 if --profile rtc is off) · SDK mints time-limited HMAC-SHA1 TURN credentials',
      },
    };

    const renderWb = () => {
      const isZh = root.lang === 'zh';
      const needsRt = [...state.caps].some((c) => c !== 'static');
      if (!needsRt && state.caps.has('static')) state.runtime = 'static';
      else if (state.runtime === 'static' && needsRt) state.runtime = 'isolate';

      wbRoot.querySelectorAll('[data-wb-preset]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-wb-preset') === state.preset));
      });
      wbRoot.querySelectorAll('[data-wb-runtime]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-wb-runtime') === state.runtime));
      });
      wbRoot.querySelectorAll('[data-wb-cap]').forEach((b) => {
        const cap = b.getAttribute('data-wb-cap');
        b.setAttribute('aria-pressed', String(cap ? state.caps.has(cap) : false));
      });
      wbRoot.querySelectorAll('[data-wb-tab]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-wb-tab') === state.activeTab));
      });

      const manifestObj = { contract: 1 };
      if (state.runtime === 'isolate') manifestObj.runtime = 'isolate';
      else if (state.runtime === 'container') manifestObj.runtime = 'container';
      manifestObj.capabilities = {};
      for (const k of ['files', 'db', 'kv', 'object', 'static', 'ws', 'cron', 'identity', 'rtc']) {
        if (state.caps.has(k)) manifestObj.capabilities[k] = CAP_INFO[k].decl;
      }

      let codeText = '';
      if (state.runtime === 'static') {
        codeText = [
          '<!-- public/index.html (Static lane: no process, 0 ms wake, served by S3BundleStore) -->',
          '<!doctype html>',
          '<html lang="en">',
          '<head><meta charset="utf-8"><title>Static Site on PneumaSpace</title></head>',
          '<body>',
          '  <h1>Served directly from pneuma-space-bundles/&lt;sha256&gt;/</h1>',
          '  <p>Supports ETag, 304 Not Modified, and HTTP Range requests without runtime.acquire().</p>',
          '</body>',
          '</html>',
        ].join('\n');
      } else {
        const imports = ["import { serve } from '../sdk/serve.ts';"];
        if (state.caps.has('files')) imports.push("import { need } from '../sdk/env.ts';");
        if (state.caps.has('db')) imports.push("import { db } from '../sdk/db.ts';");
        if (state.caps.has('kv')) imports.push("import { kv } from '../sdk/kv.ts';");
        if (state.caps.has('object')) imports.push("import { objects } from '../sdk/objects.ts';");
        if (state.caps.has('ws')) imports.push("import { ws } from '../sdk/ws.ts';");
        if (state.caps.has('rtc')) imports.push("import { iceServers } from '../sdk/rtc.ts';");

        const bodyLines = [];
        if (state.caps.has('db')) {
          bodyLines.push('// Portable SQL subset: works identically on SQLite and PostgreSQL (INV-8)');
          bodyLines.push('const database = db();');
          bodyLines.push("await database.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, owner TEXT, created_at TEXT)');");
        }
        if (state.caps.has('kv')) {
          bodyLines.push('// Scoped Redis client: every key & pub/sub channel auto-prefixed with PNEUMA_SPACE_KV_PREFIX');
          bodyLines.push('const store = await kv();');
        }
        if (state.caps.has('files')) {
          bodyLines.push('// Persistent directory surviving sleep & new releases (/data)');
          bodyLines.push("const filesDir = need('files').dir;");
        }
        if (state.caps.has('object')) {
          bodyLines.push('// Direct browser-to-S3 transfer via presigned URLs (INV-10: 0 bytes through app/gateway)');
          bodyLines.push('const bucket = objects();');
        }

        const triggerLines = state.caps.has('cron')
          ? [
              '}, {',
              '  triggers: {',
              "    'nightly-export': async (delivery) => {",
              '      // Idempotent by delivery.id (X-Pneuma-Space-Delivery); retries up to 5x on error',
              "      console.log('trigger delivery', delivery.id, 'attempt', delivery.attempt);",
              '    },',
              "    'on-demand-sync': async (delivery) => {",
              "      console.log('on-demand caller', delivery.subject);",
              '    }',
              '  }',
              '});',
            ]
          : ['});'];

        codeText = [
          ...imports,
          '',
          ...bodyLines,
          bodyLines.length ? '' : null,
          'const server = serve(async ({ req, res, url, prefix, identity }) => {',
          state.caps.has('rtc')
            ? "  if (url.pathname === '/ice' && identity) {\n    res.writeHead(200, { 'content-type': 'application/json' });\n    return void res.end(JSON.stringify(iceServers(identity.subject, 3600)));\n  }"
            : null,
          state.caps.has('object')
            ? "  if (url.pathname === '/upload-url' && req.method === 'POST') {\n    const putUrl = bucket.presignPut('items/asset.bin', { contentType: 'application/octet-stream', expiresSeconds: 600 });\n    res.writeHead(200, { 'content-type': 'application/json' });\n    return void res.end(JSON.stringify({ putUrl }));\n  }"
            : null,
          "  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });",
          '  res.end(JSON.stringify({',
          '    app: process.env.PNEUMA_SPACE_APP,',
          '    release: Number(process.env.PNEUMA_SPACE_RELEASE),',
          '    prefix,',
          '    viewer: identity ? { subject: identity.subject, name: identity.name, owner: identity.owner } : null,',
          '  }, null, 2));',
          ...triggerLines,
          state.caps.has('ws')
            ? "\n// WebSocket upgrade keeps instance awake via 'channel' Lease; closes with 1001 on new release\nws(server, (socket) => {\n  socket.onmessage = (msg) => socket.send(JSON.stringify({ echo: msg, by: socket.identity?.subject }));\n});"
            : null,
        ].filter((x) => x !== null).join('\n');
      }

      const envLines = [
        '# Always injected by Runtime (gateway/src/model.ts:L52)',
        'PNEUMA_SPACE_APP=myapp',
        'PNEUMA_SPACE_RELEASE=1',
        state.runtime === 'container' ? 'PNEUMA_SPACE_PORT=8000' : 'PNEUMA_SPACE_PORT=<allocated-ephemeral-port-32768..60999>',
        '',
        '# Capability-specific bindings (gateway/src/model.ts:L38-L49)',
      ];
      for (const k of state.caps) {
        envLines.push('# [' + k + ']');
        for (const line of CAP_INFO[k].env) envLines.push(line);
      }
      envLines.push(
        '',
        '# Forwarded HTTP Headers (gateway/src/ingress.ts:L86-L106 — inbound X-Pneuma-Space-* always stripped)',
        'X-Forwarded-Prefix: /apps/myapp   # (empty string in subdomain mode https://myapp.<apps-domain>/)',
      );
      if (state.caps.has('identity')) {
        envLines.push(
          'X-Pneuma-Space-Subject: user:alice   # (or service:ci when called with Bearer token)',
          'X-Pneuma-Space-Name: Alice',
          'X-Pneuma-Space-Owner: 1              # (present only when Subject === App.owner)',
        );
      }

      const profiles = [];
      if (state.runtime === 'isolate') profiles.push('--profile isolate');
      if (state.caps.has('rtc')) profiles.push('--profile rtc');
      const composeCmd = ('docker compose ' + profiles.join(' ') + ' up -d').replace(/\s+/g, ' ');
      const initFlag = state.runtime === 'container' ? ' --container' : state.runtime === 'static' ? ' --static' : '';
      const opsLines = [
        '# 1. Start platform stack with required profiles',
        composeCmd,
        '',
        '# 2. Scaffold & publish (' + (state.runtime === 'isolate' ? 'bundle upload, 0 Docker image build, ~6.9 s' : state.runtime === 'container' ? 'docker build & image ID / registry digest' : 'static tar bundle upload, no runtime process') + ')',
        'node cli/appctl.ts init myapp' + initFlag,
        'node cli/appctl.ts publish myapp ./myapp --owner user:alice',
        '',
        '# 3. Provider lifecycle executed by Registry.publish (gateway/src/registry.ts:L210-L290):',
      ];
      for (const k of state.caps) {
        opsLines.push('• [' + k + '] ' + CAP_INFO[k].provider);
        opsLines.push('  └─ ' + CAP_INFO[k].ops);
      }

      const preEl = document.getElementById('wb-code-pre');
      const titleEl = document.getElementById('wb-file-label');
      if (preEl && titleEl) {
        if (state.activeTab === 'manifest') {
          titleEl.textContent = 'pneuma-space.json — validated by parseManifest() in gateway/src/model.ts:L86';
          preEl.textContent = JSON.stringify(manifestObj, null, 2);
        } else if (state.activeTab === 'code') {
          titleEl.textContent = state.runtime === 'static' ? 'public/index.html' : 'src/server.ts — templates/app/sdk/*';
          preEl.textContent = codeText;
        } else if (state.activeTab === 'env') {
          titleEl.textContent = isZh ? '注入的环境变量与请求头 (ENV_BY_KIND & forwardedHeaders)' : 'Injected Environment & Forwarded Headers (ENV_BY_KIND & forwardedHeaders)';
          preEl.textContent = envLines.join('\n');
        } else {
          titleEl.textContent = isZh ? '底层 Provider 线协议动作与 CLI 命令' : 'Under-the-Hood Provider Wire Actions & CLI Commands';
          preEl.textContent = opsLines.join('\n');
        }
      }
    };

    wbRoot.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      const presetBtn = target.closest('[data-wb-preset]');
      if (presetBtn) {
        const p = presetBtn.getAttribute('data-wb-preset');
        if (p && PRESETS[p]) {
          state.preset = p;
          state.runtime = PRESETS[p].runtime;
          state.caps = new Set(PRESETS[p].caps);
          renderWb();
        }
        return;
      }

      const rtBtn = target.closest('[data-wb-runtime]');
      if (rtBtn) {
        const rt = rtBtn.getAttribute('data-wb-runtime');
        if (rt) {
          state.preset = '';
          state.runtime = rt;
          if (rt === 'static') state.caps = new Set(['static']);
          else if (state.caps.size === 1 && state.caps.has('static')) state.caps.add('db');
          renderWb();
        }
        return;
      }

      const capBtn = target.closest('[data-wb-cap]');
      if (capBtn) {
        const cap = capBtn.getAttribute('data-wb-cap');
        if (cap) {
          state.preset = '';
          if (state.caps.has(cap)) {
            if (state.caps.size > 1) state.caps.delete(cap);
          } else {
            state.caps.add(cap);
          }
          renderWb();
        }
        return;
      }

      const tabBtn = target.closest('[data-wb-tab]');
      if (tabBtn) {
        const tab = tabBtn.getAttribute('data-wb-tab');
        if (tab) {
          state.activeTab = tab;
          renderWb();
        }
      }
    });

    window.__pneumaUpdateWb = renderWb;
    renderWb();
  }

  // 3. Interactive 9-Step Request & CAS Lifecycle Simulator
  const simRoot = document.getElementById('lifecycle-simulator');
  if (simRoot) {
    let currentScenario = 'isolate-wake';
    let currentStep = 0;

    const SCENARIOS = {
      'isolate-wake': {
        steps: [
          {
            name: '1. Locate',
            state: 'asleep',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'INV-1',
            src: 'gateway/src/ingress.ts:L251-L270',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/ingress.ts#L251-L270',
            en: 'Ingress.#locate extracts the app name from Host (<name>.<apps-domain>) in subdomain mode or /apps/<name>/<rest> in path mode (308 if trailing slash is missing). Release numbers, container IDs, nodes, and tenants never appear in URLs.',
            zh: 'Ingress.#locate 在子域名模式下从 Host 提取 <name>.<apps-domain>，在路径模式下解析 /apps/<name>/<rest>（缺尾斜杠返回 308）。版本号、容器名、节点与租户绝不出现在 URL 中。',
            code: [
              '// gateway/src/ingress.ts:L251-L270',
              '#locate(req: IncomingMessage, pathname: string, search: string) {',
              "  if (addressing.mode === 'subdomain') {",
              '    const label = hostLabel(addressing.domain, req.headers.host);',
              '    const view = label ? this.#view(label) : null;',
              "    if (!view) return reply(404, 'no app at this address');",
              '    return { view, rest: pathname };',
              '  }',
              '  const match = /^\\/apps\\/([^/]+)(\\/.*)?$/.exec(pathname);',
              '  const view = match && this.#view(match[1]);',
              "  if (!match || !view) return reply(404, 'no app at this address');",
              '  if (match[2] === undefined)',
              '    return reply(308, undefined, { location: `${APPS_PATH}/${view.name}/` });',
              '  return { view, rest: match[2] };',
              '}',
            ].join('\n'),
          },
          {
            name: '2. Strip Headers',
            state: 'asleep',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'INV-5',
            src: 'gateway/src/ingress.ts:L86-L106',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/ingress.ts#L86-L106',
            en: 'forwardedHeaders() drops every inbound X-Pneuma-Space-* header (including CGI underscore variants like X_Pneuma_Space_Subject), Bearer tokens, upstream JWT headers, and platform session cookies so an app never receives a replayable credential.',
            zh: 'forwardedHeaders() 剥离所有入站 X-Pneuma-Space-* 请求头（含 CGI 下划线变体 X_Pneuma_Space_Subject）、Bearer 令牌、上游 JWT 头与平台会话 Cookie，确保应用绝不会拿到可在控制台重放的凭据。',
            code: [
              '// gateway/src/ingress.ts:L86-L100',
              'for (let i = 0; i < raw.length; i += 2) {',
              "  const name = raw[i].toLowerCase().replaceAll('_', '-');",
              '  let value = raw[i + 1];',
              "  if (name === 'authorization' && /^Bearer\\s/i.test(value)) continue;",
              '  if (name.startsWith(RESERVED_HEADER_PREFIX) || name === HEADERS.prefix) continue;',
              '  if (upstream && raw[i].toLowerCase() === upstream.header && carriesJwt(value)) continue;',
              "  if (upstream && name === 'cookie' && (value = withoutCookies(value, upstream.stripCookies)) === '') continue;",
              '  out.push(raw[i], value);',
              '}',
            ].join('\n'),
          },
          {
            name: '3. RouteView',
            state: 'asleep',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'INV-7',
            src: 'gateway/src/registry.ts:L156-L175',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/registry.ts#L156-L175',
            en: 'Ingress reads the immutable in-memory RouteView snapshot held by PlatformRegistry (0 database queries, 0 Docker/K8s calls on the request path). Policy overrides merge on read with the global Policy snapshot.',
            zh: 'Ingress 从 PlatformRegistry 读取内存中的只读 RouteView 快照（请求热路径上 0 数据库查询、0 Docker/K8s 调用）。应用级 Policy override 在读取时与全局 Policy 即时合并。',
            code: [
              '// gateway/src/model.ts:L231-L234',
              'export function effectivePolicy(global: Policy, override: PolicyOverride): Policy {',
              '  const set = Object.entries(override).filter(([, value]) => value !== undefined);',
              '  return { ...global, ...Object.fromEntries(set) };',
              '}',
            ].join('\n'),
          },
          {
            name: '4. Access & Auth',
            state: 'asleep',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'INV-5',
            src: 'gateway/src/ingress.ts:L273-L285',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/ingress.ts#L273-L285',
            en: 'Ingress.#admit checks the app access scope (tenant | org | public) and authenticates at most once per request. When identity is declared, Principal is encoded into X-Pneuma-Space-Subject, X-Pneuma-Space-Name, and X-Pneuma-Space-Owner: 1.',
            zh: 'Ingress.#admit 检查应用的 access 范围（tenant | org | public），每个请求至多认证一次。若声明了 identity，网关将 Principal 编码注入为 X-Pneuma-Space-Subject、X-Pneuma-Space-Name 与 X-Pneuma-Space-Owner: 1。',
            code: [
              '// gateway/src/ingress.ts:L101-L105',
              'out.push(HEADERS.prefix, prefix);',
              'if (who) {',
              '  out.push(HEADERS.subject, who.subject, HEADERS.name, encodeName(who.name));',
              "  if (who.subject === view.owner) out.push(HEADERS.owner, '1');",
              '}',
            ].join('\n'),
          },
          {
            name: '5. Static Bypass',
            state: 'asleep',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'INV-10',
            src: 'gateway/src/ingress.ts:L315-L321',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/ingress.ts#L315-L321',
            en: 'Before waking any compute, Ingress checks the release BundleIndex. If the path matches a static asset (e.g. /ui.css), serveStatic streams it directly from S3BundleStore with ETag and Range support while the app stays asleep! For a dynamic API path, execution continues to step 6.',
            zh: '在唤醒任何计算实例前，Ingress 先查 BundleIndex。若命中静态文件（如 /ui.css），serveStatic 直接从对象存储流式返回（支持 ETag、304 与 Range），应用继续保持休眠！若是动态路径，则进入第 6 步唤醒。',
            code: [
              '// gateway/src/ingress.ts:L315-L321',
              "if (!upgrade && view.bundle && (req.method === 'GET' || req.method === 'HEAD')) {",
              '  const path = staticPath(view.bundle, rest, view.staticRoot);',
              '  if (path !== null) {',
              "    trace.kind = 'static';",
              "    return { to: 'static', view, path, shared: ... };",
              '  }',
              '}',
            ].join('\n'),
          },
          {
            name: '6. CAS & Guard',
            state: 'waking',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'INV-11 · INV-12',
            src: 'gateway/src/runtimes.ts:L199-L219',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/runtimes.ts#L199-L219',
            en: 'Lifecycle.#wake performs a conditional update (CAS) on the instance row: asleep → waking (incrementing epoch). Inside the same SERIALIZABLE transaction, AppGuard.admit checks quarantine, restart_backoff_seconds, and tenant quota under the tenant row lock.',
            zh: 'Lifecycle.#wake 对 instance 表执行带 (state, epoch) 的条件更新（CAS）：asleep → waking（epoch 加 1），成为全集群唯一唤醒者。在同一事务内，AppGuard.admit 在租户行锁下完成隔离检查、退避检查与配额准入。',
            code: [
              '// gateway/src/runtimes.ts:L206-L219',
              'async #refusal(tx: StoreOps, spec: RunSpec): Promise<Quarantined | Backoff | QuotaExceeded | null> {',
              "  const record = await tx.guard(spec.app, 'update');",
              '  if (record?.quarantinedAt !== null) return new Quarantined(...);',
              '  const wait = record.failures.at(-1)! + spec.policy.restart_backoff_seconds * 1000 - this.#now();',
              '  if (wait > 0) return new Backoff(Math.ceil(wait / 1000));',
              "  const tenant = await tx.tenant(spec.tenant, 'update');",
              '  const refusal = admits(tenant.quota, await tx.quotaUsed(spec.tenant), { awake: 1, ... });',
              '  return refusal && new QuotaExceeded(spec.tenant, refusal);',
              '}',
            ].join('\n'),
          },
          {
            name: '7. Driver Start',
            state: 'waking',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'INV-9',
            src: 'gateway/src/isolate.ts:L207-L245',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/isolate.ts#L207-L245',
            en: 'IsolateDriver sends POST /instances/<app> to the app home runner with a presigned tar URL and Injection env/storage. The runner unpacks the bundle (if new) and spawns a worker_threads Worker with isolate-shim.ts and memory resourceLimits in 62–87 ms.',
            zh: 'IsolateDriver 向该应用的 home runner 发送 POST /instances/<app>（携带预签名代码包 URL 与 Injection 环境变量/持久目录）。runner 解包并启动带 isolate-shim.ts 与内存上限的 worker_threads 线程，热唤醒仅需 62–87 ms。',
            code: [
              '// gateway/src/isolate.ts:L214-L223',
              'const request: StartRequest = {',
              '  release: spec.release,',
              '  spec: specHash(spec),',
              '  bundleUrl: this.#bundleUrl(spec.runtime.bundle),',
              '  entry: spec.runtime.entry,',
              '  env: { ...spec.injection.env, [RUNTIME_ENV.app]: spec.name, [RUNTIME_ENV.release]: String(spec.release) },',
              '  storage: spec.injection.storage.map(({ id, env }) => ({ id, env })),',
              '  heapMb: spec.policy.memory_mb,',
              '  readyMs,',
              '};',
            ].join('\n'),
          },
          {
            name: '8. Lease & Stream',
            state: 'awake',
            lease: 'request: 1 · channel: 0 · trigger: 0',
            inv: 'INV-3',
            src: 'gateway/src/lifecycle.ts:L161-L171',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/lifecycle.ts#L161-L171',
            en: 'Once listening, CAS transitions waking → awake and commits the replica lease_tally (>0). Subsequent warm requests on that replica take the zero-IO fast path (#covered). Proxy.forward streams 64 KiB chunks bidirectionally; if the response is text/event-stream or 101 WebSocket, the Lease upgrades to channel.',
            zh: '端口就绪后，CAS 将状态置为 waking → awake 并提交本副本的 lease_tally (>0)。同副本后续热请求直接走零 IO 快路径（#covered）。Proxy.forward 以 64 KiB 块双向流式转发；若是 SSE 或 WebSocket 101，Lease 自动升级为 channel。',
            code: [
              '// gateway/src/lifecycle.ts:L161-L164',
              "if (row?.runtime === this.kind && row.state === 'awake' && local.ended !== row.epoch) {",
              '  if (this.#driver.serves && !this.#driver.serves(row.handle as H, row.address!))',
              '    throw new Unavailable(this.kind, `the instance at ${row.address} is gone; retry`);',
              '  if (this.#covered(local, row.epoch)) return this.#lease(local, row, kind);',
              '}',
            ].join('\n'),
          },
          {
            name: '9. Idle Sleep',
            state: 'asleep',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'INV-3 · INV-6',
            src: 'gateway/src/runner.ts:L150-L154',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/runner.ts#L150-L154',
            en: 'When the response finishes, runtime.release(lease) decrements the tally and records sleepsAt = lastReleaseAt + idle_seconds (default 60s). When idle_seconds elapses with 0 leases across all replicas, the leader reaper CAS-transitions awake → stopping → asleep. Compute vanishes; /data, DB, KV, and S3 objects stay intact.',
            zh: '响应最后一个字节写完后，runtime.release(lease) 归还租约并记录 sleepsAt = lastReleaseAt + idle_seconds（默认 60s）。当所有副本 Lease 归零且满闲置时间，reaper 通过 CAS 执行 awake → stopping → asleep。计算完全回收，而 /data、数据库、KV 与对象存储持久保留。',
            code: [
              '// gateway/src/runner.ts:L150-L154',
              'async function stop(inst: Instance, drainMs: number): Promise<void> {',
              '  inst.stopping = true;',
              "  inst.thread.postMessage({ type: 'drain' });",
              '  if (!(await Promise.race([inst.exited.then(() => true), sleep(drainMs, false)]))) await terminate(inst);',
              '}',
            ].join('\n'),
          },
        ],
      },
      'guard-quarantine': {
        steps: [
          {
            name: '1. Event-Loop Hang',
            state: 'awake',
            lease: 'request: 1 · channel: 0 · trigger: 0',
            inv: 'ADR 0017 §6',
            src: 'gateway/src/runner.ts:L56-L58',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/runner.ts#L56-L58',
            en: 'An isolate app enters an infinite synchronous loop (while(true){}) or allocates past its off-heap Buffer limit while handling a request. Other worker threads in the runner keep serving their apps normally.',
            zh: '某个 isolate 应用在处理请求时陷入同步死循环（while(true){}）或超出堆外 Buffer 内存预算。同一个 runner 内的其他应用 worker 线程不受影响，继续正常应答。',
            code: [
              '// gateway/src/runner.ts:L49-L58',
              'const HEAP_CAP_MB = Number(env.PNEUMA_SPACE_RUNNER_WORKER_HEAP_MB ?? 256);',
              'const OFFHEAP_CAP_MB = Number(env.PNEUMA_SPACE_RUNNER_WORKER_OFFHEAP_MB ?? 256);',
              'const PING_MS = 1000;',
              'const SILENCE_MS = 3000;',
              'const TERMINATE_MS = 5000;',
            ].join('\n'),
          },
          {
            name: '2. Watchdog Ping',
            state: 'awake',
            lease: 'request: 1 · channel: 0 · trigger: 0',
            inv: 'AC-ISO-2',
            src: 'gateway/src/isolate-shim.ts:L1-L65',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/isolate-shim.ts#L1-L65',
            en: 'Every 1000 ms (PING_MS), the runner main thread sends a ping message to each worker private MessagePort. The shim replies with pong and process.memoryUsage().external. If the main thread itself was delayed, watchdog deadlines shift by the lag so a busy host never causes a false hang.',
            zh: 'runner 主线程每 1000 ms（PING_MS）向每个 worker 的私有 MessagePort 发送心跳，垫片 isolate-shim.ts 回复 pong 并附带堆外内存采样。若主线程短暂迟滞，看门狗按迟滞量顺延期限，绝不误判。',
            code: [
              '// gateway/src/runner.ts:L38-L42',
              'export type WorkerMessage =',
              "  | { readonly type: 'pong'; readonly seq: number; readonly external: number }",
              "  | { readonly type: 'listening'; readonly port: number }",
              "  | { readonly type: 'log'; readonly stream: 'stdout' | 'stderr'; readonly lines: readonly string[] }",
              "  | { readonly type: 'dropped'; readonly count: number };",
            ].join('\n'),
          },
          {
            name: '3. Terminate (3.5s)',
            state: 'stopping',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'AC-ISO-2',
            src: 'gateway/src/runner.ts:L122-L148',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/runner.ts#L122-L148',
            en: 'After 3000 ms of silence (SILENCE_MS), the runner records worker-hung and calls thread.terminate() (V8 TerminateExecution). Within at most one 250 ms gateway poll (POLL_MS), IsolateDriver observes the hung event—3.5 to 4 s total.',
            zh: '3000 ms 无应答（SILENCE_MS）后，runner 记录 worker-hung 并调用 thread.terminate()（V8 TerminateExecution 打断死循环）。网关 IsolateDriver 在至多一个 250 ms 轮询周期（POLL_MS）内观测到该事件——总耗时 3.5 至 4 秒。',
            code: [
              '// gateway/src/runner.ts:L136-L143',
              'async function abandonIfStuck(inst: Instance): Promise<void> {',
              '  const done = inst.thread.terminate().then(() => true);',
              '  if (await Promise.race([done, sleep(TERMINATE_MS, false)])) return;',
              '  stuck++;',
              '  if (instances.get(inst.app) === inst) instances.delete(inst.app);',
              "  record(inst, 'exit', { reason: 'stuck' });",
              '}',
            ].join('\n'),
          },
          {
            name: '4. CAS & Failure',
            state: 'asleep',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'INV-11',
            src: 'gateway/src/runtimes.ts:L221-L234',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/runtimes.ts#L221-L234',
            en: 'Every gateway replica follows the runner event stream, but only the single replica that wins the CAS awake → asleep (matching epoch and handle) calls AppGuard.fail() inside that transaction, preventing duplicate failure counts across replicas.',
            zh: '每个网关副本都在跟随 runner 事件流，但只有唯一赢下 awake → asleep（匹配 epoch 与 handle）CAS 更新的副本会在同一事务中调用 AppGuard.fail()，确保多副本下绝不会重复计次。',
            code: [
              '// gateway/src/runtimes.ts:L221-L234',
              'async fail(tx: StoreOps, spec: RunSpec, reason: string): Promise<Quarantine | null> {',
              '  const now = this.#now();',
              "  const found = await tx.guard(spec.app, 'update');",
              '  const record = found?.release === spec.release ? found : null;',
              '  const failures = [...(record?.failures ?? []).filter((t) => t > now - spec.policy.failure_window_seconds * 1000), now];',
              '  const quarantined = record?.quarantinedAt == null && failures.length >= spec.policy.max_failures;',
              '  await tx.putGuard({ app: spec.app, release: spec.release, failures, ... });',
              '  return quarantined ? { reason, since: now, failures: failures.length } : null;',
              '}',
            ].join('\n'),
          },
          {
            name: '5. Backoff (5s)',
            state: 'asleep',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'ADR 0017',
            src: 'gateway/src/runtimes.ts:L11-L17',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/runtimes.ts#L11-L17',
            en: 'For the first 1 or 2 failures, a wake arriving within restart_backoff_seconds (default 5s) is refused with 503 Retry-After without counting as another failure. After the backoff window, the next request wakes a fresh worker.',
            zh: '在前 1～2 次失败后，若请求在 restart_backoff_seconds（默认 5 秒）内到达，AppGuard 拒绝唤醒并返回 503 Retry-After（不计为新失败）；退避期过后，新请求正常唤醒全新 worker。',
            code: [
              '// gateway/src/runtimes.ts:L11-L17',
              'export class Backoff extends Error {',
              '  readonly retryAfterSeconds: number;',
              '  constructor(retryAfterSeconds: number) {',
              '    super(`the app failed moments ago; retry in ${retryAfterSeconds} s`);',
              '    this.retryAfterSeconds = retryAfterSeconds;',
              '  }',
              '}',
            ].join('\n'),
          },
          {
            name: '6. Quarantined (3x)',
            state: 'quarantined',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'AC-ISO-2 · AC-K8S-7',
            src: 'gateway/src/runtimes.ts:L26-L32',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/runtimes.ts#L26-L32',
            en: 'When failures reach max_failures (default 3) within failure_window_seconds (default 60s), the guard row sets quarantinedAt and quarantineReason. Every replica mirrors the guard row via LISTEN pneuma_space and answers 503 immediately.',
            zh: '当 failure_window_seconds（默认 60 秒）内失败达到 max_failures（默认 3 次）时，guard 行写入 quarantinedAt 与原因。所有网关副本经 LISTEN pneuma_space 同步镜像，后续请求立即返回 503。',
            code: [
              '// gateway/src/runtimes.ts:L26-L32',
              'export class Quarantined extends Error {',
              '  readonly quarantine: Quarantine;',
              '  constructor(quarantine: Quarantine) {',
              '    super(`the app is quarantined after ${quarantine.failures} failures (${quarantine.reason}); publish a new release or POST /api/apps/<name>/unquarantine`);',
              '    this.quarantine = quarantine;',
              '  }',
              '}',
            ].join('\n'),
          },
          {
            name: '7. Console Alert',
            state: 'quarantined',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'ADR 0018',
            src: 'gateway/src/admin.ts:L1-L120',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/admin.ts#L1-L120',
            en: 'The quarantined event enters the persisted events table and the Console Attention Inbox. On the Topology page, the app chip turns red with its quarantine reason and an inline Unquarantine action.',
            zh: 'quarantined 生命周期事件落入平台库 events 表并浮现在控制台总览的收件箱（Attention Inbox）中。在拓扑页上，该应用节点变为红色故障态并展示隔离原因与一键解除按钮。',
            code: [
              '// gateway/src/runtimes.ts:L236-L238',
              'announce(app: AppId, quarantine: Quarantine): void {',
              "  this.#log('quarantined', app, { reason: quarantine.reason, failures: quarantine.failures });",
              '}',
            ].join('\n'),
          },
          {
            name: '8. Unquarantine',
            state: 'asleep',
            lease: 'request: 0 · channel: 0 · trigger: 0',
            inv: 'ADR 0017',
            src: 'gateway/src/runtimes.ts:L184-L196',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/runtimes.ts#L184-L196',
            en: 'Publishing a new release automatically invalidates an older release guard row (record.release !== spec.release), OR the owner runs appctl unquarantine <name> (POST /api/apps/<name>/unquarantine) to delete the guard row across all replicas.',
            zh: '发布新版本会自动使旧版本的 guard 记录失效（record.release !== spec.release），或者所有者执行 appctl unquarantine <name>（POST /api/apps/<name>/unquarantine）跨所有副本删除 guard 行。',
            code: [
              '// gateway/src/runtimes.ts:L184-L196',
              'quarantine(app: AppId): Quarantine | null {',
              '  const record = this.#instances.guard(app);',
              '  if (!record || record.quarantinedAt === null || record.release !== this.#specFor(app)?.release) return null;',
              "  return { reason: record.quarantineReason ?? '', since: record.quarantinedAt, failures: record.failures.length };",
              '}',
            ].join('\n'),
          },
          {
            name: '9. Clean Resume',
            state: 'awake',
            lease: 'request: 1 · channel: 0 · trigger: 0',
            inv: 'INV-2 · AC-ISO-4',
            src: 'gateway/src/lifecycle.ts:L177-L189',
            srcUrl: 'https://github.com/pandazki/pneuma-space/blob/main/gateway/src/lifecycle.ts#L177-L189',
            en: 'The very next request wakes the new or unquarantined release with all data in /data, SQLite/PostgreSQL, Redis KV, and S3 bucket completely intact.',
            zh: '下一次请求到来时立即唤醒新版本或解除隔离后的实例，此前保存在 /data、SQLite/PostgreSQL、Redis KV 与 S3 bucket 中的持久数据分毫无损。',
            code: [
              '// gateway/src/lifecycle.ts:L177-L189',
              "if (!row || row.state === 'asleep') {",
              '  const wake = this.#wake(app, spec, kind);',
              '  // Wakes cleanly with all persistent StorageBindings re-injected',
              '}',
            ].join('\n'),
          },
        ],
      },
    };

    const renderSim = () => {
      const isZh = root.lang === 'zh';
      const steps = SCENARIOS[currentScenario].steps;
      const step = steps[currentStep] || steps[0];

      simRoot.querySelectorAll('[data-sim-scenario]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-sim-scenario') === currentScenario));
      });

      const stepBtns = simRoot.querySelectorAll('[data-sim-step]');
      stepBtns.forEach((b, idx) => {
        const s = steps[idx];
        if (!s) return;
        b.setAttribute('aria-selected', String(idx === currentStep));
        const nameEl = b.querySelector('.s-name');
        if (nameEl) nameEl.textContent = s.name.replace(/^\d+\.\s*/, '');
      });

      const titleEl = document.getElementById('sim-step-title');
      const descEl = document.getElementById('sim-step-desc');
      const codeEl = document.getElementById('sim-step-code');
      const invEl = document.getElementById('sim-step-inv');
      const leaseEl = document.getElementById('sim-step-lease');
      const srcEl = document.getElementById('sim-step-src');

      if (titleEl) titleEl.textContent = step.name;
      if (descEl) descEl.textContent = isZh ? step.zh : step.en;
      if (codeEl) codeEl.textContent = step.code;
      if (invEl) invEl.textContent = step.inv;
      if (leaseEl) leaseEl.textContent = step.lease;
      if (srcEl) {
        srcEl.setAttribute('href', step.srcUrl);
        const span = srcEl.querySelector('span');
        if (span) span.textContent = step.src;
      }

      simRoot.querySelectorAll('[data-state-node]').forEach((node) => {
        const st = node.getAttribute('data-state-node');
        node.className = 'state-node';
        if (st === step.state) {
          if (st === 'awake') node.classList.add('active-awake');
          else if (st === 'waking' || st === 'draining' || st === 'stopping') node.classList.add('active-transit');
          else if (st === 'quarantined') node.classList.add('active-fault');
          else node.classList.add('active-transit');
        }
      });
    };

    simRoot.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      const scenBtn = target.closest('[data-sim-scenario]');
      if (scenBtn) {
        const sc = scenBtn.getAttribute('data-sim-scenario');
        if (sc && SCENARIOS[sc]) {
          currentScenario = sc;
          currentStep = 0;
          renderSim();
        }
        return;
      }

      const stepBtn = target.closest('[data-sim-step]');
      if (stepBtn) {
        const idx = Number(stepBtn.getAttribute('data-sim-step'));
        if (!Number.isNaN(idx)) {
          currentStep = idx;
          renderSim();
        }
        return;
      }

      const navBtn = target.closest('[data-sim-nav]');
      if (navBtn) {
        const dir = navBtn.getAttribute('data-sim-nav');
        const len = SCENARIOS[currentScenario].steps.length;
        if (dir === 'next') currentStep = (currentStep + 1) % len;
        else if (dir === 'prev') currentStep = (currentStep - 1 + len) % len;
        renderSim();
      }
    });

    window.__pneumaUpdateSim = renderSim;
    renderSim();
  }

  // 4. ADR Codex Filtering & Expand All (on adr.html)
  const adrList = document.getElementById('adr-codex-list');
  if (adrList) {
    let activeCat = 'all';
    let query = '';

    const filterAdrs = () => {
      const items = adrList.querySelectorAll('details.adr-item');
      let shown = 0;
      items.forEach((item) => {
        const cat = item.getAttribute('data-adr-cat') || '';
        const text = (item.textContent || '').toLowerCase();
        const matchCat = activeCat === 'all' || cat === activeCat;
        const matchQ = !query || text.includes(query);
        if (matchCat && matchQ) {
          item.removeAttribute('hidden');
          shown++;
        } else {
          item.setAttribute('hidden', '');
        }
      });
      const countEl = document.getElementById('adr-visible-count');
      if (countEl) countEl.textContent = String(shown);
    };

    const searchInput = document.getElementById('adr-filter-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        query = (e.target.value || '').trim().toLowerCase();
        filterAdrs();
      });
    }

    document.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const catBtn = target.closest('[data-adr-cat-btn]');
      if (catBtn) {
        activeCat = catBtn.getAttribute('data-adr-cat-btn') || 'all';
        document.querySelectorAll('[data-adr-cat-btn]').forEach((b) => {
          b.setAttribute('aria-pressed', String(b.getAttribute('data-adr-cat-btn') === activeCat));
        });
        filterAdrs();
        return;
      }
      const toggleAll = target.closest('[data-adr-toggle-all]');
      if (toggleAll) {
        const open = toggleAll.getAttribute('data-adr-toggle-all') === 'open';
        adrList.querySelectorAll('details.adr-item:not([hidden])').forEach((d) => {
          if (open) d.setAttribute('open', '');
          else d.removeAttribute('open');
        });
      }
    });

    const openHashAdr = () => {
      if (location.hash.startsWith('#adr-')) {
        const el = document.querySelector(location.hash);
        if (el && el.tagName === 'DETAILS') {
          el.setAttribute('open', '');
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    };
    window.addEventListener('hashchange', openHashAdr);
    openHashAdr();
  }

  // 5. Global Search Modal (Cmd+K / /)
  const modal = document.getElementById('global-search-modal');
  const modalInput = document.getElementById('global-search-input');
  const modalResults = document.getElementById('global-search-results');
  const indexData = window.__PNEUMA_SEARCH_INDEX || [];

  const renderSearch = (q) => {
    if (!modalResults) return;
    const isZh = root.lang === 'zh';
    const clean = q.trim().toLowerCase();
    const hits = indexData.filter((item) => {
      if (!clean) return true;
      return (
        item.titleEn.toLowerCase().includes(clean) ||
        item.titleZh.toLowerCase().includes(clean) ||
        item.descEn.toLowerCase().includes(clean) ||
        item.descZh.toLowerCase().includes(clean) ||
        (item.src && item.src.toLowerCase().includes(clean)) ||
        (item.tag && item.tag.toLowerCase().includes(clean))
      );
    }).slice(0, 18);

    modalResults.innerHTML = hits.map((h) => (
      '<a class="search-hit" href="' + h.href + '">' +
        '<div>' +
          '<b>' + (isZh ? h.titleZh : h.titleEn) + '</b>' +
          '<small>' + (isZh ? h.descZh : h.descEn) + '</small>' +
        '</div>' +
        '<span class="chip">' + (h.tag || 'DOC') + '</span>' +
      '</a>'
    )).join('') || ('<div class="empty">' + (isZh ? '无匹配条目' : 'No matching specification or ADR found.') + '</div>');
  };

  const openSearch = () => {
    if (!modal) return;
    modal.removeAttribute('hidden');
    renderSearch(modalInput ? modalInput.value : '');
    setTimeout(() => modalInput && modalInput.focus(), 20);
  };

  const closeSearch = () => {
    if (!modal) return;
    modal.setAttribute('hidden', '');
  };

  document.querySelectorAll('[data-open-search]').forEach((b) => b.addEventListener('click', openSearch));
  document.querySelectorAll('[data-close-search]').forEach((b) => b.addEventListener('click', closeSearch));
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeSearch();
    });
  }
  if (modalInput) {
    modalInput.addEventListener('input', (e) => renderSearch(e.target.value || ''));
  }

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (modal && !modal.hasAttribute('hidden')) closeSearch();
      else openSearch();
    } else if (e.key === 'Escape' && modal && !modal.hasAttribute('hidden')) {
      closeSearch();
    }
  });
})();
