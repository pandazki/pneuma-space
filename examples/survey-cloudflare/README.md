# Cloudflare survey adaptation

This maintained example runs the survey in a Node container while keeping answers in D1. Its fixed `SurveyStore` operations replace the original survey's SQLite calls. The original survey and the platform app contract remain unchanged. See [the app contract](../../docs/app-contract.md) for the platform's runtime and capability rules. This example does not implement the platform SQL URL, files capability, generic runtime or provider, and it does not establish hostile tenant isolation.

The owner builds a CSV in the browser. A browser with a short-lived ticket uploads and downloads it directly from a private R2 bucket. The Worker handles export metadata and R2 HEAD only. This changes the original nightly export to an owner-initiated export. The **Download CSV locally** action works without R2 signing credentials. **Save export** and **Download saved export** report unavailable until bucket-scoped S3 signing credentials are installed.

## Resources and private configuration

The example owns one D1 database, one private R2 bucket, one named Container Durable Object and two image versions under `pneuma-space-survey-cf-20261112`. The D1 ID and names in `wrangler.jsonc` are public resource identifiers. Do not reuse the bucket for other apps. The existing account's Cloudflare plan and R2 credential permissions govern whether direct browser transfers can run. [Cloudflare's presigned URL documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) requires S3 credentials; a Worker R2 binding does not create them.

Install these Worker secrets privately with `wrangler secret put NAME`:

- `PNEUMA_SPACE_OWNER_TOKEN_HASH`, `PNEUMA_SPACE_MEMBER_TOKEN_HASH`, `PNEUMA_SPACE_OPERATOR_TOKEN_HASH`. Each is the lowercase SHA-256 hex digest of a different random 32-byte URL-safe access key. The first signs in `pandazki`, the second signs in the test member, and the third reaches only `/_pneuma-space/control/*`.
- `PNEUMA_SPACE_COOKIE_KEY`. Use at least 32 random bytes as a private string.
- `PNEUMA_SPACE_R2_ACCOUNT_ID`, `PNEUMA_SPACE_R2_ACCESS_KEY_ID`, and `PNEUMA_SPACE_R2_SECRET_ACCESS_KEY` for private browser R2 transfers. The S3 key must be scoped to this bucket. These three are optional as a group; without them, the Worker responds with an explicit unavailable state. Never put these keys in the container or browser.

`PNEUMA_SPACE_EXPIRES` and `PNEUMA_SPACE_MAX_REQUESTS` in `wrangler.jsonc` bound the trial. The current expiry is 2026-11-19 16:00 UTC. The process exits after 120 seconds, and the Container inactivity timeout is 30 seconds. The bucket needs a CORS rule for the deployed origin allowing `PUT` and `GET` with `Content-Type`. CORS allows browser transfers; the signed URL is the authorization. A PUT ticket remains reusable for 180 seconds. The demo does not promise immutable exports or unattended cleanup of incomplete uploads.

## Deploy

Use Node 24 and Wrangler 4.161.0. From this directory:

```sh
npm ci
npx wrangler types
npm run check
npx wrangler d1 execute pneuma-space-survey-cf-20261112 --remote --file schema.sql
npx wrangler d1 execute pneuma-space-survey-cf-20261112 --remote --file verify-fixture.sql
npm run build:dry-run
npx wrangler deploy
```

The operator should install secrets before `wrangler deploy`. D1 schema application is idempotent. `wrangler deploy` is a cloud write; run it only after reviewing the account, resources, expiry and private keys. The container image uses a pinned official Node digest by default. To use a cached image, set the `PNEUMA_SPACE_NODE_IMAGE` Docker build argument in both image entries of `wrangler.jsonc`.

## Real verification

Put private tokens in a local JSON file outside the repository:

```json
{"ownerToken":"...","memberToken":"...","operatorToken":"..."}
```

Then run:

```sh
PNEUMA_SPACE_VERIFY_URL=https://pneuma-space-survey-cf-20261112.ianepo.workers.dev \
PNEUMA_SPACE_VERIFY_CREDENTIALS=/private/path/keys.json \
PNEUMA_SPACE_VERIFY_EVIDENCE=/private/path/observations.json \
node verify.mjs
```

The script resets to image v1, checks private access, owner-only routes, same-origin cookie writes, language choice, forged identity, the 4 KiB answer limit and fixed internal storage scopes. The operator probe reads the known subject in the survey scope and rejects the `other` scope and unknown operation. The fixture row must be installed before verification; the owner results exclude it. The script waits without requests for an idle stop, then checks persisted choices before new writes after idle, kill and the actual v1 to v2 transition. It records boot and image identifiers. When signing credentials exist, it uploads and downloads each CSV through the R2 S3 host, checks old exports before each new one, compares SHA-256 digests, and tests altered-key, wrong-method and unsigned requests. It never writes tokens or ticket URLs to evidence. Missing signing credentials yield `r2: incomplete` and exit code 2. Failure writes partial observations with `lifecycle: failed`. A browser network trace and visual inspection require a real browser session. The Node verifier demonstrates direct R2 transfer through its own client, not browser CORS or visual behavior.

The verification script changes the owner answer and switches the single named container to v2. It leaves the D1 rows and completed exports in place. To reset this dedicated trial, an operator must separately review and remove its resources. No automatic purge is included.
