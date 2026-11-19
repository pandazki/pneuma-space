// Container IPs are unreachable from a macOS host, so the suite runs where the gateway runs: in a container on the app network.
// On the host this file builds the app image and that container; inside it (PNEUMA_SPACE_TEST_IMAGE set) it runs the Runtime tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { demux, Docker, type ContainerInfo } from './docker.ts';
import { DockerInfra } from './infra.ts';
import { Instances } from './instances.ts';
import { CURRENT, register, tempStore } from './lifecycle.fakes.ts';
import {
  appName, DEFAULT_POLICY, DEFAULT_TENANT, newAppId, NotFound, type AppId, type ImageId, type Lease, type Policy, type ReleaseNumber, type ReplicaId, type RunSpec, type StorageBinding,
} from './model.ts';
import { DockerRuntime } from './runtime.ts';

const SERVER = `if (process.env.FIXTURE_EXIT) process.exit(1);
console.log('fixture ready');
process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => {});
if (process.env.FIXTURE_SILENT) setInterval(() => {}, 1000);
else require('http').createServer((q, s) => q.url === '/exit' ? process.exit(3) : s.end(process.env.PNEUMA_SPACE_APP + ' ' + process.env.PNEUMA_SPACE_RELEASE)).listen(8000);`;

if (process.env.PNEUMA_SPACE_TEST_IMAGE) inner(process.env.PNEUMA_SPACE_TEST_IMAGE as ImageId, process.env.PNEUMA_SPACE_NETWORK!);
else outer();

function outer(): void {
  test('runtime suite passes inside a container on the app network', { timeout: 300_000 }, async (t) => {
    const docker = new Docker();
    const network = `pneuma-space-u3-test-${randomBytes(4).toString('hex')}`;
    const labels = { 'pneuma-space.test': '1', 'pneuma-space.network': network };
    const call = async (method: string, path: string, body?: unknown) => {
      const reply = await docker.request(method, path, body);
      assert.ok(reply.status < 300, `${method} ${path}: ${reply.status} ${reply.body}`);
      return reply.body.length ? JSON.parse(reply.body.toString()) : null;
    };
    let image = '';
    try {
      await call('POST', '/networks/create', { Name: network, Labels: labels });
      const build = await call('POST', `/containers/create?name=${network}-build`, { Image: 'node:24-alpine', Cmd: ['node', '-e', SERVER], Labels: labels });
      image = (await call('POST', `/commit?container=${build.Id}&repo=pneuma-space-u3-test-app&tag=${network}`)).Id;
      await call('DELETE', `/containers/${build.Id}`);
      const runner = await call('POST', `/containers/create?name=${network}-runner`, {
        Image: 'node:24-alpine',
        Cmd: ['node', '--test', '--test-reporter=spec', '/gateway/src/runtime.test.ts'],
        Env: [`PNEUMA_SPACE_TEST_IMAGE=${image}`, `PNEUMA_SPACE_NETWORK=${network}`],
        Labels: labels,
        HostConfig: { NetworkMode: network, Binds: ['/var/run/docker.sock:/var/run/docker.sock', `${resolve(import.meta.dirname, '..')}:/gateway:ro`, `${resolve(import.meta.dirname, '../../shared')}:/shared:ro`] },
      });
      await call('POST', `/containers/${runner.Id}/start`);
      const { StatusCode } = await call('POST', `/containers/${runner.Id}/wait`);
      const logs = demux((await docker.request('GET', `/containers/${runner.Id}/logs?stdout=1&stderr=1`)).body);
      for (const line of (logs.stdout + logs.stderr).trimEnd().split('\n')) t.diagnostic(line);
      assert.equal(StatusCode, 0, 'inner suite failed; its output is in the diagnostics above');
    } finally {
      for (const container of await docker.list({ label: [`pneuma-space.network=${network}`] })) await docker.remove(container.Id);
      if (image) await docker.request('DELETE', `/images/${image}?force=1`);
      await docker.request('DELETE', `/networks/${network}`);
    }
    const left = execFileSync('docker', ['ps', '-aq', '--filter', 'label=pneuma-space.test', '--filter', `label=pneuma-space.network=${network}`]).toString();
    assert.equal(left, '', 'no test container is left behind');
  });
}

