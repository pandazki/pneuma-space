# App contract (protocol version 1)

What an app sees from PneumaSpace, and nothing else. The contract fixes protocols, not providers. `db` is a SQL connection URL, `kv` speaks the Redis protocol, `object` speaks S3, push is WebSocket and SSE. An app that follows this file runs on any PneumaSpace whichever database engine, Redis deployment, object store or runtime sits behind them. The one exception is SQL dialect: write the subset SQLite and PostgreSQL both accept. The platform model behind it is in `DESIGN.md` (Chinese). The example TypeScript SDK in `templates/` wraps this contract. Any language can do the same by reading environment variables and headers.

## Manifest

The manifest is `pneuma-space.json` at the source root. `route` is implicit and must not be written. Unknown keys are errors. The app name is given at publish, not in the manifest, and matches `^[a-z][a-z0-9-]{0,39}$`.

```json
{
  "contract": 1,
  "capabilities": {
    "files":    {},
    "db":       {},
    "kv":       {},
    "object":   {},
    "static":   {"dir": "dist"},
    "ws":       {},
    "cron":     {"triggers": {"daily-report": {"schedule": "0 8 * * *"}, "reindex": {}}},
    "identity": {},
    "rtc":      {}
  }
}
```

| Capability | What you get | Needs a runtime |
| --- | --- | --- |
| `files` | A persistent directory at `/data` | yes |
| `db` | A relational database behind one URL. The operator chooses SQLite or PostgreSQL per app. Switching provisions the other engine and does not migrate data | yes |
| `kv` | A Redis-protocol key-value store with pub/sub, namespaced per app | yes |
| `object` | An S3-compatible bucket. Object bytes never pass through your app | yes |
| `static` | The platform serves `dir` at your address without waking your app | no |
| `ws` | WebSocket upgrades and `text/event-stream` responses pass through and keep the app awake | yes |
| `cron` | Named triggers the platform calls, on a 5-field cron schedule in the platform's `timezone` policy (default UTC) or on demand, at least once | yes |
| `identity` | The visitor's identity as request headers, set by the platform, never by the browser. `{"required": false}` lets anonymous visitors through without headers. The app sends them to `/_pneuma-space/login?next=<path>` when it needs a login | yes |
| `rtc` | STUN and TURN configuration for WebRTC. Signaling is your own `ws` | yes |

A manifest with only `static` publishes without a runtime. A manifest with any other capability needs one: an image or a code bundle.

## Runtime rules

An app runs in one of two runtimes (ADR 0017). `manifest.runtime` chooses it; when absent, the publish decides: an image means `container`, a code bundle means `isolate`. A container app is any image listening on port 8000. An isolate app is a directory of JavaScript or TypeScript run by Node inside the platform's runner service. Its `entry` (default `src/server.ts`) is loaded in its own worker thread. Pure JavaScript dependencies ship in the bundle under `node_modules`. Native addons and child processes are unavailable; the filesystem is available. The app listens on the port in `PNEUMA_SPACE_PORT`. The same source works in both runtimes: `templates/app` is the isolate scaffold and `templates/container` adds a Dockerfile.

