# Hosted cluster verification

Verified on 2026-11-12 using the existing `docker-desktop` context. The gateway image contains runtime revision `41f0855`. This follow-up changes the peer DNS configuration and test tooling. The gateway runs as two replicas with a shared PostgreSQL platform store.

## Results

| Run | Result |
| --- | --- |
| `npm run test:k8s`, repeated after the DNS correction | [13 passed](assets/hosted/cluster-k8s.txt) |
| `npm run test:hosted` on Kubernetes, with a registry and RTC enabled | [28 passed, 1 skipped](assets/hosted/cluster-hosted.txt). The skipped provisioning-pause check operates on the Compose development service. |
| `npm run test:hosted:replicas` | [5 passed](assets/hosted/cluster-replicas.txt), with distinct gateway process IDs and more than 600 prior requests in the feed |
| `npm run test:hosted` on the existing Compose hosted stack, with RTC enabled | 28 passed, the same provisioning-pause check skipped |
| `npm run test:unit` | 466 passed, 1 Linux-only RSS assertion skipped on macOS |
| Python prototype tests | 18 passed |
| README CLI smoke on Compose | Original template initialized, published, answered HTTP 200 and republished without a second release |
| `kubectl kustomize deploy/hosted/kubernetes` | Passed |

The cluster run exercises the original application fixtures through hosted identities. The individual capability and permission results are in the logs above. The replica checks target concrete Pod port-forwards while retaining the configured Host and Origin. They prove shared login state, one-use grant consumption, next-request logout and credential revocation, and authenticated request-log aggregation.

Run instructions are in [the hosted deployment guide](../deploy/hosted/README.md#kubernetes). These checks use development identity, not production GitHub OAuth.

## Corrections found by the run

The initial replica check reported an external address in `feed.missing`. Inside a gateway Pod, `resolve4('pneuma-space-gateway-peers')` returned `198.18.6.128`, while the full cluster name returned both gateway Pod IPs. The Kubernetes configuration now uses the headless Service's full DNS name. The [failure before the correction](assets/hosted/cluster-peer-dns-before.txt) and final replica result show the difference.

Independent review found that the new feed assertion read only its first page. After 600 real static requests, it [falsely failed](assets/hosted/cluster-feed-pagination-before.txt). It now follows the API cursor until it finds both fixture requests. The final replica run passed with that existing history.

Two setup errors were resolved before counting the runs above. The stopped cluster had an older runner command without the checked-in `/shared` read permission. Its registry also lacked the fixture images. Updating the live command and pushing the local test images resolved those setup failures. Neither required a production-code change.

## Existing data and restoration

The original workload specifications, configuration, identity Secret and volume identities were saved before startup. PostgreSQL backups were taken before the new gateway started. All integration fixtures then used the separate `release_gates_20261112` platform database.

The gateway briefly connected to the original platform database before that switch. It applied additive migration 3, including the new hosted tables and token restrictions column. The migration was retained. A restore of the pre-run backup into a separate comparison database confirmed that [all pre-existing columns and rows in nine business tables remained identical](assets/hosted/cluster-original-records.json). This comparison excludes runtime telemetry and new schema objects.

The [restoration result](assets/hosted/cluster-restoration.json) confirms that all eight workload specifications match their originals, all replicas are zero, all ten original PVC identities remain, and neither platform namespace contains a Pod. The ConfigMap and identity Secret also match their saved values. The two test databases and private backups remain locally for inspection. They are not evidence of cross-cloud migration.

## Limits

The host cannot route directly to Pod IPs, so `PNEUMA_SPACE_TEST_POD_ROUTABLE=0` bypassed that probe in the low-level PodDriver smoke test. Gateway-driven application checks still used actual Pod readiness and connections.

Docker Desktop does not enforce NetworkPolicy. This single-node run does not establish hostile-workload isolation, resource-abuse containment, cross-node recovery, production OAuth, public TLS or Cloudflare deployment. It verifies the named test rows, not every M2 acceptance row. RTC checks here verify configuration; they do not prove public TURN reachability.

The [release plan](hosted-release-plan.md) records the remaining deployment choices. Public release still requires [AC-SAAS-15 through AC-SAAS-17](acceptance.md#full-platform-saas).
