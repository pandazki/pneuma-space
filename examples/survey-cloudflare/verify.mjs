import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { csv } from './public/csv.js';
const endpoint = process.env.PNEUMA_SPACE_VERIFY_URL;
const credentialPath = process.env.PNEUMA_SPACE_VERIFY_CREDENTIALS;
if (!endpoint || !credentialPath) throw new Error('Set PNEUMA_SPACE_VERIFY_URL and PNEUMA_SPACE_VERIFY_CREDENTIALS');
const { ownerToken, memberToken, operatorToken } = JSON.parse(await readFile(credentialPath, 'utf8'));
const base = new URL(endpoint).origin;
const observations = [];
const node = {};
const exports = {};
const digest = (value) => createHash('sha256').update(value).digest('hex');
async function r2Denied(label, url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const xml = await response.text();
  assert((response.status === 403 && /<Code>(AccessDenied|SignatureDoesNotMatch)<\/Code>/.test(xml)) ||
    (response.status === 400 && /<Code>InvalidArgument<\/Code>/.test(xml) && /Authorization/i.test(xml)), `${label} auth denial: ${response.status}`);
  observations.push({ label, status: response.status, denial: /<Code>([^<]+)<\/Code>/.exec(xml)?.[1] });
}
async function downloadOld(label, previous) {
  if (previous.status !== 'passed') return;
  const ticket = await call(`${label}-old-download`, '/_pneuma-space/export/download');
  assert.equal(ticket.status, 200);
  assert(new URL(ticket.data.url).pathname.endsWith(`/${previous.id}.csv`), `${label} retained export id`);
  const response = await fetch(ticket.data.url, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200);
  assert.equal(digest(Buffer.from(await response.arrayBuffer())), previous.sha256, `${label} retained export digest`);
}
async function call(label, path, { method = 'GET', role = 'owner', body, headers = {} } = {}) {
  const token = { owner: ownerToken, member: memberToken, operator: operatorToken }[role];
  const response = await fetch(base + path, {
    method, redirect: 'manual', signal: AbortSignal.timeout(90000),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body,
  });
  const text = await response.text();
  observations.push({ label, status: response.status, cfRay: response.headers.get('cf-ray') });
  return { status: response.status, text, headers: response.headers, data: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
}
const control = (path, method = 'GET') => call(`control-${path}`, `/_pneuma-space/control/${path}`, { role: 'operator', method });
async function save(label, answer) {
  const body = new URLSearchParams(answer).toString();
  assert.equal((await call(label, '/answer', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 303);
  return readAnswer(label, answer);
}
async function readAnswer(label, answer) {
  const page = await call(`${label}-read`, '/');
  assert.equal(page.status, 200);
  for (const key of ['q1', 'q2', 'q3']) {
    const inputs = [...page.text.matchAll(new RegExp(`<input[^>]*name="${key}"[^>]*>`, 'g'))].map((x) => x[0]);
    const selected = inputs.filter((x) => /\schecked(?:\s|>)/.test(x));
    assert.equal(selected.length, 1, `${label} ${key} selected count`);
    assert(selected[0].includes(`value="${answer[key]}"`), `${label} ${key} selected value`);
  }
  const rows = await call(`${label}-rows`, '/_pneuma-space/export/rows');
  assert.equal(rows.status, 200);
  assert(rows.data.answers.some((a) => a.subject === 'pandazki' && a.q1 === answer.q1 && a.q2 === answer.q2 && a.q3 === answer.q3));
  assert(!rows.data.answers.some((a) => a.subject === 'cf-other-scope-probe'), 'other app excluded');
  return rows.data.answers;
}
async function exportRound(label, answers) {
  const content = csv(answers);
  const availability = await call(`${label}-availability`, '/_pneuma-space/export/availability');
  if (!availability.data.enabled) return { status: 'incomplete', reason: availability.data.reason };
  const begin = await call(`${label}-begin`, '/_pneuma-space/export/begin', {
    method: 'POST', body: JSON.stringify({ bytes: Buffer.byteLength(content) }), headers: { 'content-type': 'application/json' },
  });
  assert.equal(begin.status, 200);
  const put = await fetch(begin.data.url, { method: 'PUT', headers: begin.data.headers, body: content, signal: AbortSignal.timeout(30000) });
  assert.equal(put.status, 200, `direct R2 PUT ${label}`);
  const altered = new URL(begin.data.url); altered.pathname = altered.pathname.replace(/\.csv$/, '-wrong.csv');
  await r2Denied(`${label}-altered-key`, altered, { method: 'PUT', headers: begin.data.headers, body: content });
  await r2Denied(`${label}-wrong-method`, begin.data.url, { method: 'GET' });
  const complete = await call(`${label}-complete`, '/_pneuma-space/export/complete', {
    method: 'POST', body: JSON.stringify({ id: begin.data.id }), headers: { 'content-type': 'application/json' },
  });
  assert.equal(complete.status, 200);
  const again = await call(`${label}-complete-repeat`, '/_pneuma-space/export/complete', {
    method: 'POST', body: JSON.stringify({ id: begin.data.id }), headers: { 'content-type': 'application/json' },
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.data, complete.data);
  const getTicket = await call(`${label}-download`, '/_pneuma-space/export/download');
  assert.equal(getTicket.status, 200);
  assert(new URL(getTicket.data.url).pathname.endsWith(`/${begin.data.id}.csv`), `${label} latest export id`);
  const get = await fetch(getTicket.data.url, { signal: AbortSignal.timeout(30000) });
  assert.equal(get.status, 200, `direct R2 GET ${label}`);
  const downloaded = Buffer.from(await get.arrayBuffer());
  assert.equal(digest(downloaded), digest(content));
  await r2Denied(`${label}-unsigned`, new URL(getTicket.data.url).origin + new URL(getTicket.data.url).pathname);
  return { status: 'passed', id: begin.data.id, bytes: downloaded.length, sha256: digest(downloaded) };
}
try {
  assert.equal((await call('no-auth', '/', { role: 'none' })).status, 401);
  assert.equal((await call('member-results', '/results', { role: 'member' })).status, 403);
  assert.equal((await call('member-ticket', '/_pneuma-space/export/begin', { role: 'member', method: 'POST', body: '{}' })).status, 403);
  assert.equal((await call('owner-control', '/_pneuma-space/control/status')).status, 401);
  assert.equal((await call('spoof-owner', '/results', { role: 'member', headers: { 'x-pneuma-space-owner': '1' } })).status, 403);
  const probe = await control('storage-probe');
  assert.deepEqual(probe.data, { fixturePresent: true, allowed: { status: 200, foreignSubjectAbsent: true }, forbidden: 403, unknown: 404 });
  const loginPage = await call('login-page', '/login', { role: 'none' });
  assert.equal(loginPage.status, 200);
  assert(!loginPage.text.includes('value="member"'));
  const login = await call('cookie-login', '/login', { role: 'none', method: 'POST', body: new URLSearchParams({ user: 'owner', key: ownerToken }).toString(), headers: { origin: base } });
  assert.equal(login.status, 303);
  const session = login.headers.get('set-cookie').split(';')[0];
  const language = await call('language-choice', '/?lang=zh', { role: 'none', headers: { cookie: session } });
  assert.equal(language.status, 303);
  const lang = language.headers.get('set-cookie').split(';')[0];
  const zhPage = await call('language-persisted', '/', { role: 'none', headers: { cookie: `${session}; ${lang}`, 'accept-language': 'en' } });
  assert.equal(zhPage.status, 200);
  assert(zhPage.text.includes('<html lang="zh"'));
  assert.equal((await call('cookie-csrf', '/answer', { role: 'none', method: 'POST', body: 'q1=ok&q2=hybrid&q3=growth', headers: { cookie: session, origin: 'https://evil.example' } })).status, 403);
  const beforeSpoof = (await call('before-spoof', '/_pneuma-space/export/rows')).data.answers.find((a) => a.subject === 'pandazki');
  assert.equal((await call('spoof-subject', '/answer', { role: 'member', method: 'POST', body: 'q1=ok&q2=hybrid&q3=growth', headers: { 'x-pneuma-space-subject': 'pandazki', origin: base } })).status, 303);
  const memberRows = await call('member-saved', '/_pneuma-space/export/rows');
  assert.equal(memberRows.status, 200);
  assert(memberRows.data.answers.some((a) => a.subject === 'member' && a.q1 === 'ok' && a.q2 === 'hybrid' && a.q3 === 'growth'));
  assert.deepEqual(memberRows.data.answers.find((a) => a.subject === 'pandazki'), beforeSpoof, 'forged subject did not change owner');
  assert.equal((await call('evil-origin', '/answer', { role: 'member', method: 'POST', body: 'q1=poor&q2=remote&q3=culture', headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('oversized-answer', '/answer', { method: 'POST', body: new URLSearchParams({ q1: 'great', q2: 'office', q3: 'pay', padding: 'x'.repeat(5000) }).toString() })).status, 413);
  assert.deepEqual((await call('after-oversized', '/_pneuma-space/export/rows')).data.answers.find((a) => a.subject === 'pandazki'), beforeSpoof, 'oversized answer did not write');
  assert.equal((await call('unknown-op', '/_pneuma-space/export/sql', { method: 'POST', body: JSON.stringify({ sql: 'DROP TABLE answer', app: 'other' }) })).status, 404);
  assert.equal((await control('image/v1', 'POST')).data.image, 'v1');
  const firstMetaRequestStarted = performance.now();
  const firstMeta = (await call('meta-first', '/_pneuma-space/meta')).data;
  assert.equal(firstMeta.image, 'v1');
  assert(typeof firstMeta.boot === 'string' && firstMeta.boot.length > 0, 'first boot id');
  assert(Number.isFinite(firstMeta.uptimeMs) && firstMeta.uptimeMs >= 0, 'first process uptime');
  node.firstMeta = firstMeta;
  observations.push({ label: 'meta-first-readiness', elapsedMs: performance.now() - firstMetaRequestStarted, metadataUptimeMs: firstMeta.uptimeMs });
  console.log(`first: image=${firstMeta.image} boot=${firstMeta.boot}`);
  const warmMetaRequestStarted = performance.now();
  const warmMeta = (await call('meta-warm', '/_pneuma-space/meta')).data;
  assert.equal(warmMeta.image, 'v1');
  assert.equal(warmMeta.boot, firstMeta.boot);
  assert(Number.isFinite(warmMeta.uptimeMs) && warmMeta.uptimeMs >= 0, 'warm process uptime');
  node.warmMeta = warmMeta;
  const processAgeUpperBoundMs = () => warmMeta.uptimeMs + performance.now() - warmMetaRequestStarted;
  const first = await save('first', { q1: 'great', q2: 'office', q3: 'pay' });
  assert.equal(first.find((a) => a.subject === 'pandazki').q1, 'great');
  exports.initial = await exportRound('initial', first);
  const quietStart = new Date().toISOString();
  const quietStartProcessAgeUpperBoundMs = processAgeUpperBoundMs();
  assert(quietStartProcessAgeUpperBoundMs < 20000, 'quiet window started within process lifetime limit');
  await new Promise((resolve) => setTimeout(resolve, 90000));
  const status = (await control('status')).data;
  const quietEnd = new Date().toISOString();
  const quietEndProcessAgeUpperBoundMs = processAgeUpperBoundMs();
  observations.push({ label: 'quiet-window', start: quietStart, end: quietEnd, running: status.running, processAgeUpperBoundMs: { start: quietStartProcessAgeUpperBoundMs, end: quietEndProcessAgeUpperBoundMs }, metadataUptimeMs: warmMeta.uptimeMs });
  assert(quietEndProcessAgeUpperBoundMs < 120000, 'idle stop observed before process lifetime limit');
  assert.equal(status.running, false, 'idle stop');
  const idleMeta = (await call('meta-idle', '/_pneuma-space/meta')).data;
  assert.equal(idleMeta.image, 'v1'); node.idleMeta = idleMeta;
  console.log(`idle: image=${idleMeta.image} boot=${idleMeta.boot}`);
  assert.notEqual(idleMeta.boot, firstMeta.boot);
  await readAnswer('idle-persisted', { q1: 'great', q2: 'office', q3: 'pay' });
  await downloadOld('idle', exports.initial);
  exports.idle = await exportRound('idle', await save('idle-write', { q1: 'ok', q2: 'hybrid', q3: 'growth' }));
  assert.equal((await control('kill', 'POST')).status, 200);
  const killMeta = (await call('meta-kill', '/_pneuma-space/meta')).data;
  assert.equal(killMeta.image, 'v1'); node.killMeta = killMeta;
  console.log(`kill: image=${killMeta.image} boot=${killMeta.boot}`);
  assert.notEqual(killMeta.boot, idleMeta.boot);
  await readAnswer('kill-persisted', { q1: 'ok', q2: 'hybrid', q3: 'growth' });
  await downloadOld('kill', exports.idle);
  exports.kill = await exportRound('kill', await save('kill-write', { q1: 'poor', q2: 'remote', q3: 'culture' }));
  assert.equal((await control('image/v2', 'POST')).status, 200);
  const v2Meta = (await call('meta-v2', '/_pneuma-space/meta')).data;
  node.v2Meta = v2Meta;
  console.log(`v2: image=${v2Meta.image} boot=${v2Meta.boot}`);
  assert.equal(v2Meta.image, 'v2');
  assert.notEqual(v2Meta.boot, killMeta.boot);
  await readAnswer('v2-persisted', { q1: 'poor', q2: 'remote', q3: 'culture' });
  await downloadOld('v2', exports.kill);
  exports.v2 = await exportRound('v2', await save('v2-write', { q1: 'great', q2: 'remote', q3: 'growth' }));
  const r2 = Object.values(exports).every((x) => x.status === 'passed') ? 'passed' : 'incomplete';
  const result = { at: new Date().toISOString(), base, lifecycle: 'passed', r2, node, exports, observations };
  if (process.env.PNEUMA_SPACE_VERIFY_EVIDENCE) await writeFile(process.env.PNEUMA_SPACE_VERIFY_EVIDENCE, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ lifecycle: 'passed', r2, observations: observations.length }));
  if (r2 !== 'passed') process.exitCode = 2;
} catch (error) {
  if (process.env.PNEUMA_SPACE_VERIFY_EVIDENCE) await writeFile(process.env.PNEUMA_SPACE_VERIFY_EVIDENCE, JSON.stringify({ at: new Date().toISOString(), base, lifecycle: 'failed', r2: 'incomplete', error: error.message, node, exports, observations }, null, 2) + '\n');
  console.error(`Verification failed: ${error.message}`);
  process.exitCode = 1;
}
