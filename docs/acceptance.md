# Acceptance

One check per M1 story in `docs/user-stories.md`, plus the numeric thresholds; the M2 section follows them. A check passes only against the real platform started with `docker compose up -d`, never against a mock. Thresholds are gates, not capacity claims, measured on a 4-core, 8 GB host.

## Story checks

| ID | Check |
| --- | --- |
| AC-P-1 | Publish an app with a manifest and an image; `GET /apps/<name>/` answers from the app. Publish it again under the same name; the address is unchanged. |
| AC-P-2 | Publish a second image under the same name; data written before is readable after; `release` increments; publishing the identical inputs a third time changes nothing. |
| AC-P-3 | Add `kv` to the manifest and publish; the container sees `PNEUMA_SPACE_KV_URL`. Remove `kv` and publish; the variable is absent; add it back and the previously written keys are still there. |
| AC-P-4 | After the idle timeout, `GET /api/apps` shows the app asleep; a request wakes it and earlier data is present. |
| AC-P-5 | From a clean checkout, `docker compose up -d` is the only command before the console at `127.0.0.1:8081` loads. |
| AC-P-6 | The console shows an overview and projects: list, publish, releases, capability bindings, per-app policy, state with leases, last access, request count, error count, trigger deliveries, logs, remove, purge. No global policy, token or owner page. |
| AC-P-7 | `PUT /api/apps/<name>/policy` with `idle_seconds=5`, and `PUT /api/policy` with `idle_seconds=5` for an app without an override, each take effect on the next reaper tick without a publish. |
| AC-P-8 | With 500 registered apps and 20 running, `GET /api/apps` completes under 100 ms and issues zero Docker calls. |
| AC-P-9 | After `remove`, the address returns 404 and the volume, database and bucket still exist. After `purge`, they are gone. `purge` on a registered app is refused. |
| AC-P-10 | `docker compose restart gateway`; every registration, release, policy and binding is unchanged; a sleeping app wakes on request; a `delivering` trigger re-runs. |
| AC-P-13 | `GET /api/metrics` answers under 50 ms with zero Docker calls. After one request to a sleeping app, the next snapshot counts one wake with its latency and one request; the overview page renders the services, fleet, wakes, traffic, deliveries, host and events sections in Chinese and English, light and dark. |
| AC-P-14 | `GET /api/apps` reports `sleepsAt` for an awake instance holding no lease, equal to its last release plus `idle_seconds`, and the instance is asleep within 10 s of that time; `sleepsAt` is null while a lease is held. Events in `/api/metrics` carry strictly increasing `id` that survives a gateway restart. With the overview open and no reload, a request to a sleeping app lights a seat, adds the app to the awake timeline with its wake latency and enters the event tail within 5 s (flush, settle window and poll); more than 100 events between two polls show as a gap in the tail; the page is still while nothing happens. |
| AC-P-15 | `GET /api/requests?after=<cursor>` answers `{records, cursor, missing}` with only records newer than the cursor, under 50 ms with zero Docker calls. After one request to a sleeping app the newest record has `cold` true and `ms` at least the wake latency; opening and closing a WebSocket yields one `ws` record with its duration; a trigger delivery yields one `trigger` record with the app's status. The realtime page has a filter, a request stream and an event stream; the overview timeline shows at most 10 apps. |
| AC-P-16 | `GET /api/health` lists `runtimes` for both kinds with their `health` checks and the global `policy`, under 50 ms with zero Docker calls. `GET /api/apps` reports `dbBackend` for an app declaring `db`. The topology page's lane view draws every registered app in the lane of its runtime, and its graph view draws each app's own edges to its declared capabilities and their services, lighting one app's whole path on selection; with the isolate profile down it marks the runner off and the isolate lane unreachable; after `docker compose stop redis` it marks redis down and every app declaring `kv` as affected within 15 s, and after `start` clears both; a quarantined app is shown with its reason and the page's unquarantine control lifts it. |
| AC-P-17 | Under `local`, in Chrome, an app's page sending a `POST` to `/api/apps/<name>/remove` on the admin port leaves the app registered, while the same `POST` from the console's own page removes it. A `GET /api/apps` with `Host: evil.test:<port>`, and a `POST` with that `Host` and the matching `Origin`, answer 403. A container on the stack network calling `http://gateway:8081` without browser headers succeeds, as `appctl` does. |
| AC-ISO-1 | With `--profile isolate` up, an app from `appctl init` publishes without a Docker build, release 1 is registered, `GET /api/apps` reports `runtime: isolate`, `docker ps -a` shows no container for it, and the first request answers within 1 s. |
| AC-ISO-2 | An isolate app that enters a busy loop is stopped within 5 s of the first stuck request and answers again on the next request; after `max_failures` hangs within `failure_window_seconds` the listing shows the quarantine, requests answer 503, the attention inbox lists it, and `POST /api/apps/<name>/unquarantine` or a new release lifts it; other awake isolate apps answer throughout. |
| AC-ISO-3 | An isolate app that exceeds its heap limit ends, counts as a failure, and other apps keep answering. |
| AC-ISO-4 | A file under `PNEUMA_SPACE_FILES_DIR` and a row in the SQLite database of an isolate app survive sleep, a new release and `docker compose restart runner`; purge deletes them. |
| AC-ISO-5 | Publishing an isolate app while the runner is not running is refused with 409; the overview's service strip shows the runner off. |
| AC-ISO-6 | Five apps across the container, isolate and static kinds answer at the same time; the listing names each app's runtime. |
| AC-ISO-7 | A container app with `files` writes a file; publishing the same name as an isolate app with `files` answers 409 naming both runtimes; the container release still serves the file with the same bytes. |
| AC-FORM-1 | The same app image serves correct results with `db_backend=sqlite` and, after switching and republishing, with `db_backend=postgres`, with no code change. |
| AC-FORM-2 | A request with a forged `X-Pneuma-Space-Subject` header reaches the app without it. A logged-in browser's request reaches the app with the platform-set subject. |
| AC-FORM-3 | `X-Pneuma-Space-Owner: 1` is present only for the owner's subject. |
| AC-FORM-5 | Write a file under `/data` through the app, publish a new release, restart the gateway; the file is still there. |
| AC-CRUD-1 | Write through the app, stop the container by hand, request again; the data is present. |
| AC-CRUD-2 | A trigger with `schedule` fires while the app is asleep; the app's trigger endpoint runs within 5 s of wake. |
| AC-CRUD-3 | A service token's request carries `X-Pneuma-Space-Subject: service:<name>`; a browser's carries `user:<id>`. |
| AC-COLLAB-1 | Two WebSocket clients on one app; a message from one reaches the other through the app. |
| AC-COLLAB-2 | The app's container sees `PNEUMA_SPACE_KV_URL` and can `PUBLISH` and `SUBSCRIBE` within its prefix; a key outside the prefix fails with `NOPERM`. |
| AC-COLLAB-3 | An open WebSocket with no traffic for longer than `idle_seconds` keeps the app awake. |
| AC-COLLAB-4 | Publishing a new release closes open WebSockets with code 1001; a reconnect wakes the new release; data written before is present. |
| AC-GAME-1 | With the `rtc` profile on, the container sees `PNEUMA_SPACE_RTC_*`; without it, publishing a manifest that declares `rtc` is refused with 409. |
| AC-GAME-2 | Two pages on the host open a datachannel using the injected ICE configuration; the TURN server accepts a credential minted from the secret. Cross-NAT relay is not verified in M1. |
| AC-GAME-3 | Keys written to the KV store survive `docker compose restart redis`. |
| AC-MEDIA-1 | The container sees `PNEUMA_SPACE_OBJECT_*`; the bucket exists; the key cannot access another app's bucket. |
| AC-MEDIA-2 | A browser `PUT`s a 500 MB file to a presigned URL; the app container and the gateway process receive none of the bytes (measured by their network counters). |
| AC-MEDIA-3 | `GET <public endpoint>/<bucket>/public/<key>` with `Range: bytes=1000-` returns 206 with the right slice. |
| AC-MEDIA-4 | While a client reads a 1 GB public object, the app stays asleep and the gateway's RSS does not grow. |
| AC-WORKER-1 | A trigger with `schedule: "* * * * *"` fires every minute with no HTTP traffic to the app. |
| AC-WORKER-2 | `POST /apps/<name>/_pneuma-space/trigger/<t>` with a service token returns 202; the app's endpoint runs within 5 s of wake. |
| AC-WORKER-3 | Kill the gateway while a trigger is `delivering`; after restart the app receives the same `X-Pneuma-Space-Delivery` again. |
| AC-WORKER-4 | A trigger that takes longer than `idle_seconds` is not interrupted by idle stop. |
| AC-STATIC-1 | Publish a manifest with only `static` and no image; `GET /apps/<name>/` serves `index.html`; `docker ps -a` shows no container for it. |
| AC-STATIC-2 | First byte of a static site under 50 ms with no container start. |
| AC-STATIC-3 | A manifest with both `static` and an image: `/apps/<name>/app.js` is served without waking the app; `/apps/<name>/api/x` wakes it. |

