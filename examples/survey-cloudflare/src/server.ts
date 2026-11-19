import { randomUUID } from 'node:crypto';
import { body, serve } from '../sdk/serve.ts';
import type { Context } from '../sdk/serve.ts';
import { pickLang, switchLang, translate } from '../ui/i18n.ts';
import type { Lang, T } from '../ui/i18n.ts';
import { esc, page } from '../ui/page.ts';
import { store } from './store.ts';
import type { Answer, SavedAnswer } from './store.ts';

const questions = [
  { id: 'q1', options: ['great', 'ok', 'poor'] },
  { id: 'q2', options: ['office', 'hybrid', 'remote'] },
  { id: 'q3', options: ['pay', 'growth', 'culture'] },
] as const;
const dict = {
  en: {
    title: 'Company survey', survey: 'Survey', results: 'Results', yourAnswer: 'Your answer',
    yourAnswerAbout: 'Three questions, one choice each. You can change your answer at any time.',
    signedIn: 'Signed in as {name}', answered: 'Answered {at}', notAnswered: 'Not answered yet', saved: 'Answer saved',
    incomplete: 'Choose one option for every question', submit: 'Submit', update: 'Update answer',
    q1: 'How satisfied are you working here?', 'q1.great': 'Great', 'q1.ok': 'Okay', 'q1.poor': 'Poor',
    q2: 'Where do you work most days?', 'q2.office': 'Office', 'q2.hybrid': 'Hybrid', 'q2.remote': 'Remote',
    q3: 'What should we improve first?', 'q3.pay': 'Pay', 'q3.growth': 'Growth', 'q3.culture': 'Culture',
    downloads: 'Exports', downloadsAbout: 'Only the owner can save an export. Your browser builds the CSV and transfers it directly to R2.',
    saveExport: 'Save export', downloadExport: 'Download saved export', localCsv: 'Download CSV locally',
    noExport: 'No saved export', unavailable: 'R2 export is unavailable until scoped signing credentials are configured.',
    tally: 'Answers', tallyAbout: '{n} people answered.', ownerOnly: 'Only the survey owner can see results.',
    notFound: 'This page does not exist.', back: 'Back to the survey',
  },
  zh: {
    title: '公司问卷', survey: '问卷', results: '结果', yourAnswer: '你的回答',
    yourAnswerAbout: '三个问题，每题选一项。随时可以修改。',
    signedIn: '当前登录：{name}', answered: '已于 {at} 回答', notAnswered: '尚未回答', saved: '回答已保存',
    incomplete: '每个问题都要选一项', submit: '提交', update: '更新回答',
    q1: '你在这里工作满意吗？', 'q1.great': '很满意', 'q1.ok': '一般', 'q1.poor': '不满意',
    q2: '你平时主要在哪里办公？', 'q2.office': '办公室', 'q2.hybrid': '混合', 'q2.remote': '远程',
    q3: '最先应该改进什么？', 'q3.pay': '薪酬', 'q3.growth': '成长', 'q3.culture': '文化',
    downloads: '导出', downloadsAbout: '只有所有者可以保存导出。浏览器生成 CSV，并直接传输到 R2。',
    saveExport: '保存导出', downloadExport: '下载已保存的导出', localCsv: '本地下载 CSV',
    noExport: '没有已保存的导出', unavailable: '配置专用签名凭证后才能使用 R2 导出。',
    tally: '回答统计', tallyAbout: '共 {n} 人回答。', ownerOnly: '只有问卷所有者能查看结果。',
    notFound: '页面不存在。', back: '返回问卷',
  },
};
const when = (lang: Lang, iso: string) =>
  `${new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso))} UTC`;
