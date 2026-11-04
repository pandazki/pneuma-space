# Pneuma Space: local stateful app prototype

A small local runtime for trusted HTTP app images. Publish an image under a stable URL; the gateway starts it on demand, stops it after inactivity, and keeps its `/data` volume. People and agents use the same CLI. This is the earlier prototype, kept as evidence; the M1 design starts at [REQUIREMENTS.md](REQUIREMENTS.md).

## 项目入口与设计记录

- [需求与范围](REQUIREMENTS.md) · [总体设计](DESIGN.md) · [架构决策记录](docs/adr/) · [验证回查](VERIFICATION.md)
- [独立 Agent 构建问卷](prototype/01-agent-app/) · [业务数据语义实验](prototype/02-storage/) · [有界冷应用实验](prototype/03-cold-apps/) · [独立 Agent 复验](prototype/04-agent-recheck/)

所有目录都是 prototype/demo；具体运行步骤和观察结果见各目录的 README。

## Requirements

Docker Engine 25 or newer (API 1.44+) and Compose, Python 3.9+, network access to install the pinned PostgreSQL driver when building the sample image, and free local ports 8080 and 8081. On Docker Desktop, start Docker Desktop first. Commands run from this directory. The gateway needs access to the Docker daemon socket and therefore effectively has host-level control. Only use trusted images and a trusted local machine.

## Start and publish

```sh
docker compose up -d --build
docker build -t appbase-counter:local ./templates/counter
python3 appctl.py publish counter appbase-counter:local
python3 appctl.py list
```

Use the local management page at <http://127.0.0.1:8081/> to view running state, publish an image, and open or remove apps. You can also use the CLI. Open <http://127.0.0.1:8080/apps/counter/> and increment the counter. By default, after 60 seconds without completed requests the container becomes eligible for stopping; the periodic check can add up to 10 seconds. Reload the page: the app starts again and the count remains. `python3 appctl.py list` reports its current running state. Override the timeout when starting the gateway, for example `IDLE_SECONDS=10 docker compose up -d --build`.

To publish a new version, build an image and run `publish` again with the same name. The URL and data volume stay the same. `python3 appctl.py remove counter` removes the registration and container but **preserves data**. `docker compose down` stops the gateway but also preserves its registry and app volumes. It does not stop independently created app containers; remove registrations first if you need to stop and remove them. App volumes named `appbase-data-<name>` are not managed by Compose and need deliberate manual cleanup. Back up data before cleanup.

## Try PostgreSQL

The default is SQLite. The optional Compose `postgres` profile starts a local PostgreSQL service with its own persistent volume; it is reachable only on the Compose network. Supply your own strong password in `POSTGRES_PASSWORD` before starting it. The image requires one on first initialization; the runtime does not generate credentials. Do not use this prototype as a production credential-management pattern.

```sh
# Set POSTGRES_PASSWORD yourself in your shell, without committing it to a file.
docker compose --profile postgres up -d postgres
```

Provide your own PostgreSQL password file in standard libpq `.pgpass` format, with owner-only permissions, at `/data/.pgpass` in the app's existing volume. For example, after publishing the SQLite sample, a trusted operator can copy an existing `~/.pgpass` file into its volume and set the required permissions:

```sh
docker run --rm -v appbase-data-counter:/data -v "$HOME/.pgpass:/input/.pgpass:ro" \
  --entrypoint sh python:3.12.12-slim -c 'cp /input/.pgpass /data/.pgpass && chmod 600 /data/.pgpass'
```

 The relevant default entry has host `postgres`, port `5432`, database `postgres`, and user `postgres`. For real deployments, provision a dedicated database and least-privilege role instead of the bootstrap superuser. Do not place passwords in `--env`: these settings are stored in the gateway registry and visible through Docker.

```sh
python3 appctl.py publish counter appbase-counter:local \
  --env DB_BACKEND=postgres --env PGHOST=postgres --env PGPORT=5432 \
  --env PGDATABASE=postgres --env PGUSER=postgres
```

Reload the same URL to use PostgreSQL. Switch back by publishing again with `--env DB_BACKEND=sqlite` (or no environment options). **This changes configuration only: it does not copy or migrate data.** Each backend retains its own state. App registration preserves the SQLite volume, and Compose preserves PostgreSQL's volume. The sample uses fixed `counter` and `appbase_records` tables, so two apps pointed at the same database and schema share those tables. A shared PostgreSQL instance is not tenant isolation: per-app schema names or `search_path` alone do not prevent cross-app access. Use separate roles and grants, plus a reviewed isolation model, before handling mutually untrusted workloads.

## JSON records in the template

`templates/counter/records.py` offers a small Python interface for app-owned records. `RecordStore(backend, sqlite_path)` supports `setup()`, `create(collection, key, value)`, `get(collection, key)`, `list(collection, after="", limit=100)`, `replace(collection, key, value, revision)`, and `delete(collection, key, revision)`. Collections and keys contain 1–80 ASCII letters, digits, `_` or `-`; values are JSON up to 64 KiB. Lists return up to 100 records ordered by key. Backend collation may differ, so do not carry a pagination cursor across a backend switch. Each RecordStore operation commits separately; that record interface does not offer multi-record transactions, server-side filtering, aggregation, full-text search, or automatic migration. A separate relational adapter is described below.

