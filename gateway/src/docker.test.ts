import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Docker } from './docker.ts';
import { DEFAULT_POLICY, type AppId, type AppName, type ImageId, type ReleaseNumber, type TenantName } from './model.ts';
import { containerSpec, type ContainerRun } from './runtime.ts';

class RecordingDocker extends Docker {
  readonly bodies: unknown[] = [];
  override async request(_method: string, _path: string, body?: unknown) {
    this.bodies.push(body);
    return { status: 201, body: Buffer.from('{"Id":"c1"}') };
  }
}

const run = (policy: Partial<ContainerRun['policy']>): ContainerRun => ({
  app: 'a1' as AppId, name: 'survey' as AppName, tenant: 'blue' as TenantName, release: 1 as ReleaseNumber,
  runtime: { kind: 'container', image: 'sha256:one' as ImageId }, injection: { env: {}, storage: [], services: [] },
  policy: { ...DEFAULT_POLICY, ...policy }, version: 1,
});

test('a container is created with NanoCpus and Memory from the effective policy', async () => {
  const docker = new RecordingDocker('/nonexistent');
  await docker.create('pneuma-space-a1-1', containerSpec(run({ cpu_millis: 500, memory_mb: 256 }), 'net'));
  const { HostConfig } = docker.bodies[0] as { HostConfig: { NanoCpus: number; Memory: number } };
  assert.deepEqual([HostConfig.NanoCpus, HostConfig.Memory], [500_000_000, 256 * 2 ** 20]);
});

test('changing cpu_millis or memory_mb changes the spec label, so the kept container is replaced', () => {
  const label = (policy: Partial<ContainerRun['policy']>) => containerSpec(run(policy), 'net').labels['pneuma-space.spec'];
  assert.equal(new Set([label({}), label({ cpu_millis: 500 }), label({ memory_mb: 1024 })]).size, 3);
});
