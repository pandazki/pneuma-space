---
name: pneuma-space
description: Build, publish, troubleshoot or benchmark this PneumaSpace application. Use for edits to the starter, new app features, deploying a release, checking natural idle recovery, or reporting live usage.
---

# Build an app the user can actually use

Work from the generated project directory. It already contains a functional stateful example, a manifest and a local CLI. Inspect `app/` before choosing what to change; use `PRODUCT.md` and `DESIGN.md` when changing the experience.

1. If the setup command was `start`, check `.pneuma-space/bench.json`. It means the unchanged starter is already published and measured; do not republish it without a change or unresolved failure. `start` does not wait for natural idle, so that report says `complete: false` until `npm run bench` runs. If it was `init`, continue the requested app work now.
2. Implement the user's app in `app/`. Put the page (HTML, CSS, browser JavaScript, icons, images) in `app/public/` and declare `"static":{"dir":"public"}`: the platform serves those files without starting the container, so the first screen appears while Node wakes, which takes seconds after idle. Those files are not in the container, so server code never reads them from disk. Keep only data endpoints in Node. Render a useful page before data arrives, and show a retry in place when an API call is slow or fails. Use relative URLs (`api/items`, `style.css`), never root paths: the app lives under `/apps/<name>/`, and root paths belong to the workspace. The runtime is Node 24 with built-in modules. Prebundle external dependencies into app/ before publication. Add declared native capabilities when needed; read `references/native-api.md` for persistence and the contract. Keep runtime writes in native storage, because the container filesystem is temporary. For work that must happen without a visitor, add a job as [Scheduled jobs](#scheduled-jobs) shows.
3. Run syntax checks for changed JavaScript and `node .pneuma-space/tool/bin/pneuma-space.mjs package` from the project root. Then run `npm run deploy`. Completion requires the CLI to report the app's actual address and release. Then check the release yourself before you report it: `node .pneuma-space/tool/bin/pneuma-space.mjs get /`, and the same with each data path you changed, such as `get api/items`, requests the live app with the project's token and prints the status and the start of the reply. `get` only reads.
4. Run `npm run bench` after a release when the starter probe remains available and the user is not using the app. It waits for natural idle as long as the app's idle policy (300 s for a new app, plus up to 90 s), performs a later request and verifies retained state. Give the command that long before any timeout, or run it in the background. Keep `/api/proof` and its per-process boot identifier until this acceptance is complete. The benchmark never issues a sleep action. If it is incomplete, resolve the specific reported cause and repeat only that failed step. Close live app tabs that generate requests before this measurement.
5. Give the user the live app link and the exact dashboard statistics link printed by the CLI. Describe what the app does, the recorded request timings including network, the platform's per-phase timings of the last wake (`wake` in the report), and, once bench completes, whether state survived natural idle. Invite the user to save and reopen an entry in the browser where they are signed into the workspace. The app is private: a browser needs the user's account login, and the project's token cannot sign a browser in. Report that boundary if browser verification reaches the login page. Do not make them read setup documentation.

Credentials stay in the ignored `.pneuma-space/` directory, never in source, logs, a URL, or chat. The deploy command packages only app/ and the manifest. A token can create and publish apps within its workspace; it cannot administer the platform, manage credentials or purge applications. Use the supplied deployment origin, not a new CF account or npm publication.

To create another independent application, use the dashboard's Create app command in a new directory. To inspect this one without waking it, run `npm run status`. Expired credentials require a new token from the product. A failed release is reported as unfinished; never fabricate a live URL or benchmark result. Natural idle releases the running instance, but platform and retained-storage charges are separate; do not claim zero total cost.

## Scheduled jobs

A job runs inside the app on a schedule, with no visitor. Declare it in `pneuma-space.json`, beside the other capabilities:

```json
"cron": {"triggers": {"digest": {"schedule": "0 6 * * *"}}}
```

Then write `app/jobs/digest.mjs`:

```js
import {native} from '../space.mjs';
export default async function ({id, attempt, payload}) {
  const saved = await native({type: 'kv.get', key: 'shelf:items'});
  // Compute from saved?.value, then store the result with native({type: 'kv.put', key, value}).
}
```

The schedule has five fields in UTC: minute, hour, day of the month, month and day of the week. `"digest": {}` declares a job that runs only on demand. `app/space.mjs` runs each delivery with the file of the same name; the `package` and deploy commands refuse a declared job without its file, and a file in `app/jobs/` without its declaration.

A run wakes the app if it sleeps. The job can use the app's stored data and the native services. It has no Internet access, so it cannot fetch anything from outside. The platform delivers each run at least once. `app/space.mjs` records a finished delivery in kv for a day, under `job:done:`, and does not run it again, so keep kv declared. A delivery that stopped partway arrives again, so write the job so that a second run does no harm, for example compute a result and overwrite it instead of appending. A job that throws is retried with growing delays, up to five attempts. An ephemeral app never runs its schedules.

`node .pneuma-space/tool/bin/pneuma-space.mjs run digest` runs the job now and prints its outcome and the app output since. `jobs` lists the declared jobs, the last 10 deliveries and the last 20 lines of app output.
