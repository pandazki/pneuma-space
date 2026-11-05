import type { IncomingMessage } from 'node:http';
import type { Context } from '../sdk/serve.ts';

export const LANGS = ['en', 'zh'] as const;
export type Lang = (typeof LANGS)[number];
export type Dict = Readonly<Record<Lang, Readonly<Record<string, string>>>>;
export type T = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function pickLang(req: IncomingMessage): Lang {
  const cookie = /(?:^|;\s*)lang=(en|zh)(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] as Lang | undefined;
  return cookie ?? (/^\s*zh/i.test(req.headers['accept-language'] ?? '') ? 'zh' : 'en');
}

export function switchLang({ req, res, url, prefix }: Context): boolean {
  const lang = url.searchParams.get('lang');
  if (req.method !== 'GET' || !LANGS.includes(lang as Lang)) return false;
  const rest = new URLSearchParams(url.search);
  rest.delete('lang');
  const query = rest.size ? `?${rest}` : '';
  res.writeHead(303, {
    location: prefix + url.pathname + query,
    'set-cookie': `lang=${lang}; Path=${prefix || '/'}; Max-Age=31536000; SameSite=Lax`,
  }).end();
  return true;
}

export function translate(dict: Dict, lang: Lang): T {
  const missing = LANGS.flatMap((l) => LANGS.flatMap((o) => Object.keys(dict[o]).filter((k) => !Object.hasOwn(dict[l], k)).map((k) => `${l}.${k}`)));
  if (missing.length) throw new Error(`dictionary is missing ${missing.join(', ')}`);
  return (key, params = {}) => {
    if (!Object.hasOwn(dict[lang], key)) throw new Error(`dictionary has no "${key}"`);
    return dict[lang][key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]));
  };
}
