# Examples

An example is only its business part: a manifest, `src/`, its own `public/` files and its dictionary, written against the scaffold in `templates/app` (or `site/` against `templates/static`).
`node examples/publish.ts <name> --owner user:<you>` lays the example over the scaffold in `examples/.build/<name>` (gitignored) and publishes that directory with `cli/appctl.ts publish`, as an isolate app (`docker compose --profile isolate up -d`) unless the example is a static site.
`--assemble-only` stops after assembling, so the directory can be run locally.
