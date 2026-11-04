# Task list: independent agent recheck

A small task list built from the counter template. Add a task, mark it complete or reopen it, and delete it. Each write to an existing task uses the displayed revision; a stale submission returns 409 and the page should be reloaded. Titles are escaped when displayed. The list reads all pages from the record store. Durable data is stored in `/data/tasks.sqlite3` by default; the copied record layer also accepts the documented PostgreSQL configuration, but PostgreSQL has not been tested for this app.

This is for a trusted operator and trusted images on one host. There is no authentication or tenant isolation. `X-Forwarded-Prefix` is used for forms and redirects. The task app does not rely on background jobs.

## Run in Appbase

With Docker available and the root README prerequisites met, run from the repository root:

```sh
docker compose up -d --build
docker build -t appbase-tasks:local ./prototype/04-agent-recheck
python3 appctl.py publish tasks appbase-tasks:local
```

Visit <http://127.0.0.1:8080/apps/tasks/>. Create a task, complete it, wait until the idle timeout has passed, then revisit and verify the task remains complete. Restart the gateway with `docker compose restart gateway` and revisit. Removing the registration with `python3 appctl.py remove tasks` preserves its volume. Follow the root README for backend settings, credentials, and the counter and PostgreSQL smoke tests. No migration occurs when switching backends.

## Reproduce tests

```sh
python3 -m unittest discover -s prototype/04-agent-recheck -p 'test_*.py' -v
python3 -m unittest discover -s tests -v
```

The app tests exercise the actual HTTP handler with in-memory request/response streams and a real temporary SQLite database. All three passed. An approved isolated Docker test also built and published the app, created and completed a task, observed idle stop, and verified the completed task after wake. Reproduce it with `python3 prototype/04-agent-recheck/docker_smoke.py`; it creates and cleans up uniquely named resources. PostgreSQL was not tested for this app.

## Evidence and subsequent verification

[SUCCESS.md](SUCCESS.md) contains the successful run and cleanup excerpt from the independent agent's manual trace. It is not a complete transcript or a system-generated audit log. The independent agent used an isolated gateway and successfully created/completed a task, waited for automatic idle stop, and verified the completed task after wake.

After the gateway's running-state cache was changed, the parent reran the same isolated smoke test against the updated gateway. Its separate output is in [parent-retest.txt](parent-retest.txt); the agent's successful run record was not altered by that retest. To write a new retest log without appending to the local trace:

```sh
APPBASE_AGENT_TRACE=/tmp/appbase-agent-retest.txt python3 prototype/04-agent-recheck/docker_smoke.py
```

Both successful Docker tests concern SQLite and do not verify this particular task app on PostgreSQL. The PostgreSQL business and questionnaire tests are separate experiments.
