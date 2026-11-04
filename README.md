# PneumaSpace

Deploy stateful web apps on one trusted machine. An app declares the infrastructure it needs in `pneuma-space.json` (files, database, key-value store, object storage, static files, WebSocket, cron triggers, visitor identity, WebRTC); the platform provides it, gives the app a stable address, starts it on demand and stops it when idle. Data outlives containers and releases.

What it is and why: `REQUIREMENTS.md`. Model and architecture: `DESIGN.md`. What an app sees: `docs/app-contract.md`. Decisions: `docs/adr/`. Acceptance: `docs/acceptance.md`. Conventions for coding agents: `AGENTS.md`. Chinese for the design documents, English for everything an app developer reads.

## Run the platform

Requirements: Docker with Compose v2, Node.js 24 or newer on the host (for `appctl`).

```sh
docker compose up -d                              # gateway, object service, redis
docker compose --profile postgres --profile rtc up -d   # also PostgreSQL and TURN
```

Console: http://127.0.0.1:8081/ (projects only). App addresses: http://127.0.0.1:8080/apps/<name>/. Object service: http://127.0.0.1:9000. Every port binds loopback. Override ports, network name, credentials and the TURN public host in a `.env` file using the `PNEUMA_SPACE_*` variables in `compose.yaml`; the defaults are for a single trusted machine only. The trust boundary is stated in `REQUIREMENTS.md` and nothing here is tenant isolation.

## Publish an app

```sh
node cli/appctl.ts init myapp                     # copy templates/app (or --static for templates/static)
cd myapp                                          # edit pneuma-space.json and src/server.ts; read AGENTS.md there
node ../cli/appctl.ts publish myapp . --owner user:me
open http://127.0.0.1:8080/apps/myapp/
```

`appctl publish <name> <dir>` reads the manifest, builds the image with Docker when the app needs a container, uploads the static directory when the manifest declares `static`, and registers the release. Publishing the same inputs again changes nothing; a new image or manifest makes a new release and keeps every volume, database, key prefix and bucket.

Other commands: `list`, `show <name>`, `remove <name>` (address returns 404, data kept), `purge <name>` (deletes data, only after remove), `policy [<name>] key=value` (idle, ready, drain, connection-idle and trigger timeouts, `db_backend`, global `timezone`), `owner <name> <subject>`, `token create <name>` (a service token for invoking triggers from outside). `PNEUMA_SPACE_ADMIN` points the CLI at another admin port.

## Tests

```sh
npm test                                          # unit tests; the runtime and provider suites need Docker
npm run test:acceptance                           # docs/acceptance.md against a real stack on its own ports (project pneuma-space-acc)
```

## License

MIT, see `LICENSE`.
