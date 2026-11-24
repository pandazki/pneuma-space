# Cloudflare plane

PneumaSpace on a Cloudflare account you own: the M1 trust boundary, one trusted owner and trusted app code, with a Cloudflare account in place of a Docker host ([ADR 0041](../docs/adr/0041-cloudflare-m1-plane.md)). A Worker serves the console and the ingress, D1 holds the directory, each app has one SQLite Durable Object and one Container, and R2 holds packages and objects ([ADR 0042](../docs/adr/0042-cloudflare-edition.md)). Apps here follow their own [contract](docs/app-contract.md), not contract 1 of the Docker and Kubernetes planes; an app targets one of the two.

The control origin is `PNEUMA_SPACE_CONTROL_ORIGIN`. Platform administrators use /admin and invited accounts use /dashboard. Each app is served at `/apps/NAME/` on the same origin ([ADR 0044](../docs/adr/0044-cloudflare-path-routing.md)).

A signed-in account starts at /dashboard?view=launch: name the app, generate its publishing token, and copy the instruction to a coding tool. The command initializes the starter app, installs project instructions and skills, publishes it, measures its requests, and returns links to the private app and its statistics. `npm run bench` in the project later verifies natural idle recovery; it waits as long as the app's idle policy. Open those links in the browser signed into the workspace. The client flow is defined by [ADR 0043](../docs/adr/0043-cloudflare-first-application.md).

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

Use a Cloudflare account with Workers, Containers, D1 and R2 enabled and the control domain's zone in it, Node 24 or later, and Docker. The installer changes no subscription. From the repository root:

    node cf/scripts/install.mjs space.example.com --prefix space-example

The prefix names the Worker, the D1 database and the buckets `PREFIX-artifacts` and `PREFIX-objects`. A first install refuses names that already exist in the account. Apps are served at `https://space.example.com/apps/NAME/`. `--owner` names the first owner (default `owner`), and `--account` picks the account when the Wrangler login sees several.

The first run stops at the one manual step. Wrangler's login cannot create the long-lived token the installer uses to create resources, attach the control domain and derive the Worker's R2 signing key, so the installer prints a link to Cloudflare's create-token form with Workers Scripts edit and Workers R2 Storage edit preselected. Create the token, save it alone in the file the installer names, and run the same command again. The installer prints the token's expiry; after it, the derived R2 key stops working, so publishing cannot upload packages and apps cannot hand out object upload or download URLs.

The installer then creates the database and buckets, applies the schema and CORS, provisions the owner, deploys (retrying a failed deploy up to three times), removes an API token an earlier install left on the Worker, attaches the control domain unless another Worker holds it, and waits for valid HTTPS. Each step checks before it acts, so the same command resumes an interrupted install, and after a `git pull` it upgrades a finished one. An upgrade from per-app domains leaves those app hostnames attached to the Worker, where they now answer 404; detach them in the Cloudflare dashboard or through the Workers domains API. It ends with the console URL and the owner credentials file.

Everything it generates stays in `~/.pneuma-space/hosts/DOMAIN/` (mode 0700): the Wrangler config, the API token, the Worker secrets and the owner credentials. The Worker itself holds no API token. To enable TURN, add `PNEUMA_SPACE_TURN_KEY_ID` and `PNEUMA_SPACE_TURN_API_TOKEN` to `worker-secrets.json` there and rerun; the installer keeps them.

## Publish an application

The example exercises the native APIs through a notebook, document and direct attachment transfers.

    node scripts/build-example.mjs
    export PNEUMA_SPACE_CREDENTIALS=~/.pneuma-space/hosts/space.example.com/owner.json
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

With PNEUMA_SPACE_CREDENTIALS set, npm run verify creates disposable static and Node applications, checks private access, the app path, publication retry, static HEAD/Range, trusted identity, native storage, direct R2 and two live WebSocket subscribers. It removes and purges only those applications and revokes its test tokens. A pending purge reports the signed-ticket deadline; confirm final cleanup after that time.

The notebook's real cloud runtime, scheduled delivery, idle/restart persistence, TURN relay and both browser consoles require the remaining checks in the acceptance document. The realtime connection button verifies an actual relay data-channel round trip in a browser.
