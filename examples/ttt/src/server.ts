import { randomUUID } from 'node:crypto';
import { kv } from '../sdk/kv.ts';
import { body, serve } from '../sdk/serve.ts';
import type { Context, Identity } from '../sdk/serve.ts';
import { ws } from '../sdk/ws.ts';
import type { Socket } from '../sdk/ws.ts';
import { pickLang, switchLang, translate } from '../ui/i18n.ts';
import type { T } from '../ui/i18n.ts';
import { esc, page } from '../ui/page.ts';

type Mark = 'X' | 'O';
type Player = { subject: string; name: string };
type Game = { board: string; turn: Mark; players: Player[]; winner: Mark | 'draw' | null };
type Rejection = 'no-game' | 'not-player' | 'game-over' | 'not-your-turn' | 'bad-cell';

const dict = {
  en: {
    title: 'Tic-tac-toe',
    newTitle: 'New game', newAbout: 'Start a board, then send its address to the other player.', create: 'New game',
    joinTitle: 'Join a game', joinAbout: 'Paste the address or id someone sent you.', joinPlaceholder: 'Game address or id', join: 'Join',
    joinBad: 'No game has that id.',
    boardTitle: 'Board', boardAbout: 'X moves first. Three in a row wins.',
    inviteTitle: 'Invite', inviteAbout: 'The next visitor takes the free seat. Everyone after that watches.',
    copy: 'Copy', copied: 'Copied', another: 'Start another game',
    missingTitle: 'Game not found', missingAbout: 'This address has no game. Check that it was copied whole.',
    connecting: 'Connecting', reconnecting: 'Disconnected ({code}), reconnecting',
    yourTurn: 'Your turn, you play {mark}', waitingFor: 'Waiting for {mark}', waitingSeat: 'Waiting for someone to take {mark}',
    watching: 'Watching, {mark} to move', won: '{mark} won', youWon: 'You won', draw: 'Draw',
    open: 'open', you: '{name} (you)', cell: 'Row {row}, column {col}',
    'error.no-game': 'This game no longer exists', 'error.not-player': 'You are watching this game',
    'error.game-over': 'The game is over', 'error.not-your-turn': 'Not your turn', 'error.bad-cell': 'That cell is taken',
    'error.bad-message': 'The move was not understood',
  },
  zh: {
    title: '井字棋',
    newTitle: '新对局', newAbout: '开一盘棋，再把地址发给对手。', create: '新对局',
    joinTitle: '加入对局', joinAbout: '粘贴别人发给你的地址或编号。', joinPlaceholder: '对局地址或编号', join: '加入',
    joinBad: '没有这个编号的对局。',
    boardTitle: '棋盘', boardAbout: 'X 先走，三子连成一线获胜。',
    inviteTitle: '邀请', inviteAbout: '下一位访问者坐上空位，之后来的人观战。',
    copy: '复制', copied: '已复制', another: '再开一局',
    missingTitle: '找不到对局', missingAbout: '这个地址没有对局，请确认复制完整。',
    connecting: '连接中', reconnecting: '连接断开（{code}），正在重连',
    yourTurn: '轮到你了，你执 {mark}', waitingFor: '等待 {mark} 落子', waitingSeat: '等待有人坐上 {mark}',
    watching: '观战中，轮到 {mark}', won: '{mark} 获胜', youWon: '你赢了', draw: '平局',
    open: '空位', you: '{name}（你）', cell: '第 {row} 行第 {col} 列',
    'error.no-game': '这盘棋已不存在', 'error.not-player': '你在观战',
    'error.game-over': '对局已结束', 'error.not-your-turn': '还没轮到你', 'error.bad-cell': '这一格已有棋子',
    'error.bad-message': '无法识别这步棋',
  },
};

const store = await kv();
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const MARKS: Mark[] = ['X', 'O'];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const seatOf = (game: Game, subject: string): Mark | null => MARKS[game.players.findIndex((p) => p.subject === subject)] ?? null;
const view = (game: Game, identity: Identity | null) =>
  ({ ...game, players: game.players.map((p) => p.name), you: identity ? seatOf(game, identity.subject) : null });