- Listen on `PNEUMA_SPACE_PORT` (8000 in a container). Be ready to accept TCP within the ready timeout (default 15 s).
- Your address takes one of two forms, and a deployment uses one: `https://<name>.<apps-domain>/` (subdomain mode, the cluster default) or `/apps/<name>/` (path mode, for a single host or a deployment without a wildcard domain). In path mode the gateway strips the prefix and sends it as `X-Forwarded-Prefix`; in subdomain mode the whole path reaches you and `X-Forwarded-Prefix` is present and empty. Use it in links, redirects, form actions and asset URLs, and the same app works in both. Only subdomain mode gives each app its own browser origin.
- The gateway removes the `Domain` attribute from every `Set-Cookie` you send, so your cookies stay on your own host. A cookie your script writes for a parent domain through `document.cookie` reaches other apps; that is your own risk.
- Keep state in `/data`, the database, the key-value store or the bucket, never in memory across requests and never in the container filesystem.
- A container image may run as root or as another user, unless the operator requires non-root (`PNEUMA_SPACE_K8S_RESTRICTED`). On Docker a fresh volume takes the ownership of the directory it mounts over, so a non-root image creates `/data` and `/pneuma/db` with its own owner. On Kubernetes it does not; the pod's `fsGroup` makes both writable to your process through its supplementary group (ADR 0019).
- Each instance has a CPU and memory limit from the `cpu_millis` and `memory_mb` policy (defaults 1000 and 512). A container over its memory limit is killed and counts as a failure; an app that needs more declares it in its policy, the one place where an M1 app may need a change. An isolate app gets `memory_mb` as its heap and its off-heap budget, capped by the runner, and shares the runner's CPU.
- When your tenant's quota of awake instances, CPU or memory is full, a request that would wake you gets 503 with `Retry-After: 30`; it does not count as a failure. A trigger delivery refused this way is retried 30 s later without using an attempt.
- The platform stops your instance when it has been idle. `SIGTERM` arrives only when no request, stream, WebSocket or trigger is in flight, except when the platform retires the instance: a new release, a removal, or a policy change that alters your environment. Then open WebSockets get close code 1001 first, and requests in flight get up to the drain timeout (default 30 s). A WebSocket with no bytes for the connection idle limit (default 6 h) is also closed with 1001; reconnecting wakes the app.
- Request and response bodies stream. There is no size limit. `Range` passes through.
- A trigger may arrive twice with the same `X-Pneuma-Space-Delivery`. Make it idempotent. A delivery that runs past the trigger timeout (default 600 s) has its connection closed by the platform and is retried later. Slots missed while the platform was down collapse into one delivery.

## Environment

Only the declared capabilities' variables exist. `PNEUMA_SPACE_APP` (the app name) and `PNEUMA_SPACE_RELEASE` (the release number) always exist.

| Capability | Variables |
| --- | --- |
| `files` | `PNEUMA_SPACE_FILES_DIR` (`/data`) |
| `db` | `PNEUMA_SPACE_DB_URL`. The scheme is `sqlite` or `postgresql`; ship a client for both and write SQL both accept, or use the example SDK which does. A SQLite URL names a file under `/pneuma/db`, a volume the platform mounts into a container |
| `kv` | `PNEUMA_SPACE_KV_URL`, `PNEUMA_SPACE_KV_PREFIX`. Every key and channel must start with the prefix; anything else fails with `NOPERM` |
| `object` | `PNEUMA_SPACE_OBJECT_ENDPOINT` (server-side S3 calls), `PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT` (browser-reachable, for presigned URLs), `PNEUMA_SPACE_OBJECT_BUCKET`, `PNEUMA_SPACE_OBJECT_ACCESS_KEY`, `PNEUMA_SPACE_OBJECT_SECRET_KEY` |
| `rtc` | `PNEUMA_SPACE_RTC_STUN_URLS`, `PNEUMA_SPACE_RTC_TURN_URLS` (comma separated), `PNEUMA_SPACE_RTC_TURN_SECRET` (HMAC secret for TURN REST credentials; one value for the whole platform, set by the operator) |

## Headers on forwarded requests

Inbound `X-Pneuma-Space-*` headers are always dropped before forwarding. So are the upstream identity header and the upstream session cookies the operator lists: your app never receives a credential that could be replayed against the console.

| Header | Value | Present |
| --- | --- | --- |
| `X-Forwarded-Prefix` | `/apps/<name>` in path mode, empty in subdomain mode | always |
| `X-Pneuma-Space-Subject` | `user:<id>` or `service:<id>`; `<id>` is 1 to 64 letters, digits or `._@+-` | `identity` declared and the caller is authenticated |
| `X-Pneuma-Space-Name` | display name; `%`, control characters and non-ASCII bytes are percent-encoded UTF-8, every other byte is literal, so `decodeURIComponent` restores it and an M1 name is unchanged | with `X-Pneuma-Space-Subject` |
| `X-Pneuma-Space-Owner` | `1` | with `X-Pneuma-Space-Subject`, only when the subject is the app's owner |

