import { kv } from '../sdk/kv.ts';
import { serve } from '../sdk/serve.ts';
import { ws } from '../sdk/ws.ts';
import type { Socket } from '../sdk/ws.ts';
import { pickLang, switchLang, translate } from '../ui/i18n.ts';
import { esc, page } from '../ui/page.ts';

const dict = {
  en: {
    title: 'Chat room', room: 'Room', about: 'Everyone signed in shares this room. The last 50 messages are kept.',
    empty: 'No messages yet.', placeholder: 'Write a message', send: 'Send',
    connecting: 'Connecting', connected: 'Connected', reconnecting: 'Disconnected ({code}), reconnecting',
  },
  zh: {
    title: '聊天室', room: '房间', about: '所有登录的人共用这个房间，保留最近 50 条消息。',
    empty: '还没有消息。', placeholder: '写点什么', send: '发送',
    connecting: '连接中', connected: '已连接', reconnecting: '连接断开（{code}），正在重连',
  },
};

const store = await kv();
const log = store.key('room:log');

const server = serve((ctx) => {
  if (switchLang(ctx)) return;
  const { req, res, url, prefix } = ctx;
  if (req.method !== 'GET' || url.pathname !== '/') return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  const lang = pickLang(req);
  const t = translate(dict, lang);
  const body = `<section>
<header><h2>${esc(t('room'))}</h2><p>${esc(t('about'))}</p></header>
<p class="status orange" id="status">${esc(t('connecting'))}</p>
<ol class="inset messages" id="room" data-empty="${esc(t('empty'))}"></ol>
<form class="row" id="say"><input name="text" maxlength="500" autocomplete="off" placeholder="${esc(t('placeholder'))}"><button class="primary">${esc(t('send'))}</button></form>
</section>`;
  const head = `<link rel="stylesheet" href="${esc(prefix)}/app.css"><script defer src="${esc(prefix)}/app.js"></script>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page({ prefix, lang, dict, title: t('title'), body, head, badge: 'example' }));
});

// Every container subscribes and fans out locally, so the room works with one container or many.
// The last 50 messages live in KV, so a new tab or a reconnect after the app slept sees them.
const room = new Set<Socket>();
await store.subscribe('room', (message) => room.forEach((socket) => socket.send(message)));
ws(server, async (socket) => {
  if (socket.url.pathname !== '/room') return socket.close(1008, 'unknown path');
  socket.onclose = () => room.delete(socket);
  for (const message of (await store.redis.lRange(log, 0, 49)).reverse()) socket.send(message);
  room.add(socket);
  socket.onmessage = async (data) => {
    const text = String(data).trim().slice(0, 500);
    if (!text) return;
    const message = JSON.stringify({ from: socket.identity?.name ?? 'anonymous', text, at: new Date().toISOString() });
    await store.redis.multi().lPush(log, message).lTrim(log, 0, 49).exec();
    await store.publish('room', message);
  };
});
