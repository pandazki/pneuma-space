import { argon2Sync, createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { Readable } from 'node:stream';
import {
  CAPABILITIES, Conflict, FILES_DIR, InputError, NotFound, RESERVED_SEGMENT, RUNTIMES,
  type AppId, type BundleFile, type BundleId, type BundleIndex, type BundleStore, type ByteRange, type CapabilityProvider,
  type Injection, type ProviderName, type Resource, type ResourceKind, type Runtime, type RuntimeKind,
} from './model.ts';
import { PgError, Session, type PgOptions } from './pg.ts';
import { Resp, RespError } from './resp.ts';

export type Credential = { readonly accessKey: string; readonly secretKey: string };
export type ObjectService = { readonly endpoint: string; readonly root: Credential };
/** A service the gateway administers as its superuser. */
export type AdminService = { readonly host: string; readonly port: number; readonly password: string };

export type ProviderConfig = {
  /** Reached by the gateway and by apps on the platform network. */
  readonly object: ObjectService;
  readonly objectPublicEndpoint: string;
  readonly postgres: AdminService;
  readonly redis: AdminService;
  readonly rtcSecret: string;
  readonly rtcPublicHost: string;
  /** GiB one files or SQLite binding is provisioned with; the tenant's `storage_gb` counts it (ADR 0023 item 4). */
  readonly volumeGb: number;
};

const QUANTITY_GIB: Readonly<Record<string, number>> = { '': 2 ** -30, Ki: 2 ** -20, Mi: 2 ** -10, Gi: 1, Ti: 2 ** 10, k: 1e3 / 2 ** 30, M: 1e6 / 2 ** 30, G: 1e9 / 2 ** 30, T: 1e12 / 2 ** 30 };

/** A Kubernetes quantity like `1Gi` or `500M`, in GiB. */
export function gibibytes(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(raw);
  if (!match) throw new InputError(`volume size "${raw}" must be a quantity like 1Gi or 500Mi`);
  return Number(match[1]) * QUANTITY_GIB[match[2] ?? '']!;
}

export function providerConfig(env: Readonly<Record<string, string | undefined>>): ProviderConfig {
  return {
    object: {
      endpoint: env.PNEUMA_SPACE_OBJECT_ENDPOINT ?? 'http://rustfs:9000',
      root: { accessKey: env.PNEUMA_SPACE_OBJECT_ROOT_USER ?? 'pneuma-local', secretKey: env.PNEUMA_SPACE_OBJECT_ROOT_PASSWORD ?? 'pneuma-local-secret' },
    },
    objectPublicEndpoint: env.PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT ?? 'http://127.0.0.1:9000',
    postgres: { host: 'postgres', port: 5432, password: env.PNEUMA_SPACE_POSTGRES_PASSWORD ?? 'pneuma-local' },
    redis: { host: 'redis', port: 6379, password: env.PNEUMA_SPACE_REDIS_PASSWORD ?? 'pneuma' },
    rtcSecret: env.PNEUMA_SPACE_RTC_SECRET ?? '',
    rtcPublicHost: env.PNEUMA_SPACE_RTC_PUBLIC_HOST ?? '127.0.0.1',
    volumeGb: gibibytes((env.PNEUMA_SPACE_PLANE === 'kubernetes' ? env.PNEUMA_SPACE_K8S_VOLUME_SIZE : env.PNEUMA_SPACE_VOLUME_SIZE) ?? '1Gi'),
  };
}

type Storage = Pick<Runtime, 'destroyStorage'>;
/** True when a profiled Compose service is on the network. */
export type ServiceProbe = (service: 'postgres' | 'coturn' | NonNullable<(typeof RUNTIMES)[RuntimeKind]['service']>) => Promise<boolean>;

// Docker's resolver forwards unknown names upstream and waits about 5 s; a 500 ms single try answers within 1 s (spike S2).
const resolver = new dns.Resolver({ timeout: 500, tries: 1 });
/** A Compose service's address, or null when the network has no such name. */
export const addressOnNetwork = (service: string): Promise<string | null> => resolver.resolve4(service).then(([address]) => address ?? null, () => null);
export const resolvesOnNetwork: ServiceProbe = async (service) => (await addressOnNetwork(service)) !== null;
type ProviderProbe = (service: 'postgres' | 'coturn') => Promise<boolean>;

async function requireService(probe: ProviderProbe, service: 'postgres' | 'coturn', profile: string, kind: ResourceKind): Promise<void> {
  if (!(await probe(service))) {
    throw new Conflict(`capability "${kind}" needs the ${service} service; start the platform with --profile ${profile}`);
  }
}

/** A failed connect means the service is not running, which publish answers with 409; a server's own error passes through. */
const unreachable = (kind: ResourceKind, service: string) => (error: Error): never => {
  if (error instanceof PgError || error instanceof RespError) throw error;
  throw new Conflict(`capability "${kind}" cannot reach the ${service} service: ${error.message}`);
};

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
const exists = async (session: Session, sql: string, name: string) => (await session.query(sql, [name])).rows.length > 0;

const secret = () => randomBytes(24).toString('hex');

/** A persistent directory; the app's runtime realizes it when it creates the instance (ADR 0017). */
class StorageProvider implements CapabilityProvider {
  readonly kind: ResourceKind;
  readonly name: ProviderName;
  readonly service = null;
  readonly #storage: Storage;
  readonly #prefix: string;
  readonly #target: string;
  readonly #env: Readonly<Record<string, string>>;

  constructor(kind: ResourceKind, name: ProviderName, storage: Storage, prefix: string, target: string, env: Record<string, string>) {
    this.kind = kind;
    this.name = name;
    this.#storage = storage;
    this.#prefix = prefix;
    this.#target = target;
    this.#env = env;
  }

  async ensure(app: AppId): Promise<Resource> {
    return { id: this.#prefix + app, target: this.#target };
  }

  inject(app: AppId): Omit<Injection, 'services'> {
    return { env: {}, storage: [{ id: this.#prefix + app, target: this.#target, env: this.#env }] };
  }

  location(resource: Resource): Record<string, string> {
    return { volume: resource.id! };
  }

  async suspend(): Promise<void> {}

  async destroy(app: AppId): Promise<void> {
    await this.#storage.destroyStorage(app, this.#prefix + app);
  }
}

class PostgresProvider implements CapabilityProvider {
  readonly kind = 'db';
  readonly name = 'postgres';
  readonly service = 'postgres';
  readonly #admin: PgOptions;
  readonly #probe: ProviderProbe;

  constructor(service: AdminService, probe: ProviderProbe) {
    this.#admin = { ...service, user: 'postgres', database: 'postgres', tls: false };
    this.#probe = probe;
  }

  // One simple query per statement: CREATE and DROP DATABASE refuse to run inside a transaction block.
  async #sql(work: (session: Session) => Promise<void>): Promise<void> {
    const session = await Session.open(this.#admin).catch(unreachable(this.kind, 'postgres'));
    try {
      await work(session);
    } finally {
      await session.close();
    }
  }

  async ensure(app: AppId, current: Resource | null): Promise<Resource> {
    await requireService(this.#probe, 'postgres', 'postgres', this.kind);
    const role = `app_${app}`;
    const password = current?.password ?? secret();
    await this.#sql(async (session) => {
      if (!(await exists(session, 'SELECT FROM pg_roles WHERE rolname = $1', role))) await session.simple(`CREATE ROLE ${quoted(role)}`);
      await session.simple(`ALTER ROLE ${quoted(role)} LOGIN PASSWORD ${literal(password)}`);
      if (!(await exists(session, 'SELECT FROM pg_database WHERE datname = $1', role))) {
        await session.simple(`CREATE DATABASE ${quoted(role)} OWNER ${quoted(role)}`);
      }
      await session.simple(`REVOKE CONNECT ON DATABASE ${quoted(role)} FROM PUBLIC`);
    });
    return { role, database: role, password };
  }

  inject(_app: AppId, resource: Resource): Omit<Injection, 'services'> {
    return { env: { PNEUMA_SPACE_DB_URL: `postgresql://${resource.role}:${resource.password}@postgres:5432/${resource.database}` }, storage: [] };
  }

  location(resource: Resource): Record<string, string> {
    return { service: `${this.#admin.host}:${this.#admin.port}`, database: resource.database! };
  }

  async suspend(app: AppId): Promise<void> {
    const role = `app_${app}`;
    await this.#sql(async (session) => {
      if (await exists(session, 'SELECT FROM pg_roles WHERE rolname = $1', role)) await session.simple(`ALTER ROLE ${quoted(role)} NOLOGIN`);
    });
  }

  async destroy(app: AppId): Promise<void> {
    const role = quoted(`app_${app}`);
    await this.#sql(async (session) => {
      await session.simple(`DROP DATABASE IF EXISTS ${role} WITH (FORCE)`);
      await session.simple(`DROP ROLE IF EXISTS ${role}`);
    });
  }
}

