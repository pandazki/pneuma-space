import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { start } from './procs.ts';

const UP = 18090, RELAY = 18091, N = 1000;
const upstream = await start('upstream', String(UP));
const relay = await start('relay', String(RELAY), String(UP));

async function upgrade(port: number): Promise<Duplex> {
  const req = http.request({
    host: '127.0.0.1', port, path: '/ws',
    headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
  });
  req.end();
  const [res, socket] = await once(req, 'upgrade') as [http.IncomingMessage, Duplex];
  assert.equal(res.statusCode, 101);
  return socket;
}

async function roundTrips(socket: Duplex): Promise<number[]> {
  const msg = Buffer.alloc(32, 0x6d);
  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    socket.write(msg);
    let got = 0;
    while (got < msg.length) got += ((await once(socket, 'data'))[0] as Buffer).length;
    times.push(Number(process.hrtime.bigint() - t0) / 1000);
  }
  return times;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const p99 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.99)];

const direct = await roundTrips(await upgrade(UP));
const relayed = await roundTrips(await upgrade(RELAY));
console.log(`${N} x 32-byte echo round trips, microseconds: direct median ${median(direct).toFixed(0)} p99 ${p99(direct).toFixed(0)}; relayed median ${median(relayed).toFixed(0)} p99 ${p99(relayed).toFixed(0)}`);
console.log(`added latency per message through the relay: median ${(median(relayed) - median(direct)).toFixed(0)} us`);

const half = await upgrade(RELAY);
const echoed: Buffer[] = [];
half.on('data', (c: Buffer) => echoed.push(c));
half.end('last words');
await once(half, 'end');
assert.equal(Buffer.concat(echoed).toString(), 'last words');
console.log('half-close: client end() after a write still received the echo, then end from upstream');

upstream.kill();
relay.kill();
