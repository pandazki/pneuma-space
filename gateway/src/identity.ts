import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  LOGIN_PATH, LOGOUT_PATH, subject,
  type Challenge, type IdentityProvider, type Principal, type Subject, type Token,
} from './model.ts';

const COOKIE = 'pneuma_space_session';
const COOKIE_ATTRIBUTES = 'HttpOnly; SameSite=Lax; Path=/';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SECRET_BYTES = 32;
const USER_NAME = /^[a-z0-9_-]{1,32}$/;
const FORM_LIMIT = 4096;

export function loadOrCreateSecret(path: string): Buffer {
  try {
    writeFileSync(path, randomBytes(SECRET_BYTES), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  const secret = readFileSync(path);
  if (secret.length !== SECRET_BYTES) {
    throw new Error(`${path} holds ${secret.length} bytes, expected ${SECRET_BYTES}; delete it to generate a new one, which signs every browser out`);
  }
  return secret;
}

/** The Registry stores `hash` and shows `token` once. */
export function issueToken(name: string): { readonly token: string; readonly hash: string; readonly subject: Subject } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token), subject: subject(`service:${name}`) };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** M1 stub: the login name is self-reported, so a user subject identifies and does not authenticate (ADR 0008). */
export class LocalIdentity implements IdentityProvider {
  readonly #secret: Buffer;
  readonly #tokenByHash: (hash: string) => Promise<Token | null>;

  constructor(secret: Buffer, tokenByHash: (hash: string) => Promise<Token | null>) {
    this.#secret = secret;
    this.#tokenByHash = tokenByHash;
  }

  async authenticate(request: IncomingMessage): Promise<Principal | Challenge> {
    return (await this.#principal(request)) ?? challenge(request);
  }

  async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://gateway');
    if (url.pathname === LOGIN_PATH && request.method === 'GET') {
      page(response, 200, loginPage(safeNext(url.searchParams.get('next')), null, languageOf(request)));
    } else if (url.pathname === LOGIN_PATH && request.method === 'POST') {
      await this.#login(request, response);
    } else if (url.pathname === LOGOUT_PATH) {
      redirect(response, LOGIN_PATH, `${COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`);
    } else {
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
    }
  }

  async #principal(request: IncomingMessage): Promise<Principal | null> {
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      const token = /^Bearer (\S+)$/i.exec(authorization)?.[1];
      const row = token === undefined ? null : await this.#tokenByHash(sha256(token));
      return row && { subject: row.subject, name: row.subject.slice(row.subject.indexOf(':') + 1) };
    }
    return this.#session(request.headers.cookie);
  }

  #session(cookieHeader: string | undefined): Principal | null {
    const value = cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    const [payload, signature, extra] = value?.slice(COOKIE.length + 1).split('.') ?? [];
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(this.#sign(payload));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const session: { sub: Subject; name: string; iat: number } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!(Date.now() - session.iat < SESSION_SECONDS * 1000)) return null;
    return { subject: session.sub, name: session.name };
  }

  #sign(payload: string): string {
    return createHmac('sha256', this.#secret).update(payload).digest('base64url');
  }

  async #login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body = '';
    for await (const chunk of request) if (body.length <= FORM_LIMIT) body += chunk;
    const form = new URLSearchParams(body);
    const name = form.get('name') ?? '';
    const next = safeNext(form.get('next'));
    if (!USER_NAME.test(name)) {
      page(response, 400, loginPage(next, 'invalid', languageOf(request)));
      return;
    }
    const payload = Buffer.from(JSON.stringify({ sub: `user:${name}`, name, iat: Date.now() })).toString('base64url');
    redirect(response, next, `${COOKIE}=${payload}.${this.#sign(payload)}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_SECONDS}`);
  }
}

function challenge(request: IncomingMessage): Challenge {
  const browser = request.method === 'GET' && (request.headers.accept ?? '').includes('text/html');
  return browser ? { status: 303, location: `${LOGIN_PATH}?next=${encodeURIComponent(request.url ?? '/')}` } : { status: 401 };
}

/** Only app paths, so the login page cannot redirect off this gateway. */
function safeNext(next: string | null): string {
  return next !== null && /^\/apps\/[\x21-\x7e]*$/.test(next) ? next : '/';
}

function redirect(response: ServerResponse, location: string, cookie: string): void {
  response.writeHead(303, { location, 'set-cookie': cookie }).end();
}

