# Verification record

Two real deployments back this record. The author's private deployment passed the cloud API, runtime and first-application checks below on 2026-11-13 UTC (2026-11-14 in Shanghai). A second, disposable deployment in the same account under another domain was installed from these files on 2026-11-24 by a developer with no knowledge of the first; that run is described at the end. The browser now connects through the owner’s existing session. This is not a claim that every [acceptance gate](acceptance.md) is complete.

| Evidence | Result |
| --- | --- |
| Identity and access | Real D1 login, concurrent invitation redemption, tenant boundaries, scoped token revocation, account disable, last-admin protection, exact Origin/CSRF and one-use app grants pass. |
| Publication and HTTPS | CLI/API direct R2 publication, exact app certificates, static HEAD/Range without a container, Node startup, idempotent retry, invalid package refusal, failed-startup recovery and rollback pass. Console publication awaits browser verification. |
| Persistent native data | SQL/KV/files retain their contents through idle, Container kill, restart and replacement. Concurrent first requests cause one wake. A retired cloud Container cannot write during its drain interval. CAS and increments are atomic; hidden platform SQL is refused. |
| Object storage | Actual signed PUT/GET byte equality, unsigned/wrong-key denial and CORS preflight pass. Final purge waits for outstanding signed upload expiry and removes application objects, artifacts and domain bindings. |
| Runtime and jobs | Incremental SSE, Node WebSocket echo, two native KV subscribers, scheduled delivery without browser traffic, idempotent manual jobs, retry success and terminal failure pass. Removal cancels active jobs and future schedules. |
| Limits and credentials | Cross-tenant and undeclared capability access fail. Concurrent application creation, file and SQL-result limits hold. Exhausting one app's requests leaves another tenant's app and the control API usable. Diagnostic polling leaves idle Containers asleep. Guest identity is trusted and its environment contains no CF credentials. |
| TURN | Ephemeral credentials issued by the deployed app relay packets over UDP and TLS/TCP 443. Each run sends and receives six packets. Browser data-channel interaction remains unverified. |
| Console HTTP routes | Owner receives /admin and /dashboard; an ordinary tenant receives /dashboard and is denied /admin. JavaScript and CSS return successfully. HTTP results do not establish rendering or working UI actions. |
| First application (CF-21) | A separate fresh Codex CLI session ran the copied product command in a temporary directory, with no repository context or implementation hints. Scaffold, project skills, direct R2 publication and live HTTPS passed. A real npm bin-symlink defect found on the first attempt was fixed and covered by a regression test. The second attempt used its own npm cache; its model-command transcript stayed within the prescribed files. This is context separation and transcript auditing, not a claim of physical read isolation. |
| Natural recovery (CF-22) | The fresh Codex run recorded five warm requests (median 389 ms), natural idle, a new process on access, a retained marker and zero request errors. The recovery request took 1,681 ms including network. A separate real-cloud run retained an edited and archived collection through another natural idle cycle, rejected a stale revision and kept the same release on unchanged publication. Five saved entries occupied 1,118 JSON bytes in that run. |
| First-application browser UI | The owner session generated a limited publishing token and successfully copied the agent instruction. Actual app UI add, archive, restore and reload passed. The app, creation page and usage page were inspected at desktop and mobile sizes; no document overflow was observed at 390 px. Chinese/dark and English/light console views were checked. Usage displayed real requests, wakes, sleeps and asleep state. These checks do not cover every console action. |
| Local engine and runner | TypeScript, all 67 tests including four real Linux amd64 Docker cases, and Wrangler dry run passed. The final SQL-error change passed TypeScript and 63 engine tests; four unchanged Docker cases were skipped in that rerun. |
| Original platform | README isolate initialization, Compose startup, CLI publish and application HTTP response pass in an isolated test stack. The stack is stopped and its volumes retained. All 18 Python prototype tests pass. |

Earlier browser-host failures were resolved by the currently available Browser skill and the owner’s signed-in browser. The blind Codex trial had no browser login and correctly could not complete visual acceptance; the parent subsequently verified the app UI separately. The login prerequisite is now explicit in the copied instruction, CLI output and generated skill. Full CF-17, manual browser upload, administrative actions and typed purge remain unverified in the browser; API checks are not substituted for them.

