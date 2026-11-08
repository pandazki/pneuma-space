import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Instances } from './instances.ts';
import { IsolateRuntime, pick, StatefulSetPool, type RunnerPool, type RunnerRef } from './isolate.ts';
import { KubeClient, type Pod } from './kube.ts';
import { CURRENT, register, tempStore, until } from './lifecycle.fakes.ts';
import { appName, DEFAULT_POLICY, DEFAULT_TENANT, newAppId, type AppId, type BundleId, type ReleaseNumber, type ReplicaId, type RunSpec } from './model.ts';
import { AppGuard, Unavailable } from './runtimes.ts';

async function listen(t: TestContext, handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A runner that starts every app at once and reports no events; `starts` names the apps it was asked to start. */
async function fakeRunner(t: TestContext, id: string) {
  const startedAt = Math.floor(Math.random() * 1e12);
  const starts: string[] = [];
  const url = await listen(t, (q, s) => {
    q.resume();
    const path = new URL(q.url!, 'http://runner').pathname;
    const json = (body: unknown) => s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (q.method === 'POST') {
      starts.push(path.split('/')[2]);
      return json({ worker: `${startedAt}:${starts.length}`, port: 1, heapMb: 1024, offheapMb: 1024 });
    }
    if (q.method === 'DELETE') return s.writeHead(204).end();
    if (path === '/events') return json({ startedAt, seq: 0, events: [] });
    if (path === '/instances') return json([]);
    json({ ok: true, startedAt });
  });
  const ref: RunnerRef = { id, url, ready: true };
  return { ref, starts };
}

async function fixture(t: TestContext, runners: readonly RunnerRef[], unreachable?: string) {
  const store = tempStore();
  const specs = new Map<AppId, RunSpec>();
  const specFor = (id: AppId) => specs.get(id) ?? null;
  const apps = [newAppId(), newAppId()];
  for (const [i, app] of apps.entries()) {
    const spec: RunSpec = {
      app, name: appName(`pool-${i}`), tenant: DEFAULT_TENANT, release: 1 as ReleaseNumber, runtime: { kind: 'isolate', bundle: 'b' as BundleId, entry: 'app.mjs' },
      injection: { env: {}, storage: [], services: [] }, policy: { ...DEFAULT_POLICY, max_failures: 1 }, version: CURRENT,
    };
    register(store, spec);
    specs.set(app, spec);
  }
  const pool = { list: runners, ready: async () => true, runners: () => pool.list, unreachable } satisfies RunnerPool & { list: readonly RunnerRef[] };
  const instances = new Instances(store, { replica: 'gateway' as ReplicaId });
  const guard = new AppGuard({ instances, specFor });
  const events: { app: string | null; ev: string; unavailable?: unknown }[] = [];
  const runtime = new IsolateRuntime({
    pool, bundleUrl: () => '', specFor, hasRun: async () => true, instances, guard, log: (ev, app, extra) => void events.push({ app, ev, ...extra }),
  });
  t.after(() => runtime.close());
  /** Wakes the app and lets it go back to sleep, so its home stays in the row. */
  const wakeAndRetire = async (app: AppId) => {
    runtime.release(await runtime.acquire(app, 'request'));
    await runtime.retire(app);
  };
  return { apps, pool, instances, guard, events, runtime, wakeAndRetire };
}

test('pick chooses the ready runner with the fewest awake workers and breaks ties by id', () => {
  const runners = [{ id: 'c', ready: false }, { id: 'b', ready: true }, { id: 'a', ready: true }].map((r) => ({ ...r, url: '' }));
  const awake: Record<string, number> = { a: 2, b: 1, c: 0 };
  assert.equal(pick(runners, (id) => awake[id])?.id, 'b');
  assert.equal(pick(runners, () => 0)?.id, 'a');
});

test('the home is written on the first wake and the second wake goes there although another runner is emptier', async (t) => {
  const [a, b] = [await fakeRunner(t, 'a'), await fakeRunner(t, 'b')];
  const { apps: [first, second], instances, runtime, wakeAndRetire } = await fixture(t, [a.ref, b.ref]);
  await wakeAndRetire(first);
  assert.equal(instances.row(first)?.home, 'a');
  await runtime.acquire(second, 'request');
  await runtime.acquire(first, 'request');
  assert.deepEqual([a.starts, b.starts], [[first, second, first], []]);
});

test('a wake whose home is not ready is refused as Unavailable and the Guard counts nothing', async (t) => {
  const a = await fakeRunner(t, 'a');
  const { apps: [app], pool, guard, runtime, wakeAndRetire } = await fixture(t, [a.ref]);
  await wakeAndRetire(app);
  pool.list = [{ ...a.ref, ready: false }];
  await assert.rejects(runtime.acquire(app, 'request'), Unavailable);
  assert.equal(guard.quarantine(app), null);
});

test('on the kubernetes plane a wake with no runner names the runner StatefulSet, not a compose profile', async (t) => {
  const kube = {
    list: async () => ({ metadata: { resourceVersion: '1' }, items: [] }),
    async *watch(_: string, { signal }: { signal: AbortSignal }) {
      await once(signal, 'abort');
    },
  } as unknown as KubeClient;
  const statefulSet = new StatefulSetPool(kube);
  t.after(() => statefulSet.close());
  const { apps: [app], runtime } = await fixture(t, [], statefulSet.unreachable);
  await assert.rejects(runtime.acquire(app, 'request'), { message: 'no runner Pod of the pneuma-space-runner StatefulSet answered' });
});

test('a runner the pool drops marks only its own apps asleep as unavailable', async (t) => {
  const [a, b] = [await fakeRunner(t, 'a'), await fakeRunner(t, 'b')];
  const { apps: [onA, onB], pool, events, runtime } = await fixture(t, [a.ref, b.ref]);
  await runtime.reconcile();
  await runtime.acquire(onA, 'request');
  await runtime.acquire(onB, 'request');
  assert.deepEqual([a.starts, b.starts], [[onA], [onB]]);
  pool.list = [b.ref];
  await until('the dropped runner\'s app is asleep', () => runtime.state(onA) === 'asleep');
  assert.equal(runtime.state(onB), 'awake');
  assert.deepEqual(events.filter((e) => e.app === onA && e.ev === 'asleep'), [{ app: onA, ev: 'asleep', unavailable: true }]);
});

const runnerPod = (name: string, ip: string, ready: boolean): Pod => ({
  metadata: { name, resourceVersion: '1', labels: { 'pneuma-space.role': 'runner' } },
  spec: { containers: [{ name: 'runner', image: 'i' }] },
  status: { podIP: ip, conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
});

test('StatefulSetPool follows ADDED, MODIFIED and DELETED runner Pods and flips ready', async (t) => {
  const watching = Promise.withResolvers<ServerResponse>();
  const server = await listen(t, (q, s) => {
    q.resume();
    const url = new URL(q.url!, 'http://api');
    assert.equal(url.searchParams.get('labelSelector'), 'pneuma-space.role=runner');
    if (url.searchParams.get('watch') !== 'true') {
      return s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ metadata: { resourceVersion: '1' }, items: [runnerPod('runner-0', '10.0.0.1', true)] }));
    }
    s.writeHead(200, { 'content-type': 'application/json' });
    watching.resolve(s);
  });
  const pool = new StatefulSetPool(new KubeClient({ server, token: async () => 't', namespace: 'pneuma-space' }));
  t.after(() => pool.close());
  const seen = () => pool.runners().map(({ id, url, ready }) => `${id} ${url} ${ready}`).sort();
  assert.equal(await pool.ready(), true);
  assert.deepEqual(seen(), ['runner-0 http://10.0.0.1:8082 true']);
  const watch = await watching.promise;
  const send = (type: string, pod: Pod) => watch.write(`${JSON.stringify({ type, object: pod })}\n`);
  send('ADDED', runnerPod('runner-1', '10.0.0.2', false));
  await until('runner-1 listed, not ready', () => seen().includes('runner-1 http://10.0.0.2:8082 false'));
  send('MODIFIED', runnerPod('runner-1', '10.0.0.2', true));
  await until('runner-1 ready', () => seen().includes('runner-1 http://10.0.0.2:8082 true'));
  send('DELETED', runnerPod('runner-0', '10.0.0.1', true));
  await until('runner-0 gone', () => seen().length === 1);
  assert.deepEqual(seen(), ['runner-1 http://10.0.0.2:8082 true']);
});
