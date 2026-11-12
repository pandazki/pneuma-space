# Cloudflare verification

Run on 2026-11-12 against the private deployment. [The machine record](verification/2026-11-12.json) contains the observations. [The example README](README.md) defines the adaptation and deployment steps; the [platform app contract](../../docs/app-contract.md) remains the reference for full platform compatibility.

The tested source is `af48c40905c6502725a59349629e958269df755c`, whose tree matches the deployed revision `9f8aa89`. Cloudflare Worker version is `d2f95c3d-91d5-4a09-b13f-28d37aeb99a2`. A later verifier-only change corrects the console label from requests to observations; it changes no assertion or runtime code.

| Check | Observed result |
| --- | --- |
| Private access and cookie login | Missing authentication denied; owner login succeeded; member results and operator controls denied. |
| Identity and input boundary | Forged subject changed only the member answer; owner answer stayed unchanged. Foreign Origin and oversized answers were rejected. |
| Language preference | Chinese persisted while the HTTP request preferred English. Checked through HTTP; no visual browser check. |
| Storage scope | The foreign fixture existed, was absent from survey reads, and remained unchanged afterward. Wrong entrypoint scope returned 403; an unknown internal operation returned 404. |
| Idle stop | The container was stopped after a quiet interval with no requests. The process-age upper bound was 94.830 seconds, below its 120-second lifetime cap. |
| D1 lifecycle | Node rendered the saved choices after idle, SIGKILL and the v1-to-v2 image change. New writes succeeded after every transition. Each transition produced a new process boot identifier. |
| R2 operator path | A 54-byte fixture retained its SHA-256 digest across the lifecycle checks. The private S3 endpoint rejected unsigned access with 400, `InvalidArgument`, `Authorization`. |
| Private R2 signed transfer | Incomplete. Bucket-scoped S3 signing credentials were unavailable. |
| Browser CORS and visual behavior | Not verified. Browser automation was unavailable. |

The verifier returned exit code 2 with `lifecycle: passed` and `r2: incomplete`. Its 51 observations include 49 Worker HTTP responses and two timing records. The timing bound separates idle stop from the process lifetime cap; it is not a startup or latency benchmark.

Local checks passed: TypeScript, Worker/verifier syntax, both container image builds, the 18 Python prototype tests, and the README init/publish/login smoke flow on the existing Docker hosted stack. The smoke app was removed and purged, and its temporary CLI credential was revoked.

The S3 credential gate leaves signed upload/download, retained export hashes, method/key denial and browser CORS unverified. An R2 binding and the operator fixture do not satisfy those checks. This record establishes the adapted survey's D1 persistence, not the full SaaS acceptance suite or hostile tenant isolation.
