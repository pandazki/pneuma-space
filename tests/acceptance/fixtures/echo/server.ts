import { createHash, createHmac } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

const env = process.env;
const filesDir = env.PNEUMA_SPACE_FILES_DIR ?? '/data';
const kvPrefix = env.PNEUMA_SPACE_KV_PREFIX ?? '';

const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** SigV4 query presigning, path style, region us-east-1. */
export function presign(o: { method: string; endpoint: string; bucket: string; key?: string; accessKey: string; secretKey: string }): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = stamp.slice(0, 8);
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const url = new URL(o.endpoint);
  const path = '/' + [o.bucket, ...(o.key ? o.key.split('/') : [])].map(rfc3986).join('/');
  const query = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${o.accessKey}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', '3600'],
    ['X-Amz-SignedHeaders', 'host'],
  ].map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).sort().join('&');
  const request = [o.method, path, query, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, createHash('sha256').update(request).digest('hex')].join('\n');
  const key = ['us-east-1', 's3', 'aws4_request'].reduce((k, part) => hmac(k, part), hmac('AWS4' + o.secretKey, day));
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `${url.origin}${path}?${query}&X-Amz-Signature=${signature}`;
}

const RTC_PAGE = `<!doctype html><script type="module">
const role = new URLSearchParams(location.search).get('role');
const ice = await (await fetch('ice')).json();
const ws = new WebSocket(new URL('ws', location.href).href.replace(/^http/, 'ws'));
await new Promise((ok) => ws.addEventListener('message', ok, { once: true }));
const pc = new RTCPeerConnection(ice);
const send = (m) => ws.send(JSON.stringify({ from: role, ...m }));
const pending = [];
pc.onicecandidate = (e) => e.candidate && send({ candidate: e.candidate });
window.result = new Promise((done) => {
  const wire = (ch) => {
    ch.onopen = () => role === 'a' && ch.send('ping');
    ch.onmessage = (e) => { if (e.data === 'ping') ch.send('pong'); done(e.data); };
  };
  if (role === 'a') wire(pc.createDataChannel('game'));
  else pc.ondatachannel = (e) => wire(e.channel);
});
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.from === role) return;
  if (m.sdp) {
    await pc.setRemoteDescription(m.sdp);
    for (const c of pending.splice(0)) await pc.addIceCandidate(c);
    if (m.sdp.type === 'offer') { await pc.setLocalDescription(); send({ sdp: pc.localDescription }); }
  } else if (m.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(m.candidate); else pending.push(m.candidate);
  }
};
if (role === 'a') { await pc.setLocalDescription(); send({ sdp: pc.localDescription }); }
window.ready = true;
</script>`;

