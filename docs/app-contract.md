# App contract (protocol version 1)

What an app sees from Pneuma Space, and nothing else. The contract fixes protocols, not providers: `db` is a SQL connection URL, `kv` speaks the Redis protocol, `object` speaks S3, push is WebSocket and SSE. An app that follows this file runs on any Pneuma Space regardless of which database engine, Redis deployment, object store or container runtime sits behind them. The one residual is SQL dialect: write the subset SQLite and PostgreSQL both accept. The platform model behind it is in `DESIGN.md` (Chinese). The example TypeScript SDK in `templates/` wraps this contract; any language can do the same by reading environment variables and headers.

## Manifest

`pneuma.json` at the source root. `route` is implicit and must not be written. Unknown keys are errors. The app name is given at publish, not in the manifest, and matches `^[a-z][a-z0-9-]{0,39}$`.

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

| Capability | What you get | Needs a container |
| --- | --- | --- |
| `files` | A persistent directory at `/data` | yes |
| `db` | A relational database behind one URL. The operator chooses SQLite or PostgreSQL per app; switching provisions the other engine and does not migrate data | yes |
| `kv` | A Redis-protocol key-value store with pub/sub, namespaced per app | yes |
| `object` | An S3-compatible bucket. Bytes never pass through your container | yes |
| `static` | The platform serves `dir` at your address without starting a container | no |
| `ws` | WebSocket upgrades and `text/event-stream` responses pass through and keep the app awake | yes |
| `cron` | Named triggers the platform calls, on a 5-field cron schedule in the platform's `timezone` policy (default UTC) or on demand, at least once | yes |
| `identity` | The visitor's identity as request headers, set by the platform, never by the browser | yes |
| `rtc` | STUN and TURN configuration for WebRTC; signaling is your own `ws` | yes |

A manifest with only `static` publishes without an image. A manifest with any other capability needs an image.

## Runtime rules

- Listen on `0.0.0.0:8000`. Be ready to accept TCP within the ready timeout (default 15 s).
- Your address is `/apps/<name>/`. The gateway strips that prefix and sends it as `X-Forwarded-Prefix`. Use it in links, redirects, form actions and asset URLs.
- Keep state in `/data`, the database, the key-value store or the bucket. Never in memory across requests and never in the container filesystem.
- The platform stops your container when it has been idle. `SIGTERM` arrives only when no request, stream, WebSocket or trigger is in flight, except when the platform retires the instance: a new release, a removal, or a policy change that alters your environment. Then open WebSockets get close code 1001 first and requests get up to the drain timeout (default 30 s). A WebSocket with no bytes for the connection idle limit (default 6 h) is also closed with 1001; reconnecting wakes the app.
- Request and response bodies stream. There is no size limit. `Range` passes through.
- A trigger may arrive twice with the same `X-Pneuma-Delivery`. Make it idempotent. A delivery that runs past the trigger timeout (default 600 s) has its connection closed by the platform and is retried later; slots missed while the platform was down collapse into one delivery.

## Environment

Only the declared capabilities' variables exist. `PNEUMA_APP` and `PNEUMA_RELEASE` always exist.

| Capability | Variables |
| --- | --- |
| `files` | `PNEUMA_FILES_DIR` (`/data`) |
| `db` | `PNEUMA_DB_URL`. The scheme is `sqlite` or `postgresql`; ship a client for both and write SQL both accept, or use the example SDK which does |
| `kv` | `PNEUMA_KV_URL`, `PNEUMA_KV_PREFIX`. Every key and channel must start with the prefix; anything else fails with `NOPERM` |
| `object` | `PNEUMA_OBJECT_ENDPOINT` (server-side S3 calls), `PNEUMA_OBJECT_PUBLIC_ENDPOINT` (browser-reachable, for presigned URLs), `PNEUMA_OBJECT_BUCKET`, `PNEUMA_OBJECT_ACCESS_KEY`, `PNEUMA_OBJECT_SECRET_KEY` |
| `rtc` | `PNEUMA_RTC_STUN_URLS`, `PNEUMA_RTC_TURN_URLS` (comma separated), `PNEUMA_RTC_TURN_SECRET` (HMAC secret for TURN REST credentials; one value for the whole platform, set by the operator) |