function render(ctx: Context, status: number, view: (t: T, lang: Lang) => string, current?: 'survey' | 'results') {
  const lang = pickLang(ctx.req);
  const t = translate(dict, lang);
  const nav = [{ href: '/', label: t('survey'), current: current === 'survey' }];
  if (ctx.identity?.owner) nav.push({ href: '/results', label: t('results'), current: current === 'results' });
  const head = '<link rel="stylesheet" href="/app.css">';
  ctx.res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(page({
    prefix: '', lang, dict, title: t('title'), body: view(t, lang), head, nav, badge: 'example',
  }));
}
function survey(ctx: Context, mine: Partial<SavedAnswer>, status: number, note?: 'saved' | 'incomplete') {
  render(ctx, status, (t, lang) => {
    const state = note === 'incomplete' ? t('incomplete') : note === 'saved' ? t('saved')
      : mine.submittedAt ? t('answered', { at: when(lang, mine.submittedAt) }) : t('notAnswered');
    const cards = questions.map((q) => `<fieldset class="card"><legend>${esc(t(q.id))}</legend><div class="choices">${q.options.map((o) =>
      `<label><input type="radio" name="${q.id}" value="${o}" required${mine[q.id] === o ? ' checked' : ''}>${esc(t(`${q.id}.${o}`))}</label>`).join('')}</div></fieldset>`).join('');
    return `<section><header><h2>${esc(t('yourAnswer'))}</h2><p>${esc(t('yourAnswerAbout'))}</p></header>
<p class="row"><span class="status">${esc(state)}</span><span class="status">${esc(t('signedIn', { name: ctx.identity!.name }))}</span></p>
<form method="post" action="/answer"><div class="questions">${cards}</div><button class="primary">${esc(t(mine.submittedAt ? 'update' : 'submit'))}</button></form></section>`;
  }, 'survey');
}
async function answer(ctx: Context) {
  const form = new URLSearchParams((await body(ctx.req)).toString());
  const q1 = form.get('q1') ?? '';
  const q2 = form.get('q2') ?? '';
  const q3 = form.get('q3') ?? '';
  if (!['great', 'ok', 'poor'].includes(q1) || !['office', 'hybrid', 'remote'].includes(q2) || !['pay', 'growth', 'culture'].includes(q3)) {
    return survey(ctx, await store.mine(ctx.identity!.subject) ?? {}, 400, 'incomplete');
  }
  await store.saveAnswer(ctx.identity!.subject, { q1: q1 === 'great' || q1 === 'ok' ? q1 : 'poor', q2: q2 === 'office' || q2 === 'hybrid' ? q2 : 'remote', q3: q3 === 'pay' || q3 === 'growth' ? q3 : 'culture' });
  ctx.res.writeHead(303, { location: '/?saved=1' }).end();
}
async function results(ctx: Context) {
  const { answers } = await store.results();
  const state = await store.exportState();
  render(ctx, 200, (t) => {
    const cards = questions.map((q) => `<div class="card"><b>${esc(t(q.id))}</b><dl class="bars">${q.options.map((o) => {
      const n = answers.filter((a) => a[q.id] === o).length;
      const share = answers.length ? Math.round(n / answers.length * 100) : 0;
      return `<dt>${esc(t(`${q.id}.${o}`))}</dt><dd><div class="bar"><i style="width:${share}%"></i></div></dd><dd class="num count">${n}</dd><dd class="num">${share}%</dd>`;
    }).join('')}</dl></div>`).join('');
    return `<section><header><h2>${esc(t('tally'))}</h2><p>${esc(t('tallyAbout', { n: answers.length }))}</p></header><div class="questions">${cards}</div></section>
<section><header><h2>${esc(t('downloads'))}</h2><p>${esc(t('downloadsAbout'))}</p></header>
<p>${state.status === 'ready' ? `${esc(t('downloadExport'))} (${esc(state.value.createdAt)})` : esc(t('noExport'))}</p>
<p class="row downloads"><button id="save-export" class="btn primary">${esc(t('saveExport'))}</button>
<button id="download-export" class="btn">${esc(t('downloadExport'))}</button>
<button id="local-csv" class="btn">${esc(t('localCsv'))}</button></p><p id="export-status" role="status"></p>
</section><script type="module" src="/export.js"></script>`;
  }, 'results');
}
const routes: Record<string, (ctx: Context) => unknown> = {
  'GET /': async (ctx) => survey(ctx, await store.mine(ctx.identity!.subject) ?? {}, 200, ctx.url.searchParams.has('saved') ? 'saved' : undefined),
  'POST /answer': answer,
  'GET /results': results,
  'GET /_pneuma-space/meta': (ctx) => ctx.res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ boot: process.env.PNEUMA_SPACE_BOOT_ID, image: process.env.PNEUMA_SPACE_IMAGE, uptimeMs: process.uptime() * 1000 })),
};
serve(async (ctx) => {
  if (switchLang(ctx)) return;
  const key = `${ctx.req.method} ${ctx.url.pathname}`;
  if (key !== 'GET /' && key !== 'POST /answer' && key !== 'GET /results' && key !== 'GET /_pneuma-space/meta') {
    return render(ctx, 404, (t) => `<p>${esc(t('notFound'))}</p>`);
  }
  if ((key === 'GET /results') && !ctx.identity?.owner) return render(ctx, 403, (t) => `<p>${esc(t('ownerOnly'))}</p>`);
  await routes[key](ctx);
});
