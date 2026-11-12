import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { startLocalServer } from '../adapters/local/server.ts';

test('US-C-2 the real CLI publishes and exports a retained application through HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pneuma-space-cli-'));
  const app = await startLocalServer({ directory, port: 0, consoleHtml: '<html>test</html>' });
  try {
    const origin = app.config.controlOrigin;
    const signin = await fetch(origin + '/auth/development', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ user: 'alice' }) });
    assert.equal(signin.status, 200, await signin.clone().text());
    const cookie = signin.headers.getSetCookie()[0].split(';')[0];
    const me = await (await fetch(origin + '/api/me', { headers: { cookie } })).json() as { csrf: string; user: { tenant: string } };
    const token = await (await fetch(origin + '/api/tokens', { method: 'POST', headers: { cookie, origin, 'x-pneuma-space-csrf': me.csrf },
      body: JSON.stringify({ label: 'smoke', scopes: ['read', 'publish', 'invoke', 'remove', 'export'], appIds: null, expiresAt: Date.now() + 3600_000 }) })).json() as { token: string };
    assert.equal(typeof token.token, 'string');
    const root = resolve(import.meta.dirname, '../..');
    const run = (args: string[]) => promisify(execFile)(process.execPath, [join(root, 'cloud/cli/appctl.ts'), ...args], { cwd: root, env: { ...process.env, PNEUMA_SPACE_ADMIN: origin, PNEUMA_SPACE_TOKEN: token.token } });
    const published = JSON.parse((await run(['publish', 'counter', 'examples/cloud-counter', '--key', 'cli-smoke-1'])).stdout);
    assert.equal(published.number, 1);
    const url = new URL(origin);
    const application = await new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
      const req = request({ hostname: '127.0.0.1', port: url.port, path: '/api/count', method: 'POST', headers: { host: `counter--${me.user.tenant}.${app.config.appsDomain}`, authorization: 'Bearer ' + token.token } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk); res.on('end', () => resolveResponse({ status: res.statusCode!, body }));
      }); req.on('error', reject); req.end();
    });
    assert.equal(application.status, 200, application.body);
    assert.equal(JSON.parse(application.body).count, 1);
    await run(['remove', 'counter']);
    const archivePath = join(directory, 'counter.json');
    await run(['export', 'counter', archivePath]);
    const archive = JSON.parse(await readFile(archivePath, 'utf8'));
    assert.equal(archive.records.records[0].value, 1);
    assert.equal(archive.artifact.manifest.contract, 2);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
