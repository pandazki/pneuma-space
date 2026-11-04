import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';

const SERVE = new URL('./serve.ts', import.meta.url).pathname;

export async function start(...args: string[]): Promise<ChildProcess> {
  const child = fork(SERVE, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const [msg] = await once(child, 'message');
  if (!(msg as { ready?: boolean }).ready) throw new Error(`${args[0]} did not start`);
  return child;
}

export async function mem(child: ChildProcess): Promise<NodeJS.MemoryUsage> {
  child.send({ rss: true });
  const [msg] = await once(child, 'message');
  return (msg as { mem: NodeJS.MemoryUsage }).mem;
}

export const MiB = (n: number) => (n / 2 ** 20).toFixed(1);
