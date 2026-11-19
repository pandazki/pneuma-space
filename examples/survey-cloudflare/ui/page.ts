import type { Dict, Lang } from './i18n.ts';

export type Page = {
  readonly prefix: string;
  readonly lang: Lang;
  readonly dict: Dict;
  readonly title: string;
  readonly body: string;
  readonly head?: string;
  readonly badge?: 'example';
  readonly nav?: readonly { readonly href: string; readonly label: string; readonly current?: boolean }[];
};

export const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const SHELL: Dict = {
  en: { language: 'Language', theme: 'Theme', light: 'Light', dark: 'Dark', footer: 'Runs on PneumaSpace' },
  zh: { language: '语言', theme: '主题', light: '浅色', dark: '深色', footer: '运行于 PneumaSpace' },
};
const BADGE = '<div class="badge">pneuma-space-example-site</div>';
const THEME = `try{var t=localStorage.getItem('pneuma-space-theme')}catch(e){}document.documentElement.dataset.theme=t||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')`;
const SUN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"/></svg>';
const MOON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"/></svg>';

export function page({ prefix, lang, dict, title, body, head = '', badge, nav = [] }: Page): string {
  const s = SHELL[lang];
  const p = esc(prefix);
  const links = nav.map((n) => `<a href="${esc(n.href)}"${n.current ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`).join('');
  const langs = (['zh', 'en'] as const).map((l) => `<a href="?lang=${l}"${l === lang ? ' aria-current="true"' : ''}>${l === 'zh' ? '中' : 'EN'}</a>`).join('');
  return `<!doctype html>
<html lang="${lang}" data-prefix="${p}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<script>${THEME}</script>
<link rel="stylesheet" href="${p}/ui.css">
<script type="application/json" id="ui-dict">${JSON.stringify(dict[lang]).replace(/</g, '\\u003c')}</script>
<script defer src="${p}/ui.js"></script>
${head}
</head>
<body>
<div class="frame">
<header class="top">
<h1>${esc(title)}</h1>${links && `<nav>${links}</nav>`}
<div class="controls">
<div class="seg" role="group" aria-label="${s.language}">${langs}</div>
<div class="seg" role="group" aria-label="${s.theme}"><button type="button" data-theme-set="light" aria-label="${s.light}">${SUN}</button><button type="button" data-theme-set="dark" aria-label="${s.dark}">${MOON}</button></div>
</div>
</header>
<main>${body}</main>
<footer>${s.footer}</footer>
</div>${badge === 'example' ? BADGE : ''}
</body>
</html>`;
}