The retained user apps are the original notebook (release 4, daily heartbeat) and little-shelf (release 1), created by the fresh Codex run. Disposable acceptance applications and their domains are removed, the UI-only test token is revoked, and the ordinary QA account is disabled. The limited token in the retained starter project remains available for later edits.

Detailed cloud records are in the ignored .audit directory: cf-identity-verification.json, cf-cloud-verify.log, cf-notebook-verification.json, cf-publication-verification.json, cf-runtime-verification.json, cf-boundary-verification.json, cf-turn-verification.json and cf-page-http-verification.json. Local logs use cf-final-* and cf-sql-*. The first upload activated its Worker but timed out applying Container settings; the documented deploy retry completed successfully. Credentials stay in private files outside tracked source.

The console was refined from a user-supplied production screenshot on 2026-11-13: capacity comparisons replace raw metadata tiles, details use bounded text, and mobile navigation and theme controls remain reachable. JavaScript/CSS parsing, TypeScript and 63 tests passed, with four unchanged Docker cases skipped. The checked text/button color pairs exceed 4.5:1 by calculation. The later first-application browser checks above establish rendering for their stated pages only.

The final onboarding change passed TypeScript and 66 tests; four unchanged Docker cases were skipped. The current portable CLI is `/downloads/pneuma-space-cli-0.1.0-1e742eb32da9.tgz` (16,021 bytes). Its npx entrypoint and delivered console asset hashes were verified after deployment. Additional records: cf-starter-live-verification.json, cf-first-app-cleanup.json, cf-first-app-domains.json, cf-ui-delivery-verification.json and the redacted first-user-feedback.md. Browser screenshots use little-shelf-*, create-app-desktop.jpg, create-app-handoff-desktop.jpg and create-app-mobile.jpg.

## Fresh install by an outside developer (2026-11-24)

A developer persona holding only these files, a logged-in Wrangler and one subdomain installed a new deployment beside the first and published the starter app. The control domain served HTTPS and redirected an unauthenticated visitor to /login. After publication, a saved entry was read back from a new session; an unauthenticated API request answered 401. Every resource of that deployment was deleted afterwards and the account inventory matched its baseline.

The run needed what the files did not provide:

- The developer rewrote the names, domains and resource IDs that were then hard-coded in wrangler.jsonc, the artifact CORS file and the starter template. Those are placeholders now.
- Wrangler's OAuth login cannot create the long-lived API token or the R2 signing credentials the Worker needs. The account owner created one account token (Workers Scripts Write and Workers R2 Storage Write) by hand. The R2 access key ID is that token's ID and the secret is the SHA-256 of its value.
- `secrets.required` lists both TURN secrets, so a deployment without TURN supplies empty values.
- Deployment succeeded on the third attempt; the first two stopped while pulling the base image and while polling container image preparation.
- Without a browser, the first publishing token came from a script against the control API.
- The first app's certificate took longer than the CLI's ten-minute wait. The CLI exited 1; publishing again succeeded.

Not covered by that run: natural idle recovery, browser rendering, TURN and billing.

## Installer (2026-11-24)

`scripts/install.mjs` replaces the manual deployment steps. A real install into an account that already held another deployment of this plane:

- The first run without a token resolved the account and zone, printed the link and the token path, and made only read calls. The account owner created the token from that link; the token then passed verification, Worker listing and R2 calls. Whether the dashboard form opened with both permissions preselected was not recorded.
- The second run finished in one pass with exit 0: it created the D1 database and both buckets, applied the schema, provisioned the owner, deployed on the first attempt, attached the control domain and saw the health endpoint over valid HTTPS.
- Afterwards the control origin redirected an unauthenticated visitor to /login, /api/v1/me answered 401, and the owner credentials signed in. The state directory was 0700 and its four files 0600. Nothing in the repository changed. The other deployment kept its version.
- Running the same command again exited 0 and created and attached nothing. Running it with another prefix was refused.
- An app published with the owner credentials uploaded its package through a URL signed with the derived R2 credentials, got its exact domain, redirected an unauthenticated visitor and answered 401 to an unauthenticated API call. Signed in, its page loaded.
- That app's first API request, its first wake on the new deployment, answered 500 `internal`; the same request succeeded seconds later and on every retry. The cause is not established.
- An example that declares `rtc` was refused with `rtc_unconfigured`, as specified for a deployment without TURN.

