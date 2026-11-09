# PneumaSpace on Kubernetes

Plain manifests for the `kubernetes` plane ([ADR 0019](../../docs/adr/0019-kubernetes-plane.md)). The gateway runs as three replicas in namespace `pneuma-space` with the runners and the platform services; instance Pods and their volumes live in `pneuma-space-apps`.

## Prerequisites

- Kubernetes 1.25 or later, with a CNI that enforces NetworkPolicy.
- A wildcard DNS record for the apps domain (`*.apps.example.com`) and hosts for the console, the API and the object store, all pointing at your ingress, with TLS terminated there.
- An authenticating proxy in front of those hosts that puts a signed JWT in a request header ([ADR 0021](../../docs/adr/0021-trusted-upstream-identity.md)). The `kubernetes` plane refuses `PNEUMA_SPACE_IDENTITY=local`.
- A storage class whose volumes can move between nodes. App data only follows an instance to another node on such a class (US-O-4).
- An image registry and a pull credential for it. PneumaSpace ships no image: build `gateway/` and push it yourself. `appctl publish` pushes app images to `PNEUMA_SPACE_REGISTRY`.

## Fill in

`node deploy/kubernetes/check.mjs` prints every `REPLACE_ME_*` token and where it occurs. A token that occurs twice takes the same value in both places.

| Token | Value |
| --- | --- |
| `REPLACE_ME_REGISTRY`, `REPLACE_ME_TAG` | Where you pushed the gateway image; `PNEUMA_SPACE_REGISTRY` also receives app images |
| `REPLACE_ME_REGISTRY_HOST`, `REPLACE_ME_REGISTRY_BASIC_AUTH` | The registry host and `base64(user:password)`, in both `pneuma-space-registry` Secrets |
| `PNEUMA_SPACE_REGISTRY_API` (ConfigMap, optional) | A URL with scheme where the gateway reaches the `PNEUMA_SPACE_REGISTRY` host for digest lookups and token requests, when that differs from the pull address (a local cluster whose nodes pull from `localhost:<nodePort>`). Empty means the pull host itself; releases still name the pull host |
| `REPLACE_ME_APPS_DOMAIN` | The apps domain, e.g. `apps.example.com` |
| `REPLACE_ME_OBJECTS_HOST` | The host browsers use for presigned object URLs, routed to Service `rustfs` |
| `REPLACE_ME_RTC_PUBLIC_HOST` | The host browsers reach TURN on |
| `REPLACE_ME_PLATFORM_ADMINS` | Comma list of `user:<id>` or `group:<name>` ([ADR 0022](../../docs/adr/0022-tenants-and-access.md)) |
| `REPLACE_ME_IDENTITY_*`, `REPLACE_ME_CONSOLE_AUDIENCE` | Your proxy's header, JWKS URL, issuer and audiences. Use a different console audience. For a static key file, mount it, set `PNEUMA_SPACE_IDENTITY_KEYS_FILE` and empty `PNEUMA_SPACE_IDENTITY_JWKS_URL`. Set `PNEUMA_SPACE_IDENTITY_USER_CLAIM` to a claim that survives an IdP change, such as `email` |
| `REPLACE_ME_POD_CIDR`, `REPLACE_ME_SERVICE_CIDR`, `REPLACE_ME_NODE_CIDR` | The cluster's Pod, Service and node ranges, which apps may not reach. Add or remove entries as needed; `check.mjs` fails if the ConfigMap and the policies disagree |
| `REPLACE_ME_MONITORING_NAMESPACE` | The namespace your Prometheus scrapes from, port 9090 |
| `REPLACE_ME_STORE_PASSWORD` and the other `*_PASSWORD`, `*_USER`, `*_SECRET` | Fresh random values |

The other ConfigMap keys carry their ADR defaults. `PNEUMA_SPACE_K8S_STORAGE_CLASS` empty means the cluster default class. Optional backends match the compose profiles: drop `postgres`, `coturn` or the runner StatefulSet if no app uses PostgreSQL, `rtc` or the isolate runtime.

## Apply