function winner(board: string): Game['winner'] {
  for (const [a, b, c] of LINES) if (board[a] !== '.' && board[a] === board[b] && board[a] === board[c]) return board[a] as Mark;
  return board.includes('.') ? null : 'draw';
}

class Rejected extends Error {
  declare readonly message: Rejection;
}

// Compare-and-set in Redis so two containers or two simultaneous moves cannot overwrite each other.
const CAS = `if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[1], ARGV[2]) return 1 end return 0`;

const load = (id: string) => store.redis.get(store.key('game:' + id));

async function update(id: string, change: (game: Game) => void): Promise<Game> {
  for (;;) {
    const raw = await load(id);
    if (!raw) throw new Rejected('no-game');
    const game: Game = JSON.parse(raw);
    change(game);
    const next = JSON.stringify(game);
    if (next === raw) return game;
    if (await store.redis.eval(CAS, { keys: [store.key('game:' + id)], arguments: [raw, next] }) === 1) {
      await store.publish('game:' + id, next);
      return game;
    }
  }
}

// A program never takes X, so a person always opens the game.
function seat(game: Game, { subject, name }: Identity) {
  if (seatOf(game, subject) || game.players.length >= 2) return;
  if (subject.startsWith('service:') && game.players.length === 0) return;
  game.players.push({ subject, name });
}

const move = (id: string, identity: Identity, cell: unknown) =>
  update(id, (game) => {
    seat(game, identity);
    const mark = seatOf(game, identity.subject);
    if (!mark) throw new Rejected('not-player');
    if (game.winner) throw new Rejected('game-over');
    if (game.turn !== mark) throw new Rejected('not-your-turn');
    if (!Number.isInteger(cell) || (cell as number) < 0 || (cell as number) > 8 || game.board[cell as number] !== '.') throw new Rejected('bad-cell');
    const at = cell as number;
    game.board = game.board.slice(0, at) + mark + game.board.slice(at + 1);
    game.winner = winner(game.board);
    game.turn = mark === 'X' ? 'O' : 'X';
  });

function html({ res, prefix }: Context, status: number, lang: 'en' | 'zh', body: string, head = '') {
  const t = translate(dict, lang);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(page({ prefix, lang, dict, title: t('title'), body, head, badge: 'example' }));
}

function json(res: Context['res'], status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}

function home(t: T, prefix: string, joinValue = '', joinError = false) {
  const p = esc(prefix);
  return `<section>
<header><h2>${esc(t('newTitle'))}</h2><p>${esc(t('newAbout'))}</p></header>
<form method="post" action="${p}/new"><button class="primary">${esc(t('create'))}</button></form>
</section>
<section>
<header><h2>${esc(t('joinTitle'))}</h2><p>${esc(t('joinAbout'))}</p></header>
<form class="row join" method="get" action="${p}/join"><input name="id" required autocomplete="off" value="${esc(joinValue)}" placeholder="${esc(t('joinPlaceholder'))}"><button>${esc(t('join'))}</button></form>
${joinError ? `<p class="status red">${esc(t('joinBad'))}</p>` : ''}
</section>`;
}

function board(t: T, prefix: string, id: string) {
  return `<section>
<header><h2>${esc(t('boardTitle'))}</h2><p>${esc(t('boardAbout'))}</p></header>
<p class="status orange" id="status">${esc(t('connecting'))}</p>
<div class="game" id="game" data-id="${esc(id)}"><div class="row seats" id="seats"></div><div class="inset board" id="board"></div></div>
</section>
<section>
<header><h2>${esc(t('inviteTitle'))}</h2><p>${esc(t('inviteAbout'))}</p></header>
<div class="row share"><code class="chip" id="share"></code><button type="button" id="copy">${esc(t('copy'))}</button></div>
<p><a href="${esc(prefix)}/">${esc(t('another'))}</a></p>
</section>`;
}

