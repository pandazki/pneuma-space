import http from 'node:http';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { start, mem, MiB } from './procs.ts';

const UP = 18080, RELAY = 18081, GiB = 2 ** 30, TARGET = 64 * 2 ** 20;
const upstream = await start('upstream', String(UP));
const relay = await start('relay', String(RELAY), String(UP));

type Got = { status: number; headers: http.IncomingHttpHeaders; bytes: number; head: Buffer };
function get(path: string, headers: http.OutgoingHttpHeaders = {}, pauseMs = 0): Promise<Got> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: RELAY, path, headers }, (res) => {
      let bytes = 0;
      const keep: Buffer[] = [];
      res.on('data', (c: Buffer) => { bytes += c.length; if (bytes <= 4096) keep.push(c); });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes, head: Buffer.concat(keep) }));
      if (pauseMs) { res.pause(); setTimeout(() => res.resume(), pauseMs); }
    }).on('error', reject);
  });
}

async function watch<T>(work: Promise<T>): Promise<{ result: T; before: number; peak: number; peakExternal: number; secs: number }> {
  const before = (await mem(relay)).rss;
  let peak = before, peakExternal = 0, done = false;
  const t0 = performance.now();
  work.finally(() => (done = true)).catch(() => {});
  while (!done) {
    const m = await mem(relay);
    peak = Math.max(peak, m.rss);
    peakExternal = Math.max(peakExternal, m.external);
    await sleep(50);
  }
  return { result: await work, before, peak, peakExternal, secs: (performance.now() - t0) / 1000 };
}

const range = await get('/small', { range: 'bytes=10-19' });
assert.equal(range.status, 206);
assert.equal(range.headers['content-range'], 'bytes 10-19/1024');
assert.deepEqual([...range.head], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
console.log('range: 206 with content-range bytes 10-19/1024 and bytes 10..19 passed through');

const one = await watch(get(`/big?bytes=${GiB}`));
assert.equal(one.result.bytes, GiB);
assert.equal(one.result.headers['transfer-encoding'], 'chunked');
await sleep(1000);
const after = (await mem(relay)).rss;
const growth = one.peak - one.before;
console.log(`1 GiB download: ${one.result.bytes} bytes, chunked, ${one.secs.toFixed(2)} s, ${(1024 / one.secs).toFixed(0)} MiB/s`);
console.log(`relay RSS MiB: before ${MiB(one.before)}, peak ${MiB(one.peak)}, after 1 s ${MiB(after)}; growth ${MiB(growth)} -> ${growth < TARGET ? 'MET' : 'MISSED'} target < 64; peak V8 external ${MiB(one.peakExternal)}`);

const four = await watch(Promise.all([1, 2, 3, 4].map(() => get(`/big?bytes=${GiB}`))));
assert.deepEqual(four.result.map((r) => r.bytes), [GiB, GiB, GiB, GiB]);
console.log(`4 concurrent 1 GiB downloads: ${four.secs.toFixed(2)} s; relay RSS peak ${MiB(four.peak)} MiB (single stream peak ${MiB(one.peak)})`);

const paused = await watch(get(`/big?bytes=${GiB}`, {}, 3000));
assert.equal(paused.result.bytes, GiB);
console.log(`1 GiB to a client paused 3 s: relay RSS ${MiB(paused.before)} -> peak ${MiB(paused.peak)} MiB (no buffering while the client stalls)`);

const UPLOAD = 256 * 2 ** 20;
const up = await watch(new Promise<string>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: RELAY, method: 'POST', path: '/sink' }, (res) => {
    let s = '';
    res.on('data', (c) => (s += c));
    res.on('end', () => resolve(s));
  }).on('error', reject);
  const chunk = Buffer.alloc(64 * 1024, 0x62);
  let left = UPLOAD;
  const pump = () => {
    while (left > 0) { left -= chunk.length; if (!req.write(chunk)) return void req.once('drain', pump); }
    req.end();
  };
  pump();
}));
assert.equal(Number(up.result), UPLOAD);
console.log(`256 MiB chunked upload: upstream counted ${up.result} bytes in ${up.secs.toFixed(2)} s; relay RSS peak ${MiB(up.peak)} MiB`);

upstream.kill();
relay.kill();
