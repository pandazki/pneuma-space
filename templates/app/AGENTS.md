# Pneuma Space app template

You are building a web app for Pneuma Space. The app is one container behind the address `/apps/<name>/`. The platform starts it on the first request, stops it when idle, and provides the infrastructure the app declares in `pneuma.json`. This file, `src/server.ts` and `sdk/` are all you need. The full contract is `docs/app-contract.md` in the Pneuma Space repository.

## What the platform gives

| Declare | You get |
| --- | --- |
| `files` | A persistent directory at `/data` |
| `db` | One SQL database, SQLite or PostgreSQL chosen by the operator; your code must not care which |
| `kv` | A Redis-protocol store with pub/sub; every key and channel carries your prefix |
| `object` | An S3 bucket; browsers upload and download directly with presigned URLs, keys under `public/` are world-readable |
| `static` | `{"dir": "public"}`: the platform serves that directory at your address without starting the container |
| `ws` | WebSocket and `text/event-stream` pass through and keep the app awake |
| `cron` | Named triggers called on a 5-field cron schedule (UTC unless the operator changes it) or on demand, at least once |
| `identity` | The visitor as headers; browsers without a session are sent to the platform login first |
| `rtc` | STUN and TURN servers for WebRTC; signaling goes over your own `ws` |

## Manifest

```json
{"contract": 1, "capabilities": {"files": {}, "db": {}, "cron": {"triggers": {"tick": {"schedule": "0 3 * * *"}, "rebuild": {}}}}}
```

Unknown keys are errors and `route` is implicit. A trigger without `schedule` runs only on demand. A manifest with only `static` publishes without an image. The app name is chosen at publish and matches `^[a-z][a-z0-9-]{0,39}$`.

## SDK

Plain TypeScript in `sdk/`, run by Node 24 with no build step. A helper whose capability is not declared throws an error naming it.

| Call | File | What it does |
| --- | --- | --- |
| `serve(handler, {triggers})` | `serve.ts` | HTTP on `0.0.0.0:8000`. `handler({req, res, url, prefix, identity})`; `url` is relative to your address; `identity` is `{subject, name, owner}` or `null`. `POST /_pneuma/trigger/<name>` calls `triggers[name](delivery)`; return means 2xx, throw means retry. Exits cleanly on `SIGTERM` |
| `body(req)` | `serve.ts` | The request body as a `Buffer`; a form is `new URLSearchParams((await body(req)).toString())` |
| `db()` | `db.ts` | `query(sql, params)` returns rows, `exec(sql, params)` returns nothing; `?` placeholders on both engines |
| `await kv()` | `kv.ts` | `redis` (node-redis client), `key(name)`, `channel(name)`, `publish(channel, text)`, `subscribe(channel, fn)`; the last two add the prefix |
| `objects()` | `objects.ts` | `presignPut(key, {contentType, expiresSeconds})`, `presignGet(key)`, `publicUrl(key)` for `public/` keys |
| `ws(server, fn)` | `ws.ts` | `fn(socket)` per WebSocket; `socket` has `url`, `prefix`, `identity`, `send`, `close`, `onmessage`, `onclose` |
| `iceServers(userId, ttlSeconds)` | `rtc.ts` | `RTCPeerConnection` `iceServers` with a short-lived TURN credential |
| `env()`, `need(kind)` | `env.ts` | The `PNEUMA_*` variables as a typed object |

## Rules

- Keep state only in `/data`, the database, the KV store or the bucket. Memory and the container filesystem are lost when the app sleeps and on every release.
- Start every link, redirect, form action, asset and WebSocket URL with `prefix`. Never write `/apps/<name>` yourself.
- A trigger can arrive twice with the same `delivery.id`. Make it idempotent, for example `INSERT ... ON CONFLICT DO NOTHING` keyed by `delivery.id` or `delivery.scheduledFor`. It gets 600 s and five attempts.
- Create tables at startup with `CREATE TABLE IF NOT EXISTS`; there is no migration step.
- SQL subset: write SQL that both SQLite and PostgreSQL accept, which means `TEXT`, `INTEGER` and `REAL` columns, ids made by the app (`crypto.randomUUID()`), timestamps as ISO 8601 `TEXT`, `0`/`1` instead of booleans, `CAST(count(*) AS INTEGER)`, `ON CONFLICT (...) DO UPDATE SET x = excluded.x`, `RETURNING`, and no `AUTOINCREMENT`, `SERIAL` or engine-specific functions.
- Use `kv.key()` and `kv.channel()` for every name. Anything outside the prefix fails with `NOPERM`.
- Upload and download object bytes in the browser with presigned URLs. Do not proxy them through the app.
- Trust `identity` only because the platform sets it. `owner` is true only for the app's owner. Without `identity` declared it is always `null`.
- A WebSocket is closed with code 1001 on a new release or after 6 h of silence. Clients reconnect and reload state.

## Run and test locally