Also verified without an account: eight CF-23 engine tests against a simulated account (the token stop changes nothing, a rerun creates nothing, generated files are private and limited to the state directory, taken names are refused, a failed deploy is retried, a foreign domain binding is kept, the generated config and the derived secrets are as specified), and `wrangler deploy --dry-run` with a config generated outside the repository. The link format follows Cloudflare's [token template URL documentation](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).

Not verified: a deploy that fails and is retried against the real service, an install interrupted midway, an account with several memberships, and an apps domain other than the control domain.

Of the stumbles above, the installer removes the hand-edited names, the hand-built secrets, the required TURN values and the manual deploy retry. The token remains the one manual step (ADR 0041). The browser-less publishing token and the CLI certificate wait belong to publishing, not installation.

## Path routing (2026-11-24)

[ADR 0044](../../docs/adr/0044-cloudflare-path-routing.md) moved every app from its own Custom Domain to `/apps/NAME/` on the control origin and removed the app session and grant exchange. The results above that mention exact app domains, certificates, app grants or domain cleanup describe that earlier addressing and say nothing about the current one.

The change passed TypeScript, 84 engine tests with the four Docker cases skipped, and `wrangler deploy --dry-run`. The installer then upgraded a real per-app-domain deployment in one run:

- It removed the account token from the Worker's secrets. The control origin kept answering; the workers.dev hostname and a former app hostname answered 404.
- A newly published starter app answered at `/apps/NAME/` immediately, with no certificate wait. Signed in, its page and its API answered 200 on the first request, served by Node under the prefix. Its assets are relative.
- Unauthenticated: an HTML navigation redirected to `/login?next=`, an API call answered 401, and the path without the trailing slash answered 308.
- A cookie-authenticated write without an `Origin` answered 403; with the control origin it reached the app.
- An app published before the change resolved by name. Its page loaded but still references assets from the root, as the ADR predicts, until it is republished.
- With two apps awake, a third answered 503 `compute_quota` until one slept. The tenant's running-app limit is unchanged by this work.

Not verified on Cloudflare: WebSockets, SSE and native subscriptions under the prefix, the pages in a browser, the notebook example and `npm run verify`.

## First screen and request path (2026-11-24)

[ADR 0045](../../docs/adr/0045-cloudflare-first-screen-and-idle.md), deployed to a real instance and measured from one client whose requests entered at a US west location while the D1 database runs in APAC. Times are after the TLS handshake on a fresh connection, which itself took about 0.3 s; the health endpoint, which touches nothing, took about 0.28 s.

- The starter published from the new template answered its page, stylesheet and script from R2 without a wake. `/style.css` at the root answered 404 and the console's stylesheet answered at its reserved path. A new app's policy showed 300 idle seconds.
- One recorded wake: reserve 531 ms, container 3,715 ms, fetch 497 ms, unpack 12 ms, listen 326 ms, confirm 118 ms. Container start is most of a cold start.
- Before the request path was shortened, a static file took about 1.3 s and a warm API call about 1.3 s. `Server-Timing` showed nine serial calls: two D1 reads to authenticate and find the app, two more to authorize, a D1 write for the daily quota, the app object's state, and an R2 head then get. Each D1 call cost about 120 ms and each R2 call about 200 ms.
- After: the app row is read while the session is checked, the app object's state and the permission check run together, the quota write runs beside the static read, and a plain GET reads R2 once. A static file took about 0.57 s and a warm API call about 0.7 s. Unauthenticated requests still answered 401 and an unknown app 404.

Not verified: the first screen in a browser on the real instance, a client entering near the database, and the cost of the static probe on API paths, which still spends one R2 read (about 200 ms) before Node is asked.

## Ephemeral and managed apps (2026-11-25)

[ADR 0046](../../docs/adr/0046-cloudflare-ephemeral-and-managed-apps.md) brings ephemeral and managed apps to this plane. The local checks came first; the upgrade and the API paths below were then run on a real account.

