# PneumaSpace app template

You are building a web app for PneumaSpace. The app is one container behind the address `/apps/<name>/`. The platform starts it on the first request, stops it when idle, and provides the infrastructure the app declares in `pneuma-space.json`. This file, `src/server.ts` and `sdk/` are all you need. The full contract is `docs/app-contract.md` in the PneumaSpace repository.

## Start

`appctl init <dir>` copies this template into `<dir>` (`--static` copies the static-site template instead). `appctl` is `node <repo>/cli/appctl.ts`; it talks to the admin API at `PNEUMA_SPACE_ADMIN` (default `http://127.0.0.1:8081`), and apps answer at the ingress, by default `http://127.0.0.1:8080/apps/<name>/`. The operator may remap both ports.

## What the platform gives

| Declare | You get |
| --- | --- |
| `files` | A persistent directory at `/data` |
| `db` | One SQL database, SQLite or PostgreSQL chosen by the operator; your code must not care which |
| `kv` | A Redis-protocol store with pub/sub; every key and channel carries your prefix |
| `object` | An S3 bucket; browsers upload and download directly with presigned URLs, keys under `public/` are world-readable |
| `static` | `{"dir": "public"}`: a request whose path matches a file in that directory is served by the platform without starting the container; any other path goes to the app (404 when the app has no container) |
| `ws` | WebSocket and `text/event-stream` pass through; an open connection keeps the app awake and a connect to a sleeping app wakes it before the upgrade completes |
| `cron` | Named triggers called on a 5-field cron schedule (UTC unless the operator changes it) or on demand, at least once; a delivery wakes the app like a request |
| `identity` | The visitor as headers; a browser (a `GET` whose `Accept` includes `text/html`) without a session is sent to the platform login first, any other client gets 401. `{"required": false}` lets anonymous visitors through with `identity` null; send them to `/_pneuma-space/login?next=<path>` when a page needs a login |
| `rtc` | STUN and TURN servers for WebRTC; signaling goes over your own `ws` |

## Manifest

```json
{"contract": 1, "capabilities": {"files": {}, "db": {}, "cron": {"triggers": {"tick": {"schedule": "0 3 * * *"}, "rebuild": {}}}}}
```

Unknown keys are errors and `route` is implicit. A trigger without `schedule` runs only on demand; trigger names follow the app-name pattern below. A manifest with only `static` publishes without an image. The app name is chosen at publish and matches `^[a-z][a-z0-9-]{0,39}$`.

## SDK

Plain TypeScript in `sdk/`, run by Node 24 with no build step. A helper whose capability is not declared throws an error naming it.

| Call | File | What it does |
| --- | --- | --- |
| `serve(handler, {triggers})` | `serve.ts` | HTTP on `0.0.0.0:8000`. `handler({req, res, url, prefix, identity})`; `url` is relative to your address; `identity` is `{subject, name, owner}` or `null`. `POST /_pneuma-space/trigger/<name>` calls `triggers[name](delivery)`; return means success (the app answers 2xx; an external caller of the trigger sees 202 from the platform), throw means retry. Exits cleanly on `SIGTERM` |
| `body(req)` | `serve.ts` | The request body as a `Buffer`; a form is `new URLSearchParams((await body(req)).toString())` |
| `db()` | `db.ts` | `query(sql, params)` returns rows, `exec(sql, params)` returns nothing; `?` placeholders on both engines |
| `await kv()` | `kv.ts` | `redis` (node-redis client), `key(name)`, `channel(name)`, `publish(channel, text)`, `subscribe(channel, fn)`; the last two add the prefix. `subscribe` takes an exact channel, no patterns, and stays subscribed; `fn` receives the published string. For read-modify-write under concurrent writers use `redis.eval` or `WATCH`/`MULTI` |
| `objects()` | `objects.ts` | `presignPut(key, {contentType, expiresSeconds})`, `presignGet(key)`, `publicUrl(key)` for `public/` keys |
| `ws(server, fn)` | `ws.ts` | `fn(socket)` per WebSocket; `socket` has `url`, `prefix`, `identity`, `send`, `close`, `onmessage`, `onclose` |
| `iceServers(userId, ttlSeconds)` | `rtc.ts` | `RTCPeerConnection` `iceServers` with a short-lived TURN credential |
| `env()`, `need(kind)` | `env.ts` | The `PNEUMA_SPACE_*` variables as a typed object; `need('files').dir` is the `/data` path, so a file a trigger wrote there is served by reading it from that directory |

## Rules

- Keep state only in `/data`, the database, the KV store or the bucket. Memory and the container filesystem are lost when the app sleeps and on every release.
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
curl -X POST -H 'X-Pneuma-Space-Delivery: d1' -H 'X-Pneuma-Space-Attempt: 1' http://127.0.0.1:8000/_pneuma-space/trigger/tick
```

Set only the variables of capabilities you declare; without `kv`, skip Redis and `PNEUMA_SPACE_KV_*`. Locally `identity` is `null` unless you send `X-Pneuma-Space-Subject`; on the platform a declared `identity` guarantees one unless it says `"required": false`. For the PostgreSQL path run `docker run -d --name dev-pg -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=pw postgres:16-alpine` and use `PNEUMA_SPACE_DB_URL=postgresql://postgres:pw@127.0.0.1:5432/postgres`. `docker build .` checks the image. Unused `sdk/*` files and their tests may be deleted. If the published app answers 502 "did not start", `appctl logs <name>` shows the container's output, and the local run above shows the same startup error.

## Publish

