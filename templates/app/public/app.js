const prefix = document.body.dataset.prefix;
const room = document.getElementById('room');
const say = document.getElementById('say');
const status = document.createElement('p');
room.before(status);

let socket;
let delay = 500;
function connect() {
  status.textContent = 'connecting';
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${prefix}/room`);
  socket.onopen = () => {
    status.textContent = 'connected';
    delay = 500;
    room.replaceChildren();
  };
  socket.onmessage = (event) => {
    const { from, text } = JSON.parse(event.data);
    const item = document.createElement('li');
    item.textContent = `${from}: ${text}`;
    room.append(item);
    item.scrollIntoView({ block: 'nearest' });
  };
  // 1001 means a new release or a long idle; the platform wakes the app again on reconnect.
  socket.onclose = (event) => {
    status.textContent = `disconnected (${event.code}), reconnecting`;
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 10000);
  };
}
connect();
say.onsubmit = (event) => {
  event.preventDefault();
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(say.elements.text.value);
  say.reset();
};