## Thresholds

| Metric | Gate |
| --- | --- |
| Registered apps | 500 |
| Simultaneously running apps | 20 |
| `GET /api/apps` | under 100 ms, not linear in registered apps |
| Cold start of the example app to first response | under 3 s median |
| Gateway overhead on a warm request | under 5 ms median |
| Added WebSocket relay latency | under 5 ms median |
| Browser upload of 500 MB | zero bytes through the app container or the gateway |
| Client read of a 1 GB object | app stays asleep; gateway RSS growth 0 |
| Static site first byte | under 50 ms, no cold start |
| Trigger to a sleeping app | runs within 5 s of wake |
| Two local pages open a datachannel | success; cross-NAT relay not verified in M1 |

## M2

Checks for the organization edition (`REQUIREMENTS-M2.md`, stories US-O-1 to US-O-8). A row that names a Pod, a node, a PVC, a runner Pod or more than one gateway replica runs against the operator's Kubernetes cluster with a three-replica gateway; these cluster-only rows run in `test:k8s`. Every M1 row also passes on that cluster. AC-ID rows except AC-ID-12 run with `PNEUMA_SPACE_IDENTITY=upstream` against a fake upstream inside the test: it generates RSA, P-256 and Ed25519 keys, gives them to the gateway as `PNEUMA_SPACE_IDENTITY_KEYS_FILE` or its own JWKS endpoint, and signs JWTs into the configured header. Other rows run against `docker compose up -d` in `test:acceptance`.

