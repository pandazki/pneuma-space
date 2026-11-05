import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../sdk/db.ts';
import { need } from '../sdk/env.ts';
import { body, serve } from '../sdk/serve.ts';
import type { Context, Identity } from '../sdk/serve.ts';
import { pickLang, switchLang, translate } from '../ui/i18n.ts';
import type { Lang, T } from '../ui/i18n.ts';
import { esc, page } from '../ui/page.ts';

const QUESTIONS = [
  { id: 'q1', options: ['great', 'ok', 'poor'] },
  { id: 'q2', options: ['office', 'hybrid', 'remote'] },
  { id: 'q3', options: ['pay', 'growth', 'culture'] },
] as const;
type Answer = Record<(typeof QUESTIONS)[number]['id'], string>;

const dict = {
  en: {
    title: 'Company survey', survey: 'Survey', results: 'Results',
    yourAnswer: 'Your answer', yourAnswerAbout: 'Three questions, one choice each. You can change your answer at any time.',
    signedIn: 'Signed in as {name}', answered: 'Answered {at}', notAnswered: 'Not answered yet', saved: 'Answer saved',
    incomplete: 'Choose one option for every question', submit: 'Submit', update: 'Update answer',
    q1: 'How satisfied are you working here?', 'q1.great': 'Great', 'q1.ok': 'Okay', 'q1.poor': 'Poor',
    q2: 'Where do you work most days?', 'q2.office': 'Office', 'q2.hybrid': 'Hybrid', 'q2.remote': 'Remote',
    q3: 'What should we improve first?', 'q3.pay': 'Pay', 'q3.growth': 'Growth', 'q3.culture': 'Culture',
    downloads: 'Downloads', downloadsAbout: 'The live CSV is built on request. The nightly export is written to /data at 02:00 UTC.',
    liveCsv: 'Live CSV', lastExport: 'Last export', exportedAt: 'Exported {at}', noExport: 'No export yet',
    tally: 'Answers', tallyAbout: '{n} people answered.',
    ownerOnly: 'Only the owner of this survey can see the results.', exportMissing: 'The nightly export has not run yet.',
    notFound: 'This page does not exist.', back: 'Back to the survey',
  },
  zh: {
    title: '公司问卷', survey: '问卷', results: '结果',
    yourAnswer: '你的回答', yourAnswerAbout: '三个问题，每题选一项。随时可以修改。',
    signedIn: '当前登录：{name}', answered: '已于 {at} 回答', notAnswered: '尚未回答', saved: '回答已保存',
    incomplete: '每个问题都要选一项', submit: '提交', update: '更新回答',
    q1: '你在这里工作满意吗？', 'q1.great': '很满意', 'q1.ok': '一般', 'q1.poor': '不满意',
    q2: '你平时主要在哪里办公？', 'q2.office': '办公室', 'q2.hybrid': '混合', 'q2.remote': '远程',
    q3: '最先应该改进什么？', 'q3.pay': '薪酬', 'q3.growth': '成长', 'q3.culture': '文化',
    downloads: '下载', downloadsAbout: '实时 CSV 在请求时生成；每晚导出在 UTC 02:00 写入 /data。',
    liveCsv: '实时 CSV', lastExport: '最近导出', exportedAt: '导出于 {at}', noExport: '还没有导出',
    tally: '回答统计', tallyAbout: '共 {n} 人回答。',
    ownerOnly: '只有问卷所有者能查看结果。', exportMissing: '每晚导出还没有运行过。',
    notFound: '页面不存在。', back: '返回问卷',
  },
};

const files = need('files').dir;
const exportFile = join(files, 'export.csv');
const sql = db();
await sql.exec('CREATE TABLE IF NOT EXISTS answer (subject TEXT PRIMARY KEY, q1 TEXT, q2 TEXT, q3 TEXT, submitted_at TEXT)');

const csvCell = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replaceAll('"', '""')}"`;

async function csv(): Promise<string> {
  const rows = await sql.query<Record<string, string>>('SELECT subject, q1, q2, q3, submitted_at FROM answer ORDER BY subject');
  return ['subject,q1,q2,q3,submitted_at', ...rows.map((r) => [r.subject, r.q1, r.q2, r.q3, r.submitted_at].map((v) => csvCell(String(v))).join(','))].join('\n') + '\n';
}

async function exportCsv() {
  const tmp = `${exportFile}.tmp`;
  await writeFile(tmp, await csv());
  await rename(tmp, exportFile);
}

const when = (lang: Lang, iso: string | Date) =>
  `${new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso))} UTC`;

function render({ req, res, prefix, identity }: Context, status: number, view: (t: T, lang: Lang) => string, current?: 'survey' | 'results') {
  const lang = pickLang(req);
  const t = translate(dict, lang);
  const nav = [{ href: `${prefix}/`, label: t('survey'), current: current === 'survey' }];
  if (identity?.owner) nav.push({ href: `${prefix}/results`, label: t('results'), current: current === 'results' });
  const head = `<link rel="stylesheet" href="${esc(prefix)}/app.css">`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    .end(page({ prefix, lang, dict, title: t('title'), body: view(t, lang), head, nav, badge: 'example' }));
}

const notice = (ctx: Context, status: number, key: string) => render(ctx, status, (t) => `<section>
<p class="empty">${esc(t(key))}<br><a href="${esc(ctx.prefix)}/">${esc(t('back'))}</a></p>
</section>`);

