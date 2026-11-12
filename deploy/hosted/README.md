# Run the full hosted platform

This profile adds accounts to the original gateway and console. Its required scope is the [SaaS baseline](../../REQUIREMENTS-M3.md); the separate [Fetch experiment](../../cloud/README.md) remains available with its existing data.

## Start locally

Use Node.js 24 or newer and Docker with Compose v2. From the repository root, run:

```sh
npm run dev:hosted
```

Open [the console](http://localhost:58081/). Choose `operator` to inspect the full monitoring and operations console. Choose `alice` or `bob` to use separate personal spaces. The operator is explicitly configured by the launcher; signup never grants that role.

The launcher uses its own Compose project, network, volumes and ports. It does not replace the existing local or Fetch stacks. To enable the existing RTC capability, run `npm run dev:hosted -- --rtc` when the TURN ports in `compose.yaml` are free.

On **Team**, create a personal token in your space. Use the original CLI and app templates:

```sh
export PNEUMA_SPACE_ADMIN=http://localhost:58081
export PNEUMA_SPACE_TOKEN='<token shown once in the console>'
node cli/appctl.ts init myapp
node cli/appctl.ts publish myapp ./myapp
```

Open the app's address printed by the CLI. The browser signs in separately from the deployment token. App capabilities, state retention and runtime behavior follow [contract 1](../../docs/app-contract.md).

## Verify locally

The [verification record](../../docs/hosted-verification.md) distinguishes local functional checks from release gates.

After starting the stack, run `npm run test:hosted`. It uses actual development sign-ins and removes only its own random test applications and credentials. Enable the RTC profile first and set `PNEUMA_SPACE_HOSTED_TEST_RTC=true` to include its ICE configuration check. Set `PNEUMA_SPACE_HOSTED_TEST_PAUSE_OBJECTS=true` to test revocation while provisioning; this briefly pauses the development object service and resumes it before checking the result. Use this option only when no one else is using the development stack. Full TURN and original application checks remain in `npm run test:acceptance`.

### Verify origin TLS

Run `npm run test:hosted:tls` with Node.js 24 or newer, Docker Compose and OpenSSL. The command creates its own local CA and uses the `pneuma-space-tls-check` Compose project, loads the exact Kubernetes Caddyfile, and runs hosted and protocol acceptance through HTTPS. It requires free loopback ports 48080, 48081, 49000 and 54443. On completion or SIGINT/SIGTERM, it stops its containers and removes temporary keys; platform test volumes remain and the next run reuses them. Run one verification at a time. Each test removes and purges only its own applications.

Clients explicitly trust the temporary CA with `NODE_EXTRA_CA_CERTS`. The command does not disable certificate verification or change system trust. It does not expose TURN ports or pause the existing object service, so those two optional hosted checks remain skipped. See the [TLS verification record](../../docs/hosted-tls-verification.md) for results and limits.

## Configure a trusted hosted deployment

Use the original Compose or Kubernetes deployment with `PNEUMA_SPACE_IDENTITY=hosted`. The [hosted configuration contract](../../docs/app-contract.md#hosted-identity) defines the required origins, identity settings and credential behavior. Store GitHub secrets in the deployment's secret mechanism. Do not put them in source control or shell arguments.

This implementation uses the existing runtime trust boundary. The [SaaS acceptance gates](../../docs/acceptance.md#full-platform-saas) separate functional parity from public hostile-workload isolation. Production OAuth, domains and cluster behavior need their actual deployment checks before public release.

### Kubernetes

The [Kubernetes overlay](kubernetes/kustomization.yaml) extends the [existing deployment](../kubernetes/README.md) and selects hosted identity. Fill its GitHub placeholders and the base deployment settings, replace the example hosts consistently, and supply the named TLS Secrets. Render it with `kubectl kustomize deploy/hosted/kubernetes` before applying it to an existing cluster. Put the nonsecret [hosted identity settings](../../docs/app-contract.md#hosted-identity) in the `pneuma-space-gateway` ConfigMap and the GitHub client secret in `pneuma-space-secrets`. The gateway Deployment already reads both. Keep the shared PostgreSQL platform store so replicas see the same sessions and revocations.

The overlay replaces the former ingress-nginx example with a dedicated Caddy Deployment and LoadBalancer Service. Its [Caddyfile](kubernetes/Caddyfile) reads the three public origins from the existing gateway ConfigMap. The same file routes control to gateway 8081, wildcard apps to gateway 8080, and objects directly to rustfs 9000. Internal upstream addresses live in [tls.yaml](kubernetes/tls.yaml). Use the control origin for the CLI API. Hosted identity handles browser login itself; the upstream JWT proxy configuration belongs to `upstream` mode.

Supply `pneuma-space-control-tls`, `pneuma-space-apps-tls` and `pneuma-space-objects-tls` as Kubernetes TLS Secrets with `tls.crt` and `tls.key`. Use publicly trusted certificates at the origin and keep them renewed. Caddy's automatic certificate acquisition and admin endpoint are disabled. Restart the TLS Deployment after a certificate change; this closes existing WebSockets. A rendered manifest does not establish public reachability or certificate trust.

Use Cloudflare DNS-only records for the exact control, wildcard app and object hosts, targeting the Service's external address. Check every CNAME hop. DNS-only provides no Cloudflare edge proxy, WAF or cache. Ordinary HTTP proxying narrows the app contract; [ADR 0032](../../docs/adr/0032-hybrid-origin-tls.md) records that decision. The Service needs an actual TCP load balancer or equivalent public routing. Keep any external timeout and body limits consistent with the original contract. The manifest can create a billable load balancer on a managed cluster, so render and review it before an operator applies it.

Remove the previous `pneuma-space-hosted` Ingress when switching an existing installation; `kubectl apply` does not remove omitted resources. Route DNS to only the selected entry point. Expose TURN UDP/TCP 3478 and its configured UDP relay range separately. Keep the OCI registry reachable from the CLI, gateway and compute nodes. Neither path goes through this HTTPS Service.

Run `npm run test:k8s` with `PNEUMA_SPACE_TEST_KUBECONTEXT` naming the operator's existing cluster, then check hosted sign-in, logout and request-log aggregation across replicas. The test command never creates a cluster. Local Compose results do not satisfy these cluster checks.

For a development cluster with hosted loopback identities, forward the control and ingress ports of two distinct gateway Pods to `39081/39080` and `40081/40080`. Keep the Service forward at the configured control and app origins. Run:

```sh
PNEUMA_SPACE_HOSTED_TEST_CONTROL=http://localhost:38081 \
PNEUMA_SPACE_HOSTED_TEST_APPS='http://*.apps.localhost:38080' \
PNEUMA_SPACE_HOSTED_TEST_REPLICAS='{"first":{"controlPort":39081,"ingressPort":39080},"second":{"controlPort":40081,"ingressPort":40080}}' \
npm run test:hosted:replicas
```

The checks require distinct gateway process IDs, preserve the configured Host and Origin, and send each admission to a specific replica. They cover shared login handshakes, concurrent grant redemption, immediate logout and credential revocation, and request-log aggregation. Without the replica configuration, these checks report skips.

To run the original hosted checks on this cluster, set `PNEUMA_SPACE_HOSTED_TEST_REGISTRY` to its registry host and run `npm run test:hosted` with the same origins. The suite builds and pushes its own fixture image. Forward the object store at its configured public endpoint. The provisioning-pause option remains specific to the Compose development stack.
