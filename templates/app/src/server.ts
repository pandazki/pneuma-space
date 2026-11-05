import { serve } from '../sdk/serve.ts';
import { pickLang, switchLang, translate } from '../ui/i18n.ts';
import { esc, page } from '../ui/page.ts';

const dict = {
  en: { title: 'Hello', hello: 'Hello, {name}', guest: 'guest', intro: 'This page is src/server.ts. Edit it and publish again.', signIn: 'Sign in' },
  zh: { title: '你好', hello: '你好，{name}', guest: '访客', intro: '这个页面就是 src/server.ts，改完重新发布即可。', signIn: '登录' },
};

serve((ctx) => {
  if (switchLang(ctx)) return;
  const { req, res, url, prefix, identity } = ctx;
  if (req.method !== 'GET' || url.pathname !== '/') return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  const lang = pickLang(req);
  const t = translate(dict, lang);
  const signIn = identity ? '' : `<a class="btn primary" href="/_pneuma-space/login?next=${encodeURIComponent(prefix + '/')}">${esc(t('signIn'))}</a>`;
  const body = `<section>
<header><h2>${esc(t('hello', { name: identity?.name ?? t('guest') }))}</h2><p>${esc(t('intro'))}</p></header>
${signIn}
</section>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page({ prefix, lang, dict, title: t('title'), body, badge: 'example' }));
});