| ID | Check |
| --- | --- |
| AC-K8S-1 | Publish a container app by registry tag; the release stores a digest; the first request answers; exactly one Pod carries `pneuma-space.app=<id>`, with no service account token mounted and limits equal to the app's policy. After the idle timeout no Pod remains and the PVC still exists. |
| AC-K8S-2 | 50 concurrent first requests to a sleeping app, spread over all gateway replicas, all answer, and the Pod watch shows exactly one ADDED for the app. |
| AC-K8S-3 | A WebSocket held through replica A keeps the app awake while HTTP requests come through replica B. After the WebSocket closes, every replica's listing shows the same `sleepsAt`, and the app is asleep within 10 s of it. |
| AC-K8S-4 | Publish through replica A while a WebSocket is open through replica B; B's client gets 1001; the new release's Pod is created only after the old Pod is gone; data written before is present. |
| AC-K8S-5 | Force-delete the replica that is waking an app; within 15 s the app is awake or asleep, never stuck in `waking`; the next request answers; at most one Pod exists throughout. |
| AC-K8S-6 | Force-delete the leader; a `* * * * *` trigger keeps firing every minute, and idle apps keep going to sleep. |
| AC-K8S-7 | An app that crashes `max_failures` times, with its requests spread across replicas, is quarantined on every replica's listing; one `unquarantine` lifts it on all. |
| AC-K8S-8 | `remove` keeps the PVCs; `purge` deletes them; a file under `/data` survives sleep, a new release and `kubectl rollout restart` of the gateway. |
| AC-K8S-9 | From inside an app Pod: another app's Pod IP on 8000 is refused; redis is unreachable unless `kv` is declared; the platform database is unreachable; `/var/run/secrets/kubernetes.io/serviceaccount` does not exist. |
| AC-K8S-10 | With `PNEUMA_SPACE_APPS_ORIGIN` set, `<name>.<domain>/` answers with `X-Forwarded-Prefix` present and empty; an unknown label is 404. Without it, `/apps/<name>/` behaves as in M1. |
| AC-K8S-11 | With two runners, an isolate app without storage answers after either runner is deleted. An app with `files` answers 503 while its home runner is down, without counting a failure, and afterwards its data is present. |
| AC-K8S-12 | Publishing an app that declares `kv` and `db` on postgres provisions both over the services' own protocols, with no Job and no exec into a Pod; the app writes and reads through both. |
| AC-K8S-13 | The console log tail of an app answers from any replica, and after the instance sleeps it still shows the last lines. |
| AC-K8S-14 | `kubectl rollout restart` of the gateway adopts every awake Pod (the Pod UID is unchanged) and creates none. |
| AC-K8S-15 | With `PNEUMA_SPACE_K8S_NODE_SELECTOR` set, app Pods land only on matching nodes; a non-root image writes `/data`. |
| AC-K8S-16 | On Compose, every M1 row, `test:runner` and `test:docker` pass with the store-backed lifecycle. |
| AC-ID-1 | A request carrying a JWT signed with each of RS256, ES256 and EdDSA reaches an app declaring `identity` with `X-Pneuma-Space-Subject: user:<claim>` and a percent-encoded non-ASCII `X-Pneuma-Space-Name`; the app sees neither the JWT header nor the cookies named in `PNEUMA_SPACE_IDENTITY_STRIP_COOKIES`. |
| AC-ID-2 | A bad signature, a wrong `iss`, a wrong `aud`, `exp` more than 60 s past, `alg: none`, `alg: HS256`, or an ES256 header on an RSA key yields 401 for an API client and a 303 to `PNEUMA_SPACE_IDENTITY_LOGIN_URL` with the original absolute URL for a browser; a forged `X-Pneuma-Space-Subject` never reaches the app. |
| AC-ID-3 | After the JWKS endpoint switches to a new key with a new `kid`, the first request signed with it succeeds; 100 requests with unknown `kid`s cause at most one JWKS fetch per 30 s; with the JWKS endpoint down and no keys cached, requests get 503, not a redirect. |
| AC-ID-4 | For one app per `access` value, a request with no JWT, with a JWT of a user outside the app's tenant, with a member's JWT and with a token of another tenant gets the result in the app contract's access table, for a static file and for a dynamic path alike. |
| AC-ID-5 | Removing a member or revoking a token takes effect on every gateway replica within 30 s; a removed member's personal token stops working at the same time. |
| AC-ID-6 | For every row of the admin endpoint table, one caller with the required role succeeds and one without it gets 403, or 404 for an app they cannot read; a token gets 403 on every row marked `*`. |
| AC-ID-7 | A JWT-authenticated `POST` to the admin API without `Sec-Fetch-Site: same-origin` gets 403; the same request with a platform token succeeds. |
| AC-ID-8 | With only `PNEUMA_SPACE_ADMIN` and `PNEUMA_SPACE_TOKEN` set, `appctl publish` registers the app in the token's tenant; for a personal token the owner is the issuer, and that user's JWT request gets `X-Pneuma-Space-Owner: 1`. |
| AC-ID-9 | On the trigger endpoint, another tenant's service token gets 202 on an `org` app and 403 on a `tenant` app; a personal token of a non-owner gets 403. |
| AC-ID-10 | An app response with `Set-Cookie: a=1; Domain=<apps-domain>` reaches the client without `Domain`; under subdomain addressing a browser-driven check shows app B never receives app A's cookie or storage. |
| AC-ID-11 | A user is registered on first JWT with first and last seen; after the upstream changes issuer and keys but maps the same user claim, the same id keeps its memberships and owned apps. |
| AC-ID-12 | With `PNEUMA_SPACE_IDENTITY=local` every M1 row passes unchanged, every app is in tenant `default`, and the console shows no tenant switcher and no team page. |
| AC-ID-13 | Two members and an admin of one tenant, and its service token: each member's app list, audit and usage hold only the apps they own; reading or changing the other member's app answers 404; a member's first publish naming another owner answers 403; the admin and the service token read and change both apps; the other member still visits an app whose `access` is `tenant`. |
| AC-OPS-1 | A tenant with quota `apps: 1` and one app gets 409 on a second app's first publish; the body's `quota` names the tenant, `apps`, used 1 and limit 1; `appctl publish` prints it; the event tail shows `quota-refused`; an app in another tenant publishes in the same minute; `GET /api/tenants/<t>/quota` reports used 1. |
| AC-OPS-2 | With quota `awake: 1` and two apps in one tenant, a request to the second while the first is awake answers 503 with `Retry-After: 30`; ten such refusals do not quarantine it; after the first sleeps the second wakes. With two gateway replicas, simultaneous requests to both apps through different replicas leave exactly one awake. |
| AC-OPS-3 | A container app's Pod carries `limits.cpu` from `cpu_millis`, `requests.memory` and `limits.memory` from `memory_mb`; an app allocating past `memory_mb` is killed and shows as a failed wake or crash. An isolate app with `memory_mb: 64` that holds a 128 MiB Buffer is terminated; other isolate apps answer throughout. |
| AC-OPS-4 | Ten requests to one app through two replicas give `GET /api/usage?app=<name>` ten requests and one wake in the current hour; the counts survive a rollout of every replica; the overview series and the project page's hour grid show them. Rows older than `usage_retention_days` are gone after the next sweep. |
| AC-OPS-5 | A wake handled by replica A appears in the event tail served by replica B within 5 s with a global, increasing `id`, and stays after both replicas restart. The realtime page served by one replica shows a request handled by the other within 3 s; with one replica unreachable the page shows a gap row naming it. |
| AC-OPS-6 | After `user:alice` purges an app, `appctl audit --tenant <t> --since 1h` lists one row with actor `user:alice`, action `app.purge`, the app, result `ok`; a refused publish is listed with result `refused`; no row holds a token secret; an `UPDATE` or `DELETE` on the audit table fails. |
| AC-OPS-7 | With `PNEUMA_SPACE_METRICS_PORT` set, `/metrics` passes `promtool check metrics`, carries `pneuma_space_requests_total` with the tenant of an app that was requested, and no series carries an `app` label; instance gauges appear on exactly one replica. |
| AC-OPS-8 | On a cluster of two or more nodes `GET /api/cluster` lists every node with allocatable and requested resources and each awake app on the node its Pod or runner runs on; a cordoned node shows unschedulable; the console's cluster page groups Pods and instances by node. On `docker compose up -d` `nodes` is empty and the host card reads the answering replica's host. |
| AC-OPS-9 | `appctl state <name>` for an app with `files`, `db` on PostgreSQL, `kv` and `object` lists the volume, database, key prefix and bucket with no credentials; `GET /api/state?tenant=<t>` lists the same for every app of the tenant. |
| AC-OPS-10 | A line a container app prints is shown by `GET /api/apps/<name>/logs` from either replica, and still after the app sleeps and its Pod is deleted; an isolate app's line appears in the runner Pod's log as JSON naming the app. |
| AC-OPS-11 | `GET /api/cluster` as a platform admin lists every node with allocatable and requested resources, the gateway Deployment and runner StatefulSet with desired and ready counts and their Pods (node, restarts, the leading gateway marked), every awake instance with its tenant, node, Pod and leases, every app PVC, and the Warning events of the last hour; a tenant admin gets 403. On the docker plane `plane` is `docker`, `nodes` and `warnings` are empty, the workloads are the compose services and no workload is `scalable`. |
| AC-OPS-12 | `PUT /api/cluster/workloads/pneuma-space-runner/scale {replicas: 3}` on a cluster running 2: the StatefulSet reaches 3 ready within 60 s, `GET /api/cluster` shows 3 and the pool serves an isolate wake on the new runner; scaling back to 2 is then refused with 409 naming that app and the new runner, and the StatefulSet stays at 3; after that app is removed and purged the scale to 2 succeeds and the removed replica's PVC remains; `replicas: 0` and `replicas` above `PNEUMA_SPACE_SCALE_MAX` are 400; scaling `pneuma-space-postgres` is 409; the audit lists `cluster.scale` with the replica count, the refused scale as `refused`. |
| AC-OPS-13 | `POST /api/cluster/pods/<leading gateway>/restart`: the Pod is replaced within 30 s, a WebSocket held through the other replica stays open, another replica leads within 10 s and a cron delivery due during the restart is delivered once; restarting a postgres Pod is 409. |
| AC-OPS-14 | `POST /api/apps/<name>/stop` on an awake app: the instance drains, its Pod is gone and the state is `asleep` within the grace period; the next request wakes it. `POST /api/apps/<name>/restart` leaves it `awake` under a new Pod (new uid; the name is fixed per app). A tenant admin may stop their tenant's app and gets 404 for another tenant's (ADR 0022). |
| AC-OPS-15 | An instance stuck `waking` whose Pod never becomes ready, or `awake` with a channel lease tallied under a dead replica: `POST /api/apps/<name>/kill` as a platform admin deletes the Pod with grace 0, sets the row `asleep`, clears the app's lease tallies on every replica and the wake claim, and the next request wakes it normally; a tenant admin gets 403; the audit lists `app.kill`. |
| AC-OPS-16 | `POST /api/cluster/nodes/<node>/drain` with three awake instances on the node: all three are `asleep` within the grace period and nothing on the node other than their Pods changed; the node's schedulable flag is untouched. |
| AC-STORE-1 | The `Store` contract suite passes against `SqliteStore` and `PgStore`. |
| AC-STORE-2 | Two replicas publish the same new name with different images at once: one app row, releases numbered 1 and 2, no error surfaces to either caller. |
| AC-STORE-3 | Publish through replica A; replica B serves the new release within 1 s. `appctl policy` through A changes B's effective policy within 1 s. |
| AC-STORE-4 | `SIGKILL` replica A while it holds an app's command lock; a publish of that app through B completes. |
| AC-STORE-5 | Terminate replica B's listen session; a publish through A during the gap is served by B after B reconnects. |
| AC-STORE-6 | Two replicas start against an empty database at once; the schema is applied once and both serve. |
| AC-STORE-7 | `PNEUMA_SPACE_STORE_URL` with `sslmode=verify-full` connects with the right CA and fails to start with a wrong one. |
| AC-STORE-8 | `package.json` declares no `dependencies`. |

