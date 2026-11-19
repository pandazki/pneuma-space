import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIdentityEnv } from './identity.ts';
import { parseHostedEnv } from './hosted-config.ts';

const production = { PNEUMA_SPACE_IDENTITY: 'hosted', PNEUMA_SPACE_HOSTED_CONTROL_ORIGIN: 'https://console.example.com', PNEUMA_SPACE_APPS_ORIGIN: 'https://*.apps.example.net', PNEUMA_SPACE_HOSTED_GITHUB_CLIENT_ID: 'client', PNEUMA_SPACE_HOSTED_GITHUB_CLIENT_SECRET: 'secret', PNEUMA_SPACE_HOSTED_ALLOWED_SUBJECTS: '12345' };

test('AC-SAAS-14 hosted production requires provider credentials and trusted immutable identities', () => {
  assert.equal(parseIdentityEnv(production).kind, 'hosted');
  for (const key of ['PNEUMA_SPACE_HOSTED_GITHUB_CLIENT_ID', 'PNEUMA_SPACE_HOSTED_GITHUB_CLIENT_SECRET', 'PNEUMA_SPACE_HOSTED_ALLOWED_SUBJECTS']) assert.throws(() => parseHostedEnv({ ...production, [key]: '' }));
  assert.throws(() => parseHostedEnv({ ...production, PNEUMA_SPACE_HOSTED_ALLOWED_SUBJECTS: 'alice' }));
});

test('AC-SAAS-14 hosted production refuses insecure and overlapping sites', () => {
  assert.throws(() => parseHostedEnv({ ...production, PNEUMA_SPACE_HOSTED_CONTROL_ORIGIN: 'http://console.example.com' }));
  assert.throws(() => parseHostedEnv({ ...production, PNEUMA_SPACE_APPS_ORIGIN: 'http://*.apps.example.net' }));
  assert.throws(() => parseHostedEnv({ ...production, PNEUMA_SPACE_APPS_ORIGIN: 'https://*.apps.example.com' }));
  assert.throws(() => parseHostedEnv({ ...production, PNEUMA_SPACE_HOSTED_DEVELOPMENT_USERS: 'alice' }));
});

test('AC-SAAS-14 development identities require explicit loopback configuration', () => {
  const local = { PNEUMA_SPACE_HOSTED_DEVELOPMENT: 'true', PNEUMA_SPACE_HOSTED_CONTROL_ORIGIN: 'http://localhost:58081', PNEUMA_SPACE_APPS_ORIGIN: 'http://*.apps.localhost:58080' };
  assert.deepEqual(parseHostedEnv(local).developmentUsers, ['alice', 'bob', 'operator']);
  assert.throws(() => parseHostedEnv({ ...local, PNEUMA_SPACE_HOSTED_DEVELOPMENT: 'false' }));
  assert.throws(() => parseHostedEnv({ ...local, PNEUMA_SPACE_APPS_ORIGIN: 'http://*.apps.example.net' }));
  assert.throws(() => parseHostedEnv({ ...local, PNEUMA_SPACE_HOSTED_CONTROL_ORIGIN: 'http://public.example.com' }));
});
