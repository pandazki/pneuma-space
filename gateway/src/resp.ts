// RESP2 over node:net, enough for the kv Provider's ACL commands (ADR 0025 item 9).
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';

export class RespError extends Error {
  override name = 'RespError';
}

export type Reply = string | number | null | RespError | readonly Reply[];
export type RespOptions = { readonly host: string; readonly port: number; readonly password: string; readonly timeoutMs?: number };

const CRLF = Buffer.from('\r\n');

/** The reply starting at `at` and the offset after it; null while the buffer holds only part of it. */
function parse(buf: Buffer, at: number): [Reply, number] | null {
  const eol = buf.indexOf(CRLF, at);
  if (eol < 0) return null;
  const type = String.fromCharCode(buf[at]);
  const line = buf.toString('utf8', at + 1, eol);
  const length = Number(line);
  let pos = eol + 2;
  if (type === '+') return [line, pos];
  if (type === '-') return [new RespError(line), pos];
  if (type === ':') return [length, pos];
  if ((type === '$' || type === '*') && length < 0) return [null, pos];
  if (type === '$') return buf.length < pos + length + 2 ? null : [buf.toString('utf8', pos, pos + length), pos + length + 2];
  if (type !== '*') throw new Error(`Redis sent an unknown reply type ${JSON.stringify(type)}`);
  const items: Reply[] = [];
  for (let i = 0; i < length; i++) {
    const item = parse(buf, pos);
    if (!item) return null;
    items.push(item[0]);
    pos = item[1];
  }
  return [items, pos];
}

const encode = (args: readonly string[]) =>
  `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')}`;

/** One authenticated connection. Callers await each command before the next; an error reply rejects with RespError. */
export class Resp {
  readonly #socket: Socket;
  readonly #timeoutMs: number;
  #buffer = Buffer.alloc(0);
  #pending: ((reply: Reply | Error) => void) | null = null;

  private constructor(socket: Socket, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.on('data', (chunk: Buffer) => this.#read(chunk));
    socket.on('error', (error) => this.#pending?.(error));
    socket.on('close', () => this.#pending?.(new Error('Redis connection closed')));
  }

  static async open(options: RespOptions): Promise<Resp> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const socket = connect({ host: options.host, port: options.port, noDelay: true });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`Redis at ${options.host}:${options.port} did not connect within ${timeoutMs} ms`)));
    await once(socket, 'connect');
    socket.setTimeout(0);
    const resp = new Resp(socket, timeoutMs);
    await resp.command('AUTH', options.password).catch(async (error) => {
      await resp.close();
      throw error;
    });
    return resp;
  }

  command(...args: string[]): Promise<Reply> {
    if (this.#socket.destroyed) return Promise.reject(new Error('Redis connection closed'));
    if (this.#pending) return Promise.reject(new Error('a Redis command is already waiting for its reply'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#socket.destroy(new Error(`Redis ${args[0]} got no reply within ${this.#timeoutMs} ms`)), this.#timeoutMs);
      this.#pending = (reply) => { clearTimeout(timer); this.#pending = null; if (reply instanceof Error) reject(reply); else resolve(reply); };
      this.#socket.write(encode(args));
    });
  }

  async close(): Promise<void> {
    this.#socket.destroy();
  }

  #read(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    try {
      const parsed = parse(this.#buffer, 0);
      if (!parsed) return;
      this.#buffer = this.#buffer.subarray(parsed[1]);
      this.#pending?.(parsed[0]);
    } catch (error) {
      this.#socket.destroy(error as Error);
    }
  }
}