What passed locally: TypeScript, and 140 engine tests with the four Docker cases skipped, 46 of them new for CF-23, CF-29 and CF-30. Expiry ran on Miniflare's Durable Object alarm, a failed directory write as a D1 trigger, and the column upgrade on SQLite through `node:sqlite`; The console was rendered against a local Miniflare instance in headless Chrome at 1440 and 390 px in Chinese and English, the ephemeral app's page in dark and the rest in light: cards and the project head show the ephemeral mark, end time and manager, usage shows the ephemeral quota, no page overflowed horizontally, and a managed remove went through only after the manager's name was typed. Publish, rollback, resume, policy and discard approvals were not driven in the browser.

On a real account, an installed deployment with five apps was upgraded by rerunning the installer from this change:

- The installer finished on its first run. D1 gained `tenants.ephemeral_limit` and `apps.expires_at`, `manager_name` and `manager_url`; the existing space kept 50 MiB of storage and got an ephemeral limit of 3; the five existing apps were listed as before.
- With five durable apps holding all 50 MiB, creating an ephemeral app answered 409 `ephemeral_quota`. After the space was raised to 80 MiB it was created.
- An ephemeral app published with a TTL of 200 s returned its `expiresAt`. A release that stated the durable kind answered 409 `kind`, and a TTL of 7200 s answered 400 `ttl`.
- With no caller it ended in the second of its `expiresAt`: the audit has `app.expire` `started` and `ok` by `platform` in that second, and it left the list.
- A second ephemeral app was discarded right after its publish. The answer was `purging` with a `retryAt` about three minutes later, usage showed one ephemeral app in use while two existed, and after that time it left the list. Storage in use then matched the remaining durable apps.
- A managed app refused a release, `remove` and clearing the manager without its name with 409 `managed`, and took `sleep` without it. With the name, `remove`, `resume` and clearing the manager succeeded and the audit carries `namedManager`. After the clearing, `remove` and `purge` needed no name.

Not verified on Cloudflare: an expiry while D1 refuses writes and a failed purge that resumes; both need a fault inside Cloudflare. The other gaps of this run were closed on a fresh install, below.

## Ephemeral and managed apps on a fresh install (2026-11-25)

A second deployment in the same account, freshly installed from this change, with no apps and the default quotas (80 MiB, 5 apps, 3 ephemeral, 2 awake):

- `npm run verify` passed its eight checks and revoked its two tokens. Its two purges answered `pending`, due about two and five minutes later; 5 s after the later time neither app was listed.
- A managed app refused `rollback` and `policy` without the manager's name with 409 `managed` and changed nothing; with the name both succeeded. An app both ephemeral and managed refused `discard` the same way and with the name answered `purging`. All three audit rows carry `namedManager`.
- Sent as raw HTTP, a malformed `X-Pneuma-Space-Manager` (`Deployer`) and the valid header sent twice each answered 400 `manager_header`, on a managed and on an unmanaged app, and changed nothing. The header sent once on the same path answered 200.
- With three live ephemeral apps, a fourth answered 409 `ephemeral_quota` with 40 of 80 MiB reserved. Discarding one left it `purging`; usage showed two ephemeral apps while storage still counted it, and a fourth was created 2 s later. A fifth then answered 409 `ephemeral_quota` with 50 MiB reserved.
- An ephemeral app published with a TTL of 240 s ended with no caller: `app.expire` `started` by `platform` 34 ms after its `expiresAt` and `ok` 1.5 s later, and it left the list.
- Headless Chrome signed in as the owner, at 1440 and 390 px in Chinese and English, light theme: the project list showed the ephemeral mark with its end time and the manager's name with its url as the tooltip; the managed app's page showed the manager as a link to that url; usage showed 3 / 3 ephemeral projects; no page overflowed horizontally. A policy change on the managed app opened an approval naming the manager whose Continue stayed disabled while the field was empty or held `deploye` and enabled at `deployer`; the policy changed and the four changes were audited with `namedManager`.
- Every app was then discarded, or removed and purged with the manager's name after both answered 409 without it. The space held no apps and no reserved storage.

Not verified: the publish, rollback, resume and discard approvals in the browser, and the dark theme on the real deployment.

## Data location (2026-11-26)

[ADR 0047](../../docs/adr/0047-cloudflare-data-location.md), run on the deployment measured in the open-path study: D1 and both buckets in APAC, requests from the operator's machine in Japan entering at SJC or SEA, where the Worker and the apps' Durable Objects run. Two apps of the owner, both managed by the governance Host, and no other live app.

