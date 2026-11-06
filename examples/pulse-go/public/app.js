const total = document.getElementById('total');
const recent = document.getElementById('recent');
const empty = document.getElementById('empty');
const clock = new Intl.DateTimeFormat(ui.lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const show = (time) => { time.textContent = clock.format(new Date(time.dateTime)); };
recent.querySelectorAll('time').forEach(show);

document.getElementById('pulse').addEventListener('submit', (event) => {
  event.preventDefault();
  fetch(event.target.action, { method: 'POST', redirect: 'manual' });
});

new EventSource(`${ui.prefix}/stream`).onmessage = (event) => {
  const { total: n, pulse } = JSON.parse(event.data);
  total.textContent = n;
  if (!pulse) return;
  const row = recent.insertRow(0);
  row.insertCell().textContent = pulse.name || ui.t('anonymous');
  const cell = row.insertCell();
  cell.className = 'num';
  const time = cell.appendChild(document.createElement('time'));
  time.dateTime = pulse.at;
  show(time);
  while (recent.rows.length > 10) recent.deleteRow(-1);
  empty.hidden = true;
};
