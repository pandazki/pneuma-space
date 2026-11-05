const root = document.documentElement;
const KEY = 'pneuma-space-theme';
const dict = JSON.parse(document.getElementById('ui-dict').textContent);
const media = matchMedia('(prefers-color-scheme: dark)');
const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

window.ui = {
  lang: root.lang,
  prefix: root.dataset.prefix,
  get theme() { return root.dataset.theme; },
  setTheme(theme) {
    root.dataset.theme = theme;
    try { localStorage.setItem(KEY, theme); } catch {}
  },
  setLang(lang) {
    const url = new URL(location.href);
    url.searchParams.set('lang', lang);
    location.assign(url);
  },
  t(key, params = {}) {
    if (!Object.hasOwn(dict, key)) throw new Error(`dictionary has no "${key}"`);
    return dict[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
  },
};

media.addEventListener('change', () => { if (!stored()) root.dataset.theme = media.matches ? 'dark' : 'light'; });
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-theme-set]');
  if (button) ui.setTheme(button.dataset.themeSet);
});