1. `docker build -t <registry>/pneuma-space-gateway:<tag> gateway && docker push <registry>/pneuma-space-gateway:<tag>`.
2. Fill in the tokens until `node deploy/kubernetes/check.mjs` prints `ok` and no `fill in:` line.
3. `kubectl apply -k deploy/kubernetes`. Kustomize creates the namespaces first.
4. `kubectl -n pneuma-space rollout status statefulset/pneuma-space-store`, then `deployment/pneuma-space-gateway`.
5. Adapt `70-ingress-example.yaml` to your controller and hosts and apply it. The ingress read timeout must be at least `connection_idle_seconds`, or WebSocket and SSE connections are cut.
6. Optional: `kubectl apply -f deploy/kubernetes/90-smoke-rbac.yaml`.

## An organization-hosted platform library

Remove `35-platform-store.yaml` from `kustomization.yaml` and set `PNEUMA_SPACE_STORE_URL` in `pneuma-space-secrets` to `postgres://user:pass@host:5432/db?sslmode=verify-full&sslrootcert=<path>`, mounting the CA at `<path>` in the gateway Pod. The instance must accept SCRAM-SHA-256 and session-level connections, so no transaction-mode PgBouncer ([ADR 0025](../../docs/adr/0025-platform-store-postgresql.md)). Do not reuse the apps' `postgres` backend. An organization-hosted Redis, object store or PostgreSQL backend for apps replaces the Pod peer of its `pneuma-space-apps-reach-*` policy with an `ipBlock`.

## Nodes

Cordon a node for maintenance; do not drain it. `kubectl drain` refuses instance Pods because no controller owns them, and `--force` deletes them behind the platform. Instances on a cordoned node move when they next wake. When a node is lost, an instance Pod on it stays Terminating until you confirm the node is down by adding the taint `node.kubernetes.io/out-of-service=nodeshutdown:NoExecute`; the platform then force-deletes the Pod. Scale the runner StatefulSet up only: an isolate app whose home replica is removed stays unavailable.

## Smoke RBAC

`90-smoke-rbac.yaml` creates `pneuma-space-smoke`, the account `npm run test:k8s` uses to create and delete test Pods in `pneuma-space-apps`. A production cluster does not need it. The kubectl context running the tests needs `create serviceaccounts/token` on it.

## Assumptions to check on your cluster

- `pneuma-space-apps-dns` allows kube-dns Pods labelled `k8s-app=kube-dns` in `kube-system`. Adjust it for NodeLocal DNSCache or another DNS layout.
- The `postgres`, `redis` and `rustfs` aliases in `pneuma-space-apps` assume the cluster domain `cluster.local`.
- The runner policy opens worker ports 32768 to 60999, the Linux ephemeral range the runner takes worker ports from.
- Kubernetes has no per-Pod process limit like compose's `pids_limit`; set `podPidsLimit` on the kubelet if you need one.

## Local cluster

`deploy/dev-cluster/` runs the platform on a one-node developer cluster whose kubelet shares the Docker daemon (Docker Desktop in kubeadm mode). It adds a `registry:2` Deployment on NodePort 30500, mounts a static identity key and runs two gateway replicas. Fill the base tokens with these values: `REPLACE_ME_REGISTRY=localhost:30500` (the daemon pulls and `docker push` pushes through the NodePort, and `localhost` needs no TLS), `PNEUMA_SPACE_REGISTRY_API=http://pneuma-space-registry.pneuma-space.svc:5000` (the gateway Pod cannot reach the node's `localhost`), `PNEUMA_SPACE_K8S_STORAGE_CLASS=hostpath`, `PNEUMA_SPACE_APPS_ORIGIN=http://*.apps.localtest.me:18080` with `kubectl port-forward svc/pneuma-space-gateway 18080:8080 18081:8081` (`*.localtest.me` resolves to 127.0.0.1), `PNEUMA_SPACE_IDENTITY_KEYS_FILE=/etc/pneuma-space/identity/keys.json` and an empty JWKS URL. Generate an ES256 key pair, export the public key as a JWKS with `kid` into `deploy/dev-cluster/keys.json`, and sign test JWTs with the private key. Build and push the gateway with `docker build -t localhost:30500/pneuma-space-gateway:dev gateway && docker push localhost:30500/pneuma-space-gateway:dev`, then `kubectl apply -k deploy/dev-cluster`. Docker Desktop's CNI does not enforce NetworkPolicy, so the policies apply but do nothing there; `PNEUMA_SPACE_TEST_POD_ROUTABLE=0` skips the host-to-Pod probe in `test:k8s`.
