# Cloudflare plane

PneumaSpace on a Cloudflare account you own: the M1 trust boundary, one trusted owner and trusted app code, with a Cloudflare account in place of a Docker host ([ADR 0041](../docs/adr/0041-cloudflare-m1-plane.md)). A Worker serves the console and the ingress, D1 holds the directory, each app has one SQLite Durable Object and one Container, and R2 holds packages and objects ([ADR 0042](../docs/adr/0042-cloudflare-edition.md)). Apps here follow their own [contract](docs/app-contract.md), not contract 1 of the Docker and Kubernetes planes; an app targets one of the two.

The control origin is `PNEUMA_SPACE_CONTROL_ORIGIN`. Platform administrators use /admin and invited accounts use /dashboard. Each app gets an exact Custom Domain beneath `PNEUMA_SPACE_APPS_DOMAIN`.

A signed-in account starts at /dashboard?view=launch: name the app, generate its publishing token, and copy the instruction to a coding tool. The command initializes the starter app, installs project instructions and skills, publishes it, verifies natural idle recovery, and returns links to the private app and its statistics. Open those links in the browser signed into the workspace. The client flow is defined by [ADR 0043](../docs/adr/0043-cloudflare-first-application.md).

The [application contract](docs/app-contract.md) defines native capabilities and limits. The [acceptance gates](docs/acceptance.md) define what must be verified. Read the [verification record](docs/verification.md) before treating this deployment as complete.

## Development

Use Node 24 or later and Docker with Linux amd64 support.

    cd cf
    npm ci
    npm run check
    npm test
    npm run build

The check command regenerates Worker types with the pinned Wrangler version. The build command performs a dry run and builds the fixed runner image. To exercise real local container tests, build that image and enable the Docker group:

    docker build --platform linux/amd64 -t pneuma-space-cf-runner-test runner
    PNEUMA_SPACE_TEST_RUNNER_DOCKER=1 npm test

Local workerd tests do not verify cloud Containers, DNS, certificates, browser behavior or TURN.

## Deployment

Use a Cloudflare account with Workers, Containers, D1 and R2 already enabled. No subscription changes are performed by these scripts.

There is no installer yet; the steps are manual, and [the verification record](docs/verification.md#fresh-install-by-an-outside-developer-2026-11-24) lists where a first install stumbled.

1. The checked-in wrangler.jsonc holds placeholders. Set the Worker, D1, bucket and container names (keep them distinct from anything already in the account), `PNEUMA_SPACE_CONTROL_ORIGIN`, `PNEUMA_SPACE_APPS_DOMAIN`, `PNEUMA_SPACE_ACCOUNT_ID` and `PNEUMA_SPACE_ZONE_ID`, and the control origin in deploy/artifact-cors.json. Do not commit the result.
2. Create the D1 database and two private R2 buckets named in that file. Put the new database ID in the binding. Keep the artifact and object buckets separate.
3. Apply the schema and CORS configuration:

       npx wrangler d1 execute D1_NAME --remote --file schema.sql --yes
       npx wrangler r2 bucket cors set ARTIFACT_BUCKET --file deploy/artifact-cors.json --force
       npx wrangler r2 bucket cors set OBJECT_BUCKET --file deploy/object-cors.json --force

4. Prepare a private JSON secrets file containing the five names in wrangler.jsonc secrets.required. Use a Workers Scripts Write account token for exact domain provisioning, R2 object read/write credentials limited to these two buckets, and a Realtime TURN key ID and its API token. Keep this file outside tracked source. Object CORS allows signed transfers from app origins; it grants no unsigned object access.
5. Provision the first owner. The credentials file is created with mode 0600, and only a hash enters D1:

       node scripts/bootstrap.mjs OWNER_USERNAME /private/path/owner.json

6. Deploy and attach the control domain:

       npm run check
       npm test
       npx wrangler deploy --secrets-file /private/path/worker-secrets.json
       node scripts/bind-domain.mjs /private/path/worker-secrets.json

The domain script refuses to replace another Worker's binding. Application domains are attached by the service. Keep domain management outside Wrangler routes so redeployment does not replace the application-domain inventory. An attached domain records the API result; verify its external HTTPS certificate separately.

## Publish an application

The example exercises the native APIs through a notebook, document and direct attachment transfers.

    node scripts/build-example.mjs
    export PNEUMA_SPACE_CREDENTIALS=/private/path/owner.json
    node scripts/cli.mjs publish .build/notebook notebook

The CLI packages prebuilt JavaScript and public files. Its package command also creates the JSON file accepted by the console's publish form:

    node scripts/cli.mjs package .build/notebook /private/path/notebook.json

Use the same credentials file for app listings, inspection and authorized data commands. The CLI signs out on completion and prints no account key.

    node scripts/cli.mjs apps
    node scripts/cli.mjs inspect APP_ID
    node scripts/cli.mjs action APP_ID remove
    node scripts/cli.mjs action APP_ID resume

Create invitations in /admin and share each link with its intended tester. Redemption shows a new account key once. There is no public owner-creation or signup endpoint.

## Verify a deployment

With PNEUMA_SPACE_CREDENTIALS set, npm run verify creates disposable static and Node applications, checks private access, publication retry, static HEAD/Range, trusted identity, native storage, direct R2 and two live WebSocket subscribers. It waits for new-domain HTTPS before issuing upload tickets. It removes and purges only those applications and revokes its test tokens. A pending purge reports the signed-ticket deadline; confirm final cleanup after that time.

The notebook's real cloud runtime, scheduled delivery, idle/restart persistence, TURN relay and both browser consoles require the remaining checks in the acceptance document. The realtime connection button verifies an actual relay data-channel round trip in a browser.
