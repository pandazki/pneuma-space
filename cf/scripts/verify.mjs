import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import tls from 'node:tls';
import { connect } from './client.mjs';

const client = await connect(), checks = [];
const check = (name, details) => { checks.push({ name, ...details }); console.log(JSON.stringify(checks.at(-1))); };
let app, tokenId;
const apps = [];
function socket(address, token, channel) {
  const url = new URL(address), key = randomBytes(16).toString('base64');
  const connection = tls.connect({ host: url.hostname, port: 443, servername: url.hostname });
  let buffer = Buffer.alloc(0), opened = false, expected;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket handshake timeout')), 30000);
    connection.once('secureConnect', () => connection.write(['GET ' + url.pathname + '_pneuma-space/realtime/' + channel + ' HTTP/1.1', 'Host: ' + url.hostname, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: ' + key, 'Authorization: Bearer ' + token, '', ''].join('\r\n')));
    connection.on('error', error => { clearTimeout(timer); reject(error); });
    connection.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!opened) {
        const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
        const headers = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 4);
        clearTimeout(timer);
        if (!/^HTTP\/1.1 101 /.test(headers)) { connection.destroy(); reject(new Error('WebSocket handshake rejected: ' + headers.split('\r\n')[0])); return; }
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (!headers.toLowerCase().includes('sec-websocket-accept: ' + accept.toLowerCase())) { reject(new Error('Invalid WebSocket accept')); return; }
        opened = true; resolve();
      }
      while (buffer.length >= 2) {
        const type = buffer[0] & 15, length = buffer[1] & 127;
        if (length >= 126) { expected?.reject(new Error('Unexpected large verification frame')); return; }
        if (buffer.length < 2 + length) return;
        const body = buffer.subarray(2, 2 + length).toString(); buffer = buffer.subarray(2 + length);
        if (type === 1) expected?.resolve(JSON.parse(body));
      }
    });
  });
  return { ready, next: () => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('WebSocket delivery timeout')), 10000); expected = { resolve: value => { clearTimeout(timer); resolve(value); }, reject }; }), close: () => connection.destroy() };
}
try {
  assert.equal(client.me.platformAdmin, true);
  const resources = await client.api('/admin/resources');
  assert.equal(resources.d1.status, 'reachable'); assert.equal(resources.objects.status, 'reachable');
  check('CF-01 owner authentication and CF resource probes', { status: 'passed' });
  const tenant = client.me.tenants[0]?.id;
  assert.ok(tenant, 'Owner needs a tenant');
  app = await client.api('/tenants/' + tenant + '/apps', { name: 'verify-' + randomUUID().slice(0, 8) });
  apps.push(app);
  const manifest = { contract: 'pneuma-space.cf/1', runtime: 'static', entry: 'public/index.html', capabilities: { static: { dir: 'public' } } };
  const contents = 'PneumaSpace private verification';
  const bytes = Buffer.from(JSON.stringify({ manifest, files: [{ path: 'public/index.html', body: Buffer.from(contents).toString('base64'), contentType: 'text/plain' }] }));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const ticket = await client.api('/apps/' + app.id + '/uploads', { manifest, digest, bytes: bytes.length });
  const upload = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: bytes, signal: AbortSignal.timeout(60000) });
  assert.equal(upload.status, 200);
  const operation = randomUUID();
  const release = await client.api('/apps/' + app.id + '/releases', { uploadId: ticket.uploadId }, 'POST', operation);
  assert.equal((await client.api('/apps/' + app.id + '/releases', { uploadId: ticket.uploadId }, 'POST', operation)).releases.length, 1);
  assert.equal(release.runtime.running, false);
  check('CF-06 direct package publication and CF-07 retry', { status: 'passed', appId: app.id });
  let createdToken = await client.api('/tenants/' + tenant + '/tokens', { label: 'cloud-verification', scopes: ['invoke', 'read'], appIds: [app.id], expiresAt: Date.now() + 600000 });
  tokenId = createdToken.id;
  const headers = { authorization: 'Bearer ' + createdToken.token };
  const response = await fetch(app.url, { headers, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200); assert.equal(await response.text(), contents);
  const partial = await fetch(app.url, { headers: { ...headers, range: 'bytes=0-5' }, signal: AbortSignal.timeout(30000) });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), contents.slice(0, 6));
  const head = await fetch(app.url, { method: 'HEAD', headers, signal: AbortSignal.timeout(30000) });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), bytes.length > 0 ? contents.length : 0);
  assert.equal((await fetch(app.url, { signal: AbortSignal.timeout(30000) })).status, 401);
  const navigation = await fetch(app.url + '?view=all', { redirect: 'manual', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(30000) });
  assert.equal(navigation.status, 303);
  assert.equal(navigation.headers.get('location'), client.origin + '/login?next=' + encodeURIComponent(new URL(app.url).pathname + '?view=all'));
  const bare = await fetch(app.url.slice(0, -1), { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  assert.equal(bare.status, 308); assert.equal(bare.headers.get('location'), app.url);
  check('CF-04 private app path and CF-12 static HEAD/Range and CF-24 path address', { status: 'passed', url: app.url });
  await client.api('/tenants/' + tenant + '/tokens/' + tokenId, undefined, 'DELETE'); tokenId = undefined;
  app = await client.api('/tenants/' + tenant + '/apps', { name: 'verify-node-' + randomUUID().slice(0, 8) });
  apps.push(app);
  const nodeManifest = { contract: 'pneuma-space.cf/1', runtime: 'node', entry: 'main.mjs', capabilities: { db: {}, kv: {}, files: {}, object: {}, identity: {} } };
  const source = "import http from 'node:http';http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({url:req.url,headers:req.headers,env:process.env}))}).listen(Number(process.env.PNEUMA_SPACE_PORT),'0.0.0.0');";
  const nodeBytes = Buffer.from(JSON.stringify({ manifest: nodeManifest, files: [{ path: 'main.mjs', body: Buffer.from(source).toString('base64'), contentType: 'text/javascript' }] }));
  const nodeTicket = await client.api('/apps/' + app.id + '/uploads', { manifest: nodeManifest, digest: createHash('sha256').update(nodeBytes).digest('hex'), bytes: nodeBytes.length });
  assert.equal((await fetch(nodeTicket.url, { method: 'PUT', headers: nodeTicket.headers, body: nodeBytes, signal: AbortSignal.timeout(60000) })).status, 200);
  await client.api('/apps/' + app.id + '/releases', { uploadId: nodeTicket.uploadId });
  createdToken = await client.api('/tenants/' + tenant + '/tokens', { label: 'cloud-native-verification', scopes: ['invoke', 'read'], appIds: [app.id], expiresAt: Date.now() + 600000 });
  tokenId = createdToken.id; headers.authorization = 'Bearer ' + createdToken.token;
  const echo = await fetch(app.url + 'probe?x=1', { headers: { ...headers, 'x-pneuma-space-subject': 'forged', cookie: '__Host-pneuma-space-control=secret' }, signal: AbortSignal.timeout(30000) });
  assert.equal(echo.status, 200);
  const identity = await echo.json();
  assert.equal(identity.headers['x-pneuma-space-subject'], client.me.user.id);
  assert.equal(identity.headers.authorization, undefined);
  assert.equal(identity.headers.cookie, undefined);
  assert.equal(identity.env.PNEUMA_SPACE_R2_SECRET_ACCESS_KEY, undefined);
  assert.equal(identity.url, '/probe?x=1');
  assert.equal(identity.headers['x-forwarded-prefix'], '/apps/' + app.name);
  check('CF-06 real Node container, CF-04 trusted identity and CF-24 stripped path with prefix header', { status: 'passed', appId: app.id });
  const data = command => client.api('/apps/' + app.id + '/data', command);
  await data({ type: 'db.query', sql: 'CREATE TABLE verification(value TEXT)', params: [] });
  await data({ type: 'db.query', sql: 'INSERT INTO verification(value) VALUES(?)', params: ['persisted'] });
  await data({ type: 'kv.put', key: 'counter', value: 0 });
  await Promise.all(Array.from({ length: 10 }, () => data({ type: 'kv.increment', key: 'counter', amount: 1 })));
  assert.equal((await data({ type: 'kv.get', key: 'counter' })).value, 10);
  await data({ type: 'files.put', path: 'proof.txt', body: Buffer.from('durable').toString('base64') });
  check('CF-08 SQL/KV/files and CF-14 concurrent increment', { status: 'passed' });
  const objectBytes = Buffer.from('direct object bytes');
  const objectTicket = await data({ type: 'object.upload', key: 'proof.txt', bytes: objectBytes.length, contentType: 'text/plain' });
  assert.equal((await fetch(objectTicket.url, { method: 'PUT', headers: objectTicket.headers, body: objectBytes, signal: AbortSignal.timeout(30000) })).status, 200);
  await data({ type: 'object.complete', id: objectTicket.id });
  const download = await data({ type: 'object.download', key: 'proof.txt' });
  assert.deepEqual(Buffer.from(await (await fetch(download.url, { signal: AbortSignal.timeout(30000) })).arrayBuffer()), objectBytes);
  check('CF-11 direct native object upload/download', { status: 'passed' });
  const a = socket(app.url, createdToken.token, 'verification'), b = socket(app.url, createdToken.token, 'verification');
  try {
    await Promise.all([a.ready, b.ready]);
    const nextA = a.next(), nextB = b.next();
    await data({ type: 'kv.publish', channel: 'verification', value: { verified: true } });
    assert.deepEqual(await nextA, { verified: true }); assert.deepEqual(await nextB, { verified: true });
  } finally { a.close(); b.close(); }
  check('CF-14 two real WebSocket subscribers', { status: 'passed' });
  await client.api('/apps/' + app.id + '/actions', { type: 'remove' });
  assert.equal((await fetch(app.url, { headers, signal: AbortSignal.timeout(30000) })).status, 409);
  await client.api('/apps/' + app.id + '/actions', { type: 'resume' });
  assert.equal((await data({ type: 'db.query', sql: 'SELECT value FROM verification', params: [] })).rows[0].value, 'persisted');
  assert.equal((await data({ type: 'kv.get', key: 'counter' })).value, 10);
  assert.equal(Buffer.from((await data({ type: 'files.get', path: 'proof.txt' })).body, 'base64').toString(), 'durable');
  check('CF-10 remove/resume retains native data', { status: 'passed' });
} finally {
  if (tokenId) await client.api('/tenants/' + client.me.tenants[0].id + '/tokens/' + tokenId, undefined, 'DELETE');
  for (const app of apps.reverse()) {
    await client.api('/apps/' + app.id + '/actions', { type: 'remove' });
    const result = await client.api('/apps/' + app.id + '/actions', { type: 'purge', confirmation: app.name });
    check('CF-10 verification cleanup', result.pending ? { status: 'pending', retryAt: result.retryAt, appId: app.id } : { status: 'purged' });
  }
  await client.close();
}
console.log(JSON.stringify({ passed: checks.filter(check => check.status === 'passed').length, note: 'Browser, Node cloud lifecycle, scheduled delivery and TURN require separate acceptance evidence.' }));