async function main(): Promise<void> {
  const { WebSocketServer, WebSocket } = await import('ws');
  let kvClient: Promise<any> | undefined;
  const kv = () => (kvClient ??= import('redis').then(async ({ createClient }) => {
    const client = createClient({ url: env.PNEUMA_SPACE_KV_URL });
    client.on('error', () => {});
    await client.connect();
    return client;
  }));
  const subscriber = async (channel: string, onMessage: (m: string) => void) => {
    const client = (await kv()).duplicate();
    client.on('error', () => {});
    await client.connect();
    await client.subscribe(channel, onMessage);
    return client;
  };

  let dbHandle: Promise<{ get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> }> | undefined;
  const create = 'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)';
  const db = () => (dbHandle ??= (async () => {
    const url = env.PNEUMA_SPACE_DB_URL!;
    if (url.startsWith('sqlite:')) {
      const { DatabaseSync } = await import('node:sqlite');
      const sqlite = new DatabaseSync(decodeURIComponent(new URL(url).pathname));
      sqlite.exec(create);
      return {
        get: async (k: string) => (sqlite.prepare('SELECT v FROM kv WHERE k = ?').get(k)?.v as string) ?? null,
        put: async (k: string, v: string) => void sqlite.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, v),
      };
    }
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url });
    client.on('error', () => {});
    await client.connect();
    await client.query(create);
    return {
      get: async (k: string) => (await client.query('SELECT v FROM kv WHERE k = $1', [k])).rows[0]?.v ?? null,
      put: async (k: string, v: string) => void await client.query('INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [k, v]),
    };
  })());

  const own = { endpoint: env.PNEUMA_SPACE_OBJECT_ENDPOINT!, accessKey: env.PNEUMA_SPACE_OBJECT_ACCESS_KEY!, secretKey: env.PNEUMA_SPACE_OBJECT_SECRET_KEY! };
  const logDelivery = (record: object) => appendFile(`${filesDir}/deliveries.jsonl`, JSON.stringify(record) + '\n');

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, 'http://app');
    const path = url.pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const reply = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    const [, head, key] = path.match(/^\/([^/]+)\/?(.*)$/) ?? [];

    if (req.method === 'POST' && path.startsWith('/_pneuma-space/trigger/')) {
      const record = {
        trigger: path.slice('/_pneuma-space/trigger/'.length),
        delivery: req.headers['x-pneuma-space-delivery'] ?? null,
        attempt: Number(req.headers['x-pneuma-space-attempt']),
        scheduledFor: req.headers['x-pneuma-space-scheduled-for'] ?? null,
        subject: req.headers['x-pneuma-space-subject'] ?? null,
        body,
      };
      await logDelivery({ ...record, phase: 'start', at: Date.now() });
      if (record.trigger === 'slow') {
        await new Promise((ok) => setTimeout(ok, 8000));
        await logDelivery({ ...record, phase: 'done', at: Date.now() });
      }
      return reply(200, { ok: true });
    }
    if (path === '/deliveries') {
      const text = await readFile(`${filesDir}/deliveries.jsonl`, 'utf8').catch(() => '');
      return reply(200, text.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    }
    if (path === '/env') return reply(200, Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('PNEUMA_SPACE_'))));
    if (path === '/headers') return reply(200, req.headers);
    if (head === 'files' && key) {
      if (req.method === 'PUT') return void (await writeFile(`${filesDir}/${key}`, body), reply(200, { ok: true }));
      return reply(200, { value: await readFile(`${filesDir}/${key}`, 'utf8').catch(() => null) });
    }
    if (head === 'db' && key) {
      if (req.method === 'PUT') return void (await (await db()).put(key, body), reply(200, { ok: true }));
      return reply(200, { value: await (await db()).get(key) });
    }
    if (head === 'kv' && key) {
      if (req.method === 'PUT') return void (await (await kv()).set(kvPrefix + key, body), reply(200, { ok: true }));
      return reply(200, { value: await (await kv()).get(kvPrefix + key) });
    }
    if (path === '/kv-foreign') {
      const error = await (await kv()).get('acc-foreign:key').then(() => null, (e: Error) => e.message);
      return reply(200, { error });
    }
    if (path === '/kv-pubsub') {
      const channel = kvPrefix + 'probe';
      let sub: any;
      const received = await new Promise<boolean>(async (ok) => {
        setTimeout(() => ok(false), 3000);
        sub = await subscriber(channel, () => ok(true)).catch(() => ok(false));
        await (await kv()).publish(channel, 'hello').catch(() => ok(false));
      });
      await sub?.quit().catch(() => {});
      return reply(200, { received });
    }
    if (path === '/presign') {
      const target = { ...own, endpoint: env.PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT!, bucket: env.PNEUMA_SPACE_OBJECT_BUCKET! };
      return reply(200, { url: presign({ ...target, method: url.searchParams.get('method') ?? 'GET', key: url.searchParams.get('key')! }) });
    }
    if (path === '/bucket-status') {
      const signed = presign({ ...own, method: 'HEAD', bucket: url.searchParams.get('bucket') ?? env.PNEUMA_SPACE_OBJECT_BUCKET! });
      return reply(200, { status: (await fetch(signed, { method: 'HEAD' })).status });
    }
    if (path === '/ice') {
      const username = `${Math.floor(Date.now() / 1000) + 3600}:acc`;
      const credential = createHmac('sha1', env.PNEUMA_SPACE_RTC_TURN_SECRET!).update(username).digest('base64');
      return reply(200, { iceServers: [
        { urls: env.PNEUMA_SPACE_RTC_STUN_URLS!.split(',') },
        { urls: env.PNEUMA_SPACE_RTC_TURN_URLS!.split(','), username, credential },
      ] });
    }
    if (path === '/rtc.html') return void res.writeHead(200, { 'content-type': 'text/html' }).end(RTC_PAGE);
    reply(200, { app: env.PNEUMA_SPACE_APP, release: env.PNEUMA_SPACE_RELEASE, variant: env.FIXTURE_VARIANT, path: req.url, prefix: req.headers['x-forwarded-prefix'] ?? null });
  }

  const server = createServer((req, res) => handle(req, res).catch((e: Error) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }));

  const sockets = new Set<any>();
  const broadcast = (message: string) => { for (const s of sockets) if (s.readyState === WebSocket.OPEN) s.send(message); };
  let room: Promise<unknown> | undefined;
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, 'http://app');
    if (url.pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, async (ws) => {
      if (url.searchParams.get('mode') === 'echo') return ws.on('message', (data, binary) => ws.send(data, { binary }));
      if (env.PNEUMA_SPACE_KV_URL) await (room ??= subscriber(kvPrefix + 'room', broadcast));
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (data) => {
        const text = data.toString();
        if (env.PNEUMA_SPACE_KV_URL) kv().then((c) => c.publish(kvPrefix + 'room', text));
        else broadcast(text);
      });
      ws.send('ready');
    });
  });
  server.listen(8000, '0.0.0.0');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