// Unlinks in the server so destroy is one round trip, not one per SCAN page.
const UNLINK_PREFIX =
  "local c = '0' repeat local r = redis.call('SCAN', c, 'MATCH', ARGV[1], 'COUNT', 1000) c = r[1] " +
  "for _, k in ipairs(r[2]) do redis.call('UNLINK', k) end until c == '0' return 1";

class RedisProvider implements CapabilityProvider {
  readonly kind = 'kv';
  readonly name = 'redis';
  readonly service = 'redis';
  readonly #service: AdminService;

  constructor(service: AdminService) {
    this.#service = service;
  }

  /** Runs the commands, then ACL SAVE so the users survive a restart. */
  async #acl(...commands: readonly string[][]): Promise<void> {
    const resp = await Resp.open(this.#service).catch(unreachable(this.kind, 'redis'));
    try {
      for (const command of [...commands, ['ACL', 'SAVE']]) await resp.command(...command);
    } finally {
      await resp.close();
    }
  }

  async ensure(app: AppId, current: Resource | null): Promise<Resource> {
    const user = `app_${app}`;
    const password = current?.password ?? secret();
    await this.#acl(['ACL', 'SETUSER', user, 'reset', 'on', `>${password}`, `~${app}:*`, `&${app}:*`, '+@all', '-@admin', '-@dangerous']);
    return { user, password, prefix: `${app}:` };
  }

