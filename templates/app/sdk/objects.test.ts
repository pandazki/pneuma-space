import test from 'node:test';
import assert from 'node:assert/strict';
import { presign } from './objects.ts';

// AWS Signature V4 documentation, "Authenticating Requests: Using Query Parameters", example GET.
test('presigned GET matches the AWS SigV4 query-string example', () => {
  const url = presign(
    { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    'GET',
    new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    { expiresSeconds: 86400, now: new Date('2013-05-24T00:00:00Z') },
  );
  assert.equal(new URL(url).searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});
