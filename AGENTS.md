PneumaSpace deploys stateful web apps on one trusted host. Read `REQUIREMENTS.md`, `DESIGN.md`, `docs/app-contract.md` and `docs/acceptance.md` before changing runtime behavior. Each fact lives in exactly one of them; link to it instead of restating it.

## Boundaries that do not move

- The platform model has no agent, LLM, template chooser or host integration. Those words appear only under `templates/` and in docs that describe examples.
- The gateway is Node.js LTS with built-in modules only and no runtime dependencies, written in TypeScript that Node runs directly (ADR 0012). The `db` and `kv` providers provision through `Runtime.runJob` inside the infrastructure containers; the `object` provider and the bundle store speak S3 and its admin API over SigV4-signed HTTP from the gateway (ADR 0013). No database driver in the gateway. Example apps may use any runtime and packages.
- App state lives in `/data` volumes and platform-provided services, never in the container filesystem. Publish and remove keep every volume, database, key prefix and bucket. Only purge deletes, and only from `removed`.
- One trusted host. Never describe loopback binding, shared networks, per-app roles or ACLs as tenant isolation or as a security boundary.
- Object bytes never pass through an app container or the gateway. Static bytes pass through the gateway only.

## Structure rules

- A new capability is one row in `CAPABILITIES` and one Provider with `ensure`, `inject`, `suspend`, `destroy`, each safe to run twice (`ensure` on a suspended binding is the resume). If a capability needs changes anywhere else, stop and write an ADR first.
- Every wake goes through `Runtime.acquire`. No Docker call outside `Runtime`. No write to a platform table outside its owning component (`DESIGN.md` section 1.2).
- Names: `PNEUMA_SPACE_*` environment variables, `X-Pneuma-Space-*` headers, `_pneuma-space/` reserved path segment, `pneuma-space-*` Docker resources. Do not introduce a second prefix.
- A deviation from `DESIGN.md` is recorded as a new ADR in `docs/adr/` before the code lands. Never edit a design doc to match code that drifted.

## Working rules

- Write the fewest precise words. No restating across files, no comments except a non-obvious why, no tests for behavior that no story, invariant or acceptance row names. One behavior per test.
- Chinese for `REQUIREMENTS.md`, `DESIGN.md`, `docs/user-stories.md` and `docs/adr/`. English for this file, `docs/app-contract.md`, `docs/acceptance.md`, `README.md` and everything under `templates/`.
- Reproduce a bug on the real platform before fixing it. Done means the relevant rows of `docs/acceptance.md` pass against `docker compose up -d`, not against a mock.
- Run the test suite (`node --test` once the M1 gateway exists) after every change and the README smoke test when Docker is available.
- The Python prototype under `prototype/00-appbase-python/` and the other `prototype/` directories is evidence from the earlier phase. Do not extend it; M1 replaces it. Until a directory is deleted, keep its tests passing with `python3 -m unittest discover -s prototype/00-appbase-python/tests -v`.