## Full platform SaaS

These rows cover [the additive SaaS baseline](../REQUIREMENTS-M3.md) and [ADR 0036](adr/0036-additive-hosted-platform.md). Run the original M1 rows on Compose and the M2 rows on the configured operator cluster as regression gates. Neither the Fetch profile checks below nor local identity tests establish public hostile-workload isolation.

| ID | Acceptance |
| --- | --- |
| AC-SAAS-1 | Concurrent first sign-ins for one verified immutable identity create one user, one personal tenant and one owner membership; retries and provider display-name changes reuse them. |
| AC-SAAS-2 | At signup capacity a new identity is refused without a partial account, while an existing identity signs in. |
| AC-SAAS-3 | Hosted login uses a browser-bound, expiring, single-use handshake; an invalid callback creates no session. |
| AC-SAAS-4 | Control writes require exact Origin and session CSRF; logout rejects the next control or derived app-session admission on every replica. |
| AC-SAAS-5 | A private-app grant is single-use and bound to AppId, exact origin and browser nonce; successful redemption removes the code from the URL. |
| AC-SAAS-6 | Another account cannot list, manage or visit a new private application; denied static, container, isolate and WebSocket requests do not execute app code or return static bytes. |
| AC-SAAS-7 | Credentials enforce expiry, revocation, action and immutable AppId restrictions on management, listings, diagnostics and every app admission path; token secrets and hashes never appear in read responses. |
| AC-SAAS-8 | Revocation while publication is preparing prevents activation; the prior release and persistent state remain usable. |
| AC-SAAS-9 | Contract-1 container, isolate and static apps use every original capability under hosted identity; the relevant original story checks pass without rewriting app code. |
| AC-SAAS-10 | The operator sees the original Overview, Realtime, Topology, Host/Cluster, Team and Projects views, including real telemetry, logs and actions; new accounts receive no platform-admin privilege. |
| AC-SAAS-11 | At 1440 and 390 px in English and Chinese, the original console completes sign-in, credential issue/revoke, app navigation and typed purge confirmation without overflow or inaccessible controls. |
| AC-SAAS-12 | Existing SQLite and PostgreSQL data migrate without changing application IDs, releases, bindings, access settings or legacy token permissions. |
| AC-SAAS-13 | Hosted app code receives no platform cookies or credentials and cannot set platform-reserved response cookies, including on WebSocket responses. |
| AC-SAAS-14 | Hosted production configuration refuses local test identities, insecure origins and overlapping control/app sites; local test login is available only in explicitly enabled loopback development mode. |
| AC-SAAS-18 | The origin TLS deployment preserves external Host and Origin, rejects unknown hosts, streams a request above 100 MiB and a response after 125 seconds, delivers SSE before a 125-second silent interval ends, and retains private static HEAD/Range, CLI bundle publication and direct object transfers. Repeat AC-SAAS-4 through 13 through TLS. |

