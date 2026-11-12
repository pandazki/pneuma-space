# Run the hosted profile locally

Use Node.js 24 or newer. This entry runs the [cloud application contract](../docs/app-contract.md#cloud-profile-contract-2). The [launch plan](../docs/saas-launch.md) records deployment prerequisites and cost approval.

## Start the console

From the repository root:

```sh
npm ci --prefix cloud
npm run dev --prefix cloud
```

Open `http://localhost:8787`. Select **Continue with GitHub**, then choose Alice or Bob on the local test-account page. The local entry uses SQLite and files under `cloud/.data`. It accepts only code you trust. The production bundle contains no local sign-in route.

Set `PNEUMA_SPACE_LOCAL_PORT` to use another port. Set `PNEUMA_SPACE_LOCAL_DATA` to use another data directory.

## Publish a private app

Create a credential on the console's **Credentials** page. Copy its secret before dismissing the dialog. From the repository root:

```sh
export PNEUMA_SPACE_ADMIN=http://localhost:8787
export PNEUMA_SPACE_TOKEN='<credential from the console>'
node cloud/cli/appctl.ts publish counter examples/cloud-counter
```

Open the app from the console. Browser sign-in stays separate from the deployment credential. The [counter example](../examples/cloud-counter/README.md) includes retention and export commands.

The CLI prints the idempotency key before an upload. To retry a lost or interrupted publication, pass that key with `--key`. A completed replay returns its original release. An unfinished attempt still counts against the current daily preparation limit.

## Verify the implementation

Run these commands from the repository root:

```sh
npm test --prefix cloud
npm run typecheck --prefix cloud
npm run build --prefix cloud
```

The test group uses native SQLite, filesystem artifacts, a real HTTP server and CLI, and local workerd with SQLite Durable Objects and R2. `build` runs `wrangler deploy --dry-run`; it creates no remote resource. Read [the evidence record](../docs/saas-verification.md) before treating a local result as a deployed result.

## Prepare Cloudflare after approval

1. Review the [launch plan](../docs/saas-launch.md) and approve the paid stage separately.
2. Set the control and application domains in `wrangler.jsonc`. Configure the control hostname and wildcard application route in their Cloudflare zones.
3. Register a GitHub OAuth application with callback `https://space.deepaste.ai/auth/callback`. Set its client ID in the config.
4. Supply `PNEUMA_SPACE_GITHUB_CLIENT_SECRET` and a random `PNEUMA_SPACE_SESSION_KEY` through Wrangler's interactive secret commands. Keep their values out of Git and shell arguments.
5. Create the private `pneuma-space-artifacts` bucket after checking account billing. The Worker owns the SQLite class migrations in `wrangler.jsonc`.
6. Leave `PNEUMA_SPACE_ENABLED=false` until the staged checks in the launch plan pass. Enable the intended stage explicitly.

Regenerate binding declarations after config changes:

```sh
npm run types --prefix cloud
```

The config disables public Workers preview addresses and request logging. Application audit events remain available through the management API.
