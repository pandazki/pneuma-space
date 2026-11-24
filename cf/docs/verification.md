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

- The developer rewrote the names, domains and resource IDs that were then hard-coded in wrangler.jsonc, the artifact CORS file and the starter template. Those are placeholders now; nothing installs them yet.
- Wrangler's OAuth login cannot create the long-lived API token or the R2 signing credentials the Worker needs. The account owner created one account token (Workers Scripts Write and Workers R2 Storage Write) by hand. The R2 access key ID is that token's ID and the secret is the SHA-256 of its value.
- `secrets.required` lists both TURN secrets, so a deployment without TURN supplies empty values.
- Deployment succeeded on the third attempt; the first two stopped while pulling the base image and while polling container image preparation.
- Without a browser, the first publishing token came from a script against the control API.
- The first app's certificate took longer than the CLI's ten-minute wait. The CLI exited 1; publishing again succeeded.

Not covered by that run: natural idle recovery, browser rendering, TURN and billing.
