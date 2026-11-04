const prefix = document.body.dataset.prefix;
const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${prefix}/room`);
const room = document.getElementById('room');
const say = document.getElementById('say');

socket.onmessage = (event) => {
  const { from, text } = JSON.parse(event.data);
  const item = document.createElement('li');
  item.textContent = `${from}: ${text}`;
  room.prepend(item);
};
say.onsubmit = (event) => {
  event.preventDefault();
  socket.send(say.elements.text.value);
  say.reset();
};
