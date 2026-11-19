import { csv } from './csv.js';
const status = document.querySelector('#export-status');
async function api(path, body) {
  const response = await fetch(`/_pneuma-space/export/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}
async function rows() { return (await api('rows')).answers; }
async function downloadLocal() {
  const blob = new Blob([csv(await rows())], { type: 'text/csv; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: 'survey.csv' });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function save() {
  const blob = new Blob([csv(await rows())], { type: 'text/csv; charset=utf-8' });
  const upload = await api('begin', { bytes: blob.size });
  const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: blob });
  if (!put.ok) throw new Error(`Direct R2 upload failed (${put.status})`);
  await api('complete', { id: upload.id });
  location.reload();
}
async function download() {
  const ticket = await api('download');
  location.assign(ticket.url);
}
for (const [id, action] of [['save-export', save], ['download-export', download], ['local-csv', downloadLocal]]) {
  document.getElementById(id).addEventListener('click', async () => {
    status.textContent = 'Working…';
    try { await action(); status.textContent = 'Done'; }
    catch (error) { status.textContent = error.message; }
  });
}
const availability = await api('availability');
if (!availability.enabled) {
  document.getElementById('save-export').disabled = true;
  document.getElementById('download-export').disabled = true;
  status.textContent = availability.reason;
}
