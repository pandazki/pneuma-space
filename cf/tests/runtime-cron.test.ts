import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSchedule } from '../src/cron.ts';

test('CF-13 schedules select the next UTC occurrence after the durable cursor', () => {
  assert.equal(new Date(nextSchedule('*/15 8-10 * * 1-5', Date.parse('2026-11-13T10:45:00Z'))).toISOString(), '2026-11-16T08:00:00.000Z');
});
test('CF-13 leap-day schedule crosses non-leap years', () => {
  assert.equal(new Date(nextSchedule('0 0 29 2 *', Date.parse('2026-01-01T00:00:00Z'))).toISOString(), '2028-02-29T00:00:00.000Z');
});
test('CF-13 invalid schedules are refused before publication', () => {
  for (const schedule of ['0 0 30 2 *', '60 * * * *', '*/0 * * * *', '1 2 3', 'x 0 * * *']) assert.throws(() => nextSchedule(schedule, Date.now()));
});
