const dict = {
  en: {
    site: 'PneumaSpace static site', home: 'Home', guide: 'Guide', about: 'About', light: 'Light', dark: 'Dark', footer: 'Runs on PneumaSpace',
    homeTitle: 'Home', serveTitle: 'What PneumaSpace serves', serveIntro: 'The manifest declares only static, so the platform serves site/ itself.',
    noContainer: 'No container', noContainerText: 'Nothing is built, started or kept running. docker ps shows no container for this site.',
    noCold: 'No cold start', noColdText: 'Files come from the platform on every request, so the first byte arrives in under 50 ms.',
    relative: 'Relative links', relativeText: 'The site lives under /apps/<name>/, so every link and asset is written ./guide.html, never /guide.html.',
    noFallback: 'No SPA fallback', noFallbackText: 'A path without a file is a 404. Link only to files that exist.',
    proofTitle: 'This page, measured', proofIntro: 'Read from the browser timing of the request that loaded this page.',
    firstByte: 'First byte {ms} ms, target under 50 ms', cached: 'Served from the browser cache; reload to measure.',
    missing: 'Open a path with no file', missingText: 'The platform answers 404 instead of falling back to index.html.',
    guideTitle: 'Guide', publishTitle: 'Publish a static site', publishIntro: 'Run from a PneumaSpace checkout. Publishing again replaces the files.',
    rulesTitle: 'Rules for site/', rulesIntro: 'What the platform expects from the published directory.',
    rule: 'Rule', reason: 'Why',
    r1: 'site/index.html answers the address', r1why: 'A request for /apps/<name>/ returns it.',
    r2: 'Use relative URLs', r2why: 'The prefix /apps/<name>/ belongs to the platform.',
    r3: 'Link to real files', r3why: 'There is no SPA fallback; a missing path is 404.',
    r4: 'Point dir elsewhere if needed', r4why: 'Set static.dir to dist when your build writes there.',
    whenTitle: 'When to pick the app template', whenIntro: 'Start from templates/app when the site needs any of these.',
    need: 'You need', cap: 'Capability',
    n1: 'A database', n2: 'A key-value store or pub/sub', n3: 'Scheduled or on-demand triggers', n4: 'WebSockets or server-sent events', n5: 'The visitor\'s identity', n6: 'Persistent files or a bucket',
    whenNote: 'An app can still declare static, and the platform serves its JS, CSS and images without waking it.',
    aboutTitle: 'About', aboutSiteTitle: 'About this site', aboutSiteIntro: 'Three pages of plain HTML with one stylesheet and one script.',
    aboutText: 'Theme and language are chosen in the browser and kept in localStorage, so the choice carries from page to page without a server.',
    filesTitle: 'Files', filesIntro: 'Everything the platform serves for this site.',
    file: 'File', role: 'Role',
    fIndex: 'Home', fGuide: 'Publishing and rules', fAbout: 'This page', fCss: 'Tokens and components shared by every page', fJs: 'Dictionary, theme and language controls',
  },
  zh: {
    site: 'PneumaSpace 静态站点', home: '首页', guide: '指南', about: '关于', light: '浅色', dark: '深色', footer: '运行于 PneumaSpace',
    homeTitle: '首页', serveTitle: 'PneumaSpace 提供什么', serveIntro: '清单只声明了 static，平台直接提供 site/ 目录。',
    noContainer: '不起容器', noContainerText: '不构建、不启动、不常驻。docker ps 里没有这个站点的容器。',
    noCold: '没有冷启动', noColdText: '每次请求都由平台直接返回文件，首字节在 50 ms 以内。',
    relative: '相对链接', relativeText: '站点位于 /apps/<name>/ 下，链接和资源一律写 ./guide.html，不写 /guide.html。',
    noFallback: '没有 SPA 回退', noFallbackText: '没有对应文件的路径返回 404，只链接存在的文件。',
    proofTitle: '本页实测', proofIntro: '取自浏览器对加载本页那次请求的计时。',
    firstByte: '首字节 {ms} ms，目标 50 ms 以内', cached: '本页来自浏览器缓存，刷新后再测。',
    missing: '打开一个不存在的路径', missingText: '平台返回 404，不会回退到 index.html。',
    guideTitle: '指南', publishTitle: '发布静态站点', publishIntro: '在 PneumaSpace 仓库目录下运行。再次发布会替换全部文件。',
    rulesTitle: 'site/ 的规则', rulesIntro: '平台对发布目录的要求。',
    rule: '规则', reason: '原因',
    r1: 'site/index.html 响应站点地址', r1why: '请求 /apps/<name>/ 时返回它。',
    r2: '使用相对 URL', r2why: '前缀 /apps/<name>/ 属于平台。',
    r3: '只链接真实文件', r3why: '没有 SPA 回退，缺失的路径返回 404。',
    r4: '需要时改 dir', r4why: '构建产物写到 dist 时，把 static.dir 设为 dist。',
    whenTitle: '何时改用 app 模板', whenIntro: '站点需要下面任意一项时，从 templates/app 开始。',
    need: '你需要', cap: '能力',
    n1: '数据库', n2: '键值存储或发布订阅', n3: '定时或按需触发', n4: 'WebSocket 或服务器推送事件', n5: '访问者身份', n6: '持久文件或对象存储桶',
    whenNote: '应用同样可以声明 static，平台直接提供它的 JS、CSS 和图片，不必唤醒应用。',
    aboutTitle: '关于', aboutSiteTitle: '关于本站', aboutSiteIntro: '三个纯 HTML 页面，共用一个样式表和一个脚本。',
    aboutText: '主题和语言在浏览器里选择并存入 localStorage，换页后保持不变，不需要服务器。',
    filesTitle: '文件', filesIntro: '平台为本站提供的全部文件。',
    file: '文件', role: '用途',
    fIndex: '首页', fGuide: '发布与规则', fAbout: '本页', fCss: '所有页面共用的令牌和组件', fJs: '词典、主题与语言切换',
  },
};
const root = document.documentElement;
const media = matchMedia('(prefers-color-scheme: dark)');
const save = (key, value) => { try { localStorage.setItem(key, value); } catch (e) {} };
const t = (key, params = {}) => {
  const text = dict[root.lang][key];
  if (text === undefined) throw new Error(`dictionary has no "${key}"`);
  return text.replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
};
function measure() {
  const el = document.getElementById('first-byte');
  const nav = performance.getEntriesByType('navigation')[0];
  if (!el || !nav) return;
  const cached = nav.transferSize === 0 && nav.responseStart > 0;
  const ms = nav.responseStart - nav.requestStart;
  el.className = cached ? 'status' : `status ${ms < 50 ? 'green' : 'red'}`;
  el.textContent = cached ? t('cached') : t('firstByte', { ms: ms.toFixed(1) });
}
function render() {
  document.title = `${t(document.body.dataset.page)} · ${t('site')}`;
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll('[data-t-label]')) el.ariaLabel = t(el.dataset.tLabel);
  measure();
}
render();
media.addEventListener('change', () => { try { if (localStorage.getItem('pneuma-space-theme')) return; } catch (e) {} root.dataset.theme = media.matches ? 'dark' : 'light'; });
document.addEventListener('click', (event) => {
  const lang = event.target.closest('[data-lang]')?.dataset.lang;
  const theme = event.target.closest('[data-theme-set]')?.dataset.themeSet;
  if (lang) { root.lang = lang; save('pneuma-space-lang', lang); render(); }
  if (theme) { root.dataset.theme = theme; save('pneuma-space-theme', theme); }
});
