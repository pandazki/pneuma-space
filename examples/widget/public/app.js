const updated = document.getElementById('updated');
const kpis = document.querySelectorAll('[data-kpi]');

function ago(iso) {
  if (!iso) return ui.t('never');
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  const when = minutes < 1 ? ui.t('justNow')
    : minutes < 60 ? ui.t('minutes', { n: minutes })
    : minutes < 1440 ? ui.t('hours', { n: Math.floor(minutes / 60) })
    : ui.t('days', { n: Math.floor(minutes / 1440) });
  return ui.t('updated', { ago: when });
}

async function load() {
  const response = await fetch(`${ui.prefix}/card.json`, { cache: 'no-store' });
  if (!response.ok) return;
  const card = await response.json();
  kpis.forEach((el) => { el.textContent = card[el.dataset.kpi]; });
  updated.dateTime = card.computed_at ?? '';
}

setInterval(async () => {
  await load().catch(() => {});
  updated.textContent = ago(updated.dateTime);
}, 30000);

const clock = new Intl.DateTimeFormat(ui.lang, { hour: '2-digit', minute: '2-digit' });
document.querySelectorAll('.notes time').forEach((el) => { el.textContent = clock.format(new Date(el.dateTime)); });
