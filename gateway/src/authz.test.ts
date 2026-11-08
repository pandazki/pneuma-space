import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ACTIONS, allows, Authority, can, parsePlatformAdmins, type Action, type Denial } from './authz.ts';
import { DEFAULT_QUOTA, type Caller, type Role, type Subject, type TenantName, type Token } from './model.ts';
import { SqliteStore } from './store.ts';

const A = 'design' as TenantName;
const B = 'data' as TenantName;

const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'pneuma-space-authz-')), 'pneuma-space.sqlite3'));
after(() => store.close());
for (const name of [A, B]) await store.putTenant({ name, display: name, quota: DEFAULT_QUOTA, createdAt: 0 });
const authority = new Authority(store, parsePlatformAdmins('user:root, group:ops'));

function token(subject: string, tenant: TenantName): Token {
  return { id: 't1', tenant, subject: subject as Subject, label: 'ci', hash: 'h', createdBy: 'user:ana' as Subject, createdAt: 0, revokedAt: null };
}

test('a user in two tenants holds each role from their memberships', async () => {
  await store.putMembership({ tenant: A, user: 'ana', role: 'admin' });
  await store.putMembership({ tenant: B, user: 'ana', role: 'member' });
  const caller = await authority.callerOf({ via: 'upstream', subject: 'user:ana' as Subject, name: 'Ana', groups: [] });
  assert.deepEqual(caller, { actor: { via: 'upstream', subject: 'user:ana', name: 'Ana' }, platformAdmin: false, roles: new Map([[A, 'admin'], [B, 'member']]), viaToken: false });
});

test('a service token is a member of its own tenant only', async () => {
  const t = token(`service:${A}.ci`, A);
  const caller = await authority.callerOf({ via: 'token', subject: t.subject, name: 'ci', token: t });
  assert.deepEqual(caller, { actor: { via: 'token', subject: t.subject, token: 't1', createdBy: 'user:ana' }, platformAdmin: false, roles: new Map([[A, 'member']]), viaToken: true });
});

test('a personal token of an id-listed platform admin is a platform admin', async () => {
  const t = token('user:root', A);
  assert.equal((await authority.callerOf({ via: 'token', subject: t.subject, name: 'root', token: t })).platformAdmin, true);
});

test('a group-listed platform admin is one in the browser and not through a token', async () => {
  assert.equal((await authority.callerOf({ via: 'upstream', subject: 'user:olga' as Subject, name: 'Olga', groups: ['ops'] })).platformAdmin, true);
  const t = token('user:olga', A);
  assert.equal((await authority.callerOf({ via: 'token', subject: t.subject, name: 'olga', token: t })).platformAdmin, false);
});

test('a membership change in a tenant reaches the next callerOf despite the cache', async () => {
  const who = { via: 'upstream', subject: 'user:ivy' as Subject, name: 'Ivy', groups: [] } as const;
  assert.equal((await authority.callerOf(who)).roles.size, 0);
  await store.putMembership({ tenant: A, user: 'ivy', role: 'member' });
  assert.equal((await authority.callerOf(who)).roles.get(A), 'member');
});

function caller(subject: string, roles: Record<string, Role>, flags: { viaToken?: boolean; platformAdmin?: boolean } = {}): Caller {
  const actor = flags.viaToken
    ? { via: 'token' as const, subject: subject as Subject, token: 't', createdBy: 'user:x' as Subject }
    : { via: 'upstream' as const, subject: subject as Subject, name: subject };
  return { actor, platformAdmin: flags.platformAdmin ?? false, roles: new Map(Object.entries(roles)) as Map<TenantName, Role>, viaToken: flags.viaToken ?? false };
}

const nobody = caller('user:nobody', {});
const memberA = caller('user:mia', { [A]: 'member' });
const memberB = caller('user:bo', { [B]: 'member' });
const adminA = caller('user:ana', { [A]: 'admin' });
const tokenA = caller(`service:${A}.ci`, { [A]: 'member' }, { viaToken: true });
const platform = caller('user:olga', {}, { platformAdmin: true });
const platformToken = caller('user:root', { [A]: 'member' }, { viaToken: true, platformAdmin: true });