function inner(image: ImageId, network: string): void {
  class CountingDocker extends Docker {
    starts = 0;
    stops = 0;
    onStop: () => void = () => {};
    async start(id: string): Promise<boolean> {
      this.starts++;
      return super.start(id);
    }
    async stop(id: string): Promise<void> {
      this.stops++;
      this.onStop();
      return super.stop(id);
    }
  }

  const raw = new Docker();

  function fixture(t: TestContext, policy: Partial<Policy> = {}) {
    const app = newAppId();
    const specs = new Map<AppId, RunSpec>();
    const store = tempStore();
    const publish = (release: number, env: Record<string, string> = {}, id: AppId = app, storage: StorageBinding[] = []) => {
      const spec: RunSpec = {
        app: id, name: appName(id === app ? 'fixture' : `fixture-${id}`), tenant: DEFAULT_TENANT, release: release as ReleaseNumber, runtime: { kind: 'container', image },
        injection: { env, storage, services: [] }, policy: { ...DEFAULT_POLICY, ...policy }, version: CURRENT,
      };
      register(store, spec);
      specs.set(id, spec);
    };
    /** A gateway process: its own mirror of the shared store, under the same replica name, as a restart keeps the host name. */
    const instances = () => new Instances(store, { replica: 'gateway' as ReplicaId });
    publish(1);
    const runtimes: DockerRuntime[] = [];
    const events: Record<string, unknown>[] = [];
    const start = () => {
      const docker = new CountingDocker();
      const runtime = new DockerRuntime({ docker, network, specFor: (id) => specs.get(id) ?? null, instances: instances(), log: (ev, id, extra) => { if (id === app) events.push({ ev, ...extra }); } });
      runtimes.push(runtime);
      return { docker, runtime };
    };
    t.after(async () => {
      for (const runtime of runtimes) runtime.close();
      for (const id of specs.keys()) {
        for (const container of await raw.list({ label: [`pneuma-space.app=${id}`] })) await raw.remove(container.Id);
      }
    });
    return { app, events, instances, publish, start, specFor: (id: AppId) => specs.get(id) ?? null, ...start() };
  }

  const answer = async (address: string) => (await fetch(`http://${address}/`)).text();
  const containers = async (app: AppId) => (await raw.list({ label: [`pneuma-space.app=${app}`] })).map((c) => c.Labels['pneuma-space.release']);
  async function until(what: string, condition: () => boolean, ms = 10_000): Promise<void> {
    for (const end = Date.now() + ms; !condition(); await sleep(10)) assert.ok(Date.now() < end, `timed out waiting for ${what}`);
  }

  test('concurrent acquires on a sleeping app start one container and get an address that answers', async (t) => {
    const { app, docker, runtime } = fixture(t);
    const started = performance.now();
    const [a, b] = await Promise.all([runtime.acquire(app, 'request'), runtime.acquire(app, 'request')]);
    t.diagnostic(`cold wake (create, start, ready): ${Math.round(performance.now() - started)} ms`);
    assert.equal(docker.starts, 1);
    assert.equal(a.address, b.address);
    assert.equal(await answer(a.address), 'fixture 1');
  });

  test('a container that exits at once fails the wake even when another container answers on its old IP', async (t) => {
    const { app, instances, publish, start, specFor } = fixture(t, { ready_timeout_seconds: 3 });
    const other = newAppId();
    publish(1, {}, other);
    const { runtime: healthy } = start();
    const live = await healthy.acquire(other, 'request');
    class ReusedAddress extends Docker {
      async inspect(id: string): Promise<ContainerInfo | null> {
        const info = await super.inspect(id);
        if (!info || this.reused) return info;
        this.reused = true;
        return { ...info, NetworkSettings: { Networks: { [network]: { IPAddress: live.address.split(':')[0] } } } };
      }
      reused = false;
    }
    publish(1, { FIXTURE_EXIT: '1' });
    const runtime = new DockerRuntime({ docker: new ReusedAddress(), network, specFor, instances: instances(), log: () => {} });
    t.after(() => runtime.close());
    await assert.rejects(runtime.acquire(app, 'request'));
    assert.equal(runtime.state(app), 'asleep');
  });

  test('logs returns what the app container printed, and nothing for an app without one', async (t) => {
    const { app, runtime } = fixture(t);
    runtime.release(await runtime.acquire(app, 'request'));
    assert.equal(await runtime.logs(app, 10), 'fixture ready\n');
    assert.equal(await runtime.logs(newAppId(), 10), '');
  });

  test('leases counts the held leases by kind after acquire and channel', async (t) => {
    const { app, runtime } = fixture(t);
    const held = await Promise.all([runtime.acquire(app, 'request'), runtime.acquire(app, 'request'), runtime.acquire(app, 'trigger')]);
    runtime.channel(held[0], () => {});
    assert.deepEqual(runtime.leases(app), { request: 1, channel: 1, trigger: 1 });
    for (const lease of held) runtime.release(lease);
  });

  test('acquire rejects with NotFound when the app has no RunSpec', async (t) => {
    const { runtime } = fixture(t);
    await assert.rejects(runtime.acquire(newAppId(), 'request'), NotFound);
  });

  test('a held lease keeps the instance awake past idle_seconds; after release the reaper stops it', async (t) => {
    const { app, docker, runtime } = fixture(t, { idle_seconds: 1 });
    const lease = await runtime.acquire(app, 'request');
    await sleep(2500);
    assert.equal(runtime.state(app), 'awake');
    assert.equal(docker.stops, 0);
    runtime.release(lease);
    await until('idle stop', () => runtime.state(app) === 'asleep', 4000);
    assert.equal(docker.stops, 1);
  });

  test('sleepsAt is null while a lease is held and is the release time plus idle_seconds after release', async (t) => {
    const { app, runtime } = fixture(t, { idle_seconds: 30 });
    const lease = await runtime.acquire(app, 'request');
    assert.equal(runtime.sleepsAt(app), null);
    const before = Date.now();
    runtime.release(lease);
    const after = Date.now();
    const at = runtime.sleepsAt(app)!;
    assert.ok(at >= before + 30_000 && at <= after + 30_000, `sleepsAt ${at - before} ms after release`);
  });

  test('an acquire during stopping waits and wakes the instance again', async (t) => {
    const { app, docker, runtime } = fixture(t, { idle_seconds: 1 });
    runtime.release(await runtime.acquire(app, 'request'));
    const during = Promise.withResolvers<{ state: string; lease: Promise<Lease> }>();
    docker.onStop = () => during.resolve({ state: runtime.state(app), lease: runtime.acquire(app, 'request') });
    const { state, lease: pending } = await during.promise;
    assert.equal(state, 'stopping');
    const lease = await pending;
    assert.equal(docker.stops, 1);
    assert.equal(docker.starts, 2);
    assert.equal(await answer(lease.address), 'fixture 1');
  });

  test('retire waits for the held lease, then removes the container; the next acquire runs the new release', async (t) => {
    const { app, publish, runtime } = fixture(t);
    const lease = await runtime.acquire(app, 'request');
    publish(2);
    const retired = runtime.retire(app);
    await sleep(500);
    assert.equal(runtime.state(app), 'draining');
    assert.deepEqual(await containers(app), ['1']);
    runtime.release(lease);
    await retired;
    assert.deepEqual(await containers(app), []);
    const next = await runtime.acquire(app, 'request');
    assert.equal(await answer(next.address), 'fixture 2');
  });

  test('retire stops after drain_timeout_seconds when a request lease is never released', async (t) => {
    const { app, runtime } = fixture(t, { drain_timeout_seconds: 1 });
    await runtime.acquire(app, 'request');
    const started = performance.now();
    await runtime.retire(app);
    const ms = performance.now() - started;
    assert.ok(ms >= 1000 && ms < 3000, `drain took ${Math.round(ms)} ms`);
    assert.equal(runtime.state(app), 'asleep');
  });

  test('retire calls onRetire for channel leases', async (t) => {
    const { app, runtime } = fixture(t);
    const lease = await runtime.acquire(app, 'request');
    let closed = 0;
    runtime.channel(lease, () => { closed++; runtime.release(lease); });
    await runtime.retire(app);
    assert.equal(closed, 1);
    assert.equal(runtime.state(app), 'asleep');
  });

  test('an external docker stop flips the instance to asleep; the next acquire wakes it under 3 s', async (t) => {
    const { app, runtime } = fixture(t);
    await runtime.reconcile();
    runtime.release(await runtime.acquire(app, 'request'));
    const [container] = await raw.list({ label: [`pneuma-space.app=${app}`] });
    await raw.stop(container.Id);
    await until('die event', () => runtime.state(app) === 'asleep');
    const started = performance.now();
    const lease = await runtime.acquire(app, 'request');
    const ms = performance.now() - started;
    t.diagnostic(`wake after external stop (start, ready): ${Math.round(ms)} ms`);
    assert.ok(ms < 3000, `wake took ${Math.round(ms)} ms`);
    assert.equal(await answer(lease.address), 'fixture 1');
  });

  const failures = (events: Record<string, unknown>[]) => events.filter((e) => e.ev === 'crashed' || e.external);

  test('a container that exits on its own while awake emits crashed, then asleep', async (t) => {
    const { app, events, runtime } = fixture(t);
    await runtime.reconcile();
    const lease = await runtime.acquire(app, 'request');
    runtime.release(lease);
    await fetch(`http://${lease.address}/exit`).catch(() => {});
    await until('die event', () => runtime.state(app) === 'asleep');
    assert.deepEqual(events.slice(-2), [{ ev: 'crashed', reason: 'container exited with code 3' }, { ev: 'asleep', external: true }]);
  });

  test('an external docker stop emits asleep marked external and no crashed', async (t) => {
    const { app, events, runtime } = fixture(t);
    await runtime.reconcile();
    runtime.release(await runtime.acquire(app, 'request'));
    const [container] = await raw.list({ label: [`pneuma-space.app=${app}`] });
    await raw.stop(container.Id);
    await until('die event', () => runtime.state(app) === 'asleep');
    assert.deepEqual(failures(events), [{ ev: 'asleep', external: true }]);
  });

  test('a signal other than SIGTERM or SIGKILL does not hide a later crash', async (t) => {
    const { app, events, runtime } = fixture(t);
    await runtime.reconcile();
    const lease = await runtime.acquire(app, 'request');
    runtime.release(lease);
    const [container] = await raw.list({ label: [`pneuma-space.app=${app}`] });
    await raw.request('POST', `/containers/${container.Id}/kill?signal=HUP`);
    await fetch(`http://${lease.address}/exit`).catch(() => {});
    await until('die event', () => runtime.state(app) === 'asleep');
    assert.equal(events.filter((e) => e.ev === 'crashed').length, 1);
  });

  // Docker delivers events within milliseconds; the pause lets a die the platform caused reach the runtime before asserting it was ignored.
  test('a ready timeout emits neither crashed nor an external asleep', async (t) => {
    const { app, events, publish, runtime } = fixture(t, { ready_timeout_seconds: 1 });
    publish(1, { FIXTURE_SILENT: '1' });
    await runtime.reconcile();
    await assert.rejects(runtime.acquire(app, 'request'));
    await sleep(1000);
    assert.deepEqual(failures(events), []);
  });

  test('a drain stop emits neither crashed nor an external asleep', async (t) => {
    const { app, events, runtime } = fixture(t);
    await runtime.reconcile();
    runtime.release(await runtime.acquire(app, 'request'));
    await runtime.retire(app);
    await sleep(1000);
    assert.deepEqual(failures(events), []);
  });

  test('reconcile adopts a matching running container as awake and removes one whose spec label differs', async (t) => {
    const { app, publish, start, runtime: before } = fixture(t);
    const stale = newAppId();
    publish(1, {}, stale);
    await Promise.all([before.acquire(app, 'request'), before.acquire(stale, 'request')]);
    before.close();
    publish(1, { CHANGED: '1' }, stale);
    const { docker, runtime } = start();
    await runtime.reconcile();
    assert.equal(runtime.state(app), 'awake');
    assert.equal(runtime.state(stale), 'asleep');
    assert.deepEqual(await containers(stale), []);
    const lease = await runtime.acquire(app, 'request');
    assert.equal(docker.starts, 0);
    assert.equal(await answer(lease.address), 'fixture 1');
  });

  const infra = new DockerInfra({ docker: raw, probes: {} as never, volumes: async () => [] });

  test('resolveImage returns the id of an existing image and null for a missing one', async () => {
    assert.equal(await infra.resolveImage(image), image);
    assert.equal(await infra.resolveImage('pneuma-space-u3-missing:none'), null);
  });

  test('a storage binding is mounted from its id at its target, and {dir} in its env reads as the target', async (t) => {
    const { app, publish, runtime } = fixture(t);
    const volume = `pneuma-space-u3-test-${randomBytes(4).toString('hex')}`;
    t.after(async () => { await runtime.retire(app); await raw.removeVolume(volume); });
    publish(1, {}, app, [{ id: volume, target: '/data', env: { FIXTURE_DB: 'sqlite://{dir}/app.sqlite3' } }]);
    runtime.release(await runtime.acquire(app, 'request'));
    const [container] = await raw.list({ label: [`pneuma-space.app=${app}`] });
    const info = JSON.parse((await raw.request('GET', `/containers/${container.Id}/json`)).body.toString());
    assert.ok(info.Config.Env.includes('FIXTURE_DB=sqlite:///data/app.sqlite3'));
    assert.deepEqual(info.Mounts.map((m: { Name: string; Destination: string }) => [m.Name, m.Destination]), [[volume, '/data']]);
  });
}
