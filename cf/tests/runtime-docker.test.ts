import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
const enabled = process.env.PNEUMA_SPACE_TEST_RUNNER_DOCKER === '1';
let container: string;
let origin: string;
let broker: http.Server;
const source = `import http from 'node:http';import {createHash} from 'node:crypto';
const server=http.createServer((req,res)=>{if(req.url==='/stream'){res.write('first');setTimeout(()=>res.end('second'),100);return;}if(req.url==='/env'){res.end(JSON.stringify(process.env));return;}req.pipe(res);});
server.on('upgrade',(req,socket)=>{const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');socket.on('data',data=>{if((data[0]&15)===8){socket.end();return;}const n=data[1]&127;const mask=data.subarray(2,6);const body=data.subarray(6,6+n);for(let i=0;i<body.length;i++)body[i]^=mask[i%4];socket.write(Buffer.concat([Buffer.from([129,body.length]),body]));});});
server.listen(Number(process.env.PNEUMA_SPACE_PORT),'0.0.0.0');console.log('runner-test-ready');`;
before(async () => {
  if (!enabled) return;
  const bytes = Buffer.from(JSON.stringify({ manifest: { contract: 'pneuma-space.cf/1', runtime: 'node', entry: 'main.mjs', capabilities: { ws: {} } }, files: [{ path: 'main.mjs', body: Buffer.from(source).toString('base64'), contentType: 'text/javascript' }] }));
  const digest = createHash('sha256').update(bytes).digest('hex');
  broker = http.createServer((req, res) => { if (req.url === '/boot') res.end(bytes); else { req.resume(); res.end('{}'); } });
  broker.listen(0, '0.0.0.0'); await once(broker, 'listening');
  const address = broker.address(); assert.ok(address && typeof address !== 'string');
  container = execFileSync('docker', ['run', '--rm', '-d', '--platform', 'linux/amd64', '-p', '127.0.0.1::8080', '-e', 'PNEUMA_SPACE_BOOT_ID=test-boot', '-e', 'PNEUMA_SPACE_DIGEST=' + digest, '-e', 'PNEUMA_SPACE_BROKER=http://host.docker.internal:' + address.port, 'pneuma-space-cf-runner-test'], { encoding: 'utf8' }).trim();
  const port = execFileSync('docker', ['port', container, '8080/tcp'], { encoding: 'utf8' }).trim().split(':').pop();
  origin = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(origin + '/_pneuma-space/ready')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(execFileSync('docker', ['logs', container], { encoding: 'utf8' }));
});
after(async () => { if (container) execFileSync('docker', ['rm', '-f', container]); if (broker) await new Promise<void>(resolve => broker.close(() => resolve())); });
test('CF-06 fixed Linux Node image loads and serves the verified artifact', { skip: !enabled }, async () => {
  const response = await fetch(origin + '/echo', { method: 'POST', body: 'immutable-app' });
  assert.equal(await response.text(), 'immutable-app');
});
test('CF-12 runner streams the first bytes before response completion', { skip: !enabled }, async () => {
  const response = await fetch(origin + '/stream');
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'second');
});
test('CF-12 runner forwards WebSocket upgrade and frames', { skip: !enabled }, async () => {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/socket');
  await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve()); socket.addEventListener('error', reject); });
  const message = new Promise(resolve => { socket.addEventListener('message', event => resolve(event.data)); });
  socket.send('hello'); assert.equal(await message, 'hello'); socket.close();
});
test('CF-04 child receives only execution configuration, never platform credentials', { skip: !enabled }, async () => {
  const env = await (await fetch(origin + '/env')).json() as Record<string, string>;
  assert.equal(env.PNEUMA_SPACE_PORT, '8000');
  assert.equal(env.PNEUMA_SPACE_DIGEST, undefined);
  assert.equal(env.PNEUMA_SPACE_R2_SECRET_ACCESS_KEY, undefined);
});