With `identity` declared (default `required: true`), an unauthenticated browser is redirected to the login page before reaching the app, and other clients get 401. With `required: false` the request reaches the app anonymously and the headers are absent. The operator picks one identity provider. Under `local`, the single-host default, the login page asks only for a name, the subject becomes `user:<name>`, and a signed cookie carries it. It identifies; it does not authenticate. Under `upstream` the organization's authenticating proxy puts a signed JWT on every request and the gateway verifies it; the platform has no login page and no session cookie of its own. `/_pneuma-space/login?next=<path>` then sends an authenticated visitor to `next` and anyone else to the organization's login; `next` must be a path on the same host. Service subjects come from platform tokens: `service:<name>` under `local` (`appctl token create`), `service:<tenant>.<name>` for a tenant's service token under `upstream`. A personal token carries its issuer's `user:<id>`, so a program using it acts as that person. Under `upstream` a program with a platform token reaches an app's own paths only where the organization's proxy lets the request through; the trigger endpoint below is the path it is expected to allow.

## Access

Who reaches your app is the app's `access` setting, not a manifest key. The publisher or a tenant admin sets it with `appctl access <name> tenant|org|public`; the default is `org`. It guards static files too. `identity` decides whether you get the headers; `access` decides whether a request arrives. Under the `local` provider it is stored and not enforced.

| `access` | Reaches the app | Unauthenticated | Authenticated, not allowed |
| --- | --- | --- | --- |
| `public` | anyone | reaches the app, unless `identity` requires a login | does not occur |
| `org` | any authenticated user or valid token | login redirect, or 401 for other clients | does not occur |
| `tenant` | members of the app's tenant, that tenant's tokens, platform admins | login redirect, or 401 for other clients | 403 |

`public` also needs the organization's proxy to let anonymous requests through to the app's host; that is the operator's proxy configuration, once per public app. Static files and bundles of a `tenant` or `org` app carry `Cache-Control: private, no-cache`, so a CDN or shared cache never stores them.

## Objects

Inside your bucket, keys under `public/` are readable by anyone at `<PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT>/<bucket>/public/<key>` with `Range`. Everything else needs a presigned URL. To accept an upload, presign a `PUT` against the public endpoint and give the URL to the browser; the bytes go straight to storage.

## Triggers

With `cron` declared, implement one endpoint on your port:

```
POST /_pneuma-space/trigger/<name>
X-Pneuma-Space-Delivery:      stable id, identical on every retry
X-Pneuma-Space-Attempt:       1..5
X-Pneuma-Space-Scheduled-For: RFC 3339 (scheduled deliveries)
X-Pneuma-Space-Subject:       caller (on-demand deliveries)
body:                         the on-demand caller's body, empty when scheduled
```

Any 2xx means done. Anything else, a timeout, or a dropped connection means the platform retries with backoff, five attempts in total. The gateway never forwards client requests under `/_pneuma-space/` to your port, so from outside the platform network they can only come from the platform. Another container on the shared network can still reach your port directly. That is inside the trust boundary, not a security claim. On Kubernetes only the gateway reaches a container instance; isolate apps on one runner share its network.

External programs invoke a trigger through the gateway. This endpoint always authenticates, whether or not the app declares `identity`, checks `access`, and then accepts a `service:` subject or the owner. `<address>` is `/apps/<name>` or `https://<name>.<apps-domain>`:

```
POST <address>/_pneuma-space/trigger/<trigger>
Authorization: Bearer <token>
Idempotency-Key: <optional; the same key within 24 h returns the same delivery>
-> 202 {"delivery": "<id>"}
```

## Admin API (operators and tooling, not apps)

Port 8081, JSON. Under the `local` identity provider it is unauthenticated and bound to loopback, and every caller is a platform admin. Under `upstream` a request authenticates with the upstream JWT (the console) or `Authorization: Bearer <platform token>` (`appctl` and programs, through the API host). A JWT-authenticated request other than `GET` and `HEAD` needs `Sec-Fetch-Site: same-origin`, or it gets 403.