Public release also requires the following checks on the actual deployment. Local hosted checks do not satisfy them.

| ID | Pass condition |
| --- | --- |
| AC-SAAS-15 | Deliberately hostile contract-1 container and isolate applications cannot read another app’s memory or state, reach platform control sockets or the platform store, obtain platform credentials, or cross into another account through network or browser-origin attacks. Repeat after sleep, release replacement and removal. |
| AC-SAAS-16 | Exhausting compute, memory, processes, storage or request capacity in one account is refused at its limits while another account and the control plane remain usable; billable resource use is bounded and visible. |
| AC-SAAS-17 | On the required Cloudflare deployment, every supported contract-1 runtime and capability passes its original acceptance rows; an export restores application artifacts, persistent state and account ownership on a second adapter, with the source data retained. |

## Ephemeral apps

These rows cover [ADR 0038](adr/0038-ephemeral-apps.md) and US-P-17 and run in `test:acceptance` against `docker compose up -d`.

| ID | Check |
| --- | --- |
| AC-EPH-1 | `appctl publish <name> <image> --ephemeral --ttl 120` prints the end; the listing and the detail show `expiresAt` 120 s after the publish and access `tenant`. A republish with another ttl makes release 2 and keeps `expiresAt`. A publish without the marker answers 409, as does one with the marker for a durable app, which keeps its release. Setting access `org` or `public` answers 409. A ttl above `ephemeral_max_ttl_seconds` answers 400 and creates no app. |
| AC-EPH-2 | `POST /api/apps/<name>/discard` on a registered ephemeral app with written files and db: the address returns 404, the app leaves the listing, its volumes and bucket are gone, and the audit holds `app.discard` started and ok after an `app.publish` carrying the marker. On a durable app it answers 409 and the app stays registered. |
| AC-EPH-3 | An ephemeral app with `--ttl 10` is gone, with its volume, within 30 s and no request, and the audit holds `app.expire` started and ok by `platform`. One whose end passes while the gateway is stopped is gone within 30 s of the gateway starting again. |
| AC-EPH-4 | The default tenant's `ephemeral` quota is null. In a tenant with `ephemeral` 1, one ephemeral app counts 1 in `ephemeral` and 0 in `apps`; a second answers 409 with quota resource `ephemeral` until the first is discarded. |
| AC-EPH-5 | An ephemeral app declaring `schedule: "* * * * *"` has no delivery after a minute boundary; `POST /apps/<name>/_pneuma-space/trigger/<t>` with a service token returns 202 and the delivery runs. |
| AC-EPH-6 | A tenant row without the `ephemeral` field, as a gateway from before ADR 0038 writes it during a rolling update after the migration ran, reads as 3: the quota endpoint shows 3, and a fourth ephemeral app in the tenant answers 409 with quota resource `ephemeral`. |
| AC-EPH-7 | An ephemeral app whose postgres database cannot be dropped, because the postgres service is stopped when it ends, stays `purging`, and while later sweeps fail the same way the audit gains no row after one `app.expire` error. Once postgres starts again it ends within 60 s, and its last audit row is `app.expire` ok with `resumed`. |
| AC-EPH-8 | `appctl publish --ephemeral` prints the app's id. After the app is discarded and its name published again as ephemeral, `POST /api/apps/<name>/discard?app=<first id>` answers 409 and the second app stays registered; `appctl discard <name> --app <second id>` ends it. |
| AC-EPH-9 | In Chrome, the console's detail of an ephemeral app offers Discard behind ⋯; its approval card names the app and, on Continue, sends the discard with the app's id, after which the app leaves the listing, its volume is gone and the audit holds `app.discard` started and ok. |
| AC-EPH-10 | An ephemeral app on postgres whose discard fails because the postgres service is stopped stays `purging`. After postgres starts again and the gateway restarts, the app is gone, and its last audit row is `app.discard` ok with `resumed`, by `platform`. |
| AC-EPH-11 | After an ephemeral app is discarded and its name published again, stop, remove, a policy change and an owner change sent with `?app=<first id>`, and `appctl remove <name> --app <first id>`, answer 409 and the second app keeps its status, owner and policy. In Chrome, Remove on the console's detail of the second app sends `?app=<second id>` and removes it. |

