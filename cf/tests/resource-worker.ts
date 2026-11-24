import { DurableObject } from 'cloudflare:workers';
import { NativeResources } from '../src/resources.ts';
import { DEFAULT_POLICY, HttpError, type ExecutionScope, type Manifest, type Policy } from '../src/model.ts';
export class ResourceProbe extends DurableObject<Env> {
  private resources: NativeResources;
  private policy: Policy = DEFAULT_POLICY;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.resources = new NativeResources(ctx.storage, env, ctx.id.toString(), {
      guard: scope => {
        if (scope && scope.generation !== (ctx.storage.kv.get<number>('platform:generation') ?? 1)) throw new HttpError(409, 'stale', 'Stale execution.');
      },
      policy: () => this.policy,
      broadcast: (channel, value) => { ctx.storage.kv.put('platform:last-broadcast', { channel, value }); return 2; },
    });
  }
  async alarm(): Promise<void> {}
  async fetch(request: Request): Promise<Response> {
    try {
      const body: { action?: string; manifest?: Manifest; command?: unknown; scope?: ExecutionScope; policy?: Policy } = await request.json();
      if (body.policy) this.policy = body.policy;
      switch (body.action) {
        case 'ensure': if (!body.manifest) throw Error('Missing manifest'); this.resources.ensure(body.manifest); return Response.json({ ok: true });
        case 'retire': this.ctx.storage.kv.put('platform:generation', 2); return Response.json({ ok: true });
        case 'suspend': this.resources.suspend(); return Response.json({ ok: true });
        case 'inventory': return Response.json(this.resources.inventory());
        case 'read-alarm': return Response.json({ alarm: await this.ctx.storage.getAlarm() });
        case 'alarm': await this.ctx.storage.setAlarm(Date.now() + 3600000); return Response.json({ alarm: await this.ctx.storage.getAlarm(), schema: this.ctx.storage.sql.exec('SELECT name,type FROM sqlite_schema').toArray() });
        case 'destroy': return Response.json(await this.resources.destroy());
        case 'platform': return Response.json(Array.from(this.ctx.storage.kv.list({ prefix: 'platform:' })));
        case 'expire-kv': {
          const entry = this.ctx.storage.kv.get<{ value: unknown; revision: number }>('kv:ttl');
          this.ctx.storage.kv.put('kv:ttl', { ...entry, expiresAt: Date.now() - 1000 }); return Response.json({ ok: true });
        }
        case 'expire': {
          for (const [key, entry] of this.ctx.storage.kv.list<{ expiresAt: number }>({ prefix: 'object:upload:' })) this.ctx.storage.kv.put(key, { ...entry, expiresAt: Date.now() - 2000 });
          this.ctx.storage.kv.put('resource:purging', Date.now() - 1000);
          return Response.json({ ok: true });
        }
        default: return Response.json(await this.resources.perform(body.command, body.scope ?? null));
      }
    } catch (error) {
      return Response.json({ error: error instanceof HttpError ? error.code : String(error) }, { status: error instanceof HttpError ? error.status : 500 });
    }
  }
}
export default {
  fetch(request: Request, env: { TEST: DurableObjectNamespace<ResourceProbe> }): Promise<Response> { return env.TEST.getByName(new URL(request.url).hostname).fetch(request); },
};