Roles are per tenant: `member` or `admin`. Platform admins, listed by the operator in `PNEUMA_SPACE_PLATFORM_ADMINS` as `user:<id>` or `group:<name>`, pass every check. A token belongs to one tenant and never exceeds `member` there, platform admins included: endpoints marked `platform` accept only the upstream JWT. A personal token stops working when its issuer leaves that tenant. A member reads and changes only the apps they own; an admin of the tenant and the tenant's service tokens reach every app in it. Visiting an app still follows its `access`. A missing role answers 403 naming it; an app the caller cannot read, in another tenant or owned by another member, answers 404. Removing a member or revoking a token takes effect on every replica within 30 s.

The console renders these pages. Overview, Realtime and Topology are shown to platform admins only; a user in several tenants picks one with the tenant switcher.

| Page | Shows |
| --- | --- |
| Overview | Polled from gateway memory while the tab is visible: services, seats against the awake cap, an awake timeline, wakes, traffic, deliveries, host or cluster, a heat grid of the last 30 days by weekday and hour, an attention inbox, an event tail |
| Realtime | A request stream from every gateway replica and the event stream side by side, one filter over both; rows expand to every field; a replica that does not answer shows as a gap row |
| Topology | Three views of how a request reaches each runtime and what each app depends on: lanes by runtime with capability edges, a graph with one node per app, and nodes with the gateways, runner and apps on each; a service that is down colours the apps it affects; a quarantine is lifted in place (ADR 0018) |
| Projects | The apps the caller can read (a member's own), publish with an owner field on first publish for an admin, releases, capability bindings, per-app policy, access, tenant and a move to another tenant for a platform admin, state and leases, last access, counts, an hour grid of use, trigger deliveries, logs, remove, purge |
| Team | Under `upstream` only: members grouped by role (add by id, the role as a segmented control, remove behind ⋯), tokens (issue a service or personal token whose secret is shown once; revoke behind ⋯) and the quota (edited by a platform admin through ⋯ and an approval card); for a platform admin with no tenant chosen, tenant cards by quota pressure and a quiet control to create one. Every console page follows `docs/console.md` |

Global policy and owner changes are `appctl` commands; under `upstream` tokens are issued on the Team page, because a token cannot issue a token. `appctl` talks to `PNEUMA_SPACE_ADMIN` and sends `PNEUMA_SPACE_TOKEN` as `Authorization: Bearer`. `appctl publish <name> <dir|image> --owner <subject>` sends the owner; `--owner` defaults to `PNEUMA_SPACE_OWNER`, then to the caller. A first publish through a token lands in the token's tenant; `--tenant <t>` names the tenant otherwise. On the Kubernetes plane `publish` first pushes a local image to `PNEUMA_SPACE_REGISTRY`, and the release stores its digest: `--registry <host[/prefix]>` overrides the variable, the image is pushed as `<registry>/pneuma-space-app/<name>:<tag>` and released as `<registry>/pneuma-space-app/<name>@sha256:…`; an image that already names a registry host is sent as is, and without a registry the local image id is sent as on Compose. A publish refused by a quota prints the `quota` field. The other M2 commands are `whoami`, `access <name> <tenant|org|public>`, `state <name> [--json]`, `audit [--tenant t] [--since 7d] [--action a] [--json]` (TSV by default) and `quota <tenant>`.

The second column names the role the caller needs in the tenant of the target app or tenant: `any` is any authenticated caller, `owner` the app's owner, an admin of its tenant or a service token of its tenant, `platform` a platform admin, and `*` marks an endpoint a token cannot use. Rows that list or count apps cover only the apps the caller can read.

```
GET    /api/me                         any        {subject, name, roles: {<tenant>: admin|member}, platformAdmin}; under local {local: true, platformAdmin: true}
GET    /healthz                        -          200 with no body while the process is up, no credential needed: the target of the Kubernetes probes and the compose healthcheck
GET    /api/health                     any        {ok, ingressPort, runtimes, policy}: the host port the ingress is published on (PNEUMA_SPACE_HTTP_PORT from compose), which the console uses to link to apps; per runtime kind its service, profile and health checks (ADR 0018); the effective global policy
GET    /api/apps                       any        the apps the caller can read; a platform admin gets every app, or one tenant's with ?tenant=: name, address, tenant, access, release, capabilities, status (registered|removed|purging), instance (none|asleep|waking|awake|draining|stopping), since (epoch ms the instance entered that state, null when none), leases {request, channel, trigger}, sleepsAt (epoch ms the reaper stops an awake instance holding no lease; null otherwise), runtime (container|isolate|null), node, quarantine ({reason, since, failures} or null), dbBackend (sqlite|postgres under the app's effective policy, null without db), last access, requests and errors over the last 24 h
GET    /api/metrics                    platform   one snapshot from gateway memory, never a Docker or Kubernetes call: gateway (startedAt, rssBytes, lastFlushAt) and host (cpus, load, memory, data filesystem) of the answering replica, services (redis, object, postgres, coturn, runner: up|down|off, latencyMs), fleet (apps and instances by state, leases by kind, activeLast24h), wakes (last 1 h and 24 h: count, failures, p50Ms, p95Ms), deliveries (due, delivering, failed, recent failures), series (minute buckets for 24 h summed over replicas: requests, errors, wakes, wakeFailures, wakeMeanMs, sleeps, deliveriesDone, deliveriesFailed, deliveriesRetried), events (last 100 lifecycle events from the platform store, each with id, increasing across the platform; an event appears a few seconds after it happens (a 1 s flush, a 2 s settle window, the poll))
GET    /api/requests?after=<cursor>&limit=<n>  platform  records newer than the cursor from every replica, merged by t, default 500; each replica keeps a memory ring of 1000 lost on its restart: replica, seq, t, app, kind (request|static|ws|trigger), method, path (no query), status, ms, waitMs (until the upstream was ready, wake included), cold, subject, error. The cursor is opaque; a replica that does not answer is named in the response
GET    /api/cluster                    platform   {plane: docker|kubernetes, sampledAt, scaleMax, nodes: [{name, ready, schedulable, labels, taints, allocatable, requested, gateways, runner, instances}], workloads: [{name, role, kind, desired, ready, scalable, image, pods: [{name, role, node, phase, ready, restarts, startedAt, leading}]}], instances: [{app, tenant, runtime, state, since, actor, node, pod, leases, requests, cpuMillis, memoryMb (what this wake took; isolate reports CPU 0), restarts}], volumes: [{app, name, sizeGb, storageClass, phase, node}], warnings: [{at, kind, object, reason, message, count}]}, sampled every 15 s by each replica, never on the request path; on Docker nodes and warnings are empty and the workloads are the compose services, none scalable (ADR 0026)
PUT    /api/cluster/workloads/<name>/scale  platform  {replicas}: 1 to PNEUMA_SPACE_SCALE_MAX (400 outside), only pneuma-space-gateway and pneuma-space-runner (409 for any other); audited as cluster.scale
POST   /api/cluster/pods/<name>/restart     platform  deletes a gateway or runner Pod (409 for any other role); the controller recreates it; audited as cluster.restart
POST   /api/cluster/nodes/<name>/drain      platform  stops every instance on the node, {stopped, failed}; the node itself is untouched; audited as cluster.drain
GET    /api/apps/<name>                owner      releases, bindings, policy, state, stats, deliveries
GET    /api/apps/<name>/logs?tail=200  owner      text/plain: the app's recent stdout and stderr (current or last instance, from any replica; empty when none)
GET    /api/apps/<name>/state          owner      where each binding's data lives, without credentials: [{kind, provider, state, location}] and the release's bundle id. Backups are the storage layer's job
GET    /api/state?tenant=<t>           member     the same for every app of the tenant
GET    /api/usage?app=<name>|tenant=<t>&from=&to=  owner|member  hourly buckets: requests, errors, wakes, wakeFailures, sleeps, deliveries, awake time
GET    /api/usage/apps?from=&to=&tenant=&limit=50  member  apps ranked by requests in the window; platform without tenant
GET    /api/audit?tenant=&from=&to=&actor=&action=&target=&limit=  member  audit rows: at, actor, actor tenant, tenant, action, target kind, target, result (ok|refused|error), details without secrets; platform without tenant
PUT    /api/apps/<name>/release        member     first publish; owner after it. {"image": reference|null, "manifest": {...}, "bundle": id|null, "owner": subject, "tenant": name} -> the release {"number": n, "image": id|null, "bundle": id|null, ...}; the gateway resolves the reference to a local image id (Docker) or a registry digest reference (Kubernetes); owner and tenant apply to the first publish only, owner defaults to the caller (required under local) and only a tenant admin or a service token may name another, tenant may be omitted by a caller in one tenant; a quota refusal answers 409 with a quota field {tenant, resource, used, limit, ask}
POST   /api/bundles                    member     tar body -> {"bundle": id}; member of any tenant
PUT    /api/policy                     platform   global policy fields
PUT    /api/apps/<name>/policy         owner      per-app overrides; cpu_millis or memory_mb above the tenant's quota totals answers 400
PUT    /api/apps/<name>/access         owner      {"access": "tenant"|"org"|"public"}
PUT    /api/apps/<name>/owner          admin      {"owner": subject}; the current owner may also call it
PUT    /api/apps/<name>/tenant         platform*  {"tenant": name}
POST   /api/apps/<name>/remove         owner      address returns 404, data kept
POST   /api/apps/<name>/unquarantine   owner      lifts a quarantine (ADR 0017); the next request wakes the app
POST   /api/apps/<name>/purge          admin*     only when removed; data deleted
POST   /api/apps/<name>/stop            owner*     drains and removes the instance; the next request wakes it
POST   /api/apps/<name>/restart         owner*     stop, then a wake
POST   /api/apps/<name>/kill            platform   no drain: the Pod or container goes with grace 0, the row is forced asleep, its lease tallies and wake claim are cleared (ADR 0026)
GET    /api/tenants                    platform*  every tenant
POST   /api/tenants                    platform*  name, display name and the first admins
GET    /api/tenants/<t>/quota          member     {quota, used}
PUT    /api/tenants/<t>/quota          platform   quota fields
GET    /api/tenants/<t>/members        member     each member's id, name, role, first and last seen; a member who never signed in has neither
PUT    /api/tenants/<t>/members/<id>   admin*     {"role": "admin"|"member"}; the user need not have signed in yet
DELETE /api/tenants/<t>/members/<id>   admin*     removing the tenant's last admin answers 409
GET    /api/tenants/<t>/tokens         member*    an admin sees every token of the tenant, a member their own
POST   /api/tenants/<t>/tokens         member*    {"kind": "service", "name": ...} (admin) or {"kind": "personal"}, optional "label" -> {"token": one-time secret, "subject"}; name matches ^[a-z][a-z0-9-]{0,22}$
DELETE /api/tenants/<t>/tokens/<id>    admin*     revokes; the issuer may also call it
POST   /api/tokens                     local only {"name": ...} -> {"token": one-time secret, "subject": "service:<name>"}
```

Policy fields: `idle_seconds`, `ready_timeout_seconds`, `drain_timeout_seconds`, `connection_idle_seconds`, `trigger_timeout_seconds`, `max_failures`, `failure_window_seconds`, `restart_backoff_seconds`, `db_backend` (`sqlite` or `postgres`; the global value is the default for an app's first database; a per-app change provisions the other engine and does not migrate data), `cpu_millis`, `memory_mb` (changing either retires the instance), and global-only `timezone`, `usage_retention_days`, `events_retention_days`, `events_max_rows`.

Quota fields, each `null` for unlimited: `apps` (apps not being purged), `awake` (instances not asleep), `cpu_millis` and `memory_mb` (sums over those instances), `storage_gb` (the provisioned volume capacity of the tenant's `files` and SQLite bindings, checked when a publish adds one; databases and buckets are not counted).

`GET /metrics` serves Prometheus text on its own port, `PNEUMA_SPACE_METRICS_PORT`, when the operator sets it (ADR 0024).
