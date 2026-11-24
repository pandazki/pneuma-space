# Cloudflare application contract

The Cloudflare plane implements pneuma-space.cf/1 under [ADR 0042](../../docs/adr/0042-cloudflare-edition.md). The Docker and Kubernetes planes implement [contract 1](../../docs/app-contract.md) instead; an app targets one of the two. It provides native APIs, not PostgreSQL, Redis or POSIX protocol compatibility.

An application package is JSON with manifest and files. Each file has a normalized relative path, base64 body and contentType. Limit: 4 MiB, 256 files, no duplicate paths or dot segments. Publication verifies SHA-256. The manifest uses contract pneuma-space.cf/1, runtime node or static, entry, and capabilities. The capability catalog and command shapes live in [model.ts](../src/model.ts).

An app admits at most 200 upload tickets over its lifetime. Their declared package bytes together cannot exceed its allocated native-data capacity. Each ticket reserves three times its size for staged bytes, immutable code and decoded static files, so the separate artifact pool is bounded at three times that capacity. Expiry and failed publication keep reservations; purge releases the pool. The state inventory reports these conservative reservations separately from application data.

Node applications are prebuilt JavaScript with bundled dependencies. They listen on PNEUMA_SPACE_PORT. The fixed runner uses Node 24 on Linux amd64. Container files are temporary. Code is reconstructed from R2 on boot. The container stops after the policy's `idleSeconds` without a request, channel or delivery. A new app starts with 300 seconds; an existing app keeps its stored policy ([ADR 0045](../../docs/adr/0045-cloudflare-first-screen-and-idle.md)). Public Internet egress is disabled; applications access native services through the scoped internal host.

An app is served at `<control origin>/apps/<name>/`, and `/apps/<name>` redirects there with 308. Names are unique across the deployment. The app receives the request path without `/apps/<name>` and an `X-Forwarded-Prefix: /apps/<name>` header, as in [contract 1](../../docs/app-contract.md); use relative URLs or the prefix in links, redirects and asset URLs. `/apps/<name>/_pneuma-space/` is reserved, and native browser subscriptions connect to `/apps/<name>/_pneuma-space/realtime/<channel>`. Static assets are served after authorization without starting Node. The console owns the other root paths (`/login`, `/invite`, `/admin`, `/dashboard`, `/api/v1/`, `/downloads/` and its own files under `/_pneuma-space/console/`); any other root path, such as `/style.css`, answers 404, so an app page that references a root path gets an error, never a console file. Every app shares one browser origin with the console and the other apps, so its page scripts act with the signed-in owner's session ([ADR 0044](../../docs/adr/0044-cloudflare-path-routing.md)).

| Capability | Native behavior |
| --- | --- |
| db | Parameterized SQLite queries and atomic statement batches, bounded results. Application SQL cannot access hidden platform KV. |
| kv | Durable JSON get/put/delete/list, revisions, CAS, atomic increment, TTL and live pub/sub without replay. |
| files | Durable relative-path byte documents, maximum 64 KiB per file, optional revision checks. No mounted directory. |
| object | Upload/download tickets, completion, listing and deletion. Bytes move directly between browser and R2. |
| static | A dir in the package, served with HEAD, ETag and single Range. |
| ws | Node WebSocket and SSE/HTTP streams hold activity until completion or configured deadline. |
| cron | Named triggers, optional five-field UTC schedule, at-least-once delivery with stable ID and attempts. |
| identity | Trusted subject/name/owner headers. Platform credentials and incoming reserved headers are removed. |
| rtc | Expiring ICE configuration from a configured TURN provider. Unconfigured service refuses dependent publication. |

The SDK calls the intercepted host pneuma-space.internal. Scope comes from trusted platform props, never app input. Every native mutation checks active lifecycle and execution generation. Publish and remove retain data. Purge requires removed status and exact name confirmation. Already-issued signed URLs remain valid until expiry; final object cleanup waits for outstanding upload tickets.

Failed cloud cleanup remains in purging and retries through its durable alarm.

The control origin is `PNEUMA_SPACE_CONTROL_ORIGIN`. /admin requires platform administration; /dashboard requires an account. A one-use, expiring invitation creates an ordinary account and private tenant. High-entropy account keys and tokens are shown once and stored as hashes. Control writes require exact Origin and session CSRF. The control session also authorizes app requests: an unauthenticated page navigation to an app redirects to `/login?next=<path>`, and other unauthenticated app requests get 401. Cookie-authenticated unsafe app requests and WebSocket upgrades require the exact control Origin. Publishing tokens with `invoke` reach apps as Bearer credentials. Platform cookies, Bearer credentials and incoming reserved headers never reach app code, and app responses cannot set platform cookies or `Service-Worker-Allowed`.

Every HTTP admission rechecks the credential. Existing native browser subscriptions recheck it every 15 seconds and close after revocation or expiry. They survive an idle container stop; execution-scoped subscriptions retire with their container. Trusted display-name headers use percent encoding.

Control APIs use /api/v1, JSON errors with error.code/message, and list envelopes with items and optional nextCursor. Mutations accept Idempotency-Key. Tokens have tenant, action, expiry and optional app restrictions, never platform/account/purge authority.

| API suffix | Behavior |
| --- | --- |
| /auth/login, /auth/redeem, /auth/logout; /me | Login with account/key; redeem invite/username/name and return accessKey once; current user, tenant roles, CSRF. |
| /admin/overview, /accounts, /tenants, /apps, /resources, /audit | Platform-admin views, with actual observed data. |
| /admin/invitations | List, create with expiresAt, revoke by ID. New URL is shown once. |
| /admin/accounts/:id, /admin/tenants/:id | PATCH account state/admin role or tenant quotas. Preserve the last administrator. |
| /tenants/:t/members, /tokens | Membership and scoped credential management. Preserve the last tenant administrator. |
| /tenants/:t/apps; /apps/:id | List/create with name; authoritative app detail. |
| /apps/:id/uploads; /apps/:id/releases | Begin direct package upload with manifest/digest/bytes; publish uploadId; release history. |
| /apps/:id/actions | Typed action from AppAction in model.ts; purge additionally confirms the name. |
| /apps/:id/state, /logs, /events, /usage, /jobs | Actual inventory and diagnostics; POST jobs with name/payload invokes a trigger. |
| /apps/:id/data | Authorized bounded NativeCommand from model.ts. |
| /tenants/:t/usage, /audit, /events | Role-filtered telemetry. |

Listings carry timestamped observed state. Precise details and operations consult AppCell. CF resource views do not fabricate Kubernetes nodes or utilization measurements.
