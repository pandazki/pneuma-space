# PneumaSpace app template

You are building a web app for PneumaSpace. The app is one Node program behind the address `/apps/<name>/`, by default an isolate: a worker thread in the platform's runner service, published without Docker. The platform starts it on the first request, stops it when idle, and provides the infrastructure the app declares in `pneuma-space.json`. This file, `src/server.ts`, `ui/` and `sdk/` are all you need. The default `src/server.ts` greets the visitor by name, or offers a sign-in link, in a finished page. The full contract is `docs/app-contract.md` in the PneumaSpace repository.

## Start

`appctl init <dir>` copies this template into `<dir>`. `--container` adds a `Dockerfile` and `"runtime": "container"`, for an app the isolate rule below excludes or that needs its own image; `--static` copies the static-site template instead. Isolate apps need the platform started with `docker compose --profile isolate up -d`; without it a publish answers 409. `appctl` is `node <repo>/cli/appctl.ts`; it talks to the admin API at `PNEUMA_SPACE_ADMIN` (default `http://127.0.0.1:8081`), and apps answer at the ingress, by default `http://127.0.0.1:8080/apps/<name>/`. The operator may remap both ports.

## What the platform gives

| Declare | You get |
| --- | --- |
| `files` | A persistent directory; its path is `need('files').dir` (`/data` in a container) |
| `db` | One SQL database, SQLite or PostgreSQL chosen by the operator; your code must not care which |
| `kv` | A Redis-protocol store with pub/sub; every key and channel carries your prefix |
| `object` | An S3 bucket; browsers upload and download directly with presigned URLs, keys under `public/` are world-readable |
| `static` | `{"dir": "public"}`: a request whose path matches a file in that directory is served by the platform without waking the app; any other path goes to the app |
| `ws` | WebSocket and `text/event-stream` pass through; an open connection keeps the app awake and a connect to a sleeping app wakes it before the upgrade completes |
| `cron` | Named triggers called on a 5-field cron schedule (UTC unless the operator changes it) or on demand, at least once; a delivery wakes the app like a request |
| `identity` | The visitor as headers; a browser (a `GET` whose `Accept` includes `text/html`) without a session is sent to the platform login first, any other client gets 401. `{"required": false}` lets anonymous visitors through with `identity` null; send them to `/_pneuma-space/login?next=<path>` when a page needs a login |
| `rtc` | STUN and TURN servers for WebRTC; signaling goes over your own `ws` |

## Manifest

```json
{"contract": 1, "runtime": "isolate", "capabilities": {"files": {}, "db": {}, "cron": {"triggers": {"tick": {"schedule": "0 3 * * *"}, "rebuild": {}}}}}
```

Unknown keys are errors and `route` is implicit. A trigger without `schedule` runs only on demand; trigger names follow the app-name pattern below. `runtime` is `isolate` here and `container` in the `--container` scaffold; `entry`, isolate only, names the module the runner loads (default `src/server.ts`). A manifest with only `static` publishes without a runtime. The app name is chosen at publish and matches `^[a-z][a-z0-9-]{0,39}$`.

## SDK

Plain TypeScript in `sdk/`, run by Node 24 with no build step. Its only packages, `pg` and `redis`, are pure JavaScript, so it runs in both runtimes. A helper whose capability is not declared throws an error naming it.

| Call | File | What it does |
| --- | --- | --- |
| `serve(handler, {triggers})` | `serve.ts` | HTTP on `0.0.0.0`, port `PNEUMA_SPACE_PORT` (8000 when unset). `handler({req, res, url, prefix, identity})`; `url` is relative to your address; `identity` is `{subject, name, owner}` or `null`. `POST /_pneuma-space/trigger/<name>` calls `triggers[name](delivery)`; return means success (the app answers 2xx; an external caller of the trigger sees 202 from the platform), throw means retry. Exits cleanly on `SIGTERM` |
| `body(req)` | `serve.ts` | The request body as a `Buffer`; a form is `new URLSearchParams((await body(req)).toString())` |
| `db()` | `db.ts` | `query(sql, params)` returns rows, `exec(sql, params)` returns nothing; `?` placeholders on both engines |
| `await kv()` | `kv.ts` | `redis` (node-redis client), `key(name)`, `channel(name)`, `publish(channel, text)`, `subscribe(channel, fn)`; the last two add the prefix. `subscribe` takes an exact channel, no patterns, and stays subscribed; `fn` receives the published string. For read-modify-write under concurrent writers use `redis.eval` or `WATCH`/`MULTI` |
| `objects()` | `objects.ts` | `presignPut(key, {contentType, expiresSeconds})`, `presignGet(key)`, `publicUrl(key)` for `public/` keys |
| `ws(server, fn)` | `ws.ts` | `fn(socket)` per WebSocket; `socket` has `url`, `prefix`, `identity`, `send`, `close`, `onmessage`, `onclose` |
| `iceServers(userId, ttlSeconds)` | `rtc.ts` | `RTCPeerConnection` `iceServers` with a short-lived TURN credential |
| `env()`, `need(kind)` | `env.ts` | The `PNEUMA_SPACE_*` variables as a typed object; `need('files').dir` is the persistent directory, so a file a trigger wrote there is served by reading it from that directory |

