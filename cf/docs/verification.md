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
