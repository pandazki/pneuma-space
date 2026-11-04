import test from 'node:test';
import assert from 'node:assert/strict';
import { iceServers } from './rtc.ts';

// Expected credential is the output of spike/coturn/mint.ts (verified against coturn) for the same secret, time, ttl and user.
test('TURN credential matches the coturn REST scheme for the same inputs', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  Object.assign(process.env, {
    PNEUMA_RTC_STUN_URLS: 'stun:127.0.0.1:3478',
    PNEUMA_RTC_TURN_URLS: 'turn:127.0.0.1:3478?transport=udp, turn:127.0.0.1:3478?transport=tcp',
    PNEUMA_RTC_TURN_SECRET: 's3cret',
  });
  assert.deepEqual(iceServers('alice', 600), [
    { urls: ['stun:127.0.0.1:3478'] },
    {
      urls: ['turn:127.0.0.1:3478?transport=udp', 'turn:127.0.0.1:3478?transport=tcp'],
      username: '1767226200:alice',
      credential: 'UHk+NIub+4c2ATJ09T6xGo8Dys8=',
    },
  ]);
});
