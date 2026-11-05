# Examples

Each example is only its business part (a manifest, `src/`, its own `public/` files and its dictionary) laid over a scaffold.

| Example | Runtime | Capabilities | Scaffold |
| --- | --- | --- | --- |
| [`survey`](survey) | isolate | `files`, `db`, `cron`, `identity`, `static` | `templates/app` |
| [`ttt`](ttt) | isolate | `kv`, `ws`, `identity`, `static` | `templates/app` |
| [`widget`](widget) | isolate | `db`, `cron`, `identity` (optional), `static` | `templates/app` |
| [`chat`](chat) | isolate | `kv`, `ws`, `identity`, `static` | `templates/app` |
| [`site-docs`](site-docs) | none, a static site | `static` | `templates/static` |

`node examples/publish.ts <name> --owner user:<you>` assembles the example in `examples/.build/<name>` (gitignored) and publishes that directory with `cli/appctl.ts publish`. The isolate examples need `docker compose --profile isolate up -d`. `--assemble-only` stops after assembling, so the directory can be run locally.