type Attempt = readonly [Caller, TenantName | null, Subject | null];
/** `refused` is null on rows any signed-in caller passes; their refusal is the challenge before `can`. */
const CASES: Record<Action, { allowed: Attempt; refused: readonly [...Attempt, Denial['status']] | null }> = {
  'me': { allowed: [tokenA, null, null], refused: null },
  'health': { allowed: [nobody, null, null], refused: null },
  'apps.list': { allowed: [nobody, null, null], refused: null },
  'app.read': { allowed: [tokenA, A, null], refused: [memberB, A, null, 404] },
  'platform.read': { allowed: [platformToken, null, null], refused: [adminA, null, null, 403] },
  'bundles.upload': { allowed: [tokenA, null, null], refused: [nobody, null, null, 403] },
  'app.release': { allowed: [tokenA, A, null], refused: [memberB, A, null, 404] },
  'app.policy': { allowed: [memberA, A, null], refused: [memberB, A, null, 404] },
  'app.access': { allowed: [memberA, A, null], refused: [nobody, A, null, 404] },
  'app.owner': { allowed: [memberA, A, 'user:mia' as Subject], refused: [memberA, A, 'user:ana' as Subject, 403] },
  'app.remove': { allowed: [tokenA, A, null], refused: [memberB, A, null, 404] },
  'app.purge': { allowed: [adminA, A, null], refused: [memberA, A, null, 403] },
  'app.move': { allowed: [platform, null, null], refused: [platformToken, null, null, 403] },
  'policy.set': { allowed: [platformToken, null, null], refused: [adminA, null, null, 403] },
  'tenants': { allowed: [platform, null, null], refused: [platformToken, null, null, 403] },
  'tenant.quota.set': { allowed: [platformToken, null, null], refused: [adminA, null, null, 403] },
  'tenant.read': { allowed: [tokenA, A, null], refused: [memberB, A, null, 403] },
  'records': { allowed: [memberA, A, null], refused: [memberA, null, null, 403] },
  'members.write': { allowed: [adminA, A, null], refused: [memberA, A, null, 403] },
  'tokens.list': { allowed: [memberA, A, null], refused: [tokenA, A, null, 403] },
  'tokens.issue.service': { allowed: [adminA, A, null], refused: [memberA, A, null, 403] },
  'tokens.issue.personal': { allowed: [memberA, A, null], refused: [tokenA, A, null, 403] },
  'tokens.revoke': { allowed: [memberA, A, 'user:mia' as Subject], refused: [memberA, A, 'user:ana' as Subject, 403] },
};

for (const action of Object.keys(ACTIONS) as Action[]) {
  test(`can: ${action}`, () => {
    const { allowed, refused } = CASES[action];
    assert.equal(can(allowed[0], action, allowed[1], allowed[2]), true);
    if (refused) assert.equal((can(refused[0], action, refused[1], refused[2]) as Denial).status, refused[3]);
  });
}

test('can: an app in a tenant the caller is not in is 404, not 403', () => {
  assert.deepEqual(can(memberB, 'app.purge', A), { status: 404 });
});

const ACCESS_CELLS = [
  ['public', null, 'ok'], ['public', memberA, 'ok'], ['public', memberB, 'ok'],
  ['org', null, 'challenge'], ['org', memberA, 'ok'], ['org', memberB, 'ok'],
  ['tenant', null, 'challenge'], ['tenant', memberA, 'ok'], ['tenant', memberB, 'forbidden'],
] as const;

for (const [access, who, expected] of ACCESS_CELLS) {
  test(`allows: ${access} app, ${who === null ? 'anonymous' : who === memberA ? 'member of its tenant' : 'member of another tenant'}`, () => {
    assert.equal(allows(who, access, A), expected);
  });
}