## Managed apps

These rows cover [ADR 0039](adr/0039-managed-apps.md) and US-P-18 and run in `test:acceptance` against `docker compose up -d`. Every row outside this section passes unchanged.

| ID | Check |
| --- | --- |
| AC-MGR-1 | `appctl publish <name> <image> --manager <m> --manager-url <url>` makes a managed app; the listing and the detail show `manager` with both, an unmanaged app's show `manager: null`, and `appctl list` prints the manager. |
| AC-MGR-2 | On a managed app, publish, policy, access, owner, tenant and remove without `X-Pneuma-Space-Manager`, or naming another manager, answer 409 with a message naming the manager and its URL, and the app keeps its release, policy, access, owner, tenant and status; purge of it once removed does the same. Each succeeds naming the manager, and its audit rows carry `namedManager` and the actor. Stop, restart, unquarantine, logs and state succeed without it. |
| AC-MGR-3 | A publish naming the current manager with another `manager` changes it; a publish of a managed app that does not name it answers 409 and the app keeps its manager. `DELETE /api/apps/<name>/manager` answers 409 without the name and clears the manager with it; afterwards remove needs no name. |
| AC-MGR-4 | An app published with `--ephemeral --ttl 10 --manager <m>` is both: discard without the name answers 409, and it still ends with its volume within 30 s, audited as `app.expire` by `platform`. |
| AC-MGR-5 | In Chrome, the console's project card and detail show the manager, linked to its URL; remove on the detail opens an approval card saying the app is managed by it and that acting here goes around it, whose Continue stays disabled until the manager's name is typed; after typing it, Continue removes the app and the audit row carries `namedManager`. |

