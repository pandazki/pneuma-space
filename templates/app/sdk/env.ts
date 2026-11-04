const VARS = {
  files: { dir: 'PNEUMA_SPACE_FILES_DIR' },
  db: { url: 'PNEUMA_SPACE_DB_URL' },
  kv: { url: 'PNEUMA_SPACE_KV_URL', prefix: 'PNEUMA_SPACE_KV_PREFIX' },
  object: {
    endpoint: 'PNEUMA_SPACE_OBJECT_ENDPOINT',
    publicEndpoint: 'PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT',
    bucket: 'PNEUMA_SPACE_OBJECT_BUCKET',
    accessKey: 'PNEUMA_SPACE_OBJECT_ACCESS_KEY',
    secretKey: 'PNEUMA_SPACE_OBJECT_SECRET_KEY',
  },
  rtc: { stunUrls: 'PNEUMA_SPACE_RTC_STUN_URLS', turnUrls: 'PNEUMA_SPACE_RTC_TURN_URLS', turnSecret: 'PNEUMA_SPACE_RTC_TURN_SECRET' },
} as const;

export type Capability = keyof typeof VARS;
export type Section<K extends Capability> = { readonly [F in keyof (typeof VARS)[K]]: string };
export type Env = { readonly app: string; readonly release: string } & { readonly [K in Capability]?: Section<K> };

function section<K extends Capability>(kind: K): Section<K> | undefined {
  const entries = Object.entries(VARS[kind]).map(([field, name]) => [field, name, process.env[name]] as const);
  if (entries.every(([, , value]) => value === undefined)) return undefined;
  const missing = entries.filter(([, , value]) => value === undefined).map(([, name]) => name);
  if (missing.length) throw new Error(`"${kind}" is only partly configured: ${missing.join(', ')} not set`);
  return Object.fromEntries(entries.map(([field, , value]) => [field, value])) as Section<K>;
}

export function env(): Env {
  const view: Record<string, unknown> = { app: process.env.PNEUMA_SPACE_APP ?? '', release: process.env.PNEUMA_SPACE_RELEASE ?? '' };
  for (const kind of Object.keys(VARS) as Capability[]) view[kind] = section(kind);
  return view as Env;
}

export function need<K extends Capability>(kind: K): Section<K> {
  const found = section(kind);
  if (!found) {
    throw new Error(`"${kind}" is not declared: add "${kind}": {} to capabilities in pneuma-space.json (${Object.values(VARS[kind]).join(', ')} not set)`);
  }
  return found;
}
