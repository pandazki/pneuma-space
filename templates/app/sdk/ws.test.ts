import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { ws } from './ws.ts';

function masked(fin: boolean, opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = Buffer.alloc(n < 126 ? 2 : n < 65536 ? 4 : 10);
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (n < 126) {
    head[1] = 0x80 | n;
  } else if (n < 65536) {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(n, 2);
  } else {
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  return Buffer.concat([head, mask, payload.map((b, i) => b ^ mask[i & 3])]);
}

function readFrames(client: net.Socket, count: number): Promise<{ opcode: number; payload: Buffer }[]> {
  let buf = Buffer.alloc(0);
  const frames: { opcode: number; payload: Buffer }[] = [];
  return new Promise((resolve) => {
    client.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        let n = buf[1] & 0x7f;
        let offset = 2;
        if (n === 126) {
          n = buf.readUInt16BE(2);
          offset = 4;
        } else if (n === 127) {
          n = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        if (buf.length < offset + n) return;
        frames.push({ opcode: buf[0] & 0x0f, payload: buf.subarray(offset, offset + n) });
        buf = buf.subarray(offset + n);
        if (frames.length === count) return resolve(frames);
      }
    });
  });
}

test('echoes a fragmented text message, a 70 kB binary message and a ping through raw RFC 6455 frames', async () => {
  const server = http.createServer();
  ws(server, (socket) => (socket.onmessage = (data) => socket.send(data)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = net.connect((server.address() as AddressInfo).port, '127.0.0.1');
  client.write(
    'GET /room HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
  );
  const [handshake] = (await once(client, 'data')) as [Buffer];
  assert.match(handshake.toString(), /^HTTP\/1\.1 101 [^]*Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n\r\n$/);

  const binary = Buffer.alloc(70_000, 7);
  const frames = readFrames(client, 3);
  client.write(Buffer.concat([
    masked(false, 0x1, Buffer.from('hel')),
    masked(true, 0x0, Buffer.from('lo')),
    masked(true, 0x9, Buffer.from('p')),
    masked(true, 0x2, binary),
  ]));
  const [text, pong, echoed] = await frames;
  assert.deepEqual([text.opcode, text.payload.toString()], [0x1, 'hello']);
  assert.deepEqual([pong.opcode, pong.payload.toString()], [0xa, 'p']);
  assert.deepEqual([echoed.opcode, echoed.payload.equals(binary)], [0x2, true]);

  const closing = readFrames(client, 1);
  client.write(masked(true, 0x8, Buffer.from([0x03, 0xe8])));
  assert.deepEqual((await closing)[0], { opcode: 0x8, payload: Buffer.from([0x03, 0xe8]) });
  client.destroy();
  server.close();
});
