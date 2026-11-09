// The authenticating proxy a developer cluster lacks: a signing key, test JWTs, and a browser proxy that adds the identity header.
//   node deploy/dev-cluster/identity.mjs keys                 private.pem and keys.json next to this file
//   node deploy/dev-cluster/identity.mjs jwt <user> <audience>
//   node deploy/dev-cluster/identity.mjs proxy <user> [user...]
// The proxy serves apps on 18080, identity from the cookie pneuma_dev_as (default: the first user), and the console
// on 18081, 18082, ... one port per user, forwarding to the gateway's port-forward on 38080 and 38081.
// PNEUMA_SPACE_DEV_PORT, PNEUMA_SPACE_DEV_UPSTREAM and PNEUMA_SPACE_DEV_KEY move the ports and the key file.
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const ISSUER = 'https://pneuma-space.test';
const KID = 'dev-1';
const HEADER = 'x-auth-jwt';
const APPS = 'pneuma-space-apps';
const CONSOLE = 'pneuma-space-console';
const here = (file) => new URL(file, import.meta.url);
const keyFile = process.env.PNEUMA_SPACE_DEV_KEY ?? here('./private.pem');
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function jwt(user, audience, key) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', typ: 'JWT', kid: KID });
  const body = b64({ iss: ISSUER, aud: audience, sub: user, name: user, email: `${user}@example.test`, iat: now, nbf: now - 30, exp: now + 900 });
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${signature}`;
}

function tokens() {
  const key = createPrivateKey(readFileSync(keyFile));
  const cache = new Map();
  return (user, audience) => {
    const hit = cache.get(`${user} ${audience}`);
    if (hit && hit.until > Date.now()) return hit.token;
    const token = jwt(user, audience, key);
    cache.set(`${user} ${audience}`, { token, until: Date.now() + 600_000 });
    return token;
  };
}

function listen(port, upstream, identity) {
  const server = http.createServer((req, res) => {
    const { connection, 'keep-alive': keepAlive, ...headers } = req.headers;
    if (!headers.authorization) headers[HEADER] = identity(req);
    const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: req.url, headers }, (answer) => {
      // Hop-by-hop headers stay behind: Node frames the relayed body itself.
      const { connection, 'keep-alive': keepAlive, 'transfer-encoding': encoding, ...passed } = answer.headers;
      res.writeHead(answer.statusCode, passed);
      answer.pipe(res);
    });
    up.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(`identity proxy: ${error.message}`);
    });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(upstream, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      if (!req.headers.authorization) lines.push(`${HEADER}: ${identity(req)}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  server.listen(port, '127.0.0.1');
}

const [command, ...args] = process.argv.slice(2);
if (command === 'keys') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(here('./keys.json'), `${JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' }] }, null, 2)}\n`);
} else if (command === 'jwt' && args.length === 2) {
  process.stdout.write(`${jwt(args[0], args[1], createPrivateKey(readFileSync(keyFile)))}\n`);
} else if (command === 'proxy' && args.length > 0) {
  const token = tokens();
  const port = Number(process.env.PNEUMA_SPACE_DEV_PORT ?? 18080);
  const upstream = Number(process.env.PNEUMA_SPACE_DEV_UPSTREAM ?? 38080);
  const cookie = (req) => /(?:^|;\s*)pneuma_dev_as=([\w.-]+)/.exec(req.headers.cookie ?? '')?.[1];
  listen(port, upstream, (req) => token(cookie(req) ?? args[0], APPS));
  args.forEach((user, i) => listen(port + 1 + i, upstream + 1, () => token(user, CONSOLE)));
  console.log(`apps http://*.apps.localtest.me:${port}/ (cookie pneuma_dev_as, default ${args[0]})`);
  args.forEach((user, i) => console.log(`console as ${user}: http://127.0.0.1:${port + 1 + i}/`));
} else {
  console.error('usage: identity.mjs keys | jwt <user> <audience> | proxy <user> [user...]');
  process.exit(2);
}
