# Cloudflare plane

PneumaSpace on a Cloudflare account you own: the M1 trust boundary, one trusted owner and trusted app code, with a Cloudflare account in place of a Docker host ([ADR 0041](../docs/adr/0041-cloudflare-m1-plane.md)). A Worker serves the console and the ingress, D1 holds the directory, each app has one SQLite Durable Object and one Container, and R2 holds packages and objects ([ADR 0042](../docs/adr/0042-cloudflare-edition.md)). Apps here follow their own [contract](docs/app-contract.md), not contract 1 of the Docker and Kubernetes planes; an app targets one of the two.

The control origin is `PNEUMA_SPACE_CONTROL_ORIGIN`. Platform administrators use /admin and invited accounts use /dashboard. Each app is served at `/apps/NAME/` on the same origin ([ADR 0044](../docs/adr/0044-cloudflare-path-routing.md)).

A signed-in account starts at /dashboard?view=launch: name the app, generate its publishing token, and copy the instruction to a coding tool. The command initializes the starter app, installs project instructions and skills, publishes it, measures its requests, and returns links to the private app and its statistics. `npm run bench` in the project later verifies natural idle recovery; it waits as long as the app's idle policy. Open those links in the browser signed into the workspace. The client flow is defined by [ADR 0043](../docs/adr/0043-cloudflare-first-application.md).

The [application contract](docs/app-contract.md) defines native capabilities and limits. The [acceptance gates](docs/acceptance.md) define what must be verified. Read the [verification record](docs/verification.md) before treating this deployment as complete.

## Limits of the Container runtime

Every Node app runs in one Cloudflare Container. These limits follow from that, and none of them applies to a static app or to files in an app's declared `static` directory, which the Worker serves from R2 without a container.

- **Cold start takes seconds.** A request to a sleeping Node app waits for the container. One measured wake took about 5.2 seconds, 3.7 of them the container start, which the platform cannot shorten ([verification record](docs/verification.md)). Serve the first screen from the `static` directory and let the page call the API after it paints ([ADR 0045](../docs/adr/0045-cloudflare-first-screen-and-idle.md)).
- **One instance per app.** An app does not scale out; all its requests share one container.
- **A space runs a limited number of apps at once.** The limit is two by default and an administrator can change it. A wake beyond it answers 503 `compute_quota` until another app sleeps.
- **One fixed runner.** Node 24 on Linux amd64, prebuilt JavaScript only. An app brings no image, system package or other runtime.
- **Nothing in the container lasts.** Its files vanish on every sleep, and it has no public Internet egress. State belongs in the native services of the [contract](docs/app-contract.md).
- **Installing needs Docker and a plan with Containers.** The installer builds the runner image locally, and a first deploy can time out while Cloudflare prepares it; the installer retries.

A runtime that starts without a container is not built. [ADR 0041](../docs/adr/0041-cloudflare-m1-plane.md) lists its evaluation as the last step of this plane.

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

The prefix names the Worker, the D1 database and the buckets `PREFIX-artifacts` and `PREFIX-objects` (data moved later carries its location in its names, as below). A first install refuses names that already exist in the account. Apps are served at `https://space.example.com/apps/NAME/`. `--owner` names the first owner (default `owner`), and `--account` picks the account when the Wrangler login sees several.

The first run stops at the one manual step. Wrangler's login cannot create the long-lived token the installer uses to create resources, attach the control domain and derive the Worker's R2 signing key, so the installer prints a link to Cloudflare's create-token form with Workers Scripts edit and Workers R2 Storage edit preselected. Create the token, save it alone in the file the installer names, and run the same command again. The installer prints the token's expiry; after it, the derived R2 key stops working, so publishing cannot upload packages and apps cannot hand out object upload or download URLs.

The installer then places the data (below), creates the database and buckets, applies the schema and CORS, provisions the owner, deploys (retrying a failed deploy up to three times), removes an API token an earlier install left on the Worker, attaches the control domain unless another Worker holds it, and waits for valid HTTPS. Each step checks before it acts, so the same command resumes an interrupted install, and after a `git pull` it upgrades a finished one. An upgrade from per-app domains leaves those app hostnames attached to the Worker, where they now answer 404; detach them in the Cloudflare dashboard or through the Workers domains API. An upgrade keeps each existing space's storage quota, while new spaces get 80 MiB; raise a space still at 50 MiB under Tenants & quotas in `/admin`, or it has no room for ephemeral apps beside five durable ones. It ends with the console URL and the owner credentials file.

