import { createClient } from 'redis';
import { need } from './env.ts';

export type Redis = ReturnType<typeof createClient>;
export type Kv = {
  readonly redis: Redis;
  key(name: string): string;
  channel(name: string): string;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (message: string) => void): Promise<void>;
};

async function connect(): Promise<Kv> {
  const { url, prefix } = need('kv');
  const redis = await createClient({ url }).on('error', (e) => console.error('kv', e)).connect();
  let subscriber: Promise<Redis> | undefined;
  return {
    redis,
    key: (name) => prefix + name,
    channel: (name) => prefix + name,
    publish: (channel, message) => redis.publish(prefix + channel, message),
    async subscribe(channel, listener) {
      subscriber ??= redis.duplicate().on('error', (e) => console.error('kv', e)).connect().catch((error) => {
        subscriber = undefined;
        throw error;
      });
      await (await subscriber).subscribe(prefix + channel, listener);
    },
  };
}

let shared: Promise<Kv> | undefined;

export function kv(): Promise<Kv> {
  return (shared ??= connect().catch((error) => {
    shared = undefined;
    throw error;
  }));
}