`appctl publish <name> . --owner user:<you>` builds this directory (`npm ci` in the Dockerfile needs `package-lock.json` to match `package.json`; unused `pg` or `redis` entries may stay) and publishes it at the ingress. The owner is needed on the first publish only, or set `PNEUMA_SPACE_OWNER`. Publishing again under the same name keeps all data. External programs call a trigger with `POST /apps/<name>/_pneuma-space/trigger/<trigger>` and `Authorization: Bearer <token>`. `appctl token create <service>` issues a token for a service, not for one app; its subject is `service:<service>` and the last line of the output is the secret, shown once.

Other commands: `appctl list`, `appctl show <name>` (instance state asleep or awake, bindings, recent trigger deliveries), `appctl logs <name>`, `appctl policy <name> idle_seconds=5` (per-app override; the default idle is 60 s), `appctl remove` and `appctl purge`.

Testing on the platform with curl, for an app that declares `identity`:

```sh
ORIGIN=http://127.0.0.1:8080
curl -c alice.jar -d name=alice -d next=/apps/<name>/ $ORIGIN/_pneuma-space/login   # sets the pneuma_space_session cookie; names match [a-z0-9_-]{1,32}
curl -b alice.jar $ORIGIN/apps/<name>/
```


## Scenario: company survey (`files`, `db`, `identity`, `cron`)

1. In `pneuma-space.json` keep `files`, `db`, `identity` and `cron` with one trigger `{"export": {"schedule": "0 2 * * *"}}`; delete `kv` and `ws`, the room code in `src/server.ts`, and `public/app.js`. Replace the `form`/`input` rules in `public/style.css`, which are laid out for one text field.
2. In `src/server.ts` create `answer (subject TEXT PRIMARY KEY, q1 TEXT, q2 TEXT, q3 TEXT, submitted_at TEXT)`, one column per question.
3. `GET /` renders the questions, prefilled from `SELECT q1, q2, q3 FROM answer WHERE subject = ?` with `identity.subject`.
4. `POST /answer` reads the form with `body(req)` and upserts with `ON CONFLICT (subject) DO UPDATE SET q1 = excluded.q1, q2 = excluded.q2, q3 = excluded.q3`, so each person has one answer and can edit it.
5. `GET /results` answers 403 unless `identity.owner`; otherwise it shows `SELECT q1, CAST(count(*) AS INTEGER) AS n FROM answer GROUP BY q1` for each question.
6. Trigger `export` writes every row as CSV to `need('files').dir + '/export.csv'` (quote fields; prefix a leading `=`, `+`, `-` or `@` with `'` so spreadsheets do not run it); `GET /export.csv` streams that file to the owner with `content-disposition: attachment`, 404 before the first export.
7. Every form action and link uses `prefix`.
8. Test with curl as two subjects and as the owner (see Publish), then once with `PNEUMA_SPACE_DB_URL=postgresql://...` when Docker is available to you.
9. `appctl publish survey . --owner user:<you>` and share `/apps/survey/`; run the export now with `appctl token create exporter` and a `POST .../_pneuma-space/trigger/export`.

## Scenario: two-player board game (`kv`, `ws`, `identity`, optional `rtc`)

1. In `pneuma-space.json` keep `kv`, `ws` and `identity`; delete `files`, `db` and `cron`.
2. `POST /new` creates `id = randomUUID()`, stores `{board: '.........', turn: 'X', players: []}` at `kv.key('game:' + id)` and redirects to `${prefix}/g/${id}`.
3. `GET /g/<id>` serves the board page; `public/game.js` opens `${prefix}/g/<id>/live`.
4. In `ws(server, ...)`, parse the id from `socket.url.pathname`, seat `socket.identity.subject` as X or O if a seat is free (a third subject is a spectator; the same subject in two tabs keeps one seat), and keep sockets in a `Map<id, Set<Socket>>`.
5. On a move message, load the game from KV, check it is that subject's turn and the cell is empty, apply it, check for a winner, save it with a compare-and-set (`redis.eval` or `WATCH`), then `kv.publish('game:' + id, json)`.
6. Subscribe once per game id (remember which ids you subscribed) and send each published state to the local sockets, as the template's room does, so it works with one container or many. A bot plays through a normal route with a service token, which answers synchronously; a trigger only returns 202.
7. On connect and on reconnect after close code 1001, send the stored state; the server never keeps the game in memory.
8. For voice or a direct data channel, add `rtc`, serve `GET /ice` with `iceServers(identity.subject, 3600)`, and relay offer, answer and candidates over the same WebSocket.
9. Test with two browsers or two curl subjects, then publish.

## Scenario: personal dashboard widget (`cron`, `db`, `static`, `identity`)

1. In `pneuma-space.json` declare `db`, `static` with `{"dir": "public"}`, `cron` with `{"refresh": {"schedule": "0 * * * *"}}` and `identity` with `{"required": false}`, so the card is public and the owner still gets `identity.owner`. Every delivery wakes the app, so a minute schedule keeps it awake most of the time.
2. Delete the asset handler in `src/server.ts`; the platform now serves `public/` without waking the app.
3. `public/card.html` and `public/card.js` render the card; `card.js` fetches `${prefix}/api/card`. Do not add `public/index.html` if `GET /` is dynamic.
4. Create `reading (slot TEXT PRIMARY KEY, value TEXT, fetched_at TEXT)`.
5. Trigger `refresh` computes the numbers (from the database, or from a `fetch()` of an external source) and upserts one row with slot `latest` and `ON CONFLICT (slot) DO UPDATE`; an append-only history uses slot `delivery.scheduledFor ?? delivery.id` and `DO NOTHING` instead.
6. `GET /api/card` returns the latest row as JSON with `cache-control: max-age=60`.
7. Test the trigger with curl twice with the same `X-Pneuma-Space-Delivery` and check one row.
8. Publish, then embed `/apps/<name>/card.html` in the dashboard.
9. Refresh on demand with a service token: `POST /apps/<name>/_pneuma-space/trigger/refresh`.
