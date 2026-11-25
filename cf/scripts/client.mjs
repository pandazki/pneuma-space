import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function connect(path = process.env.PNEUMA_SPACE_CREDENTIALS, headers = {}) {
  if (!path) throw new Error('Set PNEUMA_SPACE_CREDENTIALS to a private JSON file containing origin, account and key.');
  const credentials = JSON.parse(await readFile(path, 'utf8'));
  const origin = new URL(credentials.origin).origin;
  let cookie, csrf;
  async function api(path, body, method = body === undefined ? 'GET' : 'POST', key = randomUUID()) {
    const response = await fetch(origin + '/api/v1' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { ...headers, origin, 'content-type': 'application/json', ...(cookie ? { cookie, 'x-pneuma-space-csrf': csrf } : {}), 'idempotency-key': key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = response.status === 204 ? null : await response.json();
    if (!response.ok) throw Object.assign(new Error(value?.error?.code + ': ' + value?.error?.message), { status: response.status, code: value?.error?.code });
    return { value, response };
  }
  const login = await api('/auth/login', { account: credentials.account, key: credentials.key });
  cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  csrf = login.value.csrf;
  if (!cookie || !csrf) throw new Error('Sign-in returned no session.');
  return { origin, me: login.value, api: async (...args) => (await api(...args)).value, close: () => api('/auth/logout', {}) };
}
