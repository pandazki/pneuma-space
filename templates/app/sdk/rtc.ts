import { createHmac } from 'node:crypto';
import { need } from './env.ts';

export type IceServer = { readonly urls: string[]; readonly username?: string; readonly credential?: string };

const list = (csv: string) => csv.split(',').map((s) => s.trim()).filter(Boolean);

export function iceServers(userId: string, ttlSeconds = 3600): IceServer[] {
  const { stunUrls, turnUrls, turnSecret } = need('rtc');
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${userId}`;
  const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
  return [{ urls: list(stunUrls) }, { urls: list(turnUrls), username, credential }];
}