function page(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(html);
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const LOGIN_TEXT = {
  zh: {
    title: '登录', hint: '这台机器上的应用会看到你输入的名字。没有密码。', name: '名字', submit: '继续',
    invalid: '请输入 1 到 32 个字符：小写字母、数字、_ 和 -。', light: '浅色', dark: '深色',
  },
  en: {
    title: 'Sign in', hint: 'Apps on this machine see the name you type. There is no password.', name: 'Name', submit: 'Continue',
    invalid: 'Use 1 to 32 characters: lowercase letters, digits, _ and -.', light: 'Light', dark: 'Dark',
  },
} as const;
type Language = keyof typeof LOGIN_TEXT;

function languageOf(request: IncomingMessage): Language {
  return (request.headers['accept-language'] ?? '').trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

// The token block is the one in console.html; the visual standard keeps the two identical.
const TOKENS = `:root {
  --page: oklch(98.5% .001 286.376);
  --canvas: oklch(96.1% .002 247.84);
  --surface: oklch(100% 0 0);
  --inset: oklch(97.9% .002 247.839);
  --hover: oklch(97% .002 247.839);
  --hover-2: oklch(93.3% .003 247.86);
  --ink: oklch(24.7% .006 258.361);
  --ink-2: oklch(50.6% .01 264.477);
  --ink-3: oklch(69.5% .009 264.505);
  --line: oklch(94.6% .003 264.542);
  --line-strong: oklch(91.2% .005 258.326);
  --line-soft: oklch(96.6% .002 264.542);
  --field: oklch(96.1% .001 286.375);
  --stripe: oklch(40.5% 0 0 / .075);
  --stripe-bg: oklch(97% 0 0);
  --accent: oklch(62.6% .205 254.947);
  --accent-ink: oklch(55.6% .187 255.617);
  --accent-tint: oklch(96% .019 252.878);
  --green: oklch(60.3% .155 150.883);
  --green-tint: oklch(95.8% .017 159.118);
  --orange: oklch(68.9% .179 49.902);
  --orange-tint: oklch(96.4% .021 67.581);
  --red: oklch(62.1% .192 23.042);
  --red-tint: oklch(95.6% .017 17.462);
  --tip-bg: oklch(27.2% .008 264.435);
  --tip-fg: oklch(97.6% .002 247.839);
  --shadow-xs: 0 1px 2px oklch(0% 0 0 / .05);
  --shadow-sm: 0 1px 2px oklch(0% 0 0 / .06), 0 2px 6px oklch(0% 0 0 / .04);
  --shadow-card: 0 0 0 1px var(--line), var(--shadow-sm);
  --shadow-btn: 0 0 0 1px var(--line-strong), var(--shadow-xs);
  --font: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --page: oklch(20.9% .004 264.477);
  --canvas: oklch(23.1% .004 264.487);
  --surface: oklch(26% .006 271.191);
  --inset: oklch(24.3% .004 264.492);
  --hover: oklch(28.9% .006 271.22);
  --hover-2: oklch(31.8% .007 274.747);
  --ink: oklch(96.4% .002 247.839);
  --ink-2: oklch(73.1% .008 260.731);
  --ink-3: oklch(54.1% .01 264.484);
  --line: oklch(30.8% .006 258.354);
  --line-strong: oklch(35.6% .007 264.474);
  --line-soft: oklch(27.8% .006 258.354);
  --field: oklch(29.3% .006 271.223);
  --stripe: oklch(100% 0 0 / .055);
  --stripe-bg: oklch(22.6% .004 264.485);
  --accent: oklch(68% .173 253.301);
  --accent-ink: oklch(78.8% .113 248.33);
  --accent-tint: oklch(68% .173 253.301 / .16);
  --green: oklch(70.5% .154 153.814);
  --green-tint: oklch(70.5% .154 153.814 / .14);
  --orange: oklch(74.6% .156 55.642);
  --orange-tint: oklch(74.6% .156 55.642 / .14);
  --red: oklch(66.6% .18 21.433);
  --red-tint: oklch(66.6% .18 21.433 / .14);
  --tip-bg: oklch(96.4% .002 247.839);
  --tip-fg: oklch(24.7% .006 258.361);
  --shadow-btn: 0 0 0 1px oklch(100% 0 0 / .1), 0 1px 2px oklch(0% 0 0 / .3);
  --shadow-card: 0 0 0 1px oklch(100% 0 0 / .11), 0 1px 2px oklch(0% 0 0 / .2), 0 2px 6px oklch(0% 0 0 / .2);
  color-scheme: dark;
}`;

/** Rendered in the server's language; a language stored by the console or this page's switch replaces it before paint. */
function loginPage(next: string, error: 'invalid' | null, lang: Language): string {
  const text = LOGIN_TEXT[lang];
  const say = (key: keyof typeof text) => `<span data-t="${key}">${escape(text[key])}</span>`;
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PneumaSpace</title>
<script>
(() => {
  const root = document.documentElement;
  const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const media = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => { root.dataset.theme = stored('pneuma-space-theme') ?? (media.matches ? 'dark' : 'light'); };
  apply();
  media.addEventListener('change', apply);
  const lang = stored('pneuma-space-lang');
  if (lang) root.lang = lang.startsWith('zh') ? 'zh' : 'en';
})();
</script>
<style>
${TOKENS}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; color: var(--ink); font: 14px/21px var(--font); letter-spacing: -0.01em; -webkit-font-smoothing: antialiased;
  background: repeating-linear-gradient(-45deg, transparent 0 7px, var(--stripe) 7px 8px) var(--stripe-bg); }
.frame { width: min(440px, 100%); background: var(--page); box-shadow: var(--shadow-card); }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; }
header b { font-size: 15px; font-weight: 600; letter-spacing: -0.02em; }
.controls { display: flex; gap: 6px; }
.seg { display: inline-flex; padding: 2px; border-radius: 999px; background: var(--field); }
.seg button { border: 0; background: none; cursor: pointer; font: 500 11.5px/18px var(--font); padding: 2px 8px; border-radius: 999px; color: var(--ink-3); display: inline-flex; align-items: center; }
.seg button[aria-pressed="true"] { background: var(--surface); box-shadow: var(--shadow-btn); color: var(--ink); }
form { display: grid; gap: 16px; padding: 40px 32px; border-top: 1px dashed var(--line); }
h1 { margin: 0; font-size: 21px; line-height: 28px; font-weight: 600; letter-spacing: -0.02em; }
p { margin: 4px 0 0; font-size: 12.5px; color: var(--ink-3); }
label { display: grid; gap: 6px; font-size: 12.5px; font-weight: 500; }
input { font: 13px var(--mono); color: var(--ink); height: 30px; padding: 0 10px; border: 0; border-radius: 8px; background: var(--field); box-shadow: 0 0 0 1px var(--line-strong); outline: none; }
input:focus { box-shadow: 0 0 0 2px var(--accent-tint), 0 0 0 1px var(--accent); }
input[aria-invalid="true"] { box-shadow: 0 0 0 1px var(--red); }
.error { font-size: 12px; font-weight: 400; color: var(--red); }
button.primary { justify-self: start; height: 27px; padding: 0 12px; border: 0; border-radius: 999px; background: var(--accent); color: white; font: 500 13px var(--font); cursor: pointer; }
button.primary:hover { background: var(--accent-ink); }
</style></head>
<body>
<div class="frame">
<header><b>PneumaSpace</b><div class="controls">
<div class="seg" role="group" aria-label="theme"><button type="button" data-theme-pick="light"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg></button><button type="button" data-theme-pick="dark"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"/></svg></button></div>
<div class="seg" role="group" aria-label="language"><button type="button" data-lang-pick="zh">中</button><button type="button" data-lang-pick="en">EN</button></div>
</div></header>
<form method="post" action="${LOGIN_PATH}">
<div><h1>${say('title')}</h1><p>${say('hint')}</p></div>
<label>${say('name')}<input name="name" required pattern="[a-z0-9_\\-]{1,32}" maxlength="32" autocomplete="username" autofocus${error ? ' aria-invalid="true"' : ''}>${error ? `<span class="error">${say(error)}</span>` : ''}</label>
<input type="hidden" name="next" value="${escape(next)}">
<button class="primary">${say('submit')}</button>
</form>
</div>
<script>
(() => {
  const TEXT = ${JSON.stringify(LOGIN_TEXT)};
  const root = document.documentElement;
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const render = () => {
    for (const el of document.querySelectorAll('[data-t]')) el.textContent = TEXT[root.lang][el.dataset.t];
    for (const b of document.querySelectorAll('[data-theme-pick]')) {
      b.setAttribute('aria-pressed', String(b.dataset.themePick === root.dataset.theme));
      b.setAttribute('aria-label', TEXT[root.lang][b.dataset.themePick]);
    }
    for (const b of document.querySelectorAll('[data-lang-pick]')) b.setAttribute('aria-pressed', String(b.dataset.langPick === root.lang));
  };
  document.addEventListener('click', (e) => {
    const theme = e.target.closest('[data-theme-pick]')?.dataset.themePick;
    const lang = e.target.closest('[data-lang-pick]')?.dataset.langPick;
    if (theme) { store('pneuma-space-theme', theme); root.dataset.theme = theme; }
    if (lang) { store('pneuma-space-lang', lang); root.lang = lang; }
    render();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
  render();
})();
</script>
</body></html>
`;
}
