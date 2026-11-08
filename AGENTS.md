PneumaSpace deploys stateful web apps on one trusted host (M1) or an organization's Kubernetes cluster (M2). Read `REQUIREMENTS.md`, `REQUIREMENTS-M2.md`, `DESIGN.md`, `docs/app-contract.md` and `docs/acceptance.md` before changing runtime behavior. Each fact lives in exactly one of them; link to it instead of restating it.

## Boundaries that do not move

- The platform model has no agent, LLM, template chooser or host integration. Those words appear only under `templates/` and `examples/` and in docs that describe examples.
- The gateway is Node.js LTS with built-in modules only and no runtime dependencies, written in TypeScript that Node runs directly (ADR 0012). It speaks every protocol it needs itself: Docker and Kubernetes APIs over HTTP, S3 and its admin API over SigV4-signed HTTP (ADR 0013), PostgreSQL and Redis over their wire protocols through its own minimal clients (ADR 0025). No npm driver, no jobs for provisioning. Example apps may use any runtime and packages.
- App state lives in `/data` volumes and platform-provided services, never in the container filesystem. Publish and remove keep every volume, database, key prefix and bucket. Only purge deletes, and only from `removed`.
- Trust boundaries are in `REQUIREMENTS.md` (M1: one trusted host) and `REQUIREMENTS-M2.md` (M2: one organization, members who err but are not hostile). Never describe loopback binding, shared networks, per-app roles, ACLs, NetworkPolicies or namespaces as tenant isolation against a hostile tenant; that is M3.
- Object bytes never pass through an app container or the gateway. Static bytes pass through the gateway only.

## Structure rules

- A new capability is one row in `CAPABILITIES` and one Provider with `ensure`, `inject`, `suspend`, `destroy`, each safe to run twice (`ensure` on a suspended binding is the resume). If a capability needs changes anywhere else, stop and write an ADR first.
- A new runtime is one row in `RUNTIMES` and one class implementing `Runtime` (ADR 0017). The `Runtimes` facade dispatches by RunSpec, the Guard alone counts failures and quarantines, and Providers never learn which runtime an app uses or which plane runs it.
- Kubernetes is a deployment plane, not a runtime (ADR 0019): `PNEUMA_SPACE_PLANE` picks the container driver, the runner pool, `Infra` (now only `resolveImage`) and the `Store` in `main.ts`; everything else is shared. Instance state lives in the platform store and changes only by conditional update (ADR 0020).
- Every wake goes through `Runtime.acquire`. No Docker or Kubernetes API call outside `Runtime` and `Infra`. No write to a platform table outside its owning component (`DESIGN.md` section 1.2).
- Names: `PNEUMA_SPACE_*` environment variables, `X-Pneuma-Space-*` headers, `_pneuma-space/` reserved path segment, `pneuma-space-*` Docker and Kubernetes resources, `pneuma-space.*` Kubernetes labels. Do not introduce a second prefix.
- A deviation from `DESIGN.md` is recorded as a new ADR in `docs/adr/` before the code lands. Never edit a design doc to match code that drifted.

## Working rules

- Write the fewest precise words. No restating across files, no comments except a non-obvious why, no tests for behavior that no story, invariant or acceptance row names. One behavior per test.
- Chinese for `REQUIREMENTS.md`, `DESIGN.md`, `docs/user-stories.md` and `docs/adr/`. English for this file, `docs/app-contract.md`, `docs/acceptance.md`, `README.md` and everything under `templates/` and `examples/`.
- Reproduce a bug on the real platform before fixing it. Done means the relevant rows of `docs/acceptance.md` pass against `docker compose up -d`, not against a mock.
- Run the test group that covers the change (table below) after every change, and the README smoke test when Docker is available.
- The Python prototype under `prototype/00-appbase-python/` and the other `prototype/` directories is evidence from the earlier phase. Do not extend it; M1 replaces it. Until a directory is deleted, keep its tests passing with `python3 -m unittest discover -s prototype/00-appbase-python/tests -v`.

## Tests

`npm test` runs the first three groups in turn. Every group is `node --test`; the file lists are in `package.json`, and a new test file lands in `test:unit` unless its name is in another group's list.

| Change | Run |
| --- | --- |
| Anything under `gateway/src` or `cli/` | `npm run test:unit`: in-process, seconds. `console.html` has no test beyond it; look at the page on a running stack |
| `runner.ts`, `isolate-shim.ts`, `isolate.ts`, `lifecycle.ts` | also `npm run test:runner`: spawns runner processes, timing-sensitive, needs a quiet host |
| `runtime.ts`, `infra.ts`, `docker.ts`, `providers.ts`, `pg.ts`, `store-pg.ts`, `compose.yaml` | also `npm run test:docker`: real containers and compose services, minutes |
| `kube.ts`, `pods.ts`, `deploy/kubernetes/`, anything the `kubernetes` plane runs differently | also `npm run test:k8s` against the operator's cluster named by `PNEUMA_SPACE_TEST_KUBECONTEXT`; never creates or deletes clusters; cluster-only acceptance rows live here |
| `templates/app` | `npm test` inside `templates/app` |
| Before a merge to main | `npm run test:acceptance` against `docker compose up -d`, one run at a time; M2 rows against the cluster |
| A runtime's speed, and a new runtime against the old ones | `node tests/bench/runtimes.ts` against a running stack: first request after publish, wake after sleep, warm request, per runtime; one TSV per run in `tests/bench/results/` with the host load, so runs compare. Never a timing assertion in a unit test |
