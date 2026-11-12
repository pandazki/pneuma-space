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

After starting the stack, run `npm run test:hosted`. It uses actual development sign-ins and removes only its own random test applications and credentials. Enable the RTC profile first and set `PNEUMA_SPACE_HOSTED_TEST_RTC=true` to include its ICE configuration check. Set `PNEUMA_SPACE_HOSTED_TEST_PAUSE_OBJECTS=true` to test revocation while provisioning; this briefly pauses the development object service and resumes it before checking the result. Use this option only when no one else is using the development stack. Full TURN and original application checks remain in `npm run test:acceptance`.

## Configure a trusted hosted deployment

Use the original Compose or Kubernetes deployment with `PNEUMA_SPACE_IDENTITY=hosted`. The [hosted configuration contract](../../docs/app-contract.md#hosted-identity) defines the required origins, identity settings and credential behavior. Store GitHub secrets in the deployment's secret mechanism. Do not put them in source control or shell arguments.

This implementation uses the existing runtime trust boundary. The [SaaS acceptance gates](../../docs/acceptance.md#full-platform-saas) separate functional parity from public hostile-workload isolation. Production OAuth, domains and cluster behavior need their actual deployment checks before public release.

### Kubernetes

The [Kubernetes overlay](kubernetes/kustomization.yaml) extends the [existing deployment](../kubernetes/README.md) and selects hosted identity. Fill its GitHub placeholders and the base deployment settings, replace the example hosts consistently, and supply the named TLS Secrets. Render it with `kubectl kustomize deploy/hosted/kubernetes` before applying it to an existing cluster. Put the nonsecret [hosted identity settings](../../docs/app-contract.md#hosted-identity) in the `pneuma-space-gateway` ConfigMap and the GitHub client secret in `pneuma-space-secrets`. The gateway Deployment already reads both. Keep the shared PostgreSQL platform store so replicas see the same sessions and revocations.

The overlay includes an ingress example that routes the exact control host to port 8081 and app hosts to port 8080, preserving the original Host header. Match `PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT` to its object host. Use the control origin for the CLI API too. Configure TLS for the separate control and app sites required by the identity contract. Hosted identity handles browser login itself; the upstream JWT proxy configuration belongs to `upstream` mode.

Run `npm run test:k8s` with `PNEUMA_SPACE_TEST_KUBECONTEXT` naming the operator's existing cluster, then check hosted sign-in, logout and request-log aggregation across replicas. The test command never creates a cluster. Local Compose results do not satisfy these cluster checks.