## Headers on forwarded requests

Inbound `X-Pneuma-*` headers are always dropped before forwarding.

| Header | Value | Present |
| --- | --- | --- |
| `X-Forwarded-Prefix` | `/apps/<name>` | always |
| `X-Pneuma-Subject` | `user:<id>` or `service:<id>` | `identity` declared and the caller is authenticated |
| `X-Pneuma-Name` | display name | with `X-Pneuma-Subject` |
| `X-Pneuma-Owner` | `1` | with `X-Pneuma-Subject`, only when the subject is the app's owner |

With `identity` declared, an unauthenticated browser is redirected to the platform login page before reaching the app; other clients get 401. In M1 the login page asks only for a name, the subject becomes `user:<name>`, and a signed cookie carries it; it identifies, it does not authenticate. Service subjects come from tokens issued with `appctl token create`.

## Objects

Inside your bucket, keys under `public/` are readable by anyone at `<PNEUMA_OBJECT_PUBLIC_ENDPOINT>/<bucket>/public/<key>` with `Range`. Everything else needs a presigned URL. To accept an upload, presign a `PUT` against the public endpoint and give the URL to the browser; the bytes go straight to storage.

## Triggers

With `cron` declared, implement one endpoint on your port:

```
POST /_pneuma/trigger/<name>
X-Pneuma-Delivery:      stable id, identical on every retry
X-Pneuma-Attempt:       1..5
X-Pneuma-Scheduled-For: RFC 3339 (scheduled deliveries)
X-Pneuma-Subject:       caller (on-demand deliveries)
body:                   the on-demand caller's body, empty when scheduled
```

Any 2xx means done. Anything else, a timeout, or a dropped connection means the platform retries with backoff, five attempts in total. The gateway never forwards client requests under `/_pneuma/` to your port, so from outside the platform network they can only come from the platform. Another container on the shared network can still reach your port directly; that is inside the trust boundary, not a security claim.

External programs invoke a trigger through the gateway. This endpoint always authenticates, whether or not the app declares `identity`, and accepts a service token or the owner's session:

```
POST /apps/<name>/_pneuma/trigger/<trigger>
Authorization: Bearer <service token>
Idempotency-Key: <optional; the same key within 24 h returns the same delivery>
-> 202 {"delivery": "<id>"}
```

## Admin API (operators and tooling, not apps)

Loopback port 8081, JSON. The console renders projects only (list, publish with an owner field on first publish, releases, capability bindings, per-app policy, state, last access, counts, trigger deliveries, remove, purge); global policy, tokens and owner changes are `appctl` commands. `appctl publish <name> <dir|image> --owner user:<name>` sends the owner; `--owner` defaults to `PNEUMA_OWNER` in the environment.

```
GET  /api/apps                        list: name, address, release, capabilities, status (registered|removed|purging), instance (none|asleep|waking|awake|draining|stopping), last access, requests, errors
GET  /api/apps/<name>                 releases, bindings, policy, state, stats, deliveries
PUT  /api/apps/<name>/release         {"image": reference|null, "manifest": {...}, "bundle": id|null, "owner": subject}  the gateway resolves the reference to an image id; owner required on first publish, ignored after
POST /api/bundles                     tar body -> {"bundle": id}
PUT  /api/policy                      global policy fields
PUT  /api/apps/<name>/policy          per-app overrides
PUT  /api/apps/<name>/owner           {"owner": subject}
POST /api/apps/<name>/remove          address returns 404, data kept
POST /api/apps/<name>/purge           only when removed; data deleted
POST /api/tokens                      {"name": ...} -> {"token": one-time secret, "subject": "service:<name>"}
```

Policy fields: `idle_seconds`, `ready_timeout_seconds`, `drain_timeout_seconds`, `connection_idle_seconds`, `trigger_timeout_seconds`, `db_backend` (`sqlite` or `postgres`; the global value is the default for an app's first database; a per-app change provisions the other engine and does not migrate data), and global-only `timezone`.