Everything it generates stays in `~/.pneuma-space/hosts/DOMAIN/` (mode 0700): the Wrangler config, the API token, the Worker secrets, the owner credentials and `data.json`, where the data lives. The Worker itself holds no API token. To enable TURN, add `PNEUMA_SPACE_TURN_KEY_ID` and `PNEUMA_SPACE_TURN_API_TOKEN` to `worker-secrets.json` there and rerun; the installer keeps them.

### Data location

A request runs the Worker in the Cloudflare data center it enters, and every request reads the D1 database and often an R2 bucket from there. Data created far from that data center costs every request a round trip to it, so the database and buckets belong where requests for the control domain enter ([ADR 0047](../docs/adr/0047-cloudflare-data-location.md)).

A first install deploys a placeholder Worker on the control domain, reads which data center answers it from the installing machine (`/cdn-cgi/trace`), and creates the database and buckets with the nearest [D1](https://developers.cloudflare.com/d1/configuration/data-location/) and [R2](https://developers.cloudflare.com/r2/reference/data-location/) location hint: `wnam`, `enam`, `weur`, `eeur`, `apac` or `oc` (`scripts/colo-locations.json`, regenerated by `scripts/colo-locations.mjs`). The answer depends on the installing machine's network path, and a network can reach the zone in another country than Cloudflare's own sites. When most requests will come from elsewhere, pass `--location HINT`; when the installer cannot measure, it stops and asks for one. Hints are best effort. Each run ends with where the data is and where its requests entered. A rerun that finds them apart says so and names the command below; it moves nothing.

    node cf/scripts/install.mjs space.example.com --prefix space-example --relocate wnam

prints the plan and what it cannot make safe, and changes nothing; add `--yes` to run it. It creates `PREFIX-wnam` and its two buckets with that hint, copies every R2 object and D1 row (the audit table whole, with its triggers), compares row counts and digests per table, object keys, sizes and ETags and every artifact's SHA-256, and only then binds the Worker to the copies, redeploys, and appends the audit rows and objects that reached the old data in between. Run it while nothing is published and no app is created, removed, purged or discarded. Sign-ins and account, token and invitation changes made during the move are lost, and an upload through a URL signed before the switch must be repeated. After an interruption, run the same command again. The old database and buckets stay. At least an hour after the switch, when no URL signed before it is valid, `--remove-previous` checks that the deployed Worker binds only the new data, appends what reached the old data since, and deletes the old database and buckets.

Each app's own data lives in its Durable Object and is not moved. Cloudflare creates a Durable Object near the Worker that first reaches it and does not move it afterwards; that Worker ran where the creating request entered, so the object already sits where requests enter.

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

An ephemeral app ends by itself; a managed app's writes name its manager ([ADR 0046](../docs/adr/0046-cloudflare-ephemeral-and-managed-apps.md)):

    node scripts/cli.mjs publish .build/notebook notebook-preview --ephemeral --ttl 1800
    node scripts/cli.mjs discard notebook-preview --app APP_ID
    node scripts/cli.mjs publish .build/notebook notebook --manager deployer --manager-url https://deploy.example.com/notebook
    node scripts/cli.mjs unmanage notebook --manager deployer

Create invitations in /admin and share each link with its intended tester. Redemption shows a new account key once. There is no public owner-creation or signup endpoint.

## Verify a deployment

With PNEUMA_SPACE_CREDENTIALS set, npm run verify creates disposable static and Node applications, checks private access, the app path, publication retry, static HEAD/Range, trusted identity, native storage, direct R2 and two live WebSocket subscribers. It removes and purges only those applications and revokes its test tokens. A pending purge reports the signed-ticket deadline; confirm final cleanup after that time.

The notebook's real cloud runtime, scheduled delivery, idle/restart persistence, TURN relay and both browser consoles require the remaining checks in the acceptance document. The realtime connection button verifies an actual relay data-channel round trip in a browser.
