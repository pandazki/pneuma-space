import { ManifestError, NAME_PATTERN, type CronExpr, type TriggerName } from './values.ts';

export type Contract = 1 | 2;
export type KindClass = 'resource' | 'ingress' | 'schedule';

export type EmptyDeclaration = Record<string, never>;
export type StaticDeclaration = { readonly dir: string };
export type CronDeclaration = { readonly triggers: Readonly<Record<TriggerName, { readonly schedule?: CronExpr }>> };
/** `required` absent means true. */
export type IdentityDeclaration = { readonly required?: boolean };

type CapabilitySpec = {
  readonly contracts: readonly Contract[];
  readonly class: KindClass;
  readonly needsRuntime: boolean;
  /** Provider implementations; non-empty exactly for resource kinds. */
  readonly providers: readonly string[];
  readonly parse: (raw: unknown, where: string) => unknown;
};

/** The only capability list. Env names, providers to call and gateway flags derive from it. */
export const CAPABILITIES = {
  route:    { contracts: [1, 2], class: 'ingress',  needsRuntime: false, providers: [],                     parse: implicit },
  files:    { contracts: [1],    class: 'resource', needsRuntime: true,  providers: ['volume'],             parse: empty },
  db:       { contracts: [1],    class: 'resource', needsRuntime: true,  providers: ['sqlite', 'postgres'], parse: empty },
  kv:       { contracts: [1],    class: 'resource', needsRuntime: true,  providers: ['redis'],              parse: empty },
  object:   { contracts: [1],    class: 'resource', needsRuntime: true,  providers: ['s3'],                 parse: empty },
  static:   { contracts: [1, 2], class: 'ingress',  needsRuntime: false, providers: [],                     parse: parseStatic },
  ws:       { contracts: [1],    class: 'ingress',  needsRuntime: true,  providers: [],                     parse: empty },
  cron:     { contracts: [1],    class: 'schedule', needsRuntime: true,  providers: [],                     parse: parseCron },
  identity: { contracts: [1, 2], class: 'ingress',  needsRuntime: true,  providers: [],                     parse: parseIdentity },
  rtc:      { contracts: [1],    class: 'resource', needsRuntime: true,  providers: ['coturn'],             parse: empty },
  records:  { contracts: [2],    class: 'resource', needsRuntime: true,  providers: ['records'],            parse: empty },
} as const satisfies Record<string, CapabilitySpec>;

export type CapabilityKind = keyof typeof CAPABILITIES;

export type Declaration<K extends CapabilityKind> = ReturnType<(typeof CAPABILITIES)[K]['parse']>;
export type ResourceKind = {
  [K in CapabilityKind]: (typeof CAPABILITIES)[K]['class'] extends 'resource' ? K : never;
}[CapabilityKind];
export type ProviderName = (typeof CAPABILITIES)[CapabilityKind]['providers'][number];
export type DbBackend = (typeof CAPABILITIES)['db']['providers'][number];

for (const [kind, spec] of Object.entries(CAPABILITIES)) {
  if ((spec.class === 'resource') !== spec.providers.length > 0) {
    throw new Error(`CAPABILITIES.${kind}: a kind has providers exactly when its class is resource`);
  }
}

/** The only runtime list: a kind is one row here and one Runtime implementation. `service` names the compose service and profile it needs; `input` is what a publish must carry. */
export const RUNTIMES = {
  container: { contracts: [1], family: 'process', service: null,     profile: null,      input: 'image' },
  isolate:   { contracts: [1], family: 'process', service: 'runner', profile: 'isolate', input: 'bundle' },
  fetch:     { contracts: [2], family: 'fetch',   service: null,     profile: null,      input: 'artifact' },
} as const satisfies Record<string, { readonly contracts: readonly Contract[]; readonly family: 'process' | 'fetch'; readonly service: string | null; readonly profile: string | null; readonly input: 'image' | 'bundle' | 'artifact' }>;

export type RuntimeKind = keyof typeof RUNTIMES;