## UI

`ui/` gives every page the PneumaSpace look, light and dark themes, and Chinese and English, with no CSS of your own.

| Call | File | What it does |
| --- | --- | --- |
| `page({prefix, lang, dict, title, body, head?, nav?, badge?})` | `page.ts` | The whole HTML document: frame, title, language and theme switches, footer. `body` is inserted as given, so wrap every value in `esc()`. `head` adds tags, such as your own `public/` script with `defer`; `nav` is `[{href, label, current?}]`; `badge: 'example'` shows the example-site badge, so drop it in a real app |
| `switchLang(ctx)` | `i18n.ts` | Answers `?lang=zh` or `?lang=en` by setting the `lang` cookie for your address and redirecting to the same path; call it first and return when it returns `true` |
| `pickLang(req)` | `i18n.ts` | `zh` or `en` from the cookie, else `Accept-Language` |
| `translate(dict, lang)` | `i18n.ts` | `t(key, {name})` fills `{name}`; throws when a key is missing from either language |
| `window.ui` | `public/ui.js` | In the browser: `t`, `lang`, `prefix`, `theme`, `setTheme`, `setLang` over the same page's dictionary |

- Every visible string, on the server and in the browser, is a key in one `dict = {en: {...}, zh: {...}}`.
- Content goes in `<section><header><h2>Title</h2><p>One line</p></header>...</section>`; sections are numbered for you. Classes: `card`, `inset`, `row`, `primary` and `danger` on buttons (`btn` makes a link a button), `chip`, `status green|orange|red`, `num`, `empty`.
- Keep `public/ui.css`, `public/ui.js` and `static` in the manifest: the platform serves them without waking the app. Put your own browser files next to them.

## Rules

- Keep state only in the files directory, the database, the KV store or the bucket. Memory and every other file are lost when the app sleeps and on every release.
- An isolate app uses pure JavaScript packages only: no native addons, no child processes. Use `--container` for anything that needs them.
- Start every link, redirect, form action, asset and WebSocket URL with `prefix`. Never write `/apps/<name>` yourself.
- A trigger can arrive twice with the same `delivery.id`. Make it idempotent: an append job keys its row by `delivery.id` or `delivery.scheduledFor` with `ON CONFLICT DO NOTHING`; a recompute job upserts one `latest` row. It gets 600 s and five attempts.
- Create tables at startup with `CREATE TABLE IF NOT EXISTS`; there is no migration step.
- SQL subset: write SQL that both SQLite and PostgreSQL accept, which means `TEXT`, `INTEGER` and `REAL` columns, ids made by the app (`crypto.randomUUID()`), timestamps as ISO 8601 `TEXT`, `0`/`1` instead of booleans, `CAST(count(*) AS INTEGER)`, `ON CONFLICT (...) DO UPDATE SET x = excluded.x`, `RETURNING`, and no `AUTOINCREMENT`, `SERIAL` or engine-specific functions.
- Use `kv.key()` and `kv.channel()` for every name. Anything outside the prefix fails with `NOPERM`.
- Upload and download object bytes in the browser with presigned URLs. Do not proxy them through the app.
- Trust `identity` only because the platform sets it. `owner` is true for the subject named by `--owner` at publish, so log in with that name to be the owner. Without `identity` declared it is always `null`. A service token (`Authorization: Bearer`) works on every route of an app that declares `identity`, arriving as `service:<name>`; a non-browser WebSocket client authenticates the upgrade with the same header or the session cookie.
- A WebSocket is closed with code 1001 on a new release or after 6 h of silence. Clients reconnect and reload state.

## Run and test locally

