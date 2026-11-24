'use strict';

const root = document.querySelector('#root');
const state = {
  lang: localStorage.getItem('pneuma-space.lang') || 'zh',
  theme: localStorage.getItem('pneuma-space.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  me: null, tenant: null, app: null, epoch: 0, cleanup: [], secrets: new Map(), launches: new Map(), redeemed: null,
};
const tr = (zh, en) => state.lang === 'zh' ? zh : en;
const pathId = value => encodeURIComponent(value);
const items = result => result.items;
const knownStates = {
  draft: ['待发布','Draft'], registered: ['已发布','Published'], removed: ['已下线','Removed'], purging: ['清除中','Purging'], purged: ['已清除','Purged'],
  asleep: ['休眠','Asleep'], waking: ['唤醒中','Waking'], awake: ['运行中','Awake'], draining: ['停止中','Draining'], quarantined: ['已隔离','Quarantined'],
  ready: ['已就绪','Ready'], pending: ['待就绪','Pending'], failed: ['失败','Failed'], due: ['待执行','Due'], delivering: ['执行中','Delivering'], done: ['完成','Done'], cancelled: ['已取消','Cancelled'],
  reachable: ['可连接','Reachable'], configured: ['已配置','Configured'], unconfigured: ['未配置','Not configured'],
  admin: ['管理员','Administrator'], member: ['成员','Member'], active: ['有效','Active'], revoked: ['已撤销','Revoked'], disabled: ['已停用','Disabled'], expired: ['已过期','Expired'],
};
function word(value) { return knownStates[value] ? tr(...knownStates[value]) : String(value ?? ''); }
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key in node && !key.startsWith('aria-') && key !== 'role' && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  append(node, children);
  return node;
}
function icon(name) {
  const paths = {
    overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    projects: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
    accounts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
    invitations: 'M7 17 17 7 M7 7h10v10',
    tenants: 'M4 21V3h12v18 M16 10h4v11 M2 21h20 M8 7h4 M8 11h4 M8 15h4',
    resources: 'm12 3 9 5-9 5-9-5 9-5Z M3 8v9l9 5 9-5V8 M12 13v9',
    audit: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
    activity: 'M3 12h4l3-8 4 16 3-8h4',
    usage: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
    chevron: 'm6 9 6 6 6-6',
    more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  for (const [key,value] of Object.entries({ viewBox:'0 0 24 24',width:16,height:16,fill:'none',stroke:'currentColor','stroke-width':1.7,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false',class:'icon' })) svg.setAttribute(key,String(value));
  const path = document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d',paths[name]); svg.append(path); return svg;
}
function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
function fill(node, ...children) { node.replaceChildren(); return append(node, children); }
const btn = (text, fn, cls = '') => h('button', { type: 'button', class: `btn ${cls}`, onclick: fn }, text);
const link = (label, href, cls = 'btn ghost small') => h('a', { href, class: cls }, label);
const chip = value => h('span', { class: 'chip' }, value);
const empty = (label, action) => h('div', { class: 'empty' }, h('b', {}, label), action);
function statusBadge(value) {
  const tone = ['awake','done','ready','active','reachable','configured'].includes(value) ? 'good' : ['failed','quarantined','disabled'].includes(value) ? 'bad' : ['waking','draining','pending','purging','due','delivering','unconfigured'].includes(value) ? 'warn' : '';
  return h('span', { class: `st ${tone}` }, word(value));
}
function stamp(value) { return value == null ? tr('未记录','Not recorded') : new Date(value).toLocaleString(state.lang === 'zh' ? 'zh-CN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
function ago(value) {
  if (value == null) return tr('未记录','Not recorded');
  const seconds = Math.round((Date.now() - value) / 1000), past = seconds >= 0, n = Math.abs(seconds);
  const [count, zh, en] = n < 60 ? [n,'秒','s'] : n < 3600 ? [Math.floor(n/60),'分钟','min'] : n < 86400 ? [Math.floor(n/3600),'小时','h'] : [Math.floor(n/86400),'天','d'];
  return state.lang === 'zh' ? `${count} ${zh}${past ? '前' : '后'}` : past ? `${count} ${en} ago` : `in ${count} ${en}`;
}
const time = value => h('time', { dateTime: value == null ? '' : new Date(value).toISOString(), title: stamp(value), 'data-at': value }, ago(value));
function bytes(value) {
  if (value == null) return tr('未记录','Not recorded');
  const size = Number(value); if (size < 1024) return `${size} B`;
  const unit = Math.min(3,Math.floor(Math.log(size)/Math.log(1024))); return `${(size/1024**unit).toFixed(unit === 1 ? 0 : 1)} ${['B','KiB','MiB','GiB'][unit]}`;
}
function errorLine(error) {
  return h('div', { class: 'notice error', role: 'alert' }, h('strong', {}, error.code || tr('请求失败','Request failed')), ' · ', error.message,
    error.requestId ? h('div', { class: 'mono gap' }, error.requestId) : null,
    error.status === 401 ? h('div',{ class:'gap' },link(tr('重新登录','Sign in again'),`/login?next=${encodeURIComponent(location.pathname+location.search)}`)) : null);
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = crypto.randomUUID();
    if (state.me?.csrf) headers['X-Pneuma-Space-CSRF'] = state.me.csrf;
  }
  const response = await fetch(`/api/v1${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  let result;
  try { result = response.status === 204 ? {} : await response.json(); }
  catch { throw new Error(tr(`服务返回了无效响应（${response.status}）。`,`The service returned an invalid response (${response.status}).`)); }
  if (!response.ok) {
    const error = new Error(result.error?.message || `${response.status} ${response.statusText}`);
    Object.assign(error, result.error, { status: response.status });
    throw error;
  }
  return result;
}
function section(index, title, description, ...content) {
  return h('section', {}, h('div', { class: 'section-head' }, h('span', { class: 'index' }, String(index).padStart(2,'0')), h('div', { class: 'grow' }, h('h2', {}, title), description ? h('p', {}, description) : null)), ...content);
}
function facts(record) {
  return h('dl', { class: 'facts compact' }, (Array.isArray(record) ? record : Object.entries(record)).map(([key,value]) => h('div', { class: 'fact' }, h('dt', {}, key), h('dd', {}, value == null ? tr('未记录','Not recorded') : value))));
}
function jsonView(value) { return h('pre', { class: 'result', tabIndex: 0 }, JSON.stringify(value, null, 2)); }
function field(label, input, hint) { return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null); }
function input(options = {}) { return h('input', { type: 'text', ...options }); }
function textarea(value, cls = '') { return h('textarea', { value, class: cls, spellcheck: false }); }
function segment(options, current, change, label) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label }, options.map(([value,name]) => h('button', { type: 'button', 'aria-pressed': String(value === current), onclick: event => {
    event.currentTarget.parentElement.querySelectorAll('button').forEach(node => node.setAttribute('aria-pressed',String(node === event.currentTarget))); change(value);
  } }, name)));
}
function toggles(options, values, change, label) {
  return h('div', { class: 'toolbar', role: 'group', 'aria-label': label }, options.map(([value,name]) => h('button', { type: 'button', class: 'tog', 'aria-pressed': String(values.includes(value)), onclick: event => {
    const active = event.currentTarget.getAttribute('aria-pressed') !== 'true'; event.currentTarget.setAttribute('aria-pressed', String(active));
    if (active) values.push(value); else values.splice(values.indexOf(value),1); change?.(values);
  } }, name)));
}
let controlId = 0;
function listbox(options, current, change, label) {
  const id = `choice-${++controlId}`, container = h('div', { class: 'listbox' }), menu = h('div', { id, class: 'menu', role: 'listbox', 'aria-label': label, hidden: true });
  const chosen = options.find(option => option[0] === current);
  const trigger = h('button', { type: 'button', class: 'btn ghost small', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': label }, h('span', { class: 'listbox-label' }, chosen?.[1] || label), icon('chevron'));
  let search = '', searchAt = 0;
  function close() { menu.hidden = true; trigger.setAttribute('aria-expanded','false'); }
  function open() { menu.hidden = false; trigger.setAttribute('aria-expanded','true'); (menu.querySelector('[aria-selected="true"]') || menu.querySelector('[role="option"]'))?.focus(); }
  trigger.addEventListener('click', () => menu.hidden ? open() : close());
  trigger.addEventListener('keydown', event => { if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } });
  options.forEach(([value,name]) => menu.append(h('button', { type: 'button', role: 'option', 'aria-selected': String(value === current), 'data-value':value, onclick: () => {
    close(); trigger.querySelector('.listbox-label').textContent = name; menu.querySelectorAll('[role="option"]').forEach(node => node.setAttribute('aria-selected',String(node.getAttribute('data-value') === value))); trigger.focus(); change(value);
  } }, name)));
  if (options.length > 8) {
    const filter = input({ type: 'search', placeholder: tr('筛选…','Filter…'), 'aria-label': tr('筛选选项','Filter options'), oninput: event => {
      const query = event.currentTarget.value.toLowerCase(); menu.querySelectorAll('[role="option"]').forEach(node => node.hidden = !node.textContent.toLowerCase().includes(query));
    } }); menu.prepend(filter);
  }
  menu.addEventListener('keydown', event => {
    const nodes = [...menu.querySelectorAll('[role="option"]')].filter(node => !node.hidden), i = nodes.indexOf(document.activeElement);
    if (event.key === 'Escape') { close(); trigger.focus(); }
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length-1 : (i + (event.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length; nodes[next]?.focus();
    } else if (event.key.length === 1 && document.activeElement.tagName !== 'INPUT') {
      search = Date.now()-searchAt > 650 ? event.key : search+event.key; searchAt = Date.now(); nodes.find(node => node.textContent.toLowerCase().startsWith(search.toLowerCase()))?.focus();
    }
  });
  container.addEventListener('focusout', event => { if (!container.contains(event.relatedTarget)) close(); });
  return append(container,[trigger,menu]);
}
function moreMenu(entries) {
  const wrapper = h('div', { class: 'more' }), menu = h('div', { class: 'menu', role: 'menu', hidden: true });
  const toggle = btn(icon('more'), () => { menu.hidden = !menu.hidden; toggle.setAttribute('aria-expanded',String(!menu.hidden)); if (!menu.hidden) menu.querySelector('button')?.focus(); }, 'ghost ibtn');
  toggle.addEventListener('keydown',event => { if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); menu.hidden = false; toggle.setAttribute('aria-expanded','true'); (event.key === 'ArrowUp' ? menu.lastElementChild : menu.firstElementChild)?.focus(); } });
  toggle.setAttribute('aria-label',tr('更多操作','More actions')); toggle.setAttribute('aria-haspopup','menu'); toggle.setAttribute('aria-expanded','false');
  entries.forEach(entry => menu.append(h('button', { type: 'button', role: 'menuitem', class: entry.danger ? 'danger' : '', onclick: () => { menu.hidden = true; toggle.setAttribute('aria-expanded','false'); entry.run(); } }, entry.label, entry.note ? h('small', {}, entry.note) : null)));
  menu.addEventListener('keydown', event => {
    const nodes = [...menu.querySelectorAll('button')], index = nodes.indexOf(document.activeElement);
    if (event.key === 'Escape') { menu.hidden = true; toggle.setAttribute('aria-expanded','false'); toggle.focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); nodes[(index+(event.key === 'ArrowDown' ? 1 : -1)+nodes.length)%nodes.length]?.focus(); }
  });
  wrapper.addEventListener('focusout', event => { if (!wrapper.contains(event.relatedTarget)) { menu.hidden = true; toggle.setAttribute('aria-expanded','false'); } });
  return append(wrapper,[toggle,menu]);
}
function submitForm(content, action, label = tr('保存','Save'), options = {}) {
  const outcome = h('div', { 'aria-live': 'polite' }), submit = h('button', { type: 'submit', class: 'btn primary' }, label);
  const form = h('form', { class: `form ${options.class || ''}`, onsubmit: async event => {
    event.preventDefault(); if (submit.disabled) return; submit.disabled = true; fill(outcome);
    try { const result = await action(); if (result instanceof Node) fill(outcome,result); else if (result !== false) fill(outcome,h('div',{ class: 'notice' },tr('操作已完成。','Operation completed.'))); }
    catch (error) { fill(outcome,errorLine(error)); } finally { submit.disabled = false; }
  } }, ...content, h('div', { class: 'toolbar' },submit,options.extra),outcome);
  return form;
}
function approve({ title, description, confirmation = undefined, action, danger = true }) {
  const dialog = h('dialog', { 'aria-label': title }), typed = confirmation ? input({ autocomplete: 'off', placeholder: confirmation, 'aria-label': tr('输入名称确认','Type the name to confirm') }) : null;
  const result = h('div', { 'aria-live': 'polite' });
  const cancel = btn(tr('取消','Cancel'), () => dialog.close(), 'ghost');
  const confirm = btn(tr('继续','Continue'), async () => {
    if (typed && typed.value !== confirmation) return;
    confirm.disabled = true; cancel.disabled = true;
    try { await action(); dialog.close(); } catch (error) { fill(result,errorLine(error)); confirm.disabled = false; cancel.disabled = false; }
  }, danger ? 'danger' : 'primary');
  if (typed) { confirm.disabled = true; typed.addEventListener('input', () => confirm.disabled = typed.value !== confirmation); }
  append(dialog,[h('div', { class: 'dialog-body' }, h('h2', {}, title), h('p', { class: 'muted' }, description), typed ? field(tr(`输入 ${confirmation} 以确认`,`Type ${confirmation} to confirm`),typed) : null,result,h('div',{ class: 'toolbar' },cancel,confirm))]);
  dialog.addEventListener('close',() => dialog.remove()); document.body.append(dialog); dialog.showModal(); (typed || cancel).focus();
}
function fileField(accept, receive) {
  const chosen = h('small', {}, tr('或将文件拖到这里','Or drop a file here')), picker = input({ type: 'file', accept, tabIndex: -1 });
  async function choose(file) { if (!file) return; chosen.textContent = `${file.name} · ${bytes(file.size)}`; try { await receive(file); } catch (error) { chosen.replaceChildren(errorLine(error)); } }
  picker.addEventListener('change', () => choose(picker.files[0]));
  const node = h('div', { class: 'file-field', ondragover: event => { event.preventDefault(); node.classList.add('drag'); }, ondragleave: () => node.classList.remove('drag'), ondrop: event => { event.preventDefault(); node.classList.remove('drag'); choose(event.dataTransfer.files[0]); } }, picker,btn(tr('选择文件','Choose file'),() => picker.click(),'ghost'),chosen);
  return node;
}
function secretCard(value, title = tr('请立即保存，只显示这一次。','Save this now. It is shown only once.')) {
  if (!state.secrets.has(value)) state.secrets.set(value,crypto.randomUUID());
  const secretId = state.secrets.get(value);
  const result = h('div', { class: 'secret', role: 'status', 'data-secret': secretId }, h('strong', {},title),h('code', {},value));
  result.append(h('div', { class: 'toolbar' },btn(tr('复制','Copy'),async event => {
    const target = event.currentTarget;
    try { await navigator.clipboard.writeText(value); target.textContent = tr('已复制','Copied'); } catch (error) { result.append(errorLine(error)); }
  },'ghost small'),btn(tr('我已保存，关闭','Saved, dismiss'),() => { state.secrets.delete(value); document.querySelectorAll(`[data-secret="${secretId}"]`).forEach(node => node.remove()); },'ghost small'))); return result;
}
function route() {
  const url = new URL(location.href); return { admin: url.pathname.startsWith('/admin'), view: url.searchParams.get('view') || 'overview', app: url.searchParams.get('app'), tab: url.searchParams.get('tab') || 'runtime' };
}
function goto(view, extra = {}) {
  const url = new URL(location.href); url.search = ''; url.searchParams.set('view',view);
  Object.entries(extra).forEach(([key,value]) => { if (value != null) url.searchParams.set(key,value); }); history.pushState({},'',url); render();
}
function projectLink(app) { const url = new URL(location.href); url.search = ''; url.searchParams.set('view','projects'); url.searchParams.set('app',app.id); return url.pathname+url.search; }
const tenantPath = (suffix,tenant = state.tenant) => `/tenants/${pathId(tenant.id)}${suffix}`;
const appPath = (suffix, app = state.app) => `/apps/${pathId(app.id)}${suffix}`;
function canManageTenant() { return state.me.platformAdmin || state.tenant?.role === 'admin'; }
function settingsControls() {
  return h('div', { class: 'controls' },segment([['zh','中'],['en','EN']],state.lang,value => { state.lang = value; localStorage.setItem('pneuma-space.lang',value); render(); },tr('语言','Language')),
    segment([['light',tr('浅色','Light')],['dark',tr('深色','Dark')]],state.theme,value => { state.theme = value; localStorage.setItem('pneuma-space.theme',value); document.documentElement.dataset.theme = value; render(); },tr('外观','Appearance')));
}
function brand(subtitle) { return h('div', { class: 'brand' },h('span',{ class: 'mark','aria-hidden':'true' },'p'),h('div',{},h('b',{},'PneumaSpace'),h('small',{},subtitle))); }
function shell() {
  const current = route(), pages = current.admin ? [['overview','overview',tr('总览','Overview')],['projects','projects',tr('全部项目','All projects')],['accounts','accounts',tr('账号','Accounts')],['invitations','invitations',tr('邀请','Invitations')],['tenants','tenants',tr('租户与配额','Tenants & quotas')],['resources','resources',tr('资源','Resources')],['audit','audit',tr('审计','Audit')]] : [['overview','overview',tr('总览','Overview')],['launch','invitations',tr('创建应用','Create app')],['projects','projects',tr('项目','Projects')],['activity','activity',tr('活动','Activity')],['usage','usage',tr('用量','Usage')],['team','accounts',tr('团队与凭据','Team & credentials')]];
  const content = h('div', { id: 'content' });
  if (state.secrets.size) content.append(h('div',{ class:'pending-secrets stack' },[...state.secrets.keys()].map(value => secretCard(value))));
  const accountMenu = moreMenu([{ label: tr('退出登录','Sign out'),run: async () => { try { await api('/auth/logout',{}); location.assign('/login'); } catch (error) { fill(content,errorLine(error)); } } }]);
  const aside = h('aside', {},brand(current.admin ? tr('平台管理','Platform administration') : tr('工作空间','Workspace')),
    h('nav', { 'aria-label':tr('主导航','Main navigation') },pages.map(([value,iconName,name]) => h('a',{ href:`${current.admin ? '/admin' : '/dashboard'}?view=${value}`, 'aria-current':current.view === value ? 'page' : null, onclick:event => { event.preventDefault(); goto(value); } },icon(iconName),name))),
    h('div',{ class:'aside-foot' },state.me.platformAdmin ? link(current.admin ? tr('进入工作空间','Open workspace') : tr('平台管理','Platform administration'),current.admin ? '/dashboard' : '/admin') : null,settingsControls(),h('small',{},'Cloudflare edition')));
  const scope = current.admin ? h('span',{ class:'eyebrow' },tr('平台 / 管理','Platform / Admin')) : state.me.tenants.length ? listbox(state.me.tenants.map(tenant => [tenant.id,tenant.name]),state.tenant?.id,id => { state.tenant = state.me.tenants.find(tenant => tenant.id === id); sessionStorage.setItem('pneuma-space.tenant',id); goto('overview'); },tr('选择租户','Choose tenant')) : h('span',{},tr('没有租户','No tenant'));
  const topbar = h('div',{ class:'topbar' },scope,h('span',{ class:'grow' }),
    h('span',{ class:'user-name muted' },state.me.user.name),h('span',{ class:'avatar',title:state.me.user.username },state.me.user.name.slice(0,1).toUpperCase()),accountMenu);
  fill(root,h('div',{ class:'frame' },aside,h('main',{},topbar,content))); return content;
}
function pagehead(title,description,...actions) { return h('header',{ class:'pagehead' },h('div',{ class:'grow' },h('h1',{},title),description ? h('p',{},description) : null),h('div',{ class:'toolbar' },...actions)); }
function number(value) { return typeof value === 'number' ? value.toLocaleString(state.lang === 'zh' ? 'zh-CN' : 'en-GB') : value ?? '—'; }
function stat(label,value,note) { return h('div',{ class:'card stat' },h('span',{ class:'muted' },label),h('strong',{},number(value)),note ? h('small',{},note) : null); }
function appRows(apps) {
  if (!apps.length) return empty(tr('这里还没有项目。','No projects here yet.'),!route().admin && state.tenant ? btn(tr('创建应用','Create app'),()=>goto('launch'),'primary') : null);
  const groups = [
    [tr('需要关注','Needs attention'),app => ['quarantined','failed'].includes(app.runtime?.state) || app.status === 'purging'],
    [tr('运行中','Running'),app => ['awake','waking','draining'].includes(app.runtime?.state)],
    [tr('待命','At rest'),app => !['removed','purged'].includes(app.status)],
    [tr('已下线','Removed'),() => true],
  ];
  let remaining = [...apps];
  return h('div',{ class:'stack' },groups.map(([title,predicate]) => {
    const selected = remaining.filter(predicate); remaining = remaining.filter(app => !predicate(app));
    return selected.length ? h('div',{ class:'stack' },h('div',{ class:'eyebrow gap' },title,' · ',selected.length),selected.map(app => h('a',{ href:projectLink(app),class:'card cardlink row',onclick:event => { event.preventDefault(); goto('projects',{ app:app.id }); } },h('span',{ class:'project-mark','aria-hidden':'true' },app.name.slice(0,2)),h('div',{ class:'grow' },h('div',{ class:'row-title mono' },app.name),h('div',{ class:'meta' },statusBadge(app.status),app.runtime?.state ? statusBadge(app.runtime.state) : null,chip(app.release == null ? tr('无版本','No release') : `r${app.release}`),route().admin ? chip(app.tenantId) : null)),h('div',{ class:'hint' },tr('观测于 ','Observed '),time(app.observedAt)),icon('invitations')))) : null;
  }));
}
function pager(path, first, draw) {
  let cursor = first.nextCursor;
  const list = h('div', { class:'stack' },draw(first.items)), error = h('div');
  const more = btn(tr('加载更多','Load more'),async () => {
    more.disabled = true;
    try { const next = await api(`${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`); list.append(draw(next.items)); cursor = next.nextCursor; more.hidden = !cursor; fill(error); }
    catch (failure) { fill(error,errorLine(failure)); } finally { more.disabled = false; }
  },'ghost'); more.hidden = !cursor;
  return h('div',{ class:'stack' },list,h('div',{ class:'toolbar' },more),error);
}
function usagePanel(usage) {
  const dimensions = [
    [tr('项目','Projects'),usage.used.apps,usage.quota.apps,number],
    [tr('运行名额','Runtime slots'),usage.used.awake,usage.quota.awake,number],
    [tr('今日请求','Requests today'),usage.requestsToday,usage.quota.requestsPerDay,number],
    [tr('预留存储','Reserved storage'),usage.used.storageBytes,usage.quota.storageBytes,bytes],
  ];
  return h('div',{ class:'usage-panel' },h('div',{ class:'capacity-grid' },dimensions.map(([label,used,limit,format]) => {
    const ratio = limit > 0 ? used / limit : used > 0 ? 1 : 0;
    return h('div',{ class:'capacity' },h('span',{ class:'muted' },label),
      h('div',{ class:'capacity-value' },h('strong',{},format(used)),h('span',{},'/ ',format(limit))),
      h('meter',{ min:0,max:Math.max(1,limit),value:Math.min(used,Math.max(1,limit)),class:ratio >= 1 ? 'full' : ratio >= .8 ? 'near' : '', 'aria-label':`${label}: ${format(used)} / ${format(limit)}` }),
      h('small',{},tr('已用 / 配额','Used / limit')));
  })),h('div',{ class:'usage-foot' },h('small',{},tr('存储按项目预留，不代表实际文件大小。','Storage is allocated to projects, not measured file size.')),h('small',{},tr('更新于 ','Updated '),time(usage.observedAt))));
}
function workspaceDetails(usage) {
  return h('details',{ class:'workspace-details' },h('summary',{},tr('工作空间信息','Workspace details')),facts({
    [tr('名称','Name')]:usage.name,
    [tr('工作空间标识','Workspace ID')]:h('code',{},usage.id),
    [tr('创建时间','Created')]:stamp(usage.createdAt),
  }));
}
function launchCard(first = false) {
  return h('div',{ class:'launch-intro' },h('div',{ class:'grow' },h('h2',{},first ? tr('你的第一个应用，从一句指令开始','Your first app starts with one command') : tr('下一个想法，直接做成应用','Turn your next idea into an app')),
    h('p',{},tr('复制指令给你的 agent。脚手架、发布和休眠恢复验证，都已接好。','Give your agent one command. The starter, deployment and idle/recovery check are ready.'))),btn(tr('创建应用','Create app'),()=>goto('launch'),'primary'));
}
async function launchPage(content) {
  const tenant=state.tenant,existing=state.launches.get(tenant.id);
  const response=await fetch('/downloads/cli.json',{cache:'no-store'});
  if(!response.ok)throw Error(tr('初始化工具暂时不可用，请稍后重试。','The setup tool is temporarily unavailable. Please retry.'));
  const distribution=await response.json();
  if(!/^\/downloads\/pneuma-space-cli-\d+\.\d+\.\d+-[a-f0-9]{12}\.tgz$/.test(distribution.path))throw Error('Invalid tool distribution.');
  const name=input({value:existing?.name||'little-shelf',required:true,pattern:'[a-z][a-z0-9-]{0,39}',maxLength:40,autocomplete:'off','aria-label':tr('应用名称','App name')});
  const handoff=h('div',{class:'stack'}),progress=h('div',{class:'launch-progress','aria-live':'polite'});
  let active=existing,checking=false;
  const command=entry=>`echo ${entry.token} | npx --yes --ignore-scripts --package=${location.origin}${distribution.path} pneuma-space start ${entry.name} --origin ${location.origin} --tenant ${tenant.id} --token-stdin`;
  const prompt=entry=>tr(`请在一个新的项目目录里运行下面的命令。它会创建「拾页」有状态示例、安装项目指令和多平台 skill、发布应用，并验证自然休眠后自动恢复。命令包含发布 token，请不要输出或提交它。完成后进入 ${entry.name} 目录读取 AGENTS.md，确认验收结果，然后给我应用地址和访问统计链接，提醒我在已登录工作空间的浏览器里打开。不要重复已经成功的发布或 bench。\n\n${command(entry)}`,`Run this command from a parent directory for a new project. It scaffolds Little Shelf, installs project instructions and skills, publishes the stateful app, and verifies natural idle/recovery. The command contains a publishing token; do not print or commit it. Afterwards, read AGENTS.md in ${entry.name}, confirm the recorded result, and give me the app URL and dashboard statistics link, reminding me to open them in the browser signed into my workspace. Do not repeat an already successful deployment or benchmark.\n\n${command(entry)}`);
  async function copy(value,event){const target=event.currentTarget;try{await navigator.clipboard.writeText(value);target.textContent=tr('已复制','Copied');}catch{const field=textarea(value,'handoff-copy');field.readOnly=true;fill(handoff,h('p',{},tr('请复制下面的内容：','Copy the text below:')),field);field.select();}}
  function drawHandoff(){
    if(!active)return;
    const display=command({...active,token:'<YOUR_PUBLISH_TOKEN>'});
    fill(handoff,h('div',{class:'handoff-card stack'},h('div',{},h('h2',{},tr('接下来，交给你的 agent','Next, hand this to your agent')),h('p',{class:'muted'},tr('Claude Code、Codex、Cursor、Gemini CLI 或其他能运行终端的编程工具。','Claude Code, Codex, Cursor, Gemini CLI, or another coding tool with terminal access.'))),h('pre',{class:'command-preview',tabIndex:0},display),h('div',{class:'toolbar'},btn(tr('复制给 agent','Copy for my agent'),event=>copy(prompt(active),event),'primary'),btn(tr('只复制一行命令','Copy command only'),event=>copy(command(active),event),'ghost')),h('small',{},tr('需要 Node.js 22+ 和 npm。','Requires Node.js 22+ and npm.')),h('small',{},tr('指令内含仅限当前工作空间的发布凭据；仅交给可信工具。到期时间：','The instruction contains a publishing token for this workspace; share it only with a trusted tool. Expires: '),stamp(active.expiresAt)),btn(tr('凭据管理与撤销','Manage or revoke credentials'),()=>goto('team'),'ghost small')));
  }
  const form=submitForm([field(tr('给应用起个名字','Name your app'),name,tr('同时作为新项目文件夹名称。','This will also be the new project folder name.')),h('div',{class:'starter-preview'},h('span',{class:'starter-mark','aria-hidden':'true'},'↳'),h('div',{},h('strong',{},tr('拾页 · 私人灵感收藏夹','Little Shelf · your private idea collection')),h('p',{},tr('可编辑的完整示例：分类、置顶、归档和搜索。内容保存在持久存储中，只有几 KB。','A complete editable starter with collections, pins, archive and search. Its sample state takes only a few KB.')))),h('small',{},tr('自动选择创建、发布、访问和查看状态所需的权限；不授予平台管理或清除权限。','Only create, publish, invoke and read access. No platform administration or purge permission.'))],async()=>{
    const apps=await api(tenantPath('/apps',tenant));
    if(apps.items.some(app=>app.name===name.value))throw Error(tr('这个名称已存在，请给新应用换个名字。','That app name is already used. Choose a new name.'));
    const token=await api(tenantPath('/tokens',tenant),{label:'Development tools / '+name.value,scopes:['read','publish','invoke'],appIds:null});
    active={...token,name:name.value};state.launches.set(tenant.id,active);drawHandoff();form.hidden=true;await poll();return false;
  },tr('创建 token，生成指令','Create token & get command'));
  async function poll(){
    if(!active||checking||!content.isConnected||document.hidden)return;
    checking=true;
    try{
      const list=await api(tenantPath('/apps',tenant)),app=list.items.find(app=>app.name===active.name);
      if(!app){fill(progress,h('h3',{},tr('等待 agent 开始','Waiting for your agent')),h('p',{class:'muted'},tr('把指令粘贴给 agent。这一页会自动显示发布进展，无需反复刷新。','Paste the instruction into your agent. This page will show deployment progress automatically.')));return;}
      const detail=await api('/apps/'+pathId(app.id));
      if(!detail.current){fill(progress,h('h3',{},tr('应用已创建，正在准备发布','App created. Preparing its first release.')),h('p',{class:'muted'},tr('agent 正在上传并发布第一个版本。','Your agent is uploading and publishing the first release.')));return;}
      const verified=detail.usage.sleeps>0&&detail.usage.wakes>1;
      fill(progress,h('h3',{},verified?tr('已记录休眠与再次唤醒','Sleep and another wake are recorded'):tr('应用已上线，正在等待休眠验证','Your app is live. Waiting for the idle check.')),
        h('p',{class:'muted'},verified?tr('打开应用试试，再到统计页看看刚刚发生的访问。数据保留的验证结果由 agent 的 bench 给出。','Try the app, then see the visits in its statistics. Your agent’s benchmark reports whether data was retained.'):tr('先让 agent 完成 bench；此时打开应用可能延后自然休眠。','Let the agent finish the benchmark first. Opening the app now may delay natural idle.')),
        h('div',{class:'toolbar'},h('a',{href:app.url,target:'_blank',rel:'noopener',class:'btn primary'},tr('打开我的应用 ↗','Open my app ↗')),link(tr('查看访问统计','See visit statistics'),`/dashboard?view=projects&app=${pathId(app.id)}&tab=usage`),btn(tr('再创建一个应用','Create another app'),()=>{state.launches.delete(tenant.id);render();},'ghost')));
    }catch(error){fill(progress,errorLine(error),btn(tr('重新检查','Check again'),poll,'ghost small'));}finally{checking=false;}
  }
  append(content,[pagehead(tr('创建应用','Create an app'),tr('从一个真正能用的小产品开始，再把它改成你的想法。','Start with a useful little product, then make it your own.')),
    section(1,tr('准备你的第一个应用','Prepare your app'),tr('不需要 Cloudflare 账号，也不需要先读部署文档。','No Cloudflare account or deployment reading required.'),form,handoff),
    section(2,tr('上线之后，马上体验','Go live, then try it'),tr('在当前已登录的浏览器里体验。访问时启动，闲置后休眠，数据持续保留。','Use your signed-in browser. Starts on access, sleeps when idle, and retains your data.'),progress)]);
  if(active){form.hidden=true;drawHandoff();await poll();}else fill(progress,h('p',{class:'muted'},tr('生成指令后，这里会显示应用上线和休眠恢复的进展。','After you generate the instruction, this area follows deployment and idle/recovery progress.')));
  const timer=setInterval(poll,5000);state.cleanup.push(()=>clearInterval(timer));
}

async function overview(content) {
  if (route().admin) {
    const [overview, apps] = await Promise.all([api('/admin/overview'),api('/admin/apps')]);
    append(content,[pagehead(tr('平台总览','Platform overview'),tr('管理项目、账号与平台资源。','Manage projects, accounts and platform resources.'),btn(tr('刷新','Refresh'),render,'ghost')),
      section(1,tr('平台概况','At a glance'),null,h('div',{ class:'grid metrics' },
        stat(tr('项目','Projects'),overview.apps,tr(`${number(overview.tenants)} 个租户`,`${number(overview.tenants)} tenants`)),
        stat(tr('运行预留','Runtime reservations'),overview.reservedRuntimes,tr('占用中的运行名额','Currently reserved runtime slots')),
        stat(tr('账号','Accounts'),overview.accounts,tr(`${number(overview.disabledAccounts)} 个已停用`,`${number(overview.disabledAccounts)} disabled`)),
        stat(tr('今日请求','Requests today'),overview.requestsToday,tr('按 UTC 日累计','UTC daily total'))),h('div',{ class:'section-meta' },tr('更新于 ','Updated '),time(overview.observedAt))),
      section(2,tr('项目状态','Project state'),tr('打开项目查看版本、运行状态与数据。','Open a project to inspect releases, runtime state and data.'),pager('/admin/apps',apps,appRows))]);
  } else {
    const [apps,usage] = await Promise.all([api(tenantPath('/apps')),api(tenantPath('/usage'))]);
    append(content,[pagehead(tr('工作空间总览','Workspace overview'),tr('发布应用，查看状态与持久数据。','Publish apps and inspect their state and durable data.'),btn(tr('创建应用','Create app'),()=>goto('launch'),'primary')),
      h('div',{class:'launch-banner'},launchCard(!apps.items.length)),
      section(1,tr('用量与配额','Usage & limits'),state.tenant.name,usagePanel(usage),workspaceDetails(usage)),
      section(2,tr('项目','Projects'),tr('应用闲置时休眠，访问时按需启动。','Apps sleep when idle and start on demand.'),pager(tenantPath('/apps'),apps,appRows))]);
  }
}
function recordValue(key,value) {
  if (value == null) return h('span',{ class:'muted' },tr('未记录','Not recorded'));
  if (typeof value === 'boolean') return value ? tr('是','Yes') : tr('否','No');
  if (typeof value === 'number') {
    if (/At$|_at$|^(at|since)$/.test(key)) return time(value);
    return h('span',{ class:'mono' },/[Bb]ytes|Size$/.test(key) ? bytes(value) : number(value));
  }
  if (['status','state'].includes(key) && knownStates[value]) return statusBadge(value);
  if (/^(id|key|path|url|bucket)$|Id$|_id$/.test(key)) return h('code',{},value);
  if (value === 'Open an application for its current runtime state.') return tr('打开项目查看当前运行状态。','Open a project for its current runtime state.');
  return String(value);
}
function recordCards(record) {
  if (record == null) return empty(tr('尚无观测数据。','No observations yet.'));
  if (Array.isArray(record)) return record.length ? h('div',{ class:'record-list' },record.map(value => h('div',{ class:'record-item' },recordCards(value)))) : h('p',{ class:'hint' },tr('暂无记录。','No records.'));
  if (typeof record !== 'object') return h('span',{ class:'wrap' },String(record));
  const scalar = [], nested = [];
  for (const [key,value] of Object.entries(record)) {
    if (value !== null && typeof value === 'object') nested.push([key,value]); else scalar.push([key,value]);
  }
  return h('div',{ class:'record-view' },scalar.length ? facts(scalar.map(([key,value]) => [fieldName(key),recordValue(key,value)])) : null,
    nested.map(([key,value]) => h('div',{ class:'record-group' },h('h3',{},fieldName(key)),recordCards(value))));
}
const labels = {
  read:['读取','Read'],
  publish:['发布','Publish'],
  invoke:['调用','Invoke'],
  manage:['管理','Manage'],
  remove:['下线','Remove'],

  apps:['项目','Projects'],
  accounts:['账号','Accounts'],
  tenants:['租户','Tenants'],
  requests:['请求','Requests'],
  errors:['错误','Errors'],
  wakes:['唤醒','Wakes'],
  sleeps:['休眠','Sleeps'],
  awake:['运行中','Awake'],
  storageBytes:['存储字节','Storage bytes'],
  artifacts:['应用制品','Application artifacts'],
  reservedBytes:['预留字节','Reserved bytes'],
  limitBytes:['字节上限','Byte limit'],
  uploads:['累计上传','Lifetime uploads'],
  maxUploads:['上传上限','Upload limit'],
  requestsPerDay:['每日请求','Requests per day'],
  createdAt:['创建时间','Created'],
  observedAt:['观察时间','Observed'],
  at:['时间','Time'],
  bindings:['绑定','Bindings'],
  resources:['资源','Resources'],
  quota:['配额','Quota'],
  usage:['用量','Usage'],
  runtime:['运行时','Runtime'],
  state:['状态','State'],
  status:['状态','Status'],
  count:['数量','Count'],
  total:['总计','Total'],
  name:['名称','Name'],
  id:['标识','ID'],
  jobs:['任务','Jobs'],
  failures:['失败','Failures'],
  channels:['连接','Channels'],
  sql:['数据库','Database'],
  kv:['键值','KV'],
  files:['文件','Files'],
  object:['对象','Objects'],
  capabilities:['能力','Capabilities'],
  columns:['列','Columns'],
  rowsRead:['读取行','Rows read'],
  rowsWritten:['写入行','Rows written'],
  message:['消息','Message'],
  type:['类型','Type'],
  action:['操作','Action'],
  actorId:['操作者','Actor'],
  tenantId:['租户','Tenant'],
  appId:['项目','Project'],
  userId:['用户','User'],
  expiresAt:['到期时间','Expires'],
  usedAt:['使用时间','Used'],
  revokedAt:['撤销时间','Revoked'],
  generation:['世代','Generation'],
  due:['待执行','Due'],
  delivering:['执行中','Delivering'],
  done:['完成','Done'],
  failed:['失败','Failed'],
  cancelled:['已取消','Cancelled'],
  objects:['对象','Objects'],
  tickets:['票据','Tickets'],
  bytes:['字节','Bytes'],
  tables:['数据表','Tables'],
  rows:['行','Rows'],
  policy:['策略','Policy'],
  lastAccessAt:['最近访问','Last access'],
  since:['开始时间','Since'],
  sleepsAt:['计划休眠','Sleep due'],
  running:['运行中','Running'],
  bootId:['启动标识','Boot ID'],
  databaseSize:['数据库大小','Database size'],
  key:['键','Key'],
  path:['路径','Path'],
  revision:['修订','Revision'],
  contentType:['内容类型','Content type'],
  size:['大小','Size'],
  available:['可用','Available'],
  configured:['已配置','Configured'],
  reason:['原因','Reason'],
  scope:['范围','Scope'],
  data:['数据','Data'],
  method:['方法','Method'],
  scopeId:['范围标识','Scope ID'],
  disabled:['停用','Disabled'],
  platformAdmin:['平台管理员','Platform administrator'],
  username:['用户名','Username'],
  ownerId:['所有者','Owner'],
  url:['地址','Address'],
  release:['版本','Release'],
  number:['版本号','Release'],
  label:['标签','Label'],
  scopes:['权限','Scopes'],
  appIds:['应用范围','Apps'],
  updatedAt:['更新时间','Updated'],
  effective:['有效值','Effective'],
  inventory:['清单','Inventory'],
  limits:['限制','Limits'],
  storage:['存储','Storage'],
  compute:['计算','Compute'],
  directory:['目录','Directory'],
  invitations:['邀请','Invitations'],
  sessions:['会话','Sessions'],
  tokens:['令牌','Tokens'],
  members:['成员','Members'],
  role:['角色','Role'],
  used:['已使用','Used'],
  removed:['已下线','Removed'],
  registered:['已发布','Published'],
  draft:['待发布','Draft'],
  asleep:['休眠','Asleep'],
  quarantined:['已隔离','Quarantined'],
  pending:['待就绪','Pending'],
  ready:['已就绪','Ready'],
  checkedAt:['检查时间','Checked'],
  bucket:['存储桶','Bucket'],
  provider:['服务','Service'],
  disabledAccounts:['已停用账号','Disabled accounts'],
  reservedRuntimes:['运行预留','Runtime reservations'],
  observations:['观测','Observations'],
  cloudflare:['Cloudflare','Cloudflare'],
  containers:['容器','Containers'],
  d1:['D1','D1'],
  r2:['R2','R2'],
  durableObjects:['Durable Objects','Durable Objects'],
  node:['Node','Node'],
  static:['静态','Static'],
  rtc:['RTC','RTC'],
  turn:['TURN','TURN'],
  artifactBucket:['制品桶','Artifact bucket'],
  objectBucket:['对象桶','Object bucket'],
  appCells:['应用单元','App cells'],
  activeReservations:['运行配额预留','Active reservations'],
  reservations:['配额预留','Reservations'],
  observed:['已观测','Observed'],
  summary:['摘要','Summary'],
  recentEvents:['最近事件','Recent events'],
  requestsToday:['今日请求','Requests today'],
  errorsToday:['今日错误','Errors today'],
  storageUsed:['已用存储','Storage used'],
  maxApps:['项目上限','App limit'],
  maxAwake:['运行上限','Awake limit'],
  requestsTodayLimit:['今日请求上限','Daily request limit'],
  storageLimit:['存储上限','Storage limit'],
  returned:['返回条数','Returned'],
  truncated:['已截断','Truncated'],
  nextCursor:['下一页游标','Next cursor'],
  enabled:['已启用','Enabled'],
  bytesUsed:['已用字节','Bytes used'],
  bytesLimit:['字节上限','Byte limit'],
  provisioning:['供应中','Provisioning'],
  errorsCount:['错误数','Error count'],
  nodeRuntime:['Node 运行时','Node runtime'],
  staticRuntime:['静态运行时','Static runtime'],
  lastObservedAt:['最近观测','Last observed'],
  observedApps:['已观测项目','Observed apps'],
  controls:['控制面','Control plane'],
  sampledAt:['采样时间','Sampled'],
  memberships:['成员关系','Memberships'],
  quotas:['配额','Quotas'],
  memory:['内存','Memory'],
  cpu:['CPU','CPU'],
  requestCount:['请求数','Request count'],
  storageSize:['存储大小','Storage size'],
  createdBy:['创建者','Created by'],
  pendingUploads:['待完成上传','Pending uploads'],
  activeUploads:['有效上传','Active uploads'],
  releaseCount:['版本数','Release count'],
  native:['原生资源','Native resources'],
  warning:['提示','Warning'],
  warnings:['提示','Warnings'],
  limitsApplied:['应用限制','Applied limits'],
  source:['来源','Source'],
  updated:['已更新','Updated'],
  deleted:['已删除','Deleted'],
  retained:['已保留','Retained'],
  final:['终态','Terminal'],
  roleRequired:['所需角色','Required role'],
  nextAttemptAt:['下次尝试','Next attempt'],
  scheduledFor:['计划执行','Scheduled'],
  attempts:['尝试次数','Attempts'],
  payload:['载荷','Payload'],
  error:['错误','Error'],
  idleSeconds:['空闲秒数','Idle seconds'],
  requestSeconds:['请求秒数','Request seconds'],
  drainSeconds:['排空秒数','Drain seconds'],
  maxFailures:['失败上限','Failure limit']
};
function fieldName(key) { return labels[key] ? tr(...labels[key]) : key; }
async function projects(content) {
  if (route().app) return projectDetail(content);
  const path = route().admin ? '/admin/apps' : tenantPath('/apps'), result = await api(path);
  const query = input({ type:'search',placeholder:tr('搜索名称或应用标识','Search name or app ID'),'aria-label':tr('搜索项目','Search projects') }), list = h('div');
  const renderList = () => fill(list,appRows(result.items.filter(app => `${app.name} ${app.id}`.toLowerCase().includes(query.value.toLowerCase()))));
  query.addEventListener('input',renderList); renderList();
  append(content,[pagehead(tr('项目','Projects'),tr('版本、运行状态和持久数据在同一个项目中。','Versions, runtime state and durable data in one project.'),!route().admin ? btn(tr('创建应用','Create app'),()=>goto('launch'),'primary') : null,!route().admin ? btn(tr('手动上传','Manual upload'),createProject,'ghost') : null),
    section(1,tr('项目目录','Project directory'),tr('状态来自最近一次观测。','States reflect their latest observation.'),h('div',{ class:'stack' },query,list,result.nextCursor ? pager(path,{ items:[],nextCursor:result.nextCursor },appRows) : null))]);
}
function createProject() {
  const name = input({ required:true,pattern:'[a-z][a-z0-9-]{0,39}',maxLength:40,placeholder:'my-project',autocomplete:'off' });
  const dialog = h('dialog', { 'aria-label':tr('创建项目','Create project') });
  const form = submitForm([field(tr('项目名称','Project name'),name,tr('小写字母开头，最多 40 个小写字母、数字或连字符。','Start with a lowercase letter. Up to 40 lowercase letters, digits or hyphens.'))],async () => {
    const app = await api(tenantPath('/apps'),{ name:name.value }); dialog.close(); goto('projects',{ app:app.id,tab:'publish' }); return false;
  },tr('创建项目','Create project'),{ extra:btn(tr('取消','Cancel'),() => dialog.close(),'ghost') });
  append(dialog,[h('div',{ class:'dialog-body' },h('h2',{},tr('创建项目','Create project')),h('p',{ class:'muted' },tr('先登记项目，再发布一个应用包。','Register a project, then publish an application package.')),form)]);
  dialog.addEventListener('close',() => dialog.remove()); document.body.append(dialog); dialog.showModal(); name.focus();
}
function mayOperate(app) { return state.me.platformAdmin || state.me.tenants.some(tenant => tenant.id === app.tenantId && tenant.role === 'admin') || app.ownerId === state.me.user.id; }
async function projectDetail(content) {
  const app = await api(`/apps/${pathId(route().app)}`);
  if (!content.isConnected) return;
  state.app = app;
  const can = mayOperate(app), tab = route().tab;
  const actions = [];
  if (app.status === 'registered') actions.push(h('a',{ href:app.url,target:'_blank',rel:'noopener',class:'btn ghost' },tr('打开应用 ↗','Open app ↗')));
  actions.push(btn(tr('刷新','Refresh'),render,'ghost'));
  if (can) {
    const entries = [];
    if (app.status === 'registered') {
      if (app.current?.manifest.runtime === 'node') entries.push({ label:tr('强制终止…','Kill runtime…'),note:tr('终止当前运行进程','Stop the current runtime immediately'),danger:true,run:() => confirmAppAction('kill',app) });
      entries.push({ label:tr('下线项目…','Remove project…'),note:tr('停止访问，保留所有数据','Deny access and retain all data'),danger:true,run:() => confirmAppAction('remove',app) });
    }
    if (app.status === 'removed') entries.push({ label:tr('永久清除…','Purge permanently…'),note:tr('删除项目和所有持久数据','Delete this project and all durable data'),danger:true,run:() => confirmAppAction('purge',app) });
    if (entries.length) actions.push(moreMenu(entries));
  }
  const tabs = [['runtime',tr('运行概况','Runtime')],['publish',tr('发布','Publish')],['releases',tr('版本','Releases')],['data',tr('数据','Data')],['jobs',tr('任务','Jobs')],['logs',tr('日志','Logs')],['events',tr('事件','Events')],['usage',tr('用量','Usage')]];
  const detail = h('div');
  append(content,[pagehead(app.name,app.url,...actions),h('div',{ class:'tabs',role:'group','aria-label':tr('项目页面','Project pages') },tabs.filter(([key]) => can || key !== 'publish').map(([key,title]) => h('button',{ type:'button',class:'btn small ghost','aria-pressed':String(tab === key),onclick:() => goto('projects',{ app:app.id,tab:key }) },title))),detail]);
  const pages = { runtime:runtimePage,publish:publishPage,releases:releasesPage,data:dataPage,jobs:jobsPage,logs:diagnosticPage,events:diagnosticPage,usage:appUsagePage };
  await (pages[tab] || runtimePage)(detail,app);
}
async function appAction(action,app) { return api(appPath('/actions',app),action); }
function confirmAppAction(type,app) {
  const text = {
    kill:[tr(`终止 ${app.name}？`,`Kill ${app.name}?`),tr('当前请求可能中断。持久数据保留。下一次访问可重新唤醒应用。','Current requests may be interrupted. Durable data is retained. A later request can wake the app.')],
    remove:[tr(`下线 ${app.name}？`,`Remove ${app.name}?`),tr('停止应用与任务并拒绝访问。所有持久数据和版本保留，可以恢复。','Stop the app and jobs and deny access. Durable data and releases are retained and can be resumed.')],
    purge:[tr(`永久清除 ${app.name}？`,`Permanently purge ${app.name}?`),tr('删除所有版本、数据库、键值、文件和对象。此操作不能撤销。尚未过期的上传票据可能延迟最终清理。','Delete all releases, SQL, KV, files and objects. This cannot be undone. Outstanding upload tickets may delay final cleanup.')],
  };
  approve({ title:text[type][0],description:text[type][1],confirmation:type === 'purge' ? app.name : undefined,action:async () => {
    const result = await appAction(type === 'purge' ? { type,confirmation:app.name } : { type },app);
    if (result.pending) { await render(); const node = document.querySelector('#content'); node?.prepend(h('div',{ class:'notice' },tr('清除正在等待已有上传票据到期。','Purge is waiting for outstanding upload tickets to expire.'),' ',stamp(result.retryAt))); }
    else if (type === 'purge') goto('projects'); else await render();
  } });
}
async function runtimePage(content,app) {
  const controls = h('div',{ class:'toolbar' }), outcome = h('div',{ 'aria-live':'polite' });
  function actionButton(label,type) { return btn(label,async event => {
    const target = event.currentTarget; target.disabled = true;
    try { await appAction({ type },app); await render(); } catch (error) { fill(outcome,errorLine(error)); } finally { target.disabled = false; }
  },'ghost'); }
  if (mayOperate(app)) {
    if (app.status === 'removed') controls.append(actionButton(tr('恢复项目','Resume project'),'resume'));
    if (app.status === 'registered' && app.current?.manifest.runtime !== 'static') {
      if (app.runtime.state === 'quarantined') controls.append(actionButton(tr('解除隔离','Lift quarantine'),'unquarantine'));
      else if (app.runtime.state === 'asleep') controls.append(actionButton(tr('唤醒','Wake'),'wake'));
      else controls.append(actionButton(tr('休眠','Sleep'),'sleep'));
      controls.append(actionButton(tr('重启','Restart'),'restart'));
    }
  }
  append(content,[section(1,tr('当前状态','Current state'),tr('此处读取应用单元的即时状态。','Read directly from the app cell.'),h('div',{ class:'stack' },h('div',{ class:'card row' },h('div',{ class:'grow toolbar' },statusBadge(app.status),statusBadge(app.runtime.state),chip(`g${app.generation}`),app.current ? chip(`r${app.current.number}`) : null),controls),outcome,
    h('div',{ class:'grid' },stat(tr('请求','Requests'),app.usage.requests,tr('应用累计','Application total')),stat(tr('错误','Errors'),app.usage.errors,tr('应用累计','Application total')),stat(tr('唤醒','Wakes'),app.usage.wakes,tr('应用累计','Application total')),stat(tr('休眠','Sleeps'),app.usage.sleeps,tr('应用累计','Application total'))),
    h('div',{ class:'card' },facts({ [tr('应用标识','App ID')]:h('code',{},app.id),[tr('运行状态开始','Runtime state since')]:time(app.runtime.since),[tr('最近访问','Last access')]:time(app.lastAccessAt),[tr('计划休眠','Scheduled sleep')]:app.runtime.sleepsAt ? time(app.runtime.sleepsAt) : tr('未安排','Not scheduled'),[tr('活动请求','Active requests')]:app.runtime.requests,[tr('活动连接','Active channels')]:app.runtime.channels,[tr('失败计数','Failures')]:app.runtime.failures,[tr('当前启动','Current boot')]:app.runtime.bootId ? h('code',{},app.runtime.bootId) : tr('无','None') })))),
    section(2,tr('能力与清单','Capabilities & manifest'),tr('只有清单声明的能力可用于此项目。','Only capabilities declared in the manifest are available to this project.'),h('div',{ class:'card stack' },h('div',{ class:'toolbar' },app.capabilities.map(chip)),app.current ? jsonView(app.current.manifest) : empty(tr('尚未发布清单。','No manifest has been published.')))),
    section(3,tr('运行策略','Runtime policy'),tr('以应用单元返回的有效策略为准。','Effective policy returned by the app cell.'),mayOperate(app) ? policyForm(app) : recordCards(app.policy)),
    section(4,tr('持久数据清单','Durable inventory'),tr('读取清单不会唤醒应用。','Reading the inventory does not wake the app.'),recordCards(await api(appPath('/state',app))))]);
}
function policyForm(app) {
  const fields = Object.fromEntries(Object.entries(app.policy).map(([key,value]) => [key,input({ type:'number',required:true,min:0,step:1,value })]));
  return submitForm([h('div',{ class:'form-grid' },Object.entries(fields).map(([key,node]) => field(fieldName(key),node)))],async () => {
    await appAction({ type:'policy',policy:Object.fromEntries(Object.entries(fields).map(([key,node]) => [key,Number(node.value)])) },app);
  },tr('保存策略','Save policy'));
}
function encode64(bytesValue) {
  let binary = ''; for (let i = 0; i < bytesValue.length; i += 0x8000) binary += String.fromCharCode(...bytesValue.subarray(i,i+0x8000)); return btoa(binary);
}
const text64 = value => encode64(new TextEncoder().encode(value));
function decode64(value) { const binary = atob(value); return Uint8Array.from(binary,char => char.charCodeAt(0)); }
async function directPut(ticket, body) {
  const target = new URL(ticket.url);
  if (target.protocol !== 'https:') throw new Error(tr('上传票据不是 HTTPS 地址。','The upload ticket is not an HTTPS URL.'));
  const response = await fetch(target,{ method:'PUT',headers:ticket.headers,body,credentials:'omit',referrerPolicy:'no-referrer' });
  if (!response.ok) throw new Error(tr(`R2 上传失败（${response.status}）。`,`R2 upload failed (${response.status}).`));
}
async function publishPage(content,app) {
  if (!mayOperate(app)) { content.append(section(1,tr('发布','Publish'),null,empty(tr('此账号无权发布该项目。','This account cannot publish this project.')))); return; }
  if (['purging','purged'].includes(app.status)) { content.append(section(1,tr('发布','Publish'),null,empty(tr('清除中的项目不能发布。','A purging project cannot be published.')))); return; }
  let mode = 'source', selectedPackage = null;
  const modeArea = h('div'), progress = h('div',{ 'aria-live':'polite' });
  const source = textarea("const http = require('node:http');\nconst server = http.createServer((req, res) => {\n  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });\n  res.end('Hello from PneumaSpace');\n});\nserver.listen(Number(process.env.PNEUMA_SPACE_PORT), '0.0.0.0');\n",'editor');
  const entry = input({ value:'server.cjs',required:true,placeholder:'server.cjs' }), capabilities = textarea('{}','mono');
  const raw = textarea('','editor');
  const packageField = fileField('.json,application/json',async file => {
    if (file.size > 4*1024*1024) throw new Error(tr('应用包不能超过 4 MiB。','The application package cannot exceed 4 MiB.'));
    const text = await file.text(); selectedPackage = JSON.parse(text); raw.value = text;
  });
  function showMode() {
    if (mode === 'source') fill(modeArea,h('div',{ class:'stack' },field(tr('入口文件','Entry file'),entry),field(tr('原生能力配置（JSON）','Native capability configuration (JSON)'),capabilities,tr('例如 {"db":{},"kv":{}}。只添加应用实际需要的能力。','For example {"db":{},"kv":{}}. Add capabilities the app actually needs.')),field(tr('Node 入口源码','Node entry source'),source,tr('使用 Node 24；将依赖打包进源码。监听 PNEUMA_SPACE_PORT。','Use Node 24 with bundled dependencies. Listen on PNEUMA_SPACE_PORT.'))));
    else fill(modeArea,h('div',{ class:'stack' },packageField,field(tr('应用包预览与编辑（JSON）','Package preview & editor (JSON)'),raw,tr('包含 manifest 和 files，文件 body 使用 base64。可发布 Node 或静态应用。','Include manifest and files with base64 file bodies. Supports Node and static applications.'))));
  }
  showMode();
  const form = submitForm([segment([['source',tr('编写 Node 源码','Write Node source')],['package',tr('上传应用包','Upload package')]],mode,value => { mode = value; showMode(); },tr('发布方式','Publish method')),modeArea,progress],async () => {
    const pkg = mode === 'source' ? { manifest:{ contract:'pneuma-space.cf/1',runtime:'node',entry:entry.value,capabilities:JSON.parse(capabilities.value) },files:[{ path:entry.value,body:text64(source.value),contentType:'text/javascript' }] } : JSON.parse(raw.value || JSON.stringify(selectedPackage));
    if (!pkg || !pkg.manifest || !Array.isArray(pkg.files)) throw new Error(tr('应用包必须包含 manifest 和 files。','The package must contain manifest and files.'));
    const blob = new Blob([JSON.stringify(pkg)],{ type:'application/json' });
    if (blob.size > 4*1024*1024) throw new Error(tr('应用包不能超过 4 MiB。','The package cannot exceed 4 MiB.'));
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2,'0')).join('');
    fill(progress,h('div',{ class:'notice' },tr('正在申请直接上传票据…','Requesting a direct upload ticket…')));
    const ticket = await api(appPath('/uploads',app),{ manifest:pkg.manifest,digest,bytes:blob.size });
    fill(progress,h('div',{ class:'notice' },tr('正在将应用包直接上传到 R2…','Uploading the package directly to R2…')));
    await directPut(ticket,blob);
    fill(progress,h('div',{ class:'notice' },tr('正在校验应用包并激活版本…','Verifying the package and activating the release…')));
    await api(appPath('/releases',app),{ uploadId:ticket.uploadId });
    goto('projects',{ app:app.id,tab:'releases' }); return false;
  },tr('发布版本','Publish release'));
  append(content,[section(1,tr('发布新版本','Publish a release'),tr('发布保留持久数据。应用包由浏览器直接上传至 R2，平台验证后激活。','Publishing retains durable data. Your browser uploads directly to R2; the platform verifies before activation.'),form)]);
}
async function releasesPage(content,app) {
  const result = await api(appPath('/releases',app));
  function draw(releases) {
    if (!releases.length) return empty(tr('尚无发布版本。','No releases yet.'),mayOperate(app) ? btn(tr('发布首个版本','Publish the first release'),() => goto('projects',{ app:app.id,tab:'publish' }),'primary') : null);
    const columns = [tr('版本','Release'),tr('运行时','Runtime'),tr('创建时间','Created'),tr('应用包','Package'),tr('操作','Action')];
    return h('div',{ class:'table-wrap' },h('table',{},h('thead',{},h('tr',{},columns.map(label => h('th',{},label)))),h('tbody',{},releases.map(release => {
      const values = [h('div',{ class:'toolbar' },chip(`r${release.number}`),release.number === app.current?.number ? statusBadge('active') : null),release.manifest.runtime,time(release.createdAt),h('span',{ class:'mono',title:release.digest },bytes(release.bytes),' · ',release.digest.slice(0,12)),
        mayOperate(app) && release.number !== app.current?.number && app.status === 'registered' ? btn(tr('回滚至此版本','Roll back here'),() => approve({ title:tr(`回滚 ${app.name} 至 r${release.number}？`,`Roll back ${app.name} to r${release.number}?`),description:tr('应用代码回到此版本。持久数据保持当前内容。','App code returns to this release. Durable data keeps its current contents.'),danger:false,action:async () => { await appAction({ type:'rollback',release:release.number },app); await render(); } }),'ghost small') : h('span',{ class:'hint' },release.number === app.current?.number ? tr('当前版本','Current') : '')];
      return h('tr',{},values.map((value,index) => h('td',{ 'data-label':columns[index] },value)));
    }))));
  }
  content.append(section(1,tr('版本历史','Release history'),tr('代码回滚不会回滚持久数据。','Code rollback does not roll back durable data.'),pager(appPath('/releases',app),result,draw)));
}
async function appUsagePage(content,app) {
  content.append(h('div',{class:'usage-toolbar'},h('p',{class:'muted'},tr('每次访问、唤醒和休眠，都会在这里留下实际计数。','Actual requests, wakes and sleeps recorded for this application.')),btn(tr('刷新统计','Refresh statistics'),render,'ghost')),
    section(1,tr('刚刚发生了什么','What happened'),null,h('div',{class:'grid metrics'},stat(tr('访问请求','Requests'),app.usage.requests),stat(tr('唤醒次数','Wakes'),app.usage.wakes),stat(tr('休眠次数','Sleeps'),app.usage.sleeps),stat(tr('请求错误','Request errors'),app.usage.errors)),h('p',{class:'section-meta'},tr('包含页面、资源和 API 请求；bench 的访问也会计入。读取此页不会唤醒应用。','Includes page, asset and API requests, including the benchmark. Viewing these statistics does not wake the app.'))),
    section(2,tr('当前运行状态','Current runtime state'),null,h('div',{class:'card row'},statusBadge(app.runtime.state),h('p',{class:'muted'},tr(`连续闲置 ${app.policy.idleSeconds} 秒后自动休眠。`,`Sleeps automatically after ${app.policy.idleSeconds} idle seconds.`)),h('a',{href:app.url,target:'_blank',rel:'noopener',class:'btn ghost'},tr('访问应用 ↗','Visit app ↗')))),
    section(3,tr('更多用量详情','More usage details'),null,recordCards(await api(appPath('/usage',app)))));
}
async function native(command,app) { return api(appPath('/data',app),command); }
async function dataPage(content,app) {
  const available = app.capabilities.filter(value => ['db','kv','files','object','rtc'].includes(value));
  if (!available.length) { content.append(section(1,tr('持久数据','Durable data'),null,empty(tr('此项目尚未声明持久数据能力。','This project has not declared durable data capabilities.')))); return; }
  const pane = h('div'), error = h('div'); let capability = available[0];
  async function show(value) {
    capability = value; fill(pane); fill(error);
    try { await ({ db:sqlPane,kv:kvPane,files:filesPane,object:objectsPane,rtc:rtcPane }[capability])(pane,app); }
    catch (failure) { fill(error,errorLine(failure)); }
  }
  append(content,[section(1,tr('原生数据','Native data'),tr('操作通过项目的原生能力接口执行；数据库与文件使用持久存储。','Operate through the app’s native capability API. SQL and files use durable storage.'),h('div',{ class:'stack' },segment(available.map(value => [value,fieldName(value)]),capability,show,tr('数据能力','Data capability')),error,pane))]);
  await show(capability);
}
async function sqlPane(pane,app) {
  const perform = command => native(command,app);
  let mode = 'query';
  const sql = textarea("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",'editor'), params = textarea('[]','mono'), result = h('div',{ 'aria-live':'polite' });
  const sqlField = field(tr('SQL 语句','SQL statement'),sql), paramsField = field(tr('参数（JSON 数组）','Parameters (JSON array)'),params);
  const form = submitForm([segment([['query',tr('单条语句','Single statement')],['batch',tr('原子批处理','Atomic batch')]],mode,value => {
    mode = value;
    if (mode === 'batch') { sql.value = '[\n  { "sql": "SELECT 1", "params": [] }\n]'; sqlField.firstChild.textContent = tr('语句列表（JSON）','Statements (JSON)'); paramsField.hidden = true; }
    else { sql.value = 'SELECT 1'; sqlField.firstChild.textContent = tr('SQL 语句','SQL statement'); paramsField.hidden = false; }
  },tr('查询方式','Query mode')),sqlField,paramsField],async () => {
    const command = mode === 'query' ? { type:'db.query',sql:sql.value,params:JSON.parse(params.value) } : { type:'db.batch',statements:JSON.parse(sql.value) };
    const value = await perform(command); fill(result,h('div',{ class:'card stack' },h('h3',{},tr('执行结果','Result')),jsonView(value))); return false;
  },tr('执行 SQL','Execute SQL'));
  append(pane,[h('div',{ class:'stack' },h('div',{ class:'notice' },tr('修改语句会直接改变项目数据。查询结果受平台行数与字节限制。','Write statements change project data immediately. Platform row and byte limits apply to query results.')),form,result)]);
}
async function kvPane(pane,app) {
  const perform = command => native(command,app);
  const prefix = input({ placeholder:tr('键前缀','Key prefix'),'aria-label':tr('键前缀','Key prefix') }), list = h('div'), listError = h('div');
  const key = input({ required:true,placeholder:'settings' }), value = textarea('{}','mono'), expected = input({ type:'number',min:0,placeholder:tr('留空忽略；0 表示仅新建','Blank ignores; 0 means create only') }), ttl = input({ type:'number',min:1,placeholder:tr('留空永久保存','Blank keeps indefinitely') }), amount = input({ type:'number',value:1,required:true });
  const result = h('div',{ 'aria-live':'polite' }); let mode = 'put';
  async function load(cursor) {
    const response = await perform({ type:'kv.list',prefix:prefix.value,...(cursor ? { cursor } : {}) });
    const rows = dataRows(response.items,'kv',async entry => {
      key.value = entry.key; const record = await perform({ type:'kv.get',key:entry.key }); fill(result,jsonView(record));
      if (record) { value.value = JSON.stringify(record.value,null,2); expected.value = record.revision; }
    },async entry => { await perform({ type:'kv.delete',key:entry.key,...(entry.revision != null ? { expected:entry.revision } : {}) }); await load(); });
    fill(list,rows,response.nextCursor ? btn(tr('下一页','Next page'),() => loadSafe(response.nextCursor),'ghost small') : null);
  }
  async function loadSafe(cursor) { try { await load(cursor); fill(listError); } catch (failure) { fill(listError,errorLine(failure)); } }
  const extra = h('div');
  function show() { fill(extra,...(mode === 'put' ? [field(tr('值（JSON）','Value (JSON)'),value),h('div',{ class:'form-grid' },field(tr('预期修订','Expected revision'),expected),field(tr('存活秒数','TTL seconds'),ttl))] : mode === 'increment' ? [field(tr('增量','Amount'),amount)] : mode === 'publish' ? [field(tr('消息（JSON）','Message (JSON)'),value)] : [])); }
  show();
  const form = submitForm([segment([['get',tr('读取','Read')],['put',tr('写入','Write')],['increment',tr('递增','Increment')],['publish',tr('发布消息','Publish message')]],mode,value => { mode = value; show(); },tr('键值操作','KV operation')),field(tr('键或频道','Key or channel'),key),extra],async () => {
    let command;
    if (mode === 'get') command = { type:'kv.get',key:key.value };
    if (mode === 'put') command = { type:'kv.put',key:key.value,value:JSON.parse(value.value),...(expected.value !== '' ? { expected:Number(expected.value) === 0 ? null : Number(expected.value) } : {}),...(ttl.value ? { ttl:Number(ttl.value) } : {}) };
    if (mode === 'increment') command = { type:'kv.increment',key:key.value,amount:Number(amount.value) };
    if (mode === 'publish') command = { type:'kv.publish',channel:key.value,value:JSON.parse(value.value) };
    fill(result,jsonView(await perform(command))); if (mode !== 'publish') await loadSafe(); return false;
  },tr('执行','Run'));
  append(pane,[h('div',{ class:'stack' },h('div',{ class:'toolbar' },h('div',{ class:'grow' },prefix),btn(tr('列出键','List keys'),() => loadSafe(),'ghost')),listError,list,h('div',{ class:'card stack' },h('h3',{},tr('键值操作','KV operation')),form,result))]);
  await loadSafe();
}
function dataRows(entries,kind,open,remove) {
  if (!entries.length) return empty(tr('没有匹配的数据。','No matching data.'));
  return h('div',{ class:'stack' },entries.map(entry => {
    const key = typeof entry === 'string' ? entry : entry.key || entry.path || entry.name;
    const normalized = typeof entry === 'string' ? (kind === 'files' ? { path:entry } : { key:entry }) : entry;
    const response = h('div',{ 'aria-live':'polite' });
    return h('div',{ class:'card' },h('div',{ class:'row' },h('div',{ class:'grow' },h('div',{ class:'mono wrap row-title' },key),h('div',{ class:'meta' },entry.revision != null ? chip(`rev ${entry.revision}`) : null,entry.bytes != null ? h('small',{},bytes(entry.bytes)) : null,entry.expiresAt ? h('small',{},tr('到期 ','Expires '),time(entry.expiresAt)) : null)),h('div',{ class:'toolbar' },btn(kind === 'object' ? tr('下载','Download') : tr('读取','Read'),async event => {
      const target = event.currentTarget; target.disabled = true; try { const opened = await open(normalized); fill(response,opened instanceof Node ? opened : null); } catch (failure) { fill(response,errorLine(failure)); } finally { target.disabled = false; }
    },'ghost small'),remove ? moreMenu([{ label:tr('删除…','Delete…'),note:tr('永久删除此记录','Permanently delete this record'),danger:true,run:() => approve({ title:tr(`删除 ${key}？`,`Delete ${key}?`),description:tr('此记录会从项目的持久数据中删除，不能撤销。','This record will be deleted from the app’s durable data. This cannot be undone.'),action:() => remove(normalized) }) }]) : null)),response);
  }));
}
async function filesPane(pane,app) {
  const perform = command => native(command,app);
  const prefix = input({ placeholder:tr('路径前缀','Path prefix'),'aria-label':tr('路径前缀','Path prefix') }), path = input({ required:true,placeholder:'notes/readme.txt' }), revision = input({ type:'number',min:0,placeholder:tr('留空忽略；0 表示仅新建','Blank ignores; 0 means create only') }), text = textarea('','editor');
  const list = h('div'), outcome = h('div'), result = h('div'); let selectedBytes = null;
  const file = fileField('',async source => {
    if (source.size > 65536) throw new Error(tr('持久文件不能超过 64 KiB。','Durable files cannot exceed 64 KiB.'));
    selectedBytes = new Uint8Array(await source.arrayBuffer()); if (!path.value) path.value = source.name;
  });
  text.addEventListener('input',() => { selectedBytes = null; });
  async function load(cursor) {
    const response = await perform({ type:'files.list',prefix:prefix.value,...(cursor ? { cursor } : {}) });
    fill(list,dataRows(response.items,'files',async entry => {
      const record = await perform({ type:'files.get',path:entry.path }); if (!record) { fill(result,empty(tr('文件不存在。','File not found.'))); return; }
      path.value = record.path; revision.value = record.revision; selectedBytes = decode64(record.body); text.value = new TextDecoder().decode(selectedBytes);
      const blob = new Blob([selectedBytes],{ type:'application/octet-stream' });
      fill(result,h('div',{ class:'card stack' },facts({ [tr('路径','Path')]:record.path,[tr('修订','Revision')]:record.revision,[tr('大小','Size')]:bytes(record.bytes) }),btn(tr('下载原文件','Download original'),() => downloadBlob(blob,record.path.split('/').pop()),'ghost small')));
    },async entry => { await perform({ type:'files.delete',path:entry.path,...(entry.revision != null ? { expected:entry.revision } : {}) }); await load(); }),response.nextCursor ? btn(tr('下一页','Next page'),() => loadSafe(response.nextCursor),'ghost') : null);
  }
  async function loadSafe(cursor) { try { await load(cursor); fill(outcome); } catch (failure) { fill(outcome,errorLine(failure)); } }
  const form = submitForm([field(tr('相对路径','Relative path'),path),field(tr('文本内容','Text contents'),text,tr('编辑文本会替换所选文件的原始字节。','Editing this text replaces the selected file’s original bytes.')),file,field(tr('预期修订','Expected revision'),revision)],async () => {
    const body = selectedBytes || new TextEncoder().encode(text.value); if (body.length > 65536) throw new Error(tr('文件不能超过 64 KiB。','Files cannot exceed 64 KiB.'));
    const saved = await perform({ type:'files.put',path:path.value,body:encode64(body),...(revision.value !== '' ? { expected:Number(revision.value) === 0 ? null : Number(revision.value) } : {}) });
    fill(result,jsonView(saved)); await loadSafe(); return false;
  },tr('保存文件','Save file'));
  append(pane,[h('div',{ class:'stack' },h('div',{ class:'toolbar' },h('div',{ class:'grow' },prefix),btn(tr('列出文件','List files'),() => loadSafe(),'ghost')),outcome,list,h('div',{ class:'card stack' },h('h3',{},tr('持久文件','Durable file')),form),result)]); await loadSafe();
}
function downloadBlob(blob,name) { const url = URL.createObjectURL(blob), a = h('a',{ href:url,download:name }); a.click(); setTimeout(() => URL.revokeObjectURL(url),30000); }
async function objectsPane(pane,app) {
  const perform = command => native(command,app);
  const key = input({ required:true,placeholder:'images/photo.png' }), prefix = input({ placeholder:tr('对象键前缀','Object key prefix'),'aria-label':tr('对象键前缀','Object key prefix') }), list = h('div'), outcome = h('div'); let selected = null;
  async function load(cursor) {
    const response = await perform({ type:'object.list',prefix:prefix.value,...(cursor ? { cursor } : {}) });
    fill(list,dataRows(response.items,'object',async entry => {
      const ticket = await perform({ type:'object.download',key:entry.key }); const url = new URL(ticket.url);
      if (url.protocol !== 'https:') throw new Error(tr('下载票据不是 HTTPS 地址。','The download ticket is not an HTTPS URL.'));
      return h('a',{ href:url.href,target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer',class:'btn ghost small gap' },tr('打开限时下载链接 ↗','Open temporary download link ↗'));
    },async entry => { await perform({ type:'object.delete',key:entry.key }); await load(); }),response.nextCursor ? btn(tr('下一页','Next page'),() => loadSafe(response.nextCursor),'ghost') : null);
  }
  async function loadSafe(cursor) { try { await load(cursor); fill(outcome); } catch (failure) { fill(outcome,errorLine(failure)); } }
  const upload = submitForm([field(tr('对象键','Object key'),key),fileField('',file => { selected = file; if (!key.value) key.value = file.name; })],async () => {
    if (!selected) throw new Error(tr('请选择要上传的文件。','Choose a file to upload.'));
    const ticket = await perform({ type:'object.upload',key:key.value,bytes:selected.size,contentType:selected.type || 'application/octet-stream' });
    await directPut(ticket,selected); const complete = await perform({ type:'object.complete',id:ticket.id }); await loadSafe(); return h('div',{ class:'notice' },tr('对象上传已完成。','Object upload completed.'),complete.bytes != null ? ` ${bytes(complete.bytes)}` : '');
  },tr('直接上传到 R2','Upload directly to R2'));
  append(pane,[h('div',{ class:'stack' },h('div',{ class:'notice' },tr('对象字节直接在浏览器与 R2 之间传输。下载地址是限时票据。','Object bytes transfer directly between your browser and R2. Download URLs are time-limited tickets.')),h('div',{ class:'toolbar' },h('div',{ class:'grow' },prefix),btn(tr('列出对象','List objects'),() => loadSafe(),'ghost')),outcome,list,h('div',{ class:'card stack' },h('h3',{},tr('上传对象','Upload object')),upload))]); await loadSafe();
}
async function rtcPane(pane,app) {
  const perform = command => native(command,app);
  const outcome = h('div');
  append(pane,[h('div',{ class:'stack' },h('p',{ class:'muted' },tr('获取实际的短时 ICE 配置。未配置 TURN 时，服务会明确拒绝。','Request real short-lived ICE configuration. The service refuses when TURN is not configured.')),btn(tr('获取 ICE 配置','Get ICE configuration'),async event => {
    const target = event.currentTarget; target.disabled = true; try { fill(outcome,jsonView(await perform({ type:'rtc.credentials' }))); } catch (failure) { fill(outcome,errorLine(failure)); } finally { target.disabled = false; }
  },'ghost'),outcome)]);
}
async function jobsPage(content,app) {
  const deliveries = await api(appPath('/jobs',app)), triggers = app.current?.manifest.capabilities.cron?.triggers || {};
  if (mayOperate(app) && Object.keys(triggers).length && app.status === 'registered') {
    let selected = Object.keys(triggers)[0]; const payload = textarea('{}','mono');
    const form = submitForm([field(tr('触发器','Trigger'),listbox(Object.entries(triggers).map(([name,trigger]) => [name,`${name}${trigger.schedule ? ` · ${trigger.schedule} UTC` : ''}`]),selected,value => selected = value,tr('选择触发器','Choose trigger'))),field(tr('载荷（JSON）','Payload (JSON)'),payload)],async () => jsonView(await api(appPath('/jobs',app),{ name:selected,payload:JSON.parse(payload.value) })),tr('手动调用','Invoke manually'));
    content.append(section(1,tr('调用任务','Invoke a job'),tr('调用会创建持久投递记录，可能唤醒应用。','Invoking creates a persistent delivery and may wake the app.'),form));
  }
  function draw(rows) {
    if (!rows.length) return empty(tr('还没有任务投递。','No job deliveries yet.'));
    const columns = [tr('任务','Job'),tr('状态','State'),tr('计划时间','Scheduled'),tr('尝试','Attempts'),tr('诊断','Diagnostics')];
    return h('div',{ class:'table-wrap' },h('table',{},h('thead',{},h('tr',{},columns.map(label => h('th',{},label)))),h('tbody',{},rows.map(row => h('tr',{},[
      h('div',{ class:'stack' },h('span',{ class:'mono' },row.name),h('small',{ class:'mono' },row.id)),statusBadge(row.state),time(row.scheduledFor),row.attempts,
      h('div',{ class:'stack' },row.error ? h('span',{ class:'danger-note wrap' },row.error) : h('span',{ class:'hint' },tr('无错误记录','No error recorded')),row.state === 'due' ? h('small',{},tr('下次尝试 ','Next attempt '),time(row.nextAttemptAt)) : null),
    ].map((value,index) => h('td',{ 'data-label':columns[index] },value)))))));
  }
  content.append(section(2,tr('投递历史','Delivery history'),tr('至少送达一次；每次投递保留标识与尝试次数。','At-least-once delivery with persisted IDs and attempt counts.'),h('div',{ class:'toolbar gap' },btn(tr('刷新记录','Refresh history'),render,'ghost small')),h('div',{ class:'gap' },pager(appPath('/jobs',app),deliveries,draw))));
}
function diagnosticRows(rows,kind) {
  if (!rows.length) return empty(tr('暂无记录。','No records yet.'));
  return h('div',{},[...rows].sort((a,b) => b.at-a.at).map(row => h('div',{ class:'logline' },h('span',{ class:'hint mono' },time(row.at)),h('span',{ class:'mono' },row.level || row.type || kind),h('div',{ class:'wrap' },h('span',{},row.message || row.action || row.type),row.data ? h('details',{},h('summary',{ class:'hint' },tr('详情','Details')),jsonView(row.data)) : null))));
}
async function diagnosticPage(content,app) {
  const kind = route().tab, endpoint = appPath(`/${kind}`,app), response = await api(endpoint);
  if (!content.isConnected) return;
  const stream = h('div',{ class:'card stream',tabIndex:0 }), query = input({ type:'search',placeholder:tr('筛选记录','Filter records'),'aria-label':tr('筛选记录','Filter records') }), indicator = h('span',{ class:'st good' },tr('实时','Live')), outcome = h('div'), held = btn('',() => { if (pending) { records = pending; pending = null; draw(); } held.hidden = true; },'ghost small');
  let records = response.items, pending = null, paused = false, hovering = false, fetching = false;
  const latest = h('small');
  held.hidden = true;
  function draw() { fill(stream,diagnosticRows(records.filter(row => JSON.stringify(row).toLowerCase().includes(query.value.toLowerCase())),kind)); fill(latest,records.length ? time(Math.max(...records.map(row => row.at))) : tr('尚无到达记录','No arrivals yet')); }
  query.addEventListener('input',draw); stream.addEventListener('mouseenter',() => hovering = true); stream.addEventListener('mouseleave',() => hovering = false); draw();
  const pause = btn(tr('暂停','Pause'),() => { paused = !paused; pause.textContent = paused ? tr('继续','Resume') : tr('暂停','Pause'); indicator.textContent = paused ? tr('已暂停','Paused') : tr('实时','Live'); indicator.className = `st ${paused ? '' : 'good'}`; },'ghost small');
  const timer = setInterval(async () => {
    if (!content.isConnected) { clearInterval(timer); return; }
    if (paused || document.hidden || fetching) return;
    fetching = true;
    try {
      const next = await api(endpoint); indicator.textContent = tr('实时','Live'); indicator.className = 'st good'; fill(outcome);
      if (JSON.stringify(next.items) === JSON.stringify(records)) return;
      if (hovering || stream.scrollTop > 0) { pending = next.items; held.hidden = false; held.textContent = tr('有新记录，点击更新','New records, click to update'); }
      else { records = next.items; draw(); }
    } catch (error) { indicator.textContent = tr('离线','Offline'); indicator.className = 'st bad'; fill(outcome,errorLine(error)); } finally { fetching = false; }
  },5000);
  state.cleanup.push(() => clearInterval(timer));
  content.append(section(1,kind === 'logs' ? tr('运行日志','Runtime logs') : tr('项目事件','Project events'),tr('每 5 秒读取。悬停或向下滚动时，更新会保留在到达提示后。','Read every 5 seconds. Hovering or scrolling holds updates behind an arrival prompt.'),h('div',{ class:'stack' },h('div',{ class:'toolbar stream-toolbar' },indicator,latest,pause,held),query,outcome,stream,response.nextCursor ? pager(endpoint,{ items:[],nextCursor:response.nextCursor },rows => diagnosticRows(rows,kind)) : null)));
}
async function teamPage(content) {
  const tenant = state.tenant, path = suffix => tenantPath(suffix,tenant);
  const [members,tokens,apps] = await Promise.all([api(path('/members')),api(path('/tokens')),api(path('/apps'))]);
  const can = canManageTenant(), tokenSecret = h('div');
  const userId = input({ required:true,placeholder:'usr_…' }); let memberRole = 'member';
  const memberForm = can ? submitForm([h('div',{ class:'form-grid' },field(tr('用户标识','User ID'),userId),field(tr('角色','Role'),segment([['member',tr('成员','Member')],['admin',tr('管理员','Administrator')]],memberRole,value => memberRole = value,tr('成员角色','Member role'))))],async () => {
    await api(path('/members'),{ userId:userId.value,role:memberRole }); await render(); return false;
  },tr('添加或更新成员','Add or update member')) : null;
  function memberRows(rows) {
    if (!rows.length) return empty(tr('没有成员记录。','No membership records.'));
    return h('div',{ class:'stack' },rows.map(member => h('div',{ class:'card' },h('div',{ class:'row' },h('div',{ class:'grow' },h('div',{ class:'row-title' },member.name || member.username),h('div',{ class:'meta' },h('code',{},member.userId),chip(word(member.role)),member.username ? h('small',{},member.username) : null)),can ? moreMenu([
      { label:member.role === 'admin' ? tr('设为成员…','Make member…') : tr('设为管理员…','Make administrator…'),note:tr('服务端保护最后一名管理员','The server protects the last administrator'),run:() => approve({ title:tr(`修改 ${member.name || member.username} 的角色？`,`Change the role of ${member.name || member.username}?`),description:tr('新角色立即生效。','The new role takes effect immediately.'),danger:false,action:async () => { await api(path('/members'),{ userId:member.userId,role:member.role === 'admin' ? 'member' : 'admin' }); await render(); } }) },
      { label:tr('移除成员…','Remove member…'),note:tr('撤销此租户的成员权限','Revoke membership in this tenant'),danger:true,run:() => approve({ title:tr(`移除 ${member.name || member.username}？`,`Remove ${member.name || member.username}?`),description:tr('此用户将失去该租户的成员权限。','This user loses membership access to this tenant.'),action:async () => { await api(path(`/members/${pathId(member.userId)}`),undefined,'DELETE'); await render(); } }) },
    ]) : null))));
  }
  const label = input({ required:true,maxLength:80,placeholder:tr('例如，部署流水线','For example, deployment pipeline') }), expiration = input({ type:'datetime-local',required:true,value:localDate(Date.now()+30*86400000) });
  const scopes = ['read'], appIds = []; let scopeMode = 'all';
  const restrict = h('div',{ hidden:true },toggles(apps.items.map(app => [app.id,app.name]),appIds,null,tr('限制项目','Restrict apps')));
  const tokenForm = submitForm([field(tr('凭据标签','Credential label'),label),field(tr('权限','Actions'),toggles([['read',tr('读取','Read')],['publish',tr('发布','Publish')],['invoke',tr('调用','Invoke')],['manage',tr('管理','Manage')],['remove',tr('下线','Remove')],['data',tr('数据','Data')]],scopes,null,tr('令牌权限','Token actions'))),
    field(tr('应用范围','Application scope'),segment([['all',tr('全部项目','All apps')],['selected',tr('指定项目','Selected apps')]],scopeMode,value => { scopeMode = value; restrict.hidden = value !== 'selected'; },tr('令牌应用范围','Token app scope'))),restrict,field(tr('到期时间','Expires at'),expiration,tr('使用本地时间输入。','Enter in local time.'))],async () => {
      if (!scopes.length) throw new Error(tr('至少选择一个权限。','Choose at least one action.'));
      if (scopeMode === 'selected' && !appIds.length) throw new Error(tr('至少选择一个项目。','Choose at least one app.'));
      const value = await api(path('/tokens'),{ label:label.value,scopes,appIds:scopeMode === 'all' ? null : appIds,expiresAt:new Date(expiration.value).getTime() });
      fill(tokenSecret,secretCard(value.token)); return false;
  },tr('创建令牌','Create token'));
  function tokenRows(rows) {
    if (!rows.length) return empty(tr('尚无访问令牌。','No access tokens yet.'));
    return h('div',{ class:'stack' },rows.map(token => h('div',{ class:'card row' },h('div',{ class:'grow' },h('div',{ class:'row-title' },token.label),h('div',{ class:'meta' },statusBadge(token.revokedAt ? 'revoked' : token.expiresAt <= Date.now() ? 'expired' : 'active'),h('code',{},token.id),token.scopes.map(scope => chip(fieldName(scope)))),h('div',{ class:'hint gap' },token.appIds ? token.appIds.join(' · ') : tr('全部项目','All apps'),' · ',tr('到期 ','Expires '),time(token.expiresAt))),!token.revokedAt ? moreMenu([{ label:tr('撤销令牌…','Revoke token…'),note:tr('此凭据立即失效','This credential stops working immediately'),danger:true,run:() => approve({ title:tr(`撤销 ${token.label}？`,`Revoke ${token.label}?`),description:tr('使用该令牌的自动化将无法再访问平台。','Automation using this token can no longer access the platform.'),action:async () => { await api(path(`/tokens/${pathId(token.id)}`),undefined,'DELETE'); await render(); } }) }]) : null)));
  }
  append(content,[pagehead(tr('团队与凭据','Team & credentials'),tr('成员角色与令牌范围由服务端执行。','The server enforces membership roles and token scopes.')),
    section(1,tr('团队成员','Team members'),tr('租户至少保留一名管理员。添加成员需要已存在用户的标识。','A tenant retains at least one administrator. Adding a member requires an existing user ID.'),h('div',{ class:'stack' },memberForm,pager(path('/members'),members,memberRows))),
    section(2,tr('作用域令牌','Scoped tokens'),tr('令牌不能管理账号、凭据或永久清除数据。新令牌只显示一次。','Tokens cannot manage accounts or credentials or purge data. New tokens are shown once.'),h('div',{ class:'stack' },tokenSecret,tokenForm,pager(path('/tokens'),tokens,tokenRows)))]);
}
function localDate(ms) { const date = new Date(ms); return new Date(ms-date.getTimezoneOffset()*60000).toISOString().slice(0,16); }
async function accountsPage(content) {
  const response = await api('/admin/accounts');
  function draw(rows) {
    if (!rows.length) return empty(tr('暂无账号。','No accounts.'));
    return h('div',{ class:'stack' },rows.map(account => h('div',{ class:'card row' },h('span',{ class:'avatar' },account.name.slice(0,1)),h('div',{ class:'grow' },h('div',{ class:'row-title' },account.name),h('div',{ class:'meta' },h('code',{},account.username),statusBadge(account.disabled ? 'disabled' : 'active'),account.platformAdmin ? chip(tr('平台管理员','Platform administrator')) : null),h('div',{ class:'hint gap' },h('code',{},account.id),' · ',tr('创建于 ','Created '),time(account.createdAt))),moreMenu([
      { label:account.platformAdmin ? tr('取消平台管理员…','Remove platform administration…') : tr('设为平台管理员…','Grant platform administration…'),note:tr('服务端保留最后一名管理员','The server preserves the last administrator'),run:() => approve({ title:tr(`修改 ${account.username} 的平台角色？`,`Change the platform role of ${account.username}?`),description:account.platformAdmin ? tr('此用户将失去平台管理权限。','This user loses platform administration rights.') : tr('此用户将能管理全部账号、租户与项目。','This user can manage all accounts, tenants and projects.'),danger:account.platformAdmin,action:async () => { await api(`/admin/accounts/${pathId(account.id)}`,{ platformAdmin:!account.platformAdmin },'PATCH'); await render(); } }) },
      { label:account.disabled ? tr('启用账号…','Enable account…') : tr('停用账号…','Disable account…'),note:account.disabled ? tr('恢复登录权限','Restore sign-in access') : tr('撤销账号访问权限','Revoke account access'),danger:!account.disabled,run:() => approve({ title:account.disabled ? tr(`启用 ${account.username}？`,`Enable ${account.username}?`) : tr(`停用 ${account.username}？`,`Disable ${account.username}?`),description:account.disabled ? tr('用户可重新使用有效访问密钥登录。','The user can sign in again with a valid access key.') : tr('此用户的会话和凭据将无法访问平台。','This user’s sessions and credentials can no longer access the platform.'),danger:!account.disabled,action:async () => { await api(`/admin/accounts/${pathId(account.id)}`,{ disabled:!account.disabled },'PATCH'); await render(); } }) },
    ]))));
  }
  append(content,[pagehead(tr('账号','Accounts'),tr('邀请创建普通账号；平台管理员角色在此维护。','Invitations create ordinary accounts. Maintain platform roles here.')),section(1,tr('账号目录','Account directory'),tr('最后一名有效管理员受服务端保护。','The server protects the last active administrator.'),pager('/admin/accounts',response,draw))]);
}
async function invitationsPage(content) {
  const response = await api('/admin/invitations'), expiration = input({ type:'datetime-local',required:true,value:localDate(Date.now()+7*86400000) }), secret = h('div');
  const form = submitForm([field(tr('到期时间','Expires at'),expiration,tr('邀请只能兑换一次，过期后不能使用。','An invitation can be redeemed once and cannot be used after expiry.'))],async () => {
    const result = await api('/admin/invitations',{ expiresAt:new Date(expiration.value).getTime() });
    fill(secret,secretCard(result.url,tr('邀请链接只显示一次，请保存后发送给受邀者。','The invitation link is shown once. Save it before sending it to the invitee.'))); return false;
  },tr('创建邀请','Create invitation'));
  function draw(rows) {
    if (!rows.length) return empty(tr('尚无邀请。','No invitations yet.'));
    return h('div',{ class:'stack' },rows.map(invite => h('div',{ class:'card row' },h('div',{ class:'grow' },h('div',{ class:'toolbar' },h('code',{},invite.id),statusBadge(invite.revokedAt ? 'revoked' : invite.consumedAt ? 'done' : invite.expiresAt <= Date.now() ? 'expired' : 'active')),h('div',{ class:'hint gap' },tr('创建于 ','Created '),time(invite.createdAt),' · ',tr('到期 ','Expires '),time(invite.expiresAt),invite.consumedAt ? h('span',{},' · ',tr('已兑换 ','Redeemed '),time(invite.consumedAt)) : null)),!invite.revokedAt && !invite.consumedAt && invite.expiresAt > Date.now() ? moreMenu([{ label:tr('撤销邀请…','Revoke invitation…'),note:tr('链接将不能再被兑换','The link can no longer be redeemed'),danger:true,run:() => approve({ title:tr('撤销此邀请？','Revoke this invitation?'),description:tr('持有此链接的人将无法创建账号。','Anyone holding this link can no longer create an account.'),action:async () => { await api(`/admin/invitations/${pathId(invite.id)}`,undefined,'DELETE'); await render(); } }) }]) : null)));
  }
  append(content,[pagehead(tr('邀请','Invitations'),tr('仅限邀请注册，邀请兑换后获得独立租户。','Registration is invite-only. Redemption creates a private tenant.')),section(1,tr('新邀请','New invitation'),null,h('div',{ class:'stack' },secret,form)),section(2,tr('邀请记录','Invitation records'),tr('列表不包含邀请密钥。','This list contains no invitation secrets.'),pager('/admin/invitations',response,draw))]);
}
async function tenantsPage(content) {
  const response = await api('/admin/tenants');
  function editQuota(tenant) {
    const dialog = h('dialog',{ 'aria-label':tr('修改租户配额','Change tenant quotas') }), fields = Object.fromEntries(Object.entries(tenant.quota).map(([key,value]) => [key,input({ type:'number',min:0,step:1,value,required:true })]));
    const form = submitForm([h('div',{ class:'form-grid' },Object.entries(fields).map(([key,node]) => field(fieldName(key),node)))],async () => {
      await api(`/admin/tenants/${pathId(tenant.id)}`,{ quota:Object.fromEntries(Object.entries(fields).map(([key,node]) => [key,Number(node.value)])) },'PATCH'); dialog.close(); await render(); return false;
    },tr('保存配额','Save quotas'),{ extra:btn(tr('取消','Cancel'),() => dialog.close(),'ghost') });
    append(dialog,[h('div',{ class:'dialog-body' },h('h2',{},tenant.name),h('p',{ class:'muted' },tr('变更由服务端校验，不代表已测得的资源利用率。','The server validates changes. Quotas are not measured resource utilization.')),form)]); dialog.addEventListener('close',() => dialog.remove()); document.body.append(dialog); dialog.showModal();
  }
  function draw(rows) {
    if (!rows.length) return empty(tr('暂无租户。','No tenants.'));
    return h('div',{ class:'stack' },rows.map(tenant => h('div',{ class:'card stack' },h('div',{ class:'row' },h('div',{ class:'grow' },h('div',{ class:'row-title' },tenant.name),h('div',{ class:'meta' },h('code',{},tenant.id),time(tenant.createdAt))),moreMenu([{ label:tr('修改配额…','Change quotas…'),note:tr('项目、并发运行、请求与存储额度','Apps, concurrent compute, requests and storage'),run:() => editQuota(tenant) }])),facts({
      [tr('项目 / 配额','Apps / quota')]:`${tenant.used.apps} / ${tenant.quota.apps}`,
      [tr('运行预留 / 配额','Compute reservations / quota')]:`${tenant.used.awake} / ${tenant.quota.awake}`,
      [tr('存储预留 / 配额','Reserved storage / quota')]:`${bytes(tenant.used.storageBytes)} / ${bytes(tenant.quota.storageBytes)}`,
      [tr('每日请求配额','Daily request quota')]:tenant.quota.requestsPerDay,
    }))));
  }
  append(content,[pagehead(tr('租户与配额','Tenants & quotas'),tr('存储用量在此表示预留额度，不是数据库实测大小。','Storage usage here represents reserved capacity, not measured database size.')),section(1,tr('租户','Tenants'),tr('配额修改即时提交给服务端。','Quota changes are submitted to the server immediately.'),pager('/admin/tenants',response,draw))]);
}
async function resourcesPage(content) {
  const resources = await api('/admin/resources');
  append(content,[pagehead(tr('平台资源','Platform resources'),tr('Cloudflare 绑定、资源清单与已采集的状态。','Cloudflare bindings, resource inventory and collected state.'),btn(tr('刷新','Refresh'),render,'ghost')),section(1,tr('实际资源','Observed resources'),tr('未采集的指标不显示为正常，也不生成估算值。','Uncollected metrics are not reported as healthy or replaced with estimates.'),recordCards(resources))]);
}
function auditRows(rows) {
  if (!rows.length) return empty(tr('暂无审计记录。','No audit records.'));
  return h('div',{ class:'stack' },[...rows].sort((a,b) => b.at-a.at).map(record => h('div',{ class:'card stack' },h('div',{ class:'row' },h('div',{ class:'grow toolbar' },chip(record.action || record.type || record.event),record.actorId ? h('code',{},record.actorId) : null),h('small',{},time(record.at || record.createdAt))),facts(Object.fromEntries(Object.entries(record).filter(([key]) => !['action','type','at','createdAt','actorId','data','id'].includes(key)).map(([key,value]) => [fieldName(key),typeof value === 'object' ? JSON.stringify(value) : value]))),record.data ? h('details',{},h('summary',{ class:'hint' },tr('详情','Details')),jsonView(record.data)) : null)));
}
async function auditPage(content) {
  const path = route().admin ? '/admin/audit' : tenantPath('/audit'), response = await api(path);
  append(content,[pagehead(tr('审计','Audit'),tr('已授权操作的实际记录。','Actual records of authorized operations.')),section(1,tr('操作记录','Operation records'),null,pager(path,response,auditRows))]);
}
async function activityPage(content) {
  const [events,audit] = await Promise.all([api(tenantPath('/events')),api(tenantPath('/audit'))]);
  append(content,[pagehead(tr('活动','Activity'),tr('租户事件与操作记录。','Tenant events and operation records.'),btn(tr('刷新','Refresh'),render,'ghost')),section(1,tr('事件','Events'),null,pager(tenantPath('/events'),events,rows => h('div',{ class:'card' },diagnosticRows(rows,'event')))),section(2,tr('审计','Audit'),null,pager(tenantPath('/audit'),audit,auditRows))]);
}
async function tenantUsage(content) {
  const usage = await api(tenantPath('/usage'));
  append(content,[pagehead(tr('用量','Usage'),tr('实际请求累计与已分配的资源额度。','Actual request totals and allocated resource capacity.')),section(1,tr('用量与限制','Usage & limits'),tr('预留存储额度不代表实测的数据大小。','Reserved storage capacity is not measured data size.'),usagePanel(usage),workspaceDetails(usage))]);
}
function applyPreferences() { document.documentElement.dataset.theme = state.theme; document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en'; }
function loginDestination(me) {
  const next = new URLSearchParams(location.search).get('next');
  if (next && next.startsWith('/') && !next.startsWith('//')) {
    const url = new URL(next,location.origin);
    if (url.origin === location.origin && (url.pathname.startsWith('/apps/') || url.pathname === '/admin' && me.platformAdmin || url.pathname === '/dashboard')) return url.pathname+url.search;
  }
  return me.platformAdmin ? '/admin' : '/dashboard';
}
function authPage(redeem) {
  const code = new URLSearchParams(location.search).get('code') || '', account = input({ required:true,autocomplete:'username',maxLength:80,placeholder:tr('账号用户名','Account username') }), key = input({ type:'password',required:true,autocomplete:'current-password',placeholder:tr('账号访问密钥','Account access key') }), username = input({ required:true,autocomplete:'username',pattern:'[a-z][a-z0-9_-]{2,31}',minLength:3,maxLength:32,placeholder:'your-name' }), name = input({ required:true,autocomplete:'name',maxLength:100,placeholder:tr('你的姓名','Your name') }), invite = input({ type:'password',required:true,value:code,autocomplete:'off' });
  const body = h('div',{ class:'stack' });
  const form = submitForm(redeem ? [field(tr('邀请代码','Invitation code'),invite),field(tr('用户名','Username'),username,tr('3 至 32 个小写字母、数字、下划线或连字符，字母开头。','3 to 32 lowercase letters, digits, underscores or hyphens, starting with a letter.')),field(tr('显示名称','Display name'),name)] : [field(tr('账号','Account'),account),field(tr('访问密钥','Access key'),key)],async () => {
    const result = await api(redeem ? '/auth/redeem' : '/auth/login',redeem ? { invite:invite.value,username:username.value,name:name.value } : { account:account.value,key:key.value });
    state.me = result;
    if (redeem) {
      state.redeemed = result;
      history.replaceState({},'', '/invite');
      fill(body,secretCard(result.accessKey,tr('账号已创建。请保存访问密钥，之后不会再显示。','Account created. Save your access key. It will not be shown again.')),facts({ [tr('用户名','Username')]:result.user.username,[tr('显示名称','Display name')]:result.user.name }),btn(tr('已保存，进入工作空间','Saved, open workspace'),() => location.assign('/dashboard'),'primary')); return false;
    }
    location.assign(loginDestination(result)); return false;
  },redeem ? tr('兑换邀请','Redeem invitation') : tr('登录','Sign in'));
  if (redeem && state.redeemed) {
    const result = state.redeemed;
    fill(body,state.secrets.has(result.accessKey) ? secretCard(result.accessKey,tr('账号已创建。请保存访问密钥，之后不会再显示。','Account created. Save your access key. It will not be shown again.')) : h('div',{ class:'notice' },tr('访问密钥已保存。','Access key saved.')),facts({ [tr('用户名','Username')]:result.user.username,[tr('显示名称','Display name')]:result.user.name }),btn(tr('已保存，进入工作空间','Saved, open workspace'),() => location.assign('/dashboard'),'primary'));
  } else fill(body,form);
  fill(root,h('div',{ class:'auth-shell' },h('div',{ class:'card auth-card' },brand(tr('私有应用工作空间','Private application workspace')),h('div',{ class:'auth-head' },h('h1',{},redeem ? tr('接受邀请','Accept invitation') : tr('登录 PneumaSpace','Sign in to PneumaSpace')),h('p',{ class:'muted' },redeem ? tr('创建账号及专属租户。邀请仅可使用一次。','Create an account and your private tenant. This invitation can be used once.') : tr('使用账号和访问密钥继续。注册需要管理员邀请。','Continue with your account and access key. Registration requires an administrator invitation.'))),body,h('div',{ class:'auth-foot' },redeem ? link(tr('已有账号，前往登录','Already have an account? Sign in'),'/login') : h('small',{},tr('请妥善保存访问密钥。','Keep your access key private.')),settingsControls()))));
}
async function render() {
  const epoch = ++state.epoch; state.cleanup.splice(0).forEach(cleanup => cleanup()); applyPreferences();
  if (location.pathname === '/login' || location.pathname === '/invite') { authPage(location.pathname === '/invite'); return; }
  try {
    if (!state.me) state.me = await api('/me');
    if (epoch !== state.epoch) return;
    if (route().admin && !state.me.platformAdmin) {
      fill(root,h('div',{ class:'auth-shell' },h('div',{ class:'card auth-card' },brand(tr('平台管理','Platform administration')),h('h1',{},tr('需要平台管理权限','Platform administration required')),h('p',{ class:'muted' },tr('当前账号不能访问平台后台。服务端仍会对每个接口独立授权。','This account cannot access platform administration. The server independently authorizes every API.')),link(tr('进入工作空间','Open workspace'),'/dashboard')))); return;
    }
    const remembered = sessionStorage.getItem('pneuma-space.tenant');
    state.tenant = state.me.tenants.find(tenant => tenant.id === (state.tenant?.id || remembered)) || state.me.tenants[0] || null;
    const content = shell();
    if (!route().admin && !state.tenant) { content.append(pagehead(tr('工作空间','Workspace')),section(1,tr('租户','Tenant'),null,empty(tr('此账号没有租户成员关系，请联系管理员。','This account has no tenant membership. Contact an administrator.')))); return; }
    const loading = h('div',{ class:'loading',role:'status' },tr('正在读取…','Loading…')); content.append(loading);
    const current = route(), adminPages = { overview,projects,accounts:accountsPage,invitations:invitationsPage,tenants:tenantsPage,resources:resourcesPage,audit:auditPage }, tenantPages = { overview,projects,launch:launchPage,activity:activityPage,usage:tenantUsage,team:teamPage };
    try { await ((current.admin ? adminPages : tenantPages)[current.view] || overview)(content); }
    catch (error) { if (epoch === state.epoch) content.append(section(0,tr('无法读取此页面','Could not load this page'),null,errorLine(error),h('div',{ class:'gap' },btn(tr('重试','Retry'),render,'ghost')))); }
    finally { loading.remove(); }
    document.title = `${current.app && state.app ? state.app.name : tr('控制台','Console')} · PneumaSpace`;
  } catch (error) {
    if (error.status === 401) { const next = encodeURIComponent(location.pathname+location.search); location.assign(`/login?next=${next}`); }
    else fill(root,h('div',{ class:'auth-shell' },h('div',{ class:'card auth-card' },brand('Cloudflare edition'),h('h1',{},tr('暂时无法连接','Unable to connect')),errorLine(error),btn(tr('重试','Retry'),render,'primary'))));
  }
}
document.addEventListener('pointerdown',event => {
  document.querySelectorAll('.listbox,.more').forEach(control => {
    if (event.target instanceof Node && !control.contains(event.target)) { control.querySelector('.menu')?.setAttribute('hidden',''); control.querySelector('[aria-expanded]')?.setAttribute('aria-expanded','false'); }
  });
});
window.addEventListener('popstate',render);
setInterval(() => document.querySelectorAll('time[data-at]').forEach(node => { const at = node.getAttribute('data-at'); if (at !== null && at !== '') node.textContent = ago(Number(at)); }),1000);
render();
