import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/bind-domain.mjs PRIVATE_WORKER_SECRETS.json');
const { PNEUMA_SPACE_CF_API_TOKEN: token } = JSON.parse(await readFile(path, 'utf8'));
if (!token) throw new Error('Domain provisioning credential is missing.');
const hostname = new URL(config.vars.PNEUMA_SPACE_CONTROL_ORIGIN).hostname;
const endpoint = 'https://api.cloudflare.com/client/v4/accounts/' + config.vars.PNEUMA_SPACE_ACCOUNT_ID + '/workers/domains';
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
const listed = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30000) });
const domains = await listed.json();
if (!listed.ok || !domains.success) throw new Error('Could not inspect Worker domains: ' + listed.status);
const existing = domains.result.find(domain => domain.hostname === hostname);
if (existing && existing.service !== config.name) throw new Error('Hostname belongs to another Worker; refusing to replace it.');
if (!existing) {
  const response = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ hostname, service: config.name, zone_id: config.vars.PNEUMA_SPACE_ZONE_ID }), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error('Domain attachment failed: ' + response.status + ' ' + result.errors?.map(error => error.message).join(', '));
}
console.log('Attached ' + hostname + ' to ' + config.name + '. Verify external HTTPS before marking it ready.');