type ForContract<T extends Record<string, { readonly contracts: readonly Contract[] }>, C extends Contract> = C extends Contract ? {
  [K in keyof T as C extends T[K]['contracts'][number] ? K : never]: T[K];
} : never;

function forContract<T extends Record<string, { readonly contracts: readonly Contract[] }>, C extends Contract>(table: T, contract: C): ForContract<T, C> {
  return Object.fromEntries(Object.entries(table).filter(([, spec]) => spec.contracts.includes(contract))) as ForContract<T, C>;
}

export function capabilitiesFor<C extends Contract>(contract: C): ForContract<typeof CAPABILITIES, C> {
  return forContract(CAPABILITIES, contract);
}

export function runtimesFor<C extends Contract>(contract: C): ForContract<typeof RUNTIMES, C> {
  return forContract(RUNTIMES, contract);
}

type RawObject = Record<string, unknown>;

export function asObject(raw: unknown, where: string): RawObject {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ManifestError(`${where} must be a JSON object`);
  return raw as RawObject;
}

export function onlyKeys(raw: RawObject, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(raw).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new ManifestError(`${where}: unknown field "${unknown}"; allowed: ${allowed.length ? allowed.join(', ') : 'none'}`);
  }
}

function implicit(_raw: unknown, where: string): never {
  throw new ManifestError(`${where}: route is implicit for every app; remove it from the manifest`);
}

function empty(raw: unknown, where: string): EmptyDeclaration {
  onlyKeys(asObject(raw, where), [], where);
  return {};
}

function parseIdentity(raw: unknown, where: string): IdentityDeclaration {
  const declaration = asObject(raw, where);
  onlyKeys(declaration, ['required'], where);
  if (declaration.required !== undefined && typeof declaration.required !== 'boolean') {
    throw new ManifestError(`${where}.required must be true or false`);
  }
  return declaration.required === undefined ? {} : { required: declaration.required };
}

function parseStatic(raw: unknown, where: string): StaticDeclaration {
  const declaration = asObject(raw, where);
  onlyKeys(declaration, ['dir'], where);
  const dir = declaration.dir;
  if (typeof dir !== 'string' || dir === '' || dir.startsWith('/') || dir.split('/').includes('..')) {
    throw new ManifestError(`${where}.dir must be a relative directory inside the source root, like "dist"`);
  }
  return { dir };
}

const CRON_BOUNDS: readonly (readonly [number, number])[] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function cronFieldValid(field: string, [low, high]: readonly [number, number]): boolean {
  return field.split(',').every((item) => {
    const match = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!match) return false;
    const [, from, to, step] = match;
    const start = from === undefined ? low : Number(from);
    const end = to === undefined ? (from === undefined ? high : start) : Number(to);
    return low <= start && start <= end && end <= high && (step === undefined || Number(step) >= 1);
  });
}

function parseCron(raw: unknown, where: string): CronDeclaration {
  const declaration = asObject(raw, where);
  onlyKeys(declaration, ['triggers'], where);
  const triggers: Record<string, { schedule?: CronExpr }> = {};
  for (const [name, value] of Object.entries(asObject(declaration.triggers, `${where}.triggers`))) {
    const at = `${where}.triggers.${name}`;
    if (!NAME_PATTERN.test(name)) throw new ManifestError(`${at}: trigger name must match ${NAME_PATTERN.source}`);
    const trigger = asObject(value, at);
    onlyKeys(trigger, ['schedule'], at);
    if (trigger.schedule === undefined) {
      triggers[name] = {};
      continue;
    }
    const fields = typeof trigger.schedule === 'string' ? trigger.schedule.trim().split(/\s+/) : [];
    if (fields.length !== 5 || !fields.every((field, i) => cronFieldValid(field, CRON_BOUNDS[i]))) {
      throw new ManifestError(
        `${at}.schedule must be a 5-field cron expression (minute hour day-of-month month day-of-week) using numbers, *, -, / and ,`,
      );
    }
    triggers[name] = { schedule: fields.join(' ') as CronExpr };
  }
  return { triggers: triggers as CronDeclaration['triggers'] };
}