A record has a positive revision. Create returns false if the key already exists; replace and delete return false if the key is absent or its revision is stale. Only one concurrent write with a given revision can succeed. A duplicate create or stale update is not silently applied. After an uncertain network response, read the current record to determine the outcome; there is no general request-id deduplication. Delete keeps a tombstone so deleting and recreating the same key cannot make an old revision valid again. Tombstones currently have no automatic cleanup. SQLite files and PostgreSQL tables are separate: switching selects a different data set, not an automatic copy.

The example app exposes the same operations under `/apps/counter/records/<collection>/<key>`: `POST` with `{"value": ...}`, `GET`, `PUT` with `{"value": ..., "revision": 1}`, and `DELETE` with `{"revision": 1}`. `GET /apps/counter/records/<collection>?after=<key>&limit=100` lists records. Successful creates return 201; duplicate creates and failed revision preconditions return 409. The API is unauthenticated and is only a local example.

```sh
curl -sS -X POST http://127.0.0.1:8080/apps/counter/records/notes/first \
  -H 'Content-Type: application/json' -d '{"value":{"text":"Hello"}}'
curl -sS http://127.0.0.1:8080/apps/counter/records/notes/first
```

The template has its own [agent development guide](templates/counter/AGENTS.md). It is one starter, not an automatic template-selection system.

## Relational SQL transactions in the template

`templates/counter/relational.py` offers a deliberately small common API for SQLite and PostgreSQL. Use one transaction for related writes, pass values separately, and fetch results before leaving the context:

```python
from relational import RelationalDatabase

db = RelationalDatabase("sqlite", "/data/example.sqlite3")
with db.transaction() as tx:
    tx.execute("CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)")
    tx.execute("INSERT INTO notes (id, body) VALUES ({}, {}) ON CONFLICT (id) DO NOTHING", "first", "Hello")
with db.transaction(write=False) as tx:
    rows = tx.execute("SELECT id, body FROM notes WHERE id = {}", "first").fetchall()
```

`{}` is a value placeholder, not Python string interpolation. Escape literal braces as `{{` and `}}`; do not quote placeholders or build SQL from untrusted text. The SQL itself must work on both databases: this is not a general SQL dialect translator. SQLite write transactions use `BEGIN IMMEDIATE`; PostgreSQL uses its default isolation. `write=False` is a SQLite lock hint, not enforced read-only authorization. Database exception types, locking, type limits, DDL and isolation differ; distributed transactions, automatic migrations and a connection pool are not provided. The order example and actual two-database transaction, filtering, aggregation, concurrency and gateway tests are in [prototype/02-storage](prototype/02-storage/README.md).

## Application contract

- Build a local Docker image that listens on `0.0.0.0:8000`. Persist data under `/data`; the named volume is unique to the app name.
- The external URL is `/apps/<name>/`. The gateway strips that prefix before forwarding and supplies it as `X-Forwarded-Prefix`. Use relative links or that prefix for redirects, forms, and asset URLs. Root-absolute URLs, cookie paths, and service workers need deliberate prefix-aware handling.
- Apps must be ready within 15 seconds after the container starts and tolerate idle stops. Active HTTP requests prevent idle stops, but background jobs do not. There is no built-in scheduler or durable trigger delivery; a cron job inside an idle-stopped app will not run. Use an external trusted scheduler only if its delivery and retry semantics suit the application. The gateway supports buffered HTTP requests and responses up to 8 MiB, not WebSockets or streaming. Requests are not replayed after connecting to an app.
- The sample includes a JSON record interface, a small relational transaction adapter, and a counter example for SQLite or PostgreSQL. Neither interface provides general SQL portability. SQLite has one writer at a time and requires a suitable local filesystem; it is not a multi-node database. PostgreSQL roles, provisioning, and migrations remain operator responsibilities.

The publish command accepts only the documented non-secret database settings via repeated `--env NAME=VALUE` flags; publishing replaces all settings for that app. The control API (`GET /apps`, `POST /apps/publish`, `POST /apps/remove` on localhost:8081) accepts JSON and powers `appctl.py`. It is not authenticated. Host and browser-origin checks reduce accidental cross-site requests, but are not a security boundary against local processes or containers. See the trust boundary in [REQUIREMENTS.md](REQUIREMENTS.md).

## Verify

```sh
python3 -m unittest discover -s tests -v
```

For an end-to-end smoke test, complete the start and publish steps above, increment the counter, wait past the idle timeout, check `python3 appctl.py list` shows `"running": false`, then reload and verify the count. Repeat after `docker compose restart gateway`. Docker must be running for this smoke test.

To exercise both actual backends with no network and no password, build the sample image first, then run the disposable test below. It starts a new PostgreSQL instance inside an isolated container using local peer authentication; it does not connect to or alter an existing server. The test checks concurrent increments, rollback, constraints, and the same HTTP application against both backends.

```sh
docker build -f tests/postgres/Dockerfile -t appbase-storage-test:local .
docker run --rm --network none appbase-storage-test:local
```

To test the real gateway and both backends via Compose, first build and start the gateway and sample as above, then run `python3 tests/compose_smoke.py`. It creates uniquely named test resources and a temporary test-only password, runs an isolated PostgreSQL service attached to the local app network, tests the same URL across backend switches and restarts, then removes its test container, volumes, registration, and temporary configuration. It does not access existing databases. An interrupted process may leave uniquely named `appbaseverify...` Docker resources requiring manual cleanup.
