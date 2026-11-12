# Hosted origin TLS verification

Verified on 2026-11-12 with Caddy 2.11.7, Node.js 24 gateway containers and a Node.js 25.1 test client. The [deployment decision](adr/0032-hybrid-origin-tls.md) defines this compatibility unit. [Run instructions](../deploy/hosted/README.md#verify-origin-tls) reproduce the Compose check.

## Results

| Check | Result |
| --- | --- |
| Isolated Compose, `npm run test:hosted:tls` | 35 passed, 2 skipped. [Test output](assets/hosted/tls-compose.txt) |
| Existing `docker-desktop` cluster, hosted and TLS tests through Caddy | 34 passed, 3 skipped. [Test output](assets/hosted/tls-kubernetes.txt) |
| `npm run test:k8s` | 13 passed, no skips. [Test output](assets/hosted/tls-k8s-smoke.txt) |
| `npm run test:unit` | 466 passed, 1 Linux-only check skipped on macOS |
| Python prototype | 18 passed |
| README smoke through HTTPS | The original template initialized, published, answered 200 and republished with one release |
| Interrupted verification | An actual SIGTERM stopped the test project and removed its temporary certificate directory |
| Proxy error logs | A query marker appeared before filtering and disappeared afterward, while the cancellation diagnostic remained. [Result](assets/hosted/tls-log-redaction.json) |

Both deployments use the checked-in Caddyfile and explicitly trusted temporary certificates. The Kubernetes check uses a ClusterIP Service and a local port-forward. It does not provision a cloud load balancer. The Compose run skips TURN configuration and the object-service pause check. Kubernetes includes TURN configuration but skips the Compose pause and two Docker-counter checks.

The protocol checks preserve a 128 MiB request's byte count and SHA-256 hash. A delayed response completes after 130 seconds. An SSE event arrives before a 130-second silent interval ends. Static HEAD and Range retain authentication and cache policy. The original CLI publishes through TLS, and the hosted suite repeats permission, capability and monitoring checks.

The Compose media checks stream a 500 MiB upload and a 1 GiB download. Their output records app and gateway network deltas, gateway RSS, and the app's sleep state. A streaming relay through the gateway would fail the network-byte assertion even if its memory stayed constant.

## Corrections found during verification

The object test formerly required a different port. TLS hosts can share port 443, so it now requires an independent origin and measures byte ownership. Review also found that inherited registry and Compose settings escaped the local test scope. The launcher now owns those settings, reuses a fixed project and handles termination before cleanup.

Caddy's default cancellation diagnostic included request query strings. A real streamed request reproduced that behavior with a harmless marker. Runtime logs now omit request metadata. Gateway request logging remains unchanged. The new proxy workload also appears in cluster monitoring with both replicas ready. The proxy has an ephemeral state directory for its housekeeping and advertises only the HTTP protocols exposed by the Service.

The initial cluster setup had an empty temporary registry and needed its fixtures pushed again. The default Pod smoke image exited during one run; its replacement initially emitted no startup log. The final smoke run uses a fixture that listens on port 8000 and emits a startup line. These setup failures did not require gateway code changes.

## State restoration and limits

The cluster used the previously isolated verification database, selected before any gateway started. Original workload specifications, configuration and identity data were saved first. The [restoration record](assets/hosted/tls-restoration.json) checks all eight workload specifications, zero replicas and Pods, and all ten original PVC identities. Temporary TLS resources and port-forwards were removed. Test databases and Compose platform volumes remain. No original application was removed or purged.

This run proves the named functional paths. It does not prove public DNS, browser trust of production certificates, GitHub OAuth, external load-balancer limits, public TURN relay, six-hour channel lifetime, hostile workload isolation, account resource budgets or second-adapter restore. The [public SaaS gates](acceptance.md#full-platform-saas) remain open. The [release plan](hosted-release-plan.md) records the remaining work and paid-resource boundary.
