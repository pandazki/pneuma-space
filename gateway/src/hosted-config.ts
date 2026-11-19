import { parseAppsOrigin, type Addressing } from './address.ts';

export type HostedConfig = {
  readonly controlOrigin: string;
  readonly appsOrigin: Extract<Addressing, { mode: 'subdomain' }>;
  readonly development: boolean;
  readonly developmentUsers: readonly string[];
  readonly allowedSubjects: readonly string[];
  readonly github: { readonly clientId: string; readonly clientSecret: string } | null;
};

export function parseHostedEnv(env: NodeJS.ProcessEnv): HostedConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required for hosted identity`);
    return value;
  };
  const development = env.PNEUMA_SPACE_HOSTED_DEVELOPMENT === 'true';
  if (env.PNEUMA_SPACE_HOSTED_DEVELOPMENT && !['true', 'false'].includes(env.PNEUMA_SPACE_HOSTED_DEVELOPMENT)) throw new Error('PNEUMA_SPACE_HOSTED_DEVELOPMENT must be true or false');
  const raw = required('PNEUMA_SPACE_HOSTED_CONTROL_ORIGIN');
  const control = new URL(raw);
  if (control.origin !== raw || control.username || control.password) throw new Error('hosted control origin must be an exact origin');
  const appsOrigin = parseAppsOrigin(required('PNEUMA_SPACE_APPS_ORIGIN'));
  if (appsOrigin.mode !== 'subdomain') throw new Error('hosted identity requires app subdomains');
  new URL(`${appsOrigin.scheme}://app.${appsOrigin.domain}${appsOrigin.port}`);
  if (control.hostname === appsOrigin.domain || control.hostname.endsWith(`.${appsOrigin.domain}`)) throw new Error('control host cannot be an app host');
  const loopback = (host: string) => host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
  if (development) {
    if (!loopback(control.hostname) || !loopback(appsOrigin.domain)) throw new Error('hosted development requires loopback control and app hosts');
    if (!['http:', 'https:'].includes(control.protocol)) throw new Error('invalid hosted control protocol');
  } else {
    if (control.protocol !== 'https:' || appsOrigin.scheme !== 'https' || loopback(control.hostname) || loopback(appsOrigin.domain)) throw new Error('hosted production requires HTTPS non-loopback origins');
    const controlSite = control.hostname.split('.').slice(-2).join('.');
    const appSite = appsOrigin.domain.split('.').slice(-2).join('.');
    if (controlSite === appSite || control.hostname === appsOrigin.domain || control.hostname.endsWith(`.${appsOrigin.domain}`)) throw new Error('hosted control and apps must use separate sites');
    if (env.PNEUMA_SPACE_HOSTED_DEVELOPMENT_USERS) throw new Error('development accounts are forbidden in production');
  }
  const list = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean);
  const developmentUsers = development ? list(env.PNEUMA_SPACE_HOSTED_DEVELOPMENT_USERS ?? 'alice,bob,operator') : [];
  if (developmentUsers.some((user) => !/^[a-z0-9_-]{1,32}$/.test(user))) throw new Error('invalid development account name');
  const allowedSubjects = development ? [] : list(required('PNEUMA_SPACE_HOSTED_ALLOWED_SUBJECTS'));
  if (!development && (!allowedSubjects.length || allowedSubjects.some((id) => !/^[1-9][0-9]*$/.test(id)))) throw new Error('hosted allowed subjects must be immutable GitHub numeric IDs');
  return { controlOrigin: control.origin, appsOrigin, development, developmentUsers, allowedSubjects,
    github: development ? null : { clientId: required('PNEUMA_SPACE_HOSTED_GITHUB_CLIENT_ID'), clientSecret: required('PNEUMA_SPACE_HOSTED_GITHUB_CLIENT_SECRET') } };
}