  inject(_app: AppId, resource: Resource): Omit<Injection, 'services'> {
    return {
      env: { PNEUMA_SPACE_KV_URL: `redis://${resource.user}:${resource.password}@redis:6379`, PNEUMA_SPACE_KV_PREFIX: resource.prefix },
      storage: [],
    };
  }

  location(resource: Resource): Record<string, string> {
    return { service: `${this.#service.host}:${this.#service.port}`, prefix: resource.prefix! };
  }

  async suspend(app: AppId): Promise<void> {
    await this.#acl(['ACL', 'SETUSER', `app_${app}`, 'off']);
  }

  async destroy(app: AppId): Promise<void> {
    await this.#acl(['EVAL', UNLINK_PREFIX, '0', `${app}:*`], ['ACL', 'DELUSER', `app_${app}`]);
  }
}

class S3Provider implements CapabilityProvider {
  readonly kind = 'object';
  readonly name = 's3';
  readonly service = 'object';
  readonly #store: ObjectService;
  readonly #publicEndpoint: string;

  constructor(store: ObjectService, publicEndpoint: string) {
    this.#store = store;
    this.#publicEndpoint = publicEndpoint;
  }

  // add-user overwrites the secret and sets the user enabled, so rerunning it with the stored secret also resumes.
  async ensure(app: AppId, current: Resource | null): Promise<Resource> {
    const bucket = `app-${app}`;
    const credential = { accessKey: bucket, secretKey: current?.secretKey ?? secret() };
    await createBucket(this.#store, bucket);
    await ensureAppCredential(this.#store, bucket, credential);
    await setPublicRead(this.#store, bucket);
    await setCors(this.#store, bucket);
    return { bucket, ...credential };
  }

  inject(_app: AppId, resource: Resource): Omit<Injection, 'services'> {
    return {
      env: {
        PNEUMA_SPACE_OBJECT_ENDPOINT: this.#store.endpoint,
        PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT: this.#publicEndpoint,
        PNEUMA_SPACE_OBJECT_BUCKET: resource.bucket,
        PNEUMA_SPACE_OBJECT_ACCESS_KEY: resource.accessKey,
        PNEUMA_SPACE_OBJECT_SECRET_KEY: resource.secretKey,
      },
      storage: [],
    };
  }

  location(resource: Resource): Record<string, string> {
    return { endpoint: this.#store.endpoint, bucket: resource.bucket! };
  }

  async suspend(app: AppId): Promise<void> {
    const bucket = `app-${app}`;
    const res = await signedFetch(this.#store.root, 'DELETE', objectUrl(this.#store, bucket, '', '?policy'));
    if (!res.ok && res.status !== 404) throw new Error(`delete bucket policy: ${res.status} ${await res.text()}`);
    await ok(await signedFetch(this.#store.root, 'PUT', adminUrl(this.#store, 'set-user-status', { accessKey: bucket, status: 'disabled' })), 'set-user-status');
  }

  // remove-user answers 500 for a missing user, so check user-info first.
  async destroy(app: AppId): Promise<void> {
    const bucket = `app-${app}`;
    const root = this.#store.root;
    if ((await signedFetch(root, 'HEAD', objectUrl(this.#store, bucket))).ok) {
      await deleteObjects(this.#store, bucket, '');
      await ok(await signedFetch(root, 'DELETE', objectUrl(this.#store, bucket)), 'delete bucket');
    }
    const user = await signedFetch(root, 'GET', adminUrl(this.#store, 'user-info', { accessKey: bucket }));
    if (user.ok) await ok(await signedFetch(root, 'DELETE', adminUrl(this.#store, 'remove-user', { accessKey: bucket })), 'remove-user');
    else if (user.status !== 404) throw new Error(`user-info: ${user.status} ${await user.text()}`);
    await ok(await signedFetch(root, 'DELETE', adminUrl(this.#store, 'remove-canned-policy', { name: policyName(bucket) })), 'remove-canned-policy');
  }
}

class CoturnProvider implements CapabilityProvider {
  readonly kind = 'rtc';
  readonly name = 'coturn';
  readonly service = 'coturn';
  readonly #config: ProviderConfig;
  readonly #probe: ProviderProbe;

  constructor(config: ProviderConfig, probe: ProviderProbe) {
    this.#config = config;
    this.#probe = probe;
  }

  async ensure(): Promise<Resource> {
    if (this.#config.rtcSecret === '') throw new Conflict('capability "rtc" needs PNEUMA_SPACE_RTC_SECRET set for the gateway and coturn');
    await requireService(this.#probe, 'coturn', 'rtc', this.kind);
    return {};
  }

  inject(): Omit<Injection, 'services'> {
    const host = this.#config.rtcPublicHost;
    return {
      env: {
        PNEUMA_SPACE_RTC_STUN_URLS: `stun:${host}:3478`,
        PNEUMA_SPACE_RTC_TURN_URLS: `turn:${host}:3478?transport=udp`,
        PNEUMA_SPACE_RTC_TURN_SECRET: this.#config.rtcSecret,
      },
      storage: [],
    };
  }

  location(): Record<string, string> {
    return {};
  }

  async suspend(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export type Providers = { readonly [N in ProviderName]: CapabilityProvider };

export function createProviders(storage: Storage, config: ProviderConfig, probe: ProviderProbe = resolvesOnNetwork): Providers {
  const providers: Providers = {
    volume: new StorageProvider('files', 'volume', storage, 'pneuma-space-files-', FILES_DIR, { PNEUMA_SPACE_FILES_DIR: '{dir}' }),
    sqlite: new StorageProvider('db', 'sqlite', storage, 'pneuma-space-db-', '/pneuma/db', { PNEUMA_SPACE_DB_URL: 'sqlite://{dir}/app.sqlite3' }),
    postgres: new PostgresProvider(config.postgres, probe),
    redis: new RedisProvider(config.redis),
    s3: new S3Provider(config.object, config.objectPublicEndpoint),
    coturn: new CoturnProvider(config, probe),
  };
  for (const [name, provider] of Object.entries(providers)) {
    if (provider.name !== name || !(CAPABILITIES[provider.kind].providers as readonly string[]).includes(name)) {
      throw new Error(`provider ${name} does not match CAPABILITIES.${provider.kind}`);
    }
  }
  return providers;
}

// Bundles

const BUNDLES = 'pneuma-space-bundles';
const indexKey = (id: BundleId) => `${id}/${RESERVED_SEGMENT}/index.json`;
// Under the reserved segment, which no bundle path may use.
const tarKey = (id: BundleId) => `${id}/${RESERVED_SEGMENT}/bundle.tar`;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json',
  map: 'application/json', txt: 'text/plain; charset=utf-8', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  ico: 'image/x-icon', wasm: 'application/wasm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', webmanifest: 'application/manifest+json',
};

const contentType = (path: string) => CONTENT_TYPES[/\.([^./]+)$/.exec(path)?.[1].toLowerCase() ?? ''] ?? 'application/octet-stream';

/** Runs `write` while no other work on bundle `id` runs, on any replica. */
type BundleExclusion = <T>(id: BundleId, write: () => Promise<T>) => Promise<T>;

/** Keeps no index cache: another replica's purge may delete a bundle at any time (ADR 0028). */
export class S3BundleStore implements BundleStore {
  readonly #store: ObjectService;
  readonly #exclusive: BundleExclusion;

  /** `exclusive` is the one a purge deletes the bundle under; main.ts passes the platform store's (ADR 0028). */
  constructor(store: ObjectService, exclusive: BundleExclusion = (_, write) => write()) {
    this.#store = store;
    this.#exclusive = exclusive;
  }

  // The id is the hash of the whole tar, so the tar is read into memory before any file is stored under it.
  // index.json is written last: a bundle without it is incomplete and put() redoes it.
  async put(tar: Readable): Promise<BundleId> {
    const bytes = Buffer.concat(await tar.toArray());
    const id = createHash('sha256').update(bytes).digest('hex') as BundleId;
    const root = this.#store.root;
    const exists = async (key: string) => (await signedFetch(root, 'HEAD', objectUrl(this.#store, BUNDLES, key))).ok;
    return this.#exclusive(id, async () => {
      if ((await exists(indexKey(id))) && (await exists(tarKey(id)))) return id;
      await createBucket(this.#store, BUNDLES);
      const files: Record<string, BundleFile> = {};
      for (const { path, body } of tarFiles(bytes)) {
        const type = contentType(path);
        await ok(await signedFetch(root, 'PUT', objectUrl(this.#store, BUNDLES, `${id}/${path}`), body, { 'content-type': type }), `put ${path}`);
        files[path] = { size: body.length, etag: createHash('md5').update(body).digest('hex'), contentType: type };
      }
      await ok(await signedFetch(root, 'PUT', objectUrl(this.#store, BUNDLES, tarKey(id)), bytes, { 'content-type': 'application/x-tar' }), 'put bundle tar');
      const index: BundleIndex = { id, files };
      await ok(await signedFetch(root, 'PUT', objectUrl(this.#store, BUNDLES, indexKey(id)), JSON.stringify(index), { 'content-type': 'application/json' }), 'put bundle index');
      return id;
    });
  }

  /** Whether the store answers a signed request within `withinMs`: rustfs reports healthy before its IAM is ready, and a read then gets 503. */
  async answers(withinMs = 2000): Promise<boolean> {
    const res = await signedFetch(this.#store.root, 'HEAD', objectUrl(this.#store, BUNDLES), '', {}, AbortSignal.timeout(withinMs)).catch(() => null);
    return res !== null && res.status < 500;
  }

  async index(id: BundleId): Promise<BundleIndex> {
    const res = await signedFetch(this.#store.root, 'GET', objectUrl(this.#store, BUNDLES, indexKey(id)));
    if (res.status === 404) throw new NotFound(`bundle ${id} does not exist`);
    return (await ok(res, 'get bundle index').then((r) => r.json())) as BundleIndex;
  }

  /** `range.end` is inclusive, as in an HTTP Range header. */
  async open(id: BundleId, path: string, range: ByteRange | null): Promise<Readable> {
    const headers: Record<string, string> = range ? { range: `bytes=${range.start}-${range.end}` } : {};
    const res = await signedFetch(this.#store.root, 'GET', objectUrl(this.#store, BUNDLES, `${id}/${path}`), '', headers);
    if (res.status === 404) throw new NotFound(`bundle ${id} has no file ${path}`);
    await ok(res, `get ${path}`);
    return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  }

  /** A GET URL for the whole tar that needs no credential, so the runner fetches the bytes itself (ADR 0017). */
  presignTar(id: BundleId, seconds = 600): string {
    return presignGet(this.#store.root, objectUrl(this.#store, BUNDLES, tarKey(id)), seconds);
  }

  /** The index goes first: put() writes it last, so a bundle without one is gone to a publish, and a new put() restores it whole. */
  async delete(id: BundleId): Promise<void> {
    const res = await signedFetch(this.#store.root, 'DELETE', objectUrl(this.#store, BUNDLES, indexKey(id)));
    if (!res.ok && res.status !== 404) throw new Error(`object service delete bundle index: ${res.status} ${await res.text()}`);
    await deleteObjects(this.#store, BUNDLES, `${id}/`);
  }
}

type TarFile = { readonly path: string; readonly body: Buffer };

const tarString = (b: Buffer) => b.toString('utf8', 0, b.indexOf(0) === -1 ? b.length : b.indexOf(0));
const tarOctal = (b: Buffer) => parseInt(tarString(b).trim() || '0', 8);

function paxRecords(body: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  for (let at = 0; at < body.length; ) {
    const space = body.indexOf(0x20, at);
    const length = Number(body.toString('utf8', at, space));
    if (space === -1 || !(length > 0)) break;
    const record = body.toString('utf8', space + 1, at + length - 1);
    const eq = record.indexOf('=');
    records[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return records;
}

function bundlePath(raw: string): string {
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (raw.startsWith('/') || parts.includes('..') || parts[0] === RESERVED_SEGMENT) {
    throw new InputError(`bundle path "${raw}" must be relative, without "..", and not under ${RESERVED_SEGMENT}/`);
  }
  return parts.join('/');
}

/** Regular files of a ustar, pax or GNU tar; directories are implied by paths, links are refused. */
export function* tarFiles(tar: Buffer): Generator<TarFile> {
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) return;
    const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 0x20 : byte), 0);
    if (sum !== tarOctal(header.subarray(148, 156))) throw new InputError(`bundle is not a tar archive (bad header at byte ${at})`);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = Number(pax.size ?? tarOctal(header.subarray(124, 136)));
    const body = tar.subarray(at + 512, at + 512 + size);
    if (body.length !== size) throw new InputError('bundle tar is truncated');
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = paxRecords(body); continue; }
    if (type === 'L') { longName = tarString(body); continue; }
    if (type === 'g') continue;
    const prefix = tarString(header.subarray(345, 500));
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${tarString(header.subarray(0, 100))}` : tarString(header.subarray(0, 100)));
    pax = {};
    longName = null;
    if (type === '5') continue;
    if (type !== '0' && type !== '7') throw new InputError(`bundle entry "${name}" is tar type ${type}; a bundle holds only files and directories`);
    yield { path: bundlePath(name), body };
  }
}

// S3 and the MinIO-compatible admin API over SigV4, node:crypto only (spike S1).

const REGION = 'us-east-1';

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function amzDate(now: Date): { stamp: string; day: string } {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { stamp, day: stamp.slice(0, 8) };
}

function signature(cred: Credential, day: string, stringToSign: string): string {
  const key = ['s3', 'aws4_request'].reduce((k, part) => hmac(k, part), hmac(hmac('AWS4' + cred.secretKey, day), REGION));
  return createHmac('sha256', key).update(stringToSign).digest('hex');
}

function canonicalRequest(method: string, url: URL, headers: Record<string, string>, payloadHash: string) {
  const names = Object.keys(headers).sort();
  return {
    signedHeaders: names.join(';'),
    text: [
      method,
      url.pathname.split('/').map((seg) => rfc3986(decodeURIComponent(seg))).join('/'),
      canonicalQuery(url.searchParams),
      names.map((n) => `${n}:${headers[n].trim()}\n`).join(''),
      names.join(';'),
      payloadHash,
    ].join('\n'),
  };
}

export async function signedFetch(
  cred: Credential, method: string, url: URL, body: Uint8Array | string = '', extra: Record<string, string> = {}, signal?: AbortSignal,
): Promise<Response> {
  const { stamp, day } = amzDate(new Date());
  const payloadHash = sha256(body);
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': stamp,
    'x-amz-content-sha256': payloadHash,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const req = canonicalRequest(method, url, headers, payloadHash);
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const sig = signature(cred, day, ['AWS4-HMAC-SHA256', stamp, scope, sha256(req.text)].join('\n'));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cred.accessKey}/${scope}, SignedHeaders=${req.signedHeaders}, Signature=${sig}`;
  delete headers.host;
  return fetch(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body, signal });
}

export function presignGet(cred: Credential, url: URL, seconds: number): string {
  const { stamp, day } = amzDate(new Date());
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const signed = new URL(url);
  for (const [k, v] of Object.entries({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${cred.accessKey}/${scope}`, 'X-Amz-Date': stamp,
    'X-Amz-Expires': String(seconds), 'X-Amz-SignedHeaders': 'host',
  })) signed.searchParams.set(k, v);
  const req = canonicalRequest('GET', signed, { host: signed.host }, 'UNSIGNED-PAYLOAD');
  signed.searchParams.set('X-Amz-Signature', signature(cred, day, ['AWS4-HMAC-SHA256', stamp, scope, sha256(req.text)].join('\n')));
  return signed.href;
}

async function ok(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`object service ${what}: ${res.status} ${await res.text()}`);
  return res;
}

export const objectUrl = (store: ObjectService, bucket: string, key = '', query = '') =>
  new URL(`${store.endpoint}/${bucket}${key ? '/' + key.split('/').map(rfc3986).join('/') : ''}${query}`);

const adminUrl = (store: ObjectService, op: string, params: Record<string, string>) =>
  new URL(`${store.endpoint}/minio/admin/v3/${op}?${new URLSearchParams(params)}`);

// MinIO madmin EncryptData, which add-user requires: salt(32) | 0x00 (argon2id + AES-256-GCM) | nonce(8) | sio-go stream.
// The body fits one sio fragment (< 16 KiB): seq 1, final flag 0x80, AD tag sealed under seq 0.
function sealAdminPayload(secretKey: string, plaintext: string): Buffer {
  if (Buffer.byteLength(plaintext) >= 16384) throw new Error('admin payload exceeds one sio fragment');
  const salt = randomBytes(32);
  const nonce = randomBytes(8);
  const key = argon2Sync('argon2id', { message: secretKey, nonce: salt, parallelism: 4, tagLength: 32, memory: 65536, passes: 1 });
  const seal = (seq: number, data: Buffer, aad: Buffer) => {
    const iv = Buffer.alloc(12);
    nonce.copy(iv);
    iv.writeUInt32LE(seq, 8);
    const c = createCipheriv('aes-256-gcm', key, iv).setAAD(aad);
    const out = Buffer.concat([c.update(data), c.final()]);
    return Buffer.concat([out, c.getAuthTag()]);
  };
  const adTag = seal(0, Buffer.alloc(0), Buffer.alloc(0));
  const fragment = seal(1, Buffer.from(plaintext), Buffer.concat([Buffer.from([0x80]), adTag]));
  return Buffer.concat([salt, Buffer.from([0x00]), nonce, fragment]);
}

const policyName = (bucket: string) => `pneuma-space-${bucket}`;

async function createBucket(store: ObjectService, bucket: string): Promise<void> {
  const res = await signedFetch(store.root, 'PUT', objectUrl(store, bucket));
  if (res.ok) return;
  const text = await res.text();
  if (res.status === 409 && text.includes('BucketAlreadyOwnedByYou')) return;
  throw new Error(`object service create bucket ${bucket}: ${res.status} ${text}`);
}

async function ensureAppCredential(store: ObjectService, bucket: string, cred: Credential): Promise<void> {
  const policy = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: ['s3:*'], Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`] }],
  };
  await ok(await signedFetch(store.root, 'PUT', adminUrl(store, 'add-canned-policy', { name: policyName(bucket) }), JSON.stringify(policy)), 'add-canned-policy');
  await ok(
    await signedFetch(store.root, 'PUT', adminUrl(store, 'add-user', { accessKey: cred.accessKey }),
      sealAdminPayload(store.root.secretKey, JSON.stringify({ secretKey: cred.secretKey, status: 'enabled' }))),
    'add-user',
  );
  await ok(
    await signedFetch(store.root, 'PUT',
      adminUrl(store, 'set-user-or-group-policy', { policyName: policyName(bucket), userOrGroup: cred.accessKey, isGroup: 'false' })),
    'set-user-or-group-policy',
  );
}

async function setPublicRead(store: ObjectService, bucket: string): Promise<void> {
  const policy = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/public/*`] }],
  };
  await ok(await signedFetch(store.root, 'PUT', objectUrl(store, bucket, '', '?policy'), JSON.stringify(policy)), 'put bucket policy');
}

// Any origin: every browser that can reach the loopback object port is on the trusted host.
async function setCors(store: ObjectService, bucket: string): Promise<void> {
  const xml =
    '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin>' +
    ['GET', 'PUT', 'HEAD'].map((m) => `<AllowedMethod>${m}</AllowedMethod>`).join('') +
    '<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>' +
    '</CORSRule></CORSConfiguration>';
  const md5 = createHash('md5').update(xml).digest('base64');
  await ok(await signedFetch(store.root, 'PUT', objectUrl(store, bucket, '', '?cors'), xml, { 'content-md5': md5 }), 'put bucket cors');
}

const xmlText = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const listQuery = (params: Record<string, string>) => `?${new URLSearchParams({ 'list-type': '2', ...params })}`;

async function deleteObjects(store: ObjectService, bucket: string, prefix: string): Promise<void> {
  for (;;) {
    const list = await ok(await signedFetch(store.root, 'GET', objectUrl(store, bucket, '', listQuery({ prefix, 'max-keys': '1000' }))), 'list objects');
    const keys = [...(await list.text()).matchAll(/<Key>(.*?)<\/Key>/gs)].map((m) => xmlText(m[1]));
    if (keys.length === 0) return;
    const xml = `<Delete><Quiet>true</Quiet>${keys.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('')}</Delete>`;
    const md5 = createHash('md5').update(xml).digest('base64');
    await ok(await signedFetch(store.root, 'POST', objectUrl(store, bucket, '', '?delete'), xml, { 'content-md5': md5 }), 'delete objects');
  }
}