Before: no app purging, no ephemeral app, no upload ticket outstanding, no compute held. D1 held 1 user, 1 tenant, 100 apps (98 purged), 179 uploads, 312 sessions, 551 audit rows; the artifacts bucket 66 objects, the objects bucket none. The owner's apps were at release 10 (KV, 2 keys) and release 5 (SQL, one table of 5 rows), and each opened signed in. The plane shows no governance version, only the manager's name.

- The plain rerun of the installer recorded the existing data as APAC and printed: requests from this machine enter at SJC (wnam), the data is in apac, and the `--relocate wnam` command. It moved nothing.
- `--relocate wnam` without `--yes` printed the plan and changed nothing. With `--yes` it finished in one run of 81 s: it created the database and buckets, which Cloudflare reported in WNAM, copied 66 objects and every row, verified 12 tables, 66 objects and every artifact's SHA-256, redeployed, and appended nothing because nothing had reached the old data. None of the steps the local tests could not cover stopped it: reading `sqlite_master`, importing with `PRAGMA defer_foreign_keys`, the installer's own SigV4 requests to R2, and D1's `running_in_region`.
- After the switch, the old database's row counts stayed as at the copy while the new one gained the sessions signed in since. Every one of the 551 audit rows was in the new database unchanged; an `UPDATE` and a `DELETE` on one of them were refused by its triggers and the count stayed 551. Listed through the S3 API, both artifacts buckets held the same 66 keys, sizes and ETags. `wrangler r2 bucket info` lags: right after the copy it reported 132 objects in the old bucket and none in the new.
- The owner's apps kept their releases and their data digests. In headless Chrome signed in as the owner each showed its entries (3 and 5). An item added through the todo page was still listed after a reload. The page has no delete and its API answers 405 to one, so the item left by writing back the KV value read before through the owner's data command: the values match, one key's revision went from 6 to 8.
- The same owner credentials signed in, and the console listed both apps.
- The governance Host, with the token it holds: its owner signed in under a pseudo-terminal, created an agent token, and with it `create` published a test app in 17 s and an ordinary change went live as v2 in 15 s, a durable app managed by `appgov` whose page carried the change. The test app was then removed and purged with the manager's name, its previews had ended, the token was revoked and the owner signed out. The Host's own Worker, bucket and secrets were not touched; its record of the test app stays in its bucket.

The open-path study's measurements, repeated the same way from the same machine (medians in ms; browser runs in a fresh context each, signed in; before: 2026-11-26 03:15 to 03:45, after: 04:49 to 05:12; "data" is the end of the page's first API call, owner "asleep" before is one sample):

| Measurement | Before | After |
| --- | --- | --- |
| Starter awake, first visit: data | 1724 | 1397 |
| Starter awake, reload: data | 1618 | 1152 |
| Starter asleep: data | 4096 | 2499 |
| Ten assets, first visit / reload: last asset | 1424 / 2203 | 959 / 1225 |
| todo-list asleep / awake: data | 6202 / 2001 | 3343 / 1625 |
| reading-journal asleep / awake: data | 4107 / 1893 | 3089 / 1314 |
| Console dashboard / app page: first paint | 746 / 720 | 528 / 536 |
| Console dashboard / app page: regions filled | 2001 / 1811 | 2081 / 2032 |
| Warm `/api/v1/me`, token / session | 359 / 364 | 213 / 179 |
| Warm static file: R2 read beside the request count write | 192 | 57 |
| Warm static file, token: app state beside the membership read | 113 | 24 |
| Warm static file: the app's admission | 23 | 56 |
| Warm API call: the app's container | 103 | 170 |
| Wake: compute reservation / package fetch | 491 / 312 | 156 / 153 |

The warm rows are one keep-alive connection entering at SJC both times; a health request that touches nothing took 126 and 124. The wake row is the median over the starter apps' wakes (7 before, 8 after). The admission, a call to the app's Durable Object, and the container step depend on where each app's object and container landed, not on the data: in the browser runs the admission took 62 on this run's starter and 22 on its ten-asset sibling, against 24 and 55 for the study's two. Every request still crosses the Pacific once each way between the browser and the entry, about 120 ms per round trip, and an open makes three in a row (page, assets, API). Behind the entry no D1, R2 or Durable Object step took as long as a trans-Pacific round trip; the slowest, the todo-list object's admission, took 81 ms before and 84 after. Where Cloudflare runs the containers was not observed.

