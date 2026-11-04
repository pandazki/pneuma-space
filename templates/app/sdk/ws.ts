import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { inbound } from './serve.ts';
import type { Inbound } from './serve.ts';

export type Socket = Inbound & {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  onmessage: (data: string | Buffer) => void;
  onclose: (code: number, reason: string) => void;
};

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = Buffer.alloc(n < 126 ? 2 : n < 65536 ? 4 : 10);
  head[0] = 0x80 | opcode;
  if (n < 126) {
    head[1] = n;
  } else if (n < 65536) {
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

function closePayload(code: number, reason: string): Buffer {
  const out = Buffer.alloc(2 + Buffer.byteLength(reason));
  out.writeUInt16BE(code, 0);
  out.write(reason, 2);
  return out;
}

function accept(stream: Duplex, info: Inbound, head: Buffer): Socket {
  let state: 'open' | 'closing' | 'closed' = 'open';
  let closed = { code: 1006, reason: '' };
  let pending = head;
  let message: { opcode: number; parts: Buffer[] } | null = null;

  const write = (opcode: number, payload: Buffer) => {
    if (state !== 'closed' && stream.writable) stream.write(frame(opcode, payload));
  };
  const socket: Socket = {
    ...info,
    send(data) {
      if (state === 'open') write(typeof data === 'string' ? OP.text : OP.binary, Buffer.from(data));
    },
    close(code = 1000, reason = '') {
      if (state !== 'open') return;
      write(OP.close, closePayload(code, reason));
      state = 'closing';
      stream.end();
      setTimeout(() => stream.destroy(), 5000).unref();
    },
    onmessage: () => {},
    onclose: () => {},
  };

  const handle = (fin: boolean, opcode: number, payload: Buffer) => {
    if (opcode === OP.ping) return write(OP.pong, payload);
    if (opcode === OP.pong) return;
    if (opcode === OP.close) {
      closed = payload.length >= 2
        ? { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') }
        : { code: 1005, reason: '' };
      if (state === 'open') write(OP.close, payload.subarray(0, 2));
      state = 'closing';
      return void stream.end();
    }
    if (opcode !== OP.continuation) message = { opcode, parts: [] };
    if (!message) return socket.close(1002, 'continuation without a message');
    message.parts.push(payload);
    if (!fin) return;
    const data = Buffer.concat(message.parts);
    const text = message.opcode === OP.text;
    message = null;
    socket.onmessage(text ? data.toString('utf8') : data);
  };

  const parse = () => {
    while (pending.length >= 2 && state !== 'closed') {
      const fin = (pending[0] & 0x80) !== 0;
      const opcode = pending[0] & 0x0f;
      const masked = (pending[1] & 0x80) !== 0;
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        length = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      if (!masked) return socket.close(1002, 'client frames must be masked');
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4);
      const payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      pending = pending.subarray(offset + 4 + length);
      handle(fin, opcode, payload);
    }
  };

  stream.on('data', (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    parse();
  });
  stream.on('error', () => stream.destroy());
  stream.on('close', () => {
    state = 'closed';
    socket.onclose(closed.code, closed.reason);
  });
  // Frames sent along with the upgrade are parsed after onConnection has set onmessage.
  queueMicrotask(parse);
  return socket;
}

export function ws(server: Server, onConnection: (socket: Socket) => void): void {
  server.on('upgrade', (req, stream: Duplex, head: Buffer) => {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
      return void stream.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
    const digest = createHash('sha1').update(key + GUID).digest('base64');
    stream.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n\r\n`);
    onConnection(accept(stream, inbound(req), head));
  });
}