```sh
npm ci && npm test
mkdir -p data
docker run -d --name dev-redis -p 127.0.0.1:6379:6379 redis:7-alpine   # only with kv; pick another name and port if taken
PNEUMA_SPACE_APP=dev PNEUMA_SPACE_RELEASE=0 PNEUMA_SPACE_FILES_DIR=./data PNEUMA_SPACE_DB_URL=sqlite://$PWD/data/app.sqlite3 \
  PNEUMA_SPACE_KV_URL=redis://127.0.0.1:6379 PNEUMA_SPACE_KV_PREFIX=dev: node src/server.ts
curl -H 'X-Forwarded-Prefix: /apps/dev' -H 'X-Pneuma-Space-Subject: user:ann' -H 'X-Pneuma-Space-Name: Ann' -H 'X-Pneuma-Space-Owner: 1' http://127.0.0.1:8000/
curl -X POST -H 'X-Pneuma-Space-Delivery: d1' -H 'X-Pneuma-Space-Attempt: 1' http://127.0.0.1:8000/_pneuma-space/trigger/tick   # with a trigger named tick
```

Locally nothing serves `public/`, so pages arrive without `ui.css` and `ui.js`; publish to see them styled.

Set only the variables of capabilities you declare; without `kv`, skip Redis and `PNEUMA_SPACE_KV_*`. Locally `identity` is `null` unless you send `X-Pneuma-Space-Subject`; on the platform a declared `identity` guarantees one unless it says `"required": false`. For the PostgreSQL path run `docker run -d --name dev-pg -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=pw postgres:16-alpine` and use `PNEUMA_SPACE_DB_URL=postgresql://postgres:pw@127.0.0.1:5432/postgres`. In a `--container` app `docker build .` checks the image. Unused `sdk/*` files and their tests may be deleted. If the published app answers 502 "did not start", `appctl logs <name>` shows the app's output, and the local run above shows the same startup error.

## Publish

`appctl publish <name> . --owner user:<you>` publishes this directory at the ingress. An isolate app is copied with links followed and without `node_modules`, `data`, `.git`, `.env*`, `.npmrc` and test files, gets `npm ci --omit=dev --ignore-scripts` in the copy, and is uploaded with its `node_modules`; nothing is built. A link that leads outside the directory, such as a `file:` dependency, is skipped with a warning. A container app is built with `docker build`. Both need `package-lock.json` to match `package.json`; unused `pg` or `redis` entries may stay. The owner is needed on the first publish only, or set `PNEUMA_SPACE_OWNER`. Publishing again under the same name keeps all data. External programs call a trigger with `POST /apps/<name>/_pneuma-space/trigger/<trigger>` and `Authorization: Bearer <token>`. `appctl token create <service>` issues a token for a service, not for one app; its subject is `service:<service>` and the last line of the output is the secret, shown once.

Other commands: `appctl list`, `appctl show <name>` (runtime, quarantine, instance state asleep or awake, bindings, recent trigger deliveries), `appctl logs <name>`, `appctl unquarantine <name>` (an app that kept crashing or hanging answers 503 until this or a new publish), `appctl policy <name> idle_seconds=5` (per-app override; the default idle is 60 s), `appctl remove` and `appctl purge`.

Testing on the platform with curl, for an app that declares `identity`:

```sh
ORIGIN=http://127.0.0.1:8080
curl -c alice.jar -d name=alice -d next=/apps/<name>/ $ORIGIN/_pneuma-space/login   # sets the pneuma_space_session cookie; names match [a-z0-9_-]{1,32}
curl -b alice.jar $ORIGIN/apps/<name>/
```


## Examples

Each origin scenario is an overlay on this template under `examples/` in the PneumaSpace repository; `node examples/publish.ts <name> --owner user:<you>` assembles and publishes one. Read the one closest to your app before writing yours.

| Example | Capabilities | Shows |
| --- | --- | --- |
| `examples/survey` | `files`, `db`, `identity`, `cron` | one answer per subject by upsert, owner-only results, a nightly CSV export to `/data` with a spreadsheet-safe quote rule |
| `examples/ttt` | `kv`, `ws`, `identity` | a game stored in KV, moves by compare-and-set, one subscription per game id fanned out to local sockets, reconnect after close 1001, a bot through a service token |
| `examples/widget` | `cron`, `db`, `static`, `identity` | a trigger upserting one row by slot so a redelivery is harmless, a public `card.json` with `max-age` and CORS, owner-only writes, a minute schedule that keeps the app awake |
| `examples/chat` | `kv`, `ws`, `identity` | the smallest realtime app |
| `examples/site-docs` | `static` | a site with no container |

For a direct data channel between two players, add `rtc`, serve `GET /ice` with `iceServers(identity.subject, 3600)`, and relay offer, answer and candidates over the WebSocket.
