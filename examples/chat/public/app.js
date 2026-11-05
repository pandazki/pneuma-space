const room = document.getElementById('room');
const say = document.getElementById('say');
const status = document.getElementById('status');
const time = new Intl.DateTimeFormat(ui.lang, { hour: '2-digit', minute: '2-digit' });

function show(tone, text) {
  status.className = `status ${tone}`;
  status.textContent = text;
}

let socket;
let delay = 500;
function connect() {
  show('orange', ui.t('connecting'));
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${ui.prefix}/room`);
  socket.onopen = () => {
    show('green', ui.t('connected'));
    delay = 500;
    room.replaceChildren();
  };
  socket.onmessage = (event) => {
    const { from, text, at } = JSON.parse(event.data);
    const item = document.createElement('li');
    const who = document.createElement('b');
    const when = document.createElement('time');
    const what = document.createElement('p');
    who.textContent = from;
    when.textContent = time.format(new Date(at));
    when.dateTime = at;
    what.textContent = text;
    item.append(who, when, what);
    room.append(item);
    item.scrollIntoView({ block: 'nearest' });
  };
  // 1001 means a new release or a long idle; the platform wakes the app again on reconnect.
  socket.onclose = (event) => {
    show('orange', ui.t('reconnecting', { code: event.code }));
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 10000);
  };
}
connect();
say.onsubmit = (event) => {
  event.preventDefault();
  if (socket.readyState !== WebSocket.OPEN || !say.elements.text.value.trim()) return;
  socket.send(say.elements.text.value);
  say.reset();
};
