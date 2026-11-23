// Managed apps (ADR 0039): rows AC-MGR-1 to AC-MGR-5 of docs/acceptance.md.

import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import {
  OWNER, adminClient, adminUrl, appId, appctl, chrome, cleanup, deploy, images, publish, setupSuite, summary, teardownSuite, uniqueName, volumeExists, waitFor,
  type Capabilities,
} from './harness.ts';
import { ADMIN_PATHS, MANAGER_HEADER } from '../../gateway/src/model.ts';

before(setupSuite);
after(teardownSuite);

const MANAGER = 'deployer';
const urlOf = (name: string) => `https://deploy.test/apps/${name}`;

/** The admin API with the manager named in the header when `manager` is given; replies are returned whatever their status. */
async function admin(method: string, path: string, { body, manager }: { body?: unknown; manager?: string } = {}) {
  const response = await fetch(adminUrl + path, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(manager && { [MANAGER_HEADER]: manager }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: response.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : text };
}

/** `appctl publish --manager` under a fresh name; when the test ends its manager is cleared, then it is removed and purged. */
async function managed(t: TestContext, capabilities: Capabilities = {}, flags: readonly string[] = []) {
  const name = uniqueName('mgr');
  t.after(async () => {
    await admin('DELETE', ADMIN_PATHS.manager(name), { manager: (await summary(name))?.manager?.name });
    await cleanup(name);
  });
  publish(name, { image: images.echo, capabilities, flags: ['--manager', MANAGER, '--manager-url', urlOf(name), ...flags] });
  return { name, id: await appId(name) };
}

const around = (name: string) => new RegExp(`managed by ${MANAGER} \\(${urlOf(name).replace(/[.]/g, '\\.')}\\); acting here goes around it`);
const audit = async (name: string) => (await adminClient.audit(name)).body.reverse();

test('AC-MGR-1', { timeout: 120_000 }, async (t) => {
  const app = await managed(t);
  const expected = { name: MANAGER, url: urlOf(app.name) };
  assert.deepEqual([(await summary(app.name)).manager, (await adminClient.app(app.name)).body.app.manager], [expected, expected]);
  const plain = await deploy(t, { image: images.echo, capabilities: {} });
  assert.deepEqual([(await summary(plain.name)).manager, (await adminClient.app(plain.name)).body.app.manager], [null, null]);
  assert.match(appctl('list'), new RegExp(`^${app.name}\\t.*\\tmanaged by ${MANAGER}$`, 'm'));
});

test('AC-MGR-2', { timeout: 180_000 }, async (t) => {
  const app = await managed(t, { files: {} });
  const tenant = uniqueName('mgr');
  assert.equal((await adminClient.createTenant(tenant, OWNER.slice('user:'.length))).status, 200);
  const writes: [method: string, path: string, body?: unknown][] = [
    ['PUT', ADMIN_PATHS.release(app.name), { image: images.echo2, manifest: { contract: 1, capabilities: { files: {} } }, bundle: null }],
    ['PUT', ADMIN_PATHS.appPolicy(app.name), { idle_seconds: 5 }],
    ['PUT', ADMIN_PATHS.access(app.name), { access: 'public' }],
    ['PUT', ADMIN_PATHS.owner(app.name), { owner: 'user:acc-other' }],
    ['PUT', ADMIN_PATHS.move(app.name), { tenant }],
    ['POST', ADMIN_PATHS.remove(app.name)],
  ];
  const state = async () => {
    const { current, policyOverride, access, owner, tenant: held, status } = (await adminClient.app(app.name)).body.app;
    return JSON.stringify([current, policyOverride, access, owner, held, status]);
  };
  const before = await state();
  for (const [method, path, body] of writes) {
    for (const manager of [undefined, 'other']) {
      const refused = await admin(method, path, { body, manager });
      assert.equal(refused.status, 409, `${method} ${path} naming ${manager}`);
      assert.match(refused.body.error, around(app.name));
    }
  }
  assert.equal(await state(), before, 'a refused write changes nothing');

  for (const [method, path] of [['POST', ADMIN_PATHS.stop(app.name)], ['POST', ADMIN_PATHS.restart(app.name)], ['POST', ADMIN_PATHS.unquarantine(app.name)],
    ['GET', ADMIN_PATHS.logs(app.name)], ['GET', ADMIN_PATHS.state(app.name)]]) {
    assert.equal((await admin(method, path)).status, 200, `${method} ${path} needs no name`);
  }

  for (const [method, path, body] of writes) assert.equal((await admin(method, path, { body, manager: MANAGER })).status, 200, `${method} ${path} naming ${MANAGER}`);
  const purge = (manager?: string) => admin('POST', ADMIN_PATHS.purge(app.name), { manager });
  assert.deepEqual([(await purge()).status, (await purge('other')).status], [409, 409]);
  assert.equal((await purge(MANAGER)).status, 200);
  assert.equal(await summary(app.name), null);

  const done = (await audit(app.name)).filter((r: any) => r.result === 'ok' && r.action !== 'app.stop' && r.action !== 'app.restart' && r.action !== 'app.unquarantine');
  assert.deepEqual(done.map((r: any) => [r.actor, r.action, r.details.namedManager]), [
    ['local', 'app.publish', MANAGER], ['local', 'app.publish', MANAGER], ['local', 'app.policy', MANAGER], ['local', 'app.access', MANAGER],
    ['local', 'app.owner', MANAGER], ['local', 'app.move', MANAGER], ['local', 'app.remove', MANAGER], ['local', 'app.purge', MANAGER],
  ]);
});

test('AC-MGR-3', { timeout: 120_000 }, async (t) => {
  const app = await managed(t);
  const release = (manager: unknown) => ({ image: images.echo2, manifest: { contract: 1, capabilities: {} }, bundle: null, manager });
  assert.equal((await admin('PUT', ADMIN_PATHS.release(app.name), { body: release({ name: 'other' }) })).status, 409);
  assert.deepEqual((await summary(app.name)).manager, { name: MANAGER, url: urlOf(app.name) }, 'a publish that does not name it keeps the manager');
  const other = { name: 'other', url: 'https://other.test/' };
  assert.equal((await admin('PUT', ADMIN_PATHS.release(app.name), { body: release(other), manager: MANAGER })).status, 200);
  assert.deepEqual((await summary(app.name)).manager, other);

  assert.equal((await admin('DELETE', ADMIN_PATHS.manager(app.name))).status, 409);
  assert.equal((await admin('DELETE', ADMIN_PATHS.manager(app.name), { manager: 'other' })).status, 200);
  assert.equal((await summary(app.name)).manager, null);
  assert.equal((await adminClient.remove(app.name)).status, 200, 'an unmanaged app needs no name');
});

test('AC-MGR-4', { timeout: 120_000 }, async (t) => {
  const app = await managed(t, { files: {} }, ['--ephemeral', '--ttl', '10']);
  assert.ok((await summary(app.name)).expiresAt);
  assert.equal((await adminClient.discard(app.name)).status, 409);
  await waitFor(async () => (await summary(app.name)) === null, 30_000, 'the managed ephemeral app to expire');
  await waitFor(() => !volumeExists(`pneuma-space-files-${app.id}`), 30_000, 'volume deleted by expiry');
  assert.deepEqual((await audit(app.name)).filter((r: any) => r.action === 'app.expire').map((r: any) => [r.actor, r.result]), [['platform', 'started'], ['platform', 'ok']]);
});

test('AC-MGR-5', { timeout: 120_000 }, async (t) => {
  const app = await managed(t);
  const page = await (await chrome(t))(`${adminUrl}/`);
  // A hash set before the console has loaded is lost with the navigation.
  await waitFor(() => page.evaluate(`location.origin === ${JSON.stringify(adminUrl)} && document.readyState === 'complete' && typeof t === 'function'`), 15_000, 'the console');
  const shown = async (hash: string, expression: string, what: string) => {
    await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    return waitFor(() => page.evaluate(expression), 15_000, what);
  };
  const chip = (scope: string) => `(() => { const a = [...document.querySelectorAll('${scope} a.chip')].find((x) => x.textContent === t('d.manager', { name: '${MANAGER}' })); return a ? a.href : null; })()`;
  assert.equal(await shown('#/apps', chip(`article.acard:has(a[href="#/apps/${app.name}"])`), 'the project card with its manager'), urlOf(app.name));
  assert.equal(await shown(`#/apps/${app.name}`, chip('.meta'), 'the detail with its manager'), urlOf(app.name));

  await page.evaluate(`document.querySelector('.dact button[aria-haspopup="menu"]').click()`);
  await waitFor(() => page.evaluate(`!!document.querySelector('.menu')`), 5000, 'the actions menu');
  await page.evaluate(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.startsWith(t('d.removeItem'))).click()`);
  const card = await waitFor(() => page.evaluate(`(() => {
    const dialog = document.querySelector('dialog.approval[open]');
    if (!dialog) return null;
    const ok = dialog.querySelector('button[value="ok"]');
    return { warn: dialog.querySelector('.warn').textContent, label: dialog.querySelector('label.field span').textContent, disabled: ok.disabled };
  })()`), 5000, 'the approval card') as { warn: string; label: string; disabled: boolean };
  assert.deepEqual(card, {
    warn: await page.evaluate(`t('mg.around', { name: '${MANAGER}' }) + ' ' + t('mg.open', { name: '${MANAGER}' })`),
    label: await page.evaluate(`t('mg.confirm', { name: '${MANAGER}' })`),
    disabled: true,
  });
  const type = (text: string) => page.evaluate(`(() => {
    const input = document.querySelector('dialog.approval[open] label.field input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input'));
    return document.querySelector('dialog.approval[open] button[value="ok"]').disabled;
  })()`);
  assert.equal(await type('other'), true, 'another name keeps Continue disabled');
  assert.equal(await type(MANAGER), false);
  await page.evaluate(`document.querySelector('dialog.approval[open] button[value="ok"]').click()`);
  await waitFor(async () => (await summary(app.name))?.status === 'removed', 15_000, 'the console to remove the app');
  assert.equal((await audit(app.name)).find((r: any) => r.action === 'app.remove' && r.result === 'ok').details.namedManager, MANAGER);
});