const missing = (t: T, prefix: string) => `<section>
<header><h2>${esc(t('missingTitle'))}</h2><p>${esc(t('missingAbout'))}</p></header>
<a class="btn primary" href="${esc(prefix)}/">${esc(t('another'))}</a>
</section>`;

const server = serve(async (ctx) => {
  if (switchLang(ctx)) return;
  const { req, res, url, prefix, identity } = ctx;
  const lang = pickLang(req);
  const t = translate(dict, lang);
  const method = req.method;
  if (method === 'GET' && url.pathname === '/') return html(ctx, 200, lang, home(t, prefix));
  if (method === 'GET' && url.pathname === '/join') {
    const typed = url.searchParams.get('id') ?? '';
    const id = UUID.exec(typed.toLowerCase())?.[0];
    if (id && (await load(id))) return void res.writeHead(303, { location: `${prefix}/g/${id}` }).end();
    return html(ctx, 404, lang, home(t, prefix, typed, true));
  }
  if (method === 'POST' && url.pathname === '/new') {
    const id = randomUUID();
    const game: Game = { board: '.........', turn: 'X', players: [], winner: null };
    await store.redis.set(store.key('game:' + id), JSON.stringify(game));
    return void res.writeHead(303, { location: `${prefix}/g/${id}` }).end();
  }
  const m = /^\/g\/([0-9a-f-]{36})(\/[a-z]+)?$/.exec(url.pathname);
  if (m) {
    const [, id, sub] = m;
    if (method === 'GET' && !sub) {
      if (!(await load(id))) return html(ctx, 404, lang, missing(t, prefix));
      const head = `<link rel="stylesheet" href="${esc(prefix)}/game.css"><script defer src="${esc(prefix)}/game.js"></script>`;
      return html(ctx, 200, lang, board(t, prefix, id), head);
    }
    if (method === 'GET' && sub === '/state') {
      const raw = await load(id);
      return raw ? json(res, 200, view(JSON.parse(raw), identity)) : json(res, 404, { error: 'no-game' });
    }
    if (method === 'POST' && sub === '/move') {
      if (!identity) return json(res, 401, { error: 'identity required' });
      let cell: unknown;
      try { cell = JSON.parse((await body(req)).toString()).cell; } catch { return json(res, 400, { error: 'body must be {"cell": 0-8}' }); }
      try { return json(res, 200, view(await move(id, identity, cell), identity)); } catch (e) {
        if (e instanceof Rejected) return json(res, e.message === 'no-game' ? 404 : 409, { error: e.message });
        throw e;
      }
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
});

// Subscribe once per game id; every container fans out to its own sockets.
const rooms = new Map<string, Set<Socket>>();

async function enter(id: string, socket: Socket) {
  let room = rooms.get(id);
  if (!room) {
    rooms.set(id, (room = new Set()));
    await store.subscribe('game:' + id, (message) => {
      const game: Game = JSON.parse(message);
      for (const s of rooms.get(id) ?? []) s.send(JSON.stringify(view(game, s.identity)));
    });
  }
  room.add(socket);
}

ws(server, async (socket) => {
  const m = /^\/g\/([0-9a-f-]{36})\/live$/.exec(socket.url.pathname);
  if (!m || !socket.identity) return socket.close(1008, 'unknown path');
  const id = m[1];
  const identity = socket.identity;
  socket.onclose = () => rooms.get(id)?.delete(socket);
  socket.onmessage = async (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg.type === 'move') await move(id, identity, msg.cell);
    } catch (e) {
      socket.send(JSON.stringify({ error: e instanceof Rejected ? e.message : 'bad-message' }));
    }
  };
  await enter(id, socket);
  try {
    socket.send(JSON.stringify(view(await update(id, (g) => seat(g, identity)), identity)));
  } catch {
    socket.close(1008, 'no such game');
  }
});
