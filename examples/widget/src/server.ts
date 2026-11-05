import { randomUUID } from 'node:crypto';
import { db } from '../sdk/db.ts';
import { body, serve } from '../sdk/serve.ts';
import type { Context } from '../sdk/serve.ts';
import { pickLang, switchLang, translate } from '../ui/i18n.ts';
import type { T } from '../ui/i18n.ts';
import { esc, page } from '../ui/page.ts';

const dict = {
  en: {
    title: 'Daily notes', card: 'Note count', about: 'Recounted every minute, which keeps this app awake.',
    today: 'Today', week: '7 days', total: 'All', updated: 'Updated {ago}', never: 'Not counted yet',
    justNow: 'just now', minutes: '{n} min ago', hours: '{n} h ago', days: '{n} d ago',
    placeholder: 'Write a note', add: 'Add', signIn: 'Sign in to add notes',
    ownerOnly: 'Only the owner adds notes.', todayNotes: 'Today\'s notes', empty: 'No notes today.',
  },
  zh: {
    title: '每日笔记', card: '笔记计数', about: '每分钟重新统计一次，所以这个应用会一直保持唤醒。',
    today: '今天', week: '近 7 天', total: '全部', updated: '更新于{ago}', never: '尚未统计',
    justNow: '刚刚', minutes: '{n} 分钟前', hours: '{n} 小时前', days: '{n} 天前',
    placeholder: '写一条笔记', add: '添加', signIn: '登录后添加笔记',
    ownerOnly: '只有所有者可以添加笔记。', todayNotes: '今天的笔记', empty: '今天还没有笔记。',
  },
};

const sql = db();
await sql.exec(`CREATE TABLE IF NOT EXISTS note (
  id TEXT PRIMARY KEY, author TEXT NOT NULL, body TEXT NOT NULL, day TEXT NOT NULL, created_at TEXT NOT NULL)`);
await sql.exec(`CREATE TABLE IF NOT EXISTS card (
  slot TEXT PRIMARY KEY, today INTEGER NOT NULL, week INTEGER NOT NULL, total INTEGER NOT NULL, computed_at TEXT NOT NULL)`);

type Card = { today: number; week: number; total: number; computed_at: string | null };
type Note = { body: string; created_at: string };

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function count(where: string, params: string[]) {
  const [row] = await sql.query<{ n: number }>(`SELECT CAST(count(*) AS INTEGER) AS n FROM note ${where}`, params);
  return Number(row.n);
}

async function refresh() {
  const [today, week, total] = [await count('WHERE day = ?', [day()]), await count('WHERE day > ?', [day(-7)]), await count('', [])];
  await sql.exec(
    `INSERT INTO card (slot, today, week, total, computed_at) VALUES ('latest', ?, ?, ?, ?)
     ON CONFLICT (slot) DO UPDATE SET today = excluded.today, week = excluded.week, total = excluded.total, computed_at = excluded.computed_at`,
    [today, week, total, new Date().toISOString()]);
}

async function latest(): Promise<Card> {
  const [row] = await sql.query<Card>('SELECT today, week, total, computed_at FROM card WHERE slot = ?', ['latest']);
  return row ? { ...row, today: Number(row.today), week: Number(row.week), total: Number(row.total) } : { today: 0, week: 0, total: 0, computed_at: null };
}

function ago(t: T, iso: string | null) {
  if (!iso) return t('never');
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  const when = minutes < 1 ? t('justNow') : minutes < 60 ? t('minutes', { n: minutes }) : minutes < 1440 ? t('hours', { n: Math.floor(minutes / 60) }) : t('days', { n: Math.floor(minutes / 1440) });
  return t('updated', { ago: when });
}

async function home({ req, res, prefix, identity }: Context) {
  const lang = pickLang(req);
  const t = translate(dict, lang);
  const c = await latest();
  const tile = (key: 'today' | 'week' | 'total') => `<div><span>${esc(t(key))}</span><b data-kpi="${key}">${c[key]}</b></div>`;
  let owner = `<a class="btn primary" href="/_pneuma-space/login?next=${encodeURIComponent(prefix + '/')}">${esc(t('signIn'))}</a>`;
  if (identity && !identity.owner) owner = `<p class="hint">${esc(t('ownerOnly'))}</p>`;
  if (identity?.owner) {
    const notes = await sql.query<Note>('SELECT body, created_at FROM note WHERE day = ? ORDER BY created_at DESC LIMIT 10', [day()]);
    const items = notes.map((n) => `<li><time class="mono" datetime="${esc(n.created_at)}">${esc(n.created_at.slice(11, 16))}</time><span>${esc(n.body)}</span></li>`).join('');
    owner = `<form class="row" method="post" action="${esc(prefix)}/notes"><input name="body" required maxlength="280" autocomplete="off" placeholder="${esc(t('placeholder'))}"><button class="primary">${esc(t('add'))}</button></form>
<h3>${esc(t('todayNotes'))}</h3>${items ? `<ul class="notes">${items}</ul>` : `<p class="empty">${esc(t('empty'))}</p>`}`;
  }
  const body = `<section>
<header><h2>${esc(t('card'))}</h2><p>${esc(t('about'))}</p></header>
<div class="card widget">
<div class="kpis">${tile('today')}${tile('week')}${tile('total')}</div>
<p class="updated"><time id="updated" datetime="${esc(c.computed_at ?? '')}">${esc(ago(t, c.computed_at))}</time><a class="mono" href="${esc(prefix)}/card.json">card.json</a></p>
${owner}
</div>
</section>`;
  const head = `<link rel="stylesheet" href="${esc(prefix)}/app.css"><script defer src="${esc(prefix)}/app.js"></script>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page({ prefix, lang, dict, title: t('title'), body, head, badge: 'example' }));
}

async function cardJson({ res }: Context) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=60', 'access-control-allow-origin': '*' })
    .end(JSON.stringify(await latest()));
}

async function addNote({ req, res, prefix, identity }: Context) {
  if (!identity?.owner) return void res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(translate(dict, pickLang(req))('ownerOnly'));
  const text = new URLSearchParams((await body(req)).toString()).get('body')?.trim().slice(0, 280);
  if (text) {
    await sql.exec('INSERT INTO note (id, author, body, day, created_at) VALUES (?, ?, ?, ?, ?)',
      [randomUUID(), identity.subject, text, day(), new Date().toISOString()]);
  }
  res.writeHead(303, { location: `${prefix}/` }).end();
}

const routes: Readonly<Record<string, (ctx: Context) => Promise<void>>> = {
  'GET /': home, 'GET /card.json': cardJson, 'POST /notes': addNote,
};

serve(async (ctx) => {
  if (switchLang(ctx)) return;
  const route = routes[`${ctx.req.method} ${ctx.url.pathname}`];
  if (route) return route(ctx);
  ctx.res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}, { triggers: { refresh } });