An hour after the switch the old database and buckets still held exactly what was copied (551 audit rows, 314 sessions, 66 artifacts with the same key, size and ETag digest), and all 551 audit rows were in the new database unchanged, which by then also held the owner's own activity. `--remove-previous` found the deployed Worker bound to the new database and buckets alone, appended nothing, deleted the 66 objects, both old buckets and the old database in 14 s, and did not redeploy. Wrangler then listed only the new database and buckets, and the current version binds only them.

Not verified: a move while apps are used, an upload in flight across the switch, a client entering outside western North America, and where Cloudflare runs the containers.

## Open and release paths after the move (2026-11-26)

The release-path change (the package copy and the static files written at once, the package read once) and the open-path change (`If-None-Match` compared weakly, a compute slot reserved in one D1 round trip, readiness polled every 50 ms), deployed by a plain rerun of the installer from `main` over the relocated deployment of the previous section. Three apps of the owner, all managed by the governance Host; the owner was using the deployment, and their apps were asleep at each check.

Before: no app purging or waking, no ephemeral app, no upload ticket outstanding.

- The rerun recorded the data as wnam, printed that requests from this machine enter at SJC (wnam), where the Worker runs, and printed no relocation command. It created no database, bucket or secret: the schema's 17 statements and the column check wrote no rows, the container image was already in Cloudflare's registry and was not pushed, and the Worker deployed bound to the same database and buckets.
- Afterwards the owner's three apps were listed at the same releases (10, 10 and 5) and each page answered signed in.
- Reloading the ten-asset page, all 60 asset requests (6 reloads of 10) came back without a body: Chrome's Resource Timing reports each with status 200 and a 300-byte transfer, where before the move and after it each carried the full body. Asked directly, a stylesheet, a script and an image each answered 304 without a body to its weak ETag and to the strong form, and 200 with the body to another ETag.

The same measurements as in the previous section, from the same machine (medians in ms; browser runs in a fresh context each, signed in; this deploy's runs 05:58 to 06:10, entering at SJC and SEA; "data" is the end of the page's first API call):

| Measurement | Before the move | After the move | After this deploy |
| --- | --- | --- | --- |
| Ten assets, reload: assets answered without a body | 0 of 60 | 0 of 60 | 60 of 60 |
| Ten assets, reload: last asset | 2203 | 1225 | 1237 |
| Starter awake, first visit: data | 1724 | 1397 | 1174 |
| Starter awake, reload: data | 1618 | 1152 | 1074 |
| Starter asleep: data | 4096 | 2499 | 2581 |
| Wake: compute reservation / readiness confirmed | 491 / 202 | 156 / 108 | 114 / 68 |
| Wake: container start / runner listening | 1022 / 275 | 627 / 165 | 812 / 279 |
| `POST /releases`, Node app, first release (s) | 8.3 | 3.3 | 2.5 |
| `POST /releases`, Node app, while awake (s) | 9.9 | 3.7 | 3.5 |
| `POST /releases`, static-only app (s) | 5.9 | 1.7 | 0.9 |

The release rows before the move are the release study's medians over 32 releases; the other release cells are three releases each. The wake rows are the starter apps' wakes (7, 8 and 7).

A 304 saves the body, not the time: each revalidation still passes the credential check, the app's state, the R2 read beside the request count write (54) and the admission (40), and these assets are 0.1 to 2.7 KB, so the reload took as long as after the move. The reservation and the confirmation together took about 80 less per wake. The asleep open did not get faster because the container start and the runner's listen took about 300 longer this time (680 to 1179 against 580 to 710 for the container start); both happen in Cloudflare's container and the app's runner, which neither change touches, so this is read as placement, not as the change (inferred). The awake starter's first visit lies within the spread of runs on different apps (1120 to 1419 against 1281 to 1557), and is not attributed to either change. The release change took 0.8 s off a first release, 0.2 s off a release while awake and 0.7 s off a static-only one. It was expected to save about 2.8 s when each of the R2 writes it now makes at once cost about 0.65 s across the Pacific; with the data in wnam those writes cost little, so less was left to save (inferred).

Not verified: an ephemeral release, an app with more static files, where the parallel writes should matter most, and a browser keeping its cache across sessions.

