# Stateful HTTP app template

This directory is a working example for an agent or developer. Start from the root README and REQUIREMENTS.md. The app listens on port 8000, is published beneath `/apps/<name>/`, and stores SQLite and the optional PostgreSQL password file in `/data`. Respect `X-Forwarded-Prefix` in links and redirects. Treat the gateway and deployed code as trusted local development only.

## Start a separate app

The template is not an initializer command. From the repository root, create a new empty app directory and copy `app.py`, `records.py`, `store.py`, `relational.py`, and `Dockerfile` from this template into it. Edit the copied app, leaving the starter intact. The Docker build context must be that new directory because the Dockerfile copies these files from its context. The provided Dockerfile installs psycopg; a deliberately SQLite-only app can omit it, but must not claim to support PostgreSQL. Keep the copied record files in sync manually; there is no packaged or versioned SDK yet.

## Change the business app

- Implement HTTP routes in `app.py`; never trust browser-provided identity as authentication. There is no identity integration in this version.
- `relational.py` supplies a small parameterized SQL transaction adapter for common SQLite/PostgreSQL syntax. Use bare `{}` value placeholders, pass values separately, and read results inside the transaction. See the root README for isolation, SQL portability, and error limits.
- `records.py` supplies a portable JSON record API over the `Database` transaction wrapper in `store.py`. Call `RecordStore.setup()` once at startup; see the root README for its operations, limits, revision and retry semantics. It is a small record store, not an arbitrary SQL or distributed database interface.
- Build your copied app from the repository root, for example `docker build -t my-app:local ./my-app`; then `python3 appctl.py publish my-app my-app:local`. Open `http://127.0.0.1:8080/apps/my-app/`. Republishing preserves the app's data volume.
- Choose a backend through the documented non-secret `--env` settings. PostgreSQL credentials must be supplied separately by the operator. Switching configuration does not migrate data.
- Run the root tests and the applicable Docker smoke tests documented in the root README. Do not assume background work or cron runs while the app is idle-stopped. WebSockets and streaming are unsupported.
