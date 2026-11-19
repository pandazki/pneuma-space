# Cloudflare verification

Run on 2026-11-13 against the private deployment. [The machine record](verification/2026-11-13.json) contains the observations. The [initial D1-only record](verification/2026-11-12.json) remains available. [The example README](README.md) defines the adaptation and deployment steps; the [platform app contract](../../docs/app-contract.md) remains the reference for full platform compatibility.

The tested source is `3ee9dbb110707882f62bf9af5bac9c7590d46137`. Cloudflare Worker version is `c19ff9db-de4f-4fb7-a67c-b72b3b697cd4`. Runtime code is unchanged from the initial run; this run installs bucket-scoped R2 signing secrets obtained through the operator's authorized CLI session.

| Check | Observed result |
| --- | --- |
| Private access and cookie login | Missing authentication denied; owner login succeeded; member results and operator controls denied. |
| Identity and input boundary | Forged subject changed only the member answer; owner answer stayed unchanged. Foreign Origin and oversized answers were rejected. |
| Language preference | Chinese persisted while the HTTP request preferred English. Checked through HTTP; no visual browser check. |
| Storage scope | The foreign fixture existed, was absent from survey reads, and remained unchanged afterward. Wrong entrypoint scope returned 403; an unknown internal operation returned 404. |
| Idle stop | The container was stopped after a quiet interval with no requests. The process-age upper bound was 101.434 seconds, below its 120-second lifetime cap. |
| D1 lifecycle | Node rendered the saved choices after idle, SIGKILL and the v1-to-v2 image change. New writes succeeded after every transition. Each transition produced a new process boot identifier. |
| Private R2 signed transfer | Four CSV exports were uploaded and downloaded directly through the S3 endpoint. Their digests matched. The previous export survived idle, SIGKILL and the image change before each new export was created. Repeated completion was idempotent. |
| R2 authorization | Altered object keys, wrong HTTP methods and unsigned GET requests were rejected in every lifecycle stage. The signing credential permits object read/write only in the dedicated survey bucket. |
| CORS protocol | The survey origin's preflight returned 204; a foreign origin returned 403 without an allow-origin header. Direct PUT and GET returned 200 with the exact survey origin and matching bytes. Checked with a Node HTTP client. |
| Browser UI and interactive transfer | Not verified. Browser automation remained unavailable. |

The verifier returned exit code 0 with `lifecycle: passed` and `r2: passed`. Its 82 observations include 68 Worker HTTP responses, 12 R2 authorization denials and two timing records. The timing bound separates idle stop from the process lifetime cap; it is not a startup or latency benchmark.

The initial run's local checks passed: TypeScript, Worker/verifier syntax, both container image builds, the 18 Python prototype tests, and the README init/publish/login smoke flow on the existing Docker hosted stack. The smoke app was removed and purged, and its temporary CLI credential was revoked. This follow-up changes verification records only.

The credential and signed-transfer gates are complete. Browser UI verification remains open. This record covers the adapted survey's D1/R2 persistence, not the full SaaS acceptance suite or hostile tenant isolation.