## Wake without static files (2026-11-27)

A developer suspected that a wake also fetched and unpacked the static directory. It did: the runner fetched the whole package, every file in base64, and wrote every file to disk. Since [ADR 0050](../../docs/adr/0050-cloudflare-code-only-boot-package.md) a Node release with a static directory boots a package of its other files. The runs below are on the deployment of the two previous sections, from the operator's machine in Japan entering at SEA, between 01:03 and 01:22 JST, made with `node scripts/bench-wake.mjs`.

The script publishes one release of a minimal Node app per package size into one ephemeral app; the rest of each package is random static files of at most 512 KiB. Each cycle rolls back to a size, which wakes the app once during publication, then sleeps the app and wakes it with one GET that reaches Node. The order rotates each round, for 8 rounds. A wake counts only when the reply is 200 with a new process id and the app's last wake is new and `ready`; every wake counted, before and after. An ephemeral app wakes through the same `Runtime.acquire` as a durable one, and the owner's durable slots were full. Before and after are two apps, so their containers may have landed in different places.

Medians in ms; fetch and unpack over 16 wakes per cell (8 by request, 8 by publication), the client's time over the 8 by request:

| Package | Fetch + unpack, before | After | Unpack, before | After | Client, before | After |
| --- | --- | --- | --- | --- | --- | --- |
| 0.03 MiB | 122 | 137 | 5 | 3 | 1339 | 1370 |
| 1.0 MiB | 196 | 124 | 56 | 4 | 1535 | 1331 |
| 2.4 MiB | 339 | 120 | 153 | 4 | 1559 | 1361 |
| 3.9 MiB | 375 | 118 | 167 | 3 | 1598 | 1366 |

