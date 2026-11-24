# Cloudflare acceptance

These gates require the deployed CF edition. Local engine checks cannot prove Container, DNS, TLS, browser, R2 CORS or TURN behavior. Use disposable test applications for destructive checks.

| ID | Required behavior |
| --- | --- |
| CF-01 | Owner login reaches /admin; ordinary login reaches /dashboard. Unknown keys fail; no public signup. |
| CF-02 | Invite redemption is once-only under concurrency; expired/revoked invites fail. |
| CF-03 | Tenant cannot read platform APIs or another tenant's apps/data/static/realtime. |
| CF-04 | Origin/CSRF, one-use origin/app/nonce grants and logout revocation work. Guest receives no platform credentials or forged identity. |
| CF-05 | Tokens enforce tenant/app/action, expiry/revocation and cannot manage accounts/credentials or purge. |
| CF-06 | Console and CLI/API publish a Node package uploaded directly to R2. Exact app HTTPS works. Static publication starts no container. |
| CF-07 | Invalid paths/manifest/digest and failed startup preserve prior working release. Retry creates no duplicate release. |
| CF-08 | SQL/KV/files survive idle, kill, restart and release. SQL cannot read/write hidden platform KV. |
| CF-09 | Old generation/boot writes fail after retirement; concurrent first requests start one container. |
| CF-10 | Remove retains data and denies access; resume restores it. Purge is removed-only, typed, terminal and detaches the app domain; reused name gets new AppId. |
| CF-11 | Direct R2 PUT/GET matches hashes, denies unsigned/wrong-key access, passes CORS; final purge waits old ticket expiry. |
| CF-12 | Static HEAD/Range, streaming/SSE and WebSocket exchange work with documented lease/drain deadlines. |
| CF-13 | Schedules fire without browser traffic; manual jobs persist IDs/retries/failures and stop after removal. |
| CF-14 | KV CAS/increment are atomic; two authorized subscribers receive publish; undeclared capabilities fail. |
| CF-15 | Projects/versions/data/logs/events/usage/jobs/team/credentials/resources display actual state and working actions. |
| CF-16 | Account disable, invite revoke, membership, quotas and last-admin protection work server-side. |
| CF-17 | Browser verifies Chinese/English, light/dark, 1440/390px, accessible controls and typed purge on both consoles. |
| CF-18 | Actual TURN credentials establish a relay; master key stays private; unconfigured service is honest. |
| CF-19 | Service needs no local server. |
| CF-20 | Quotas and body/result/file limits refuse excess without stopping other apps/control. Diagnostics do not keep idle containers running. |
| CF-21 | The primary tenant flow creates a read/publish/invoke token and copies one command. A clean directory can run that command without the platform repository or CF credentials, receive project instructions and skills, publish an interactive durable demo, and obtain its app and dashboard links. Repeating setup preserves user files; credentials and instruction files never enter its package. |
| CF-22 | The starter benchmark reports real request timings and counter deltas, waits for natural idle without a sleep action, verifies a new boot and retained data after access, and links to the app's actual dashboard usage. Incomplete idle verification is reported as incomplete. |
| CF-23 | One command given a control domain and a prefix installs from the repository. Without a saved API token it prints a prefilled create-token link and changes nothing in the account. A first install refuses resource names the account already has. Generated configuration and credentials stay in a private directory outside the repository. Rerunning after an interruption resumes without creating anything twice. It ends with the control origin answering over valid HTTPS and owner credentials that sign in. |
