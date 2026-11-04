# Acceptance (M1)

One check per M1 story in `docs/user-stories.md`, plus the numeric thresholds. A check passes only against the real platform started with `docker compose up -d`, never against a mock. Thresholds are gates, not capacity claims, measured on a 4-core, 8 GB host.

## Story checks

| ID | Check |
| --- | --- |
| AC-P-1 | Publish an app with a manifest and an image; `GET /apps/<name>/` answers from the app. Publish it again under the same name; the address is unchanged. |
| AC-P-2 | Publish a second image under the same name; data written before is readable after; `release` increments; publishing the identical inputs a third time changes nothing. |
| AC-P-3 | Add `kv` to the manifest and publish; the container sees `PNEUMA_SPACE_KV_URL`. Remove `kv` and publish; the variable is absent; add it back and the previously written keys are still there. |
| AC-P-4 | After the idle timeout, `GET /api/apps` shows the app asleep; a request wakes it and earlier data is present. |
| AC-P-5 | From a clean checkout, `docker compose up -d` is the only command before the console at `127.0.0.1:8081` loads. |
| AC-P-6 | The console shows only projects: list, publish, releases, capability bindings, per-app policy, state, last access, request count, error count, trigger deliveries, remove, purge. No global policy, token or owner page. |
| AC-P-7 | `PUT /api/apps/<name>/policy` with `idle_seconds=5`, and `PUT /api/policy` with `idle_seconds=5` for an app without an override, each take effect on the next reaper tick without a publish. |
| AC-P-8 | With 500 registered apps and 20 running, `GET /api/apps` completes under 100 ms and issues zero Docker calls. |
| AC-P-9 | After `remove`, the address returns 404 and the volume, database and bucket still exist. After `purge`, they are gone. `purge` on a registered app is refused. |
| AC-P-10 | `docker compose restart gateway`; every registration, release, policy and binding is unchanged; a sleeping app wakes on request; a `delivering` trigger re-runs. |
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