- Before, fetch and unpack grew 70 ms per MiB of package, about 90 ms per MiB of static files, and the client's time grew with them. At 2.4 MiB that is 0.2 s, about a third of the developer's estimate. A second app measured just before the deploy grew 111 ms per MiB. The same 3.9 MiB package unpacks in 25 ms on the operator's machine against 167 ms on the container's `lite` instance, so unpack is limited by the container's CPU (inferred). After, the growth is -3 ms per MiB: none.
- The small app shows no measurable difference: 122 and 137 ms for fetch and unpack (rank-sum p 0.43), 1339 and 1370 ms for the client (p 0.09). The 31 ms between the client medians lie in the compute reservation, the container start, the fetch and the network, none of which the change touches; its runner now receives 0.5 KB instead of 30 KB.
- An app published just before the deploy, with releases at 0.03 and 3.9 MiB, was rolled back between them after it: 10 of 10 wakes were ready, and they still boot the whole package (fetch and unpack 217 and 771 ms on that app's slower placement).
- The owner's five apps, all published before the deploy, each woke `ready` after it when opened; they boot their whole package until they are republished. The largest, a 2.4 MB package, spent 256 ms fetching and 539 ms unpacking. Opening them one after another exposed a defect that predates this change ([#67](https://github.com/pandazki/pneuma-space/issues/67)): while two apps of the space were awake, a wake refused with 503 `compute_quota` counted as a startup failure, and the opening client's retries quarantined two apps after five refusals each. They were unquarantined, then each was opened once when a slot was free, and each was returned to asleep.

Not verified: an app whose server reads its static directory (none was found in the repository, the agent-app-governance template or the 7 CF Node projects on the operator's machine), the Docker runner tests (the runner did not change), and a wake from a browser.

## Runner image rollout (2026-11-27)

A deploy that changes `cf/runner/` pushes a new container image. The first such deploy, of the runner that reports an app's exit ([ADR 0053](../../docs/adr/0053-cloudflare-runner-reports-app-exit.md)), made healthy wakes slower, and it was rolled back after 35 minutes. This run measured how long a new runner image keeps wakes slow.

Each sample is one run of `node scripts/bench-wake.mjs --sizes 30000 --rounds 12`: a fresh ephemeral app with a 0.03 MiB Node package, put to sleep and woken by one request 12 times, then discarded. There were two samples on the old image. Then `origin/main` at `e14e0ad` was deployed at 18:35 UTC by a plain installer rerun, and a sample followed every 15 minutes for 3 hours. The new image had already been pushed at 17:49 by the trial deploy and had run until 18:22, so the installer skipped the push. "Fast" counts the wakes whose app listened within 175 ms; every wake on the old image did, at 157 to 172 ms.

Medians in ms, times in UTC on 2026-11-26:

| Time | Minutes after deploy | Image | Client | Reserve | Container | Fetch | Listen | Confirm | Fast |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 18:32 | before | old | 1394 | 131 | 495 | 105 | 163 | 41 | 12 of 12 |
| 18:33 | before | old | 1347 | 120 | 521 | 101 | 161 | 38 | 12 of 12 |
| 18:35 | 0 | new | 1616 | 103 | 758 | 133 | 222 | 45 | 0 of 12 |
| 18:50 | 15 | new | 1698 | 120 | 734 | 144 | 225 | 30 | 0 of 12 |
| 19:06 | 30 | new | 1906 | 99 | 943 | 163 | 299 | 54 | 0 of 12 |
| 19:21 | 45 | new | 1892 | 132 | 814 | 155 | 271 | 36 | 1 of 12 |
| 19:36 | 60 | new | 1582 | 125 | 667 | 156 | 221 | 40 | 3 of 12 |
| 19:51 | 75 | new | 1846 | 105 | 851 | 176 | 273 | 43 | 0 of 12 |
| 20:06 | 90 | new | 1666 | 93 | 757 | 174 | 274 | 34 | 0 of 12 |
| 20:21 | 105 | new | 1775 | 148 | 748 | 171 | 269 | 40 | 0 of 12 |
| 20:36 | 120 | new | 1821 | 124 | 795 | 135 | 271 | 41 | 0 of 12 |
| 20:51 | 135 | new | 1493 | 118 | 667 | 117 | 214 | 44 | 5 of 12 |
| 21:06 | 150 | new | 1542 | 88 | 687 | 139 | 221 | 32 | 4 of 12 |
| 21:21 | 165 | new | 1525 | 134 | 667 | 122 | 219 | 46 | 0 of 12 |
| 21:36 | 181 | new | 1834 | 131 | 778 | 144 | 274 | 33 | 0 of 12 |
| 21:42 | 187 | new | 1484 | 103 | 660 | 126 | 220 | 41 | 0 of 12 |

- The cost did not end within 3 hours. The median client time stayed at 1.49 to 1.91 s, against 1.35 to 1.39 s before, so a wake took 100 to 560 ms longer.
- The slow phases run inside the container: the container start (150 to 450 ms more), the package fetch (10 to 75 ms more) and the app's listen (50 to 140 ms more). The compute reservation and the readiness confirmation, which the AppCell measures on its own side, did not change.
- The runner's code is not the cause. On a healthy wake the new runner differs only by one field in its readiness report, and ten interleaved local runs of each image took 1761 and 1762 ms. On the deployment the images alternated within 15 minutes with the same result each time: new at 18:20 (1636 ms), old at 18:23 (1332 ms) and at 18:32 (1394 ms), new at 18:35 (1616 ms).
- All 48 wakes measured on the old image that day listened within 157 to 172 ms. Only 13 of 168 wakes on the new image did. The others fell into groups near 220, 270 and 340 ms. The groups are the runner's own steps: it asks the app's port every 50 ms, so a listen time is a whole number of steps, and an app that needs a few ms more than three steps is reported one step later. The share of fast wakes rose to 5 of 12 at 135 minutes and fell back to 0 of 12 by 180, so it shows no steady trend.
- The old image has been this slow too. With no image change, the runs of [Open and release paths after the move](#open-and-release-paths-after-the-move-2026-11-26) measured a container start of 812 ms and a listen of 279 ms, against 627 and 165 ms the run before. So the slow range is not new with this image; what is new is that this image has not left it.
- During the slow period, an app published on the old image woke on the new one in 1.7 s. An app that exits at startup answered 503 `startup` after 2.7 s, held its compute slot about 1.8 s and counted the failure. 25 on-demand runs of one job left the newest 20 in a listing of 20.

This is one rollout of one image. It was not rolled back: a wake still takes under 2 s, the runner change ends a wake at once when the app exits, and a rollback would meet the same question at the next runner change. Not known: why the same container work takes longer at some times and on this image, whether the cost ends after more hours or more wakes, and whether a new image always meets it. The old image, pushed on 2026-11-25, was not measured in its first hours.
