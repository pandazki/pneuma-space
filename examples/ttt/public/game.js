const game = document.getElementById('game');
const board = document.getElementById('board');
const seats = document.getElementById('seats');
const status = document.getElementById('status');
const share = document.getElementById('share');
const copy = document.getElementById('copy');
const id = game.dataset.id;
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const MARKS = ['X', 'O'];

share.textContent = `${location.origin}${ui.prefix}/g/${id}`;
copy.onclick = async () => {
  try { await navigator.clipboard.writeText(share.textContent); } catch { getSelection().selectAllChildren(share); return; }
  copy.textContent = ui.t('copied');
  setTimeout(() => { copy.textContent = ui.t('copy'); }, 1500);
};

function show(tone, text) {
  status.className = `status ${tone}`;
  status.textContent = text;
}

function line(state) {
  return LINES.find((l) => state.winner === state.board[l[0]] && l.every((c) => state.board[c] === state.winner)) ?? [];
}

function headline(state) {
  if (state.winner === 'draw') return ['', ui.t('draw')];
  if (state.winner) return ['green', state.winner === state.you ? ui.t('youWon') : ui.t('won', { mark: state.winner })];
  if (!state.you) return ['', ui.t('watching', { mark: state.turn })];
  if (state.turn === state.you) return ['green', ui.t('yourTurn', { mark: state.you })];
  if (state.players.length < 2) return ['orange', ui.t('waitingSeat', { mark: 'O' })];
  return ['orange', ui.t('waitingFor', { mark: state.turn })];
}

function draw(state) {
  const won = line(state);
  board.replaceChildren(...[...state.board].map((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c === '.' ? '' : c;
    b.dataset.mark = c;
    b.classList.toggle('won', won.includes(i));
    b.setAttribute('aria-label', ui.t('cell', { row: Math.floor(i / 3) + 1, col: (i % 3) + 1 }));
    b.disabled = c !== '.' || state.winner !== null || state.turn !== state.you;
    b.onclick = () => socket.send(JSON.stringify({ type: 'move', cell: i }));
    return b;
  }));
  seats.replaceChildren(...MARKS.map((mark, i) => {
    const chip = document.createElement('span');
    const name = state.players[i];
    chip.className = 'chip seat';
    chip.dataset.mark = mark;
    chip.classList.toggle('turn', !state.winner && state.turn === mark);
    chip.classList.toggle('open', !name);
    const m = document.createElement('b');
    m.textContent = mark;
    chip.append(m, name ? (state.you === mark ? ui.t('you', { name }) : name) : ui.t('open'));
    return chip;
  }));
  show(...headline(state));
}

let socket;
let delay = 500;
let last = null;
function connect() {
  show('orange', ui.t('connecting'));
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${ui.prefix}/g/${id}/live`);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    delay = 500;
    if (message.error) {
      show('red', ui.t(`error.${message.error}`));
      if (last) setTimeout(() => show(...headline(last)), 2000);
      return;
    }
    draw((last = message));
  };
  // 1001 means a new release or a long idle; the server sends the stored state again on reconnect.
  socket.onclose = (event) => {
    if (event.code === 1008) return show('red', ui.t('error.no-game'));
    show('orange', ui.t('reconnecting', { code: event.code }));
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 10000);
  };
}
connect();
