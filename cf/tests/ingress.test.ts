import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf: Miniflare;
before(async () => {
  const source = [
    "import {guestResponse,guestHeaders} from './src/worker.ts';",
    "export default {fetch(request){",
    "if(new URL(request.url).pathname==='/request')return Response.json(Object.fromEntries(guestHeaders(request,{user:{id:'u_1',name:'测试'},kind:'session'},true,{owner_id:'u_1',name:'notes'})));",
    "const headers=new Headers();headers.append('set-cookie','ordinary=value; Domain=apps.test; Path=/; HttpOnly');headers.append('set-cookie','another=ok; dOmAiN = apps.test; Secure');headers.append('set-cookie','__Host-pneuma-space-control=forged; Path=/; Secure');headers.set('service-worker-allowed','/');",
    "if(request.headers.get('upgrade')==='websocket'){const pair=new WebSocketPair();pair[1].accept();pair[1].close();return guestResponse(new Response(null,{status:101,headers,webSocket:pair[0]}))}",
    "return guestResponse(new Response('app response',{headers}))}}",
  ].join('\n');
  const bundled = await build({ stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'esnext', external: ['cloudflare:workers'] });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-11-13', compatibilityFlags: ['nodejs_compat'] }));
});
after(async () => { await mf?.dispose(); });
test('CF-04 guest cannot receive platform cookies, bearer credentials or spoofed identity', async () => {
  const response = await mf.dispatchFetch('https://test/request', { headers: { cookie: 'ordinary=ok; __Host-pneuma-space-control=secret', authorization: 'Bearer secret', 'x-pneuma-space-subject': 'forged', 'x-pneuma-space-scope': 'forged' } });
  const headers = await response.json() as Record<string, string>;
  assert.equal(headers.cookie, 'ordinary=ok');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['x-pneuma-space-scope'], undefined);
  assert.equal(headers['x-pneuma-space-subject'], 'u_1');
  assert.equal(decodeURIComponent(headers['x-pneuma-space-name']), '测试');
});
test('CF-24 the app receives its path prefix and cannot be handed another', async () => {
  const response = await mf.dispatchFetch('https://test/request', { headers: { 'x-forwarded-prefix': '/apps/other' } });
  assert.equal((await response.json() as Record<string, string>)['x-forwarded-prefix'], '/apps/notes');
});
test('CF-24 an app response cannot widen its service worker scope beyond its path', async () => {
  const response = await mf.dispatchFetch('https://test/');
  assert.equal(response.headers.get('service-worker-allowed'), null);
  await response.body?.cancel();
});
test('CF-03 guest HTTP cookies cannot target sibling hosts or platform sessions', async () => {
  const response = await mf.dispatchFetch('https://test/');
  const cookies = response.headers.getSetCookie();
  assert.deepEqual(cookies, ['ordinary=value; Path=/; HttpOnly', 'another=ok; Secure']);
  assert.equal(await response.text(), 'app response');
});
test('CF-03 guest WebSocket cookies retain the same host boundary', async () => {
  const response = await mf.dispatchFetch('https://test/', { headers: { upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  assert.deepEqual(response.headers.getSetCookie(), ['ordinary=value; Path=/; HttpOnly', 'another=ok; Secure']);
  response.webSocket?.accept();
  response.webSocket?.close();
});
