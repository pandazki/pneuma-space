# Examples

The isolate and static examples are only their business part (a manifest, `src/`, its own `public/` files and its dictionary) laid over a scaffold. The container examples are whole apps in languages without an SDK, read the contract directly and carry a copy of the scaffold's `public/ui.css` and `ui.js`.

| Example | Runtime | Why this runtime | Capabilities | Scaffold |
| --- | --- | --- | --- | --- |
| [`survey`](survey) | isolate | TypeScript with pure JavaScript dependencies | `files`, `db`, `cron`, `identity`, `static` | `templates/app` |
| [`ttt`](ttt) | isolate | TypeScript with pure JavaScript dependencies | `kv`, `ws`, `identity`, `static` | `templates/app` |
| [`widget`](widget) | isolate | TypeScript with pure JavaScript dependencies | `db`, `cron`, `identity` (optional), `static` | `templates/app` |
| [`chat`](chat) | isolate | TypeScript with pure JavaScript dependencies | `kv`, `ws`, `identity`, `static` | `templates/app` |
| [`notes-py`](notes-py) | container | Python, and `psycopg` ships a native library | `files`, `db`, `cron`, `identity`, `static` | none, own `Dockerfile` |
| [`pulse-go`](pulse-go) | container | Go compiles to its own binary | `kv`, `ws`, `identity` (optional), `static` | none, own `Dockerfile` |
| [`site-docs`](site-docs) | none, a static site | No process: the platform serves the files | `static` | `templates/static` |

`node examples/publish.ts <name> --owner user:<you>` publishes an example with `cli/appctl.ts publish`. An example with a `Dockerfile` publishes as itself and is built with `docker build`. Any other example is first assembled in `examples/.build/<name>` (gitignored); `--assemble-only` stops there, so the directory can be run locally. The isolate examples need `docker compose --profile isolate up -d`.
