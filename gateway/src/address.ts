import { APPS_PATH, InputError, type AppName } from './model.ts';

/** One mode per deployment, from `PNEUMA_SPACE_APPS_ORIGIN` (ADR 0019 item 9). `port` keeps its colon, empty when absent. */
export type Addressing =
  | { readonly mode: 'path' }
  | { readonly mode: 'subdomain'; readonly scheme: 'http' | 'https'; readonly domain: string; readonly port: string };

export const PATH_ADDRESSING: Addressing = { mode: 'path' };

export function parseAppsOrigin(raw: string | undefined): Addressing {
  const value = raw?.trim();
  if (!value) return PATH_ADDRESSING;
  const match = /^(https?):\/\/\*\.([a-z0-9-]+(?:\.[a-z0-9-]+)+)(:\d{1,5})?\/?$/i.exec(value);
  if (!match) throw new InputError(`PNEUMA_SPACE_APPS_ORIGIN must look like https://*.apps.example.com, got "${value}"`);
  return { mode: 'subdomain', scheme: match[1]!.toLowerCase() as 'http' | 'https', domain: match[2]!.toLowerCase(), port: match[3] ?? '' };
}

/** The one address function: the listing, the console and appctl all print what it returns. */
export function address(addressing: Addressing, name: AppName): string {
  return addressing.mode === 'path' ? `${APPS_PATH}/${name}/` : `${addressing.scheme}://${name}.${addressing.domain}${addressing.port}/`;
}

/** The label of a `Host` that is exactly `<label>.<domain>` after the port is dropped; the caller parses it as an app name. */
export function hostLabel(domain: string, host: string | undefined): string | null {
  const bare = (host ?? '').toLowerCase().replace(/:\d*$/, '');
  if (!bare.endsWith(`.${domain}`)) return null;
  const label = bare.slice(0, -domain.length - 1);
  return label.includes('.') ? null : label;
}
