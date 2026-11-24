import { fail } from './model.ts';

function field(source: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of source.split(',')) {
    if (!/^(\*|\d+(-\d+)?)(\/\d+)?$/.test(part)) fail(400, 'schedule', 'Invalid UTC schedule.');
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    const bounds = range === '*' ? [min, max] : range.split('-').map(Number);
    const [lo, hi = lo] = bounds;
    if (step < 1 || lo < min || hi > max || lo > hi) fail(400, 'schedule', 'Invalid UTC schedule.');
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  return values;
}
export function nextSchedule(schedule: string, after: number): number {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) fail(400, 'schedule', 'Expected five UTC schedule fields.');
  const [minute, hour, day, month, weekday] = parts.map((p, i) => field(p, [0, 0, 1, 1, 0][i], [59, 23, 31, 12, 7][i]));
  if (weekday.has(7)) weekday.add(0);
  const start = new Date(after);
  start.setUTCHours(0, 0, 0, 0);
  for (let at = start.getTime(), end = at + 366 * 86400000 * 8; at < end; at += 86400000) {
    const date = new Date(at);
    const days = parts[2] !== '*' && parts[4] !== '*' ? day.has(date.getUTCDate()) || weekday.has(date.getUTCDay()) : day.has(date.getUTCDate()) && weekday.has(date.getUTCDay());
    if (!month.has(date.getUTCMonth() + 1) || !days) continue;
    for (const h of [...hour].sort((a, b) => a - b)) for (const m of [...minute].sort((a, b) => a - b)) {
      const candidate = at + h * 3600000 + m * 60000;
      if (candidate > after) return candidate;
    }
  }
  return fail(400, 'schedule', 'Schedule has no occurrence within eight years.');
}