function survey(ctx: Context, mine: Partial<Answer> & { submitted_at?: string }, status: number, note?: 'saved' | 'incomplete') {
  const { prefix, identity } = ctx;
  render(ctx, status, (t, lang) => {
    const state = note === 'incomplete' ? `<span class="status red">${esc(t('incomplete'))}</span>`
      : note === 'saved' ? `<span class="status green">${esc(t('saved'))}</span>`
      : mine.submitted_at ? `<span class="status green">${esc(t('answered', { at: when(lang, mine.submitted_at) }))}</span>`
      : `<span class="status">${esc(t('notAnswered'))}</span>`;
    const cards = QUESTIONS.map((q) => `<fieldset class="card"><legend>${esc(t(q.id))}</legend><div class="choices">${q.options.map((o) =>
      `<label><input type="radio" name="${q.id}" value="${o}" required${mine[q.id] === o ? ' checked' : ''}>${esc(t(`${q.id}.${o}`))}</label>`).join('')}</div></fieldset>`).join('');
    return `<section>
<header><h2>${esc(t('yourAnswer'))}</h2><p>${esc(t('yourAnswerAbout'))}</p></header>
<p class="row">${state}<span class="status">${esc(t('signedIn', { name: identity!.name }))}</span></p>
<form method="post" action="${esc(prefix)}/answer"><div class="questions">${cards}</div>
<button class="primary">${esc(t(mine.submitted_at ? 'update' : 'submit'))}</button></form>
</section>`;
  }, 'survey');
}

async function mine(identity: Identity) {
  const [row] = await sql.query<Answer & { submitted_at: string }>('SELECT q1, q2, q3, submitted_at FROM answer WHERE subject = ?', [identity.subject]);
  return row ?? {};
}

async function answer(ctx: Context) {
  const form = new URLSearchParams((await body(ctx.req)).toString());
  const values = QUESTIONS.map((q) => form.get(q.id) ?? '');
  if (!QUESTIONS.every((q, i) => (q.options as readonly string[]).includes(values[i]))) {
    return survey(ctx, { ...(await mine(ctx.identity!)), ...Object.fromEntries(QUESTIONS.map((q, i) => [q.id, values[i]])) }, 400, 'incomplete');
  }
  await sql.exec(`INSERT INTO answer (subject, q1, q2, q3, submitted_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (subject) DO UPDATE SET q1 = excluded.q1, q2 = excluded.q2, q3 = excluded.q3, submitted_at = excluded.submitted_at`,
  [ctx.identity!.subject, ...values, new Date().toISOString()]);
  ctx.res.writeHead(303, { location: `${ctx.prefix}/?saved=1` }).end();
}

async function results(ctx: Context) {
  const [{ n: total }] = await sql.query<{ n: number }>('SELECT CAST(count(*) AS INTEGER) AS n FROM answer');
  const counts = await Promise.all(QUESTIONS.map(async (q) => new Map((await sql.query<{ v: string; n: number }>(
    `SELECT ${q.id} AS v, CAST(count(*) AS INTEGER) AS n FROM answer GROUP BY ${q.id}`)).map((r) => [r.v, Number(r.n)]))));
  const exported = await stat(exportFile).then((s) => s.mtime, () => null);
  const { prefix } = ctx;
  render(ctx, 200, (t, lang) => {
    const last = exported
      ? `<a class="btn" href="${esc(prefix)}/export.csv">${esc(t('lastExport'))}</a><span class="status green">${esc(t('exportedAt', { at: when(lang, exported) }))}</span>`
      : `<span class="status">${esc(t('noExport'))}</span>`;
    const cards = QUESTIONS.map((q, i) => `<div class="card"><b>${esc(t(q.id))}</b><dl class="bars">${q.options.map((o) => {
      const n = counts[i].get(o) ?? 0;
      const share = total ? Math.round((n / total) * 100) : 0;
      return `<dt>${esc(t(`${q.id}.${o}`))}</dt><dd><div class="bar"><i style="width:${share}%"></i></div></dd><dd class="num count">${n}</dd><dd class="num">${share}%</dd>`;
    }).join('')}</dl></div>`).join('');
    return `<section>
<header><h2>${esc(t('tally'))}</h2><p>${esc(t('tallyAbout', { n: total }))}</p></header>
<div class="questions">${cards}</div>
</section>
<section>
<header><h2>${esc(t('downloads'))}</h2><p>${esc(t('downloadsAbout'))}</p></header>
<p class="row downloads"><a class="btn primary" href="${esc(prefix)}/results.csv">${esc(t('liveCsv'))}</a>${last}</p>
</section>`;
  }, 'results');
}

const attachment = (ctx: Context, name: string, text: string) =>
  ctx.res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` }).end(text);

const routes: Record<string, (ctx: Context) => unknown> = {
  'GET /': async (ctx) => survey(ctx, await mine(ctx.identity!), 200, ctx.url.searchParams.has('saved') ? 'saved' : undefined),
  'POST /answer': answer,
  'GET /results': results,
  'GET /results.csv': async (ctx) => attachment(ctx, 'results.csv', await csv()),
  'GET /export.csv': async (ctx) => {
    const text = await readFile(exportFile, 'utf8').catch(() => null);
    return text === null ? notice(ctx, 404, 'exportMissing') : attachment(ctx, 'export.csv', text);
  },
};
const ownerOnly = new Set(['GET /results', 'GET /results.csv', 'GET /export.csv']);

serve(async (ctx) => {
  if (switchLang(ctx)) return;
  const key = `${ctx.req.method} ${ctx.url.pathname}`;
  if (!Object.hasOwn(routes, key)) return notice(ctx, 404, 'notFound');
  if (ownerOnly.has(key) && !ctx.identity?.owner) return notice(ctx, 403, 'ownerOnly');
  await routes[key](ctx);
}, { triggers: { export: exportCsv } });
