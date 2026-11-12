import { DEFAULT_LIMITS, type Limits } from './model.ts';

export type CloudConfig = {
  controlOrigin: string;
  appsDomain: string;
  secureCookies: boolean;
  limits: Limits;
  enabled: boolean;
};

export type ProductionConfig = CloudConfig & {
  github: { clientId: string; clientSecret: string; callbackUrl: string; handshakeSecret: string };
};

export function productionConfig(env: Record<string, unknown>): ProductionConfig {
  function required(key: string): string {
    const value = env[key];
    if (typeof value !== 'string' || !value || /REPLACE|example\.(com|net|org)/i.test(value)) throw new Error(`Configure ${key}.`);
    return value;
  }
  const controlOrigin = required('PNEUMA_SPACE_CONTROL_ORIGIN');
  const control = new URL(controlOrigin);
  if (control.protocol !== 'https:' || control.origin !== controlOrigin || control.username || control.password || control.port) {
    throw new Error('The control origin must be an HTTPS origin.');
  }
  const appsDomain = required('PNEUMA_SPACE_APPS_DOMAIN').toLowerCase();
  const dnsName = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
  if (!dnsName.test(appsDomain) || !dnsName.test(control.hostname) || appsDomain.length > 180) throw new Error('Configure valid DNS names.');
  const suffix = (host: string) => host.split('.').slice(-2).join('.');
  if (suffix(control.hostname) === suffix(appsDomain)) throw new Error('Control and application sites must be separate.');
  const handshakeSecret = required('PNEUMA_SPACE_SESSION_KEY');
  if (handshakeSecret.length < 32) throw new Error('The session key must contain at least 32 characters.');
  return {
    controlOrigin, appsDomain, secureCookies: true, limits: DEFAULT_LIMITS,
    enabled: env.PNEUMA_SPACE_ENABLED === 'true',
    github: {
      clientId: required('PNEUMA_SPACE_GITHUB_CLIENT_ID'),
      clientSecret: required('PNEUMA_SPACE_GITHUB_CLIENT_SECRET'),
      callbackUrl: controlOrigin + '/auth/callback', handshakeSecret,
    },
  };
}