```sh
npm ci && npm test
docker run -d --name dev-redis -p 127.0.0.1:6379:6379 redis:7-alpine
PNEUMA_APP=dev PNEUMA_RELEASE=0 PNEUMA_FILES_DIR=./data PNEUMA_DB_URL=sqlite://$PWD/data/app.sqlite3 \
  PNEUMA_KV_URL=redis://127.0.0.1:6379 PNEUMA_KV_PREFIX=dev: node src/server.ts
curl -H 'X-Pneuma-Subject: user:ann' -H 'X-Pneuma-Name: Ann' -H 'X-Pneuma-Owner: 1' http://127.0.0.1:8000/
curl -X POST -H 'X-Pneuma-Delivery: d1' -H 'X-Pneuma-Attempt: 1' http://127.0.0.1:8000/_pneuma/trigger/tick
```

Set only the variables of capabilities you declare; without `kv`, skip Redis and `PNEUMA_KV_*`. Locally `identity` is `null` unless you send `X-Pneuma-Subject`; on the platform a declared `identity` guarantees one. For the PostgreSQL path run `docker run -d --name dev-pg -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=pw postgres:16-alpine` and use `PNEUMA_DB_URL=postgresql://postgres:pw@127.0.0.1:5432/postgres`. `docker build .` checks the image.

## Publish

`appctl publish <name> . --owner user:<you>` builds this directory and publishes it at `http://127.0.0.1:8080/apps/<name>/`. The owner is needed on the first publish only, or set `PNEUMA_OWNER`. Publishing again under the same name keeps all data. External programs call a trigger with `POST /apps/<name>/_pneuma/trigger/<trigger>` and `Authorization: Bearer <token>`, where the token comes from `appctl token create <name>`.

## Scenario: company survey (`files`, `db`, `identity`)

1. In `pneuma.json` keep `files`, `db` and `identity`; delete `kv`, `ws` and `cron`, the room and `tick` code in `src/server.ts`, and `public/app.js`.
2. In `src/server.ts` create `answer (subject TEXT PRIMARY KEY, q1 TEXT, q2 TEXT, submitted_at TEXT)`.
3. `GET /` renders the questions, prefilled from `SELECT q1, q2 FROM answer WHERE subject = ?` with `identity.subject`.
4. `POST /answer` reads the form with `body(req)` and upserts with `ON CONFLICT (subject) DO UPDATE SET q1 = excluded.q1, q2 = excluded.q2`, so each person has one answer.
5. `GET /results` answers 403 unless `identity.owner`; otherwise it shows `SELECT q1, CAST(count(*) AS INTEGER) AS n FROM answer GROUP BY q1`.
6. `GET /results.csv` returns the rows as CSV for the owner with `content-disposition: attachment`.
7. Every form action and link uses `prefix`.
8. Test with curl as two subjects and as the owner, then once with `PNEUMA_DB_URL=postgresql://...`.
9. `appctl publish survey . --owner user:<you>` and share `/apps/survey/`.

## Scenario: two-player board game (`kv`, `ws`, `identity`, optional `rtc`)

1. In `pneuma.json` keep `kv`, `ws` and `identity`; delete `files`, `db` and `cron`.
2. `POST /new` creates `id = randomUUID()`, stores `{board: '.........', turn: 'X', players: []}` at `kv.key('game:' + id)` and redirects to `${prefix}/g/${id}`.
3. `GET /g/<id>` serves the board page; `public/game.js` opens `${prefix}/g/<id>/live`.
4. In `ws(server, ...)`, parse the id from `socket.url.pathname`, seat `socket.identity.subject` as X or O if a seat is free, and keep sockets in a `Map<id, Set<Socket>>`.
5. On a move message, load the game from KV, check it is that subject's turn and the cell is empty, apply it, check for a winner, save it, then `kv.publish('game:' + id, json)`.
6. Subscribe once per game id and send each published state to the local sockets, as the template's room does, so it works with one container or many.
7. On connect and on reconnect after close code 1001, send the stored state; the server never keeps the game in memory.
8. For voice or a direct data channel, add `rtc`, serve `GET /ice` with `iceServers(identity.subject, 3600)`, and relay offer, answer and candidates over the same WebSocket.
9. Test with two browsers or two curl subjects, then publish.

## Scenario: personal dashboard widget (`cron`, `db`, `static`)

1. In `pneuma.json` declare `db`, `static` with `{"dir": "public"}` and `cron` with `{"refresh": {"schedule": "0 * * * *"}}`; no `identity`, so the card is public.
2. Delete the asset handler in `src/server.ts`; the platform now serves `public/` without waking the app.
3. `public/card.html` and `public/card.js` render the card; `card.js` fetches `${prefix}/api/card`. Do not add `public/index.html` if `GET /` is dynamic.
4. Create `reading (slot TEXT PRIMARY KEY, value TEXT, fetched_at TEXT)`.
5. Trigger `refresh` fetches the source with `fetch()` and inserts with slot `delivery.scheduledFor ?? delivery.id` and `ON CONFLICT (slot) DO NOTHING`.
6. `GET /api/card` returns the latest row as JSON with `cache-control: max-age=60`.
7. Test the trigger with curl twice with the same `X-Pneuma-Delivery` and check one row.
8. Publish, then embed `/apps/<name>/card.html` in the dashboard.
9. Refresh on demand with a service token: `POST /apps/<name>/_pneuma/trigger/refresh`.
