# Hosted profile verification

Recorded on 2026-11-11 for `feat/saas-cloudflare`. The [acceptance table](acceptance.md#cloud-profile-contract-2) defines the required behavior. The [launch plan](saas-launch.md) owns deployment decisions and paid-stage approval.

## Local results

| Check | Result |
| --- | --- |
| `npm test --prefix cloud` | 158 passed. Native SQLite, filesystem artifacts, real HTTP and CLI, and local workerd |
| `npm run typecheck --prefix cloud` | Passed |
| `npm run build --prefix cloud` | Wrangler dry-run passed. No remote upload |
| `npm run test:unit` | 424 passed, 1 existing skip |
| `npm run test:runner` | 63 passed, 1 failure also reproduced on unchanged main |
| `npm run test:docker` | 85 passed, 1 failure also reproduced on unchanged main |
| `npm run test:acceptance` | 47 passed, 2 failures also reproduced on unchanged main |
| README smoke | A fresh template app published to the real Compose stack and returned HTTP 200 |
| Prototype unittest group | 18 passed |
| Kubernetes config checker | Passed with the expected operator placeholders |
| `npm run test:k8s` | 13 skipped because `PNEUMA_SPACE_TEST_KUBECONTEXT` was unset |

The Docker failures are not waived as passes. The runner group expects `Unavailable` for `runner.invalid` but receives a socket error. The provider test and AC-GAME-1 expect a stopped coturn service to be unavailable. AC-ISO-5 expects publishing with the runner stopped to return 409. Each failure was reproduced from unchanged main at `ebd3f00`. The host resolver returned `198.18.6.18` for `runner.invalid` during verification. These environment-sensitive checks remain open before merging.

The Compose smoke used its own network and ports 48080 and 48081. An initial run shared a network with an existing development stack and reached duplicate service aliases. The isolated run removed that ambiguity. Shared-definition extraction also required adding `/shared` to runner read permissions and container test mounts; the corrected stack completed the smoke and all other isolate acceptance rows.

## Cloud acceptance coverage

| Rows | Evidence |
| --- | --- |
| AC-C-1–2 | Persisted identity intent, concurrent registration and capacity tests on file SQLite; registration also runs on SQLite Durable Objects |
| AC-C-3–8 | Credential, session and HTTP tests; Cloudflare adapter tests repeat tenant denial, revocation, login grants and logout |
| AC-C-9–11, 24 | Publication tests with persisted metadata, actual artifact storage and controlled failures at external boundaries |
| AC-C-12–17 | SQLite transaction and lifecycle tests, process-worker races, export into a separate adapter, and R2 purge race tests |
| AC-C-18–20 | Actual local workerd tests for network denial, scoped RPC, invocation limits, runtime replacement and module-state separation |
| AC-C-21 | Console implemented with both dictionaries. Actual browser verification remains open |
| AC-C-22–23 | Production configuration checks, manifest validation and inspection of the emitted production bundle |

The production bundle contains no development identity or test HTTP routes. GitHub protocol tests use injected responses and do not establish a live OAuth login. Local workerd is the real execution engine with local provider storage implementations; it does not establish deployed account entitlements or production isolation.

Independent review found and reproduced publication retry quota bypass, late artifact writes after purge, unbounded static responses, and application CSP overriding a platform policy. Those defects were fixed and independently rechecked. Additional checks cover static deadlines and removal of adjacent reserved identity headers. The final local code review found no remaining contract blocker in its scope.

## Open deployment checks

Browser control was unavailable. The 1440 px and 390 px bilingual workflows, keyboard operation and visible layouts have not been observed. The local console remains available through the [quickstart](../cloud/README.md).

Cloudflare account queries timed out, including through the configured system proxy. No remote resource, DNS record or paid subscription was changed. Live GitHub OAuth, domain ownership and certificate routing, deployed malicious-code checks, entry rate limits, billing evidence and backup recovery remain deployment gates. No cluster was created or deleted.

## Runtime measurements

The process benchmark and the local Fetch benchmark use different transports and lifecycle semantics. Fetch has no sleep-and-wake promise. Its engine-restart case is an eviction experiment. Results are diagnostic samples under the recorded host load and do not establish a performance ranking or production latency.

The measured implementation commit is `ee5ddf3`. The [process sample](../tests/bench/results/2026-11-11-ee5ddf3.tsv) covers the running Compose stack. The [Fetch sample](../tests/bench/results/2026-11-11-hosted-fetch.tsv) contains 106 checked responses with zero errors, including five complete local-engine replacements. Each file records host load. The host was busy, so these samples are unsuitable for choosing a faster runtime.

Reproduce them with `node tests/bench/runtimes.ts` against an isolated running Compose stack and `npm run bench --prefix cloud` for the local Workers engine.
