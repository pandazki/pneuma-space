# S1 RustFS spike findings

Image `rustfs/rustfs:latest` (1.0.0-beta.12, rev 8601179). Run: `docker compose -p pneuma-s1 -f spike/rustfs/compose.yaml up -d && node spike/rustfs/run.ts`.
All seven steps pass. `s3.ts` uses only `node:crypto` and `fetch`: SigV4 header signing, SigV4 query presigning, and the madmin payload cipher.

## Per step

1. Create bucket. S3 `PUT /<bucket>` with the root credential. A repeat returns 409 `BucketAlreadyOwnedByYou`, treated as success.
2. Per-app credential. The MinIO admin API works at `/minio/admin/v3/`, signed SigV4 with service `s3`, region `us-east-1`:
   - `PUT add-canned-policy?name=pneuma-<bucket>`, body is plain policy JSON allowing `s3:*` on `arn:aws:s3:::<bucket>` and `<bucket>/*`.
   - `PUT add-user?accessKey=<key>`, body `{"secretKey","status":"enabled"}` **must be madmin-encrypted** with the root secret.
     Plain JSON fails with 400 `invalid encryption algorithm ID`. The format is salt(32) | 0x00 | nonce(8) | sio-go AES-256-GCM stream,
     with the key from argon2id (t=1, m=64 MiB, p=4), which Node 25 has as `crypto.argon2Sync`. `sealAdminPayload` handles one fragment (< 16 KiB).
   - `PUT set-user-or-group-policy?policyName=…&userOrGroup=<key>&isGroup=false`, empty body.
   The policy is enforced. The app key gets 403 on PUT and LIST in another bucket and on CreateBucket. Widening the policy to `arn:aws:s3:::*` fails this check.
   No CLI ships in the image (no `mc`, no `rc`; `rustfs` has only `server|info|tls|diagnose`). It does ship `curl` 8.21.
3. Public read. S3 `PUT /<bucket>?policy` with `Principal {"AWS":["*"]}`, `s3:GetObject` on `<bucket>/public/*`.
   Anonymous GET on `public/` returns 200. Elsewhere it returns 403, and anonymous LIST returns 403.
4. CORS. S3 `PUT /<bucket>?cors` with `Content-MD5` is per bucket and enforced. A preflight from `http://127.0.0.1:8080` gets
   `Access-Control-Allow-Origin` and `PUT`. Another origin gets no ACAO. Skipping the call makes the preflight fail, so no global default allows it.
5. Presigned PUT. Query-signed with the app key, `X-Amz-SignedHeaders=host`, `UNSIGNED-PAYLOAD`. 50 MiB uploads with `fetch`, and the response carries ACAO.
   An anonymous `Range: bytes=1000-1999` GET returns 206 with the right bytes and `Content-Range`. The full body sha256 matches.
   Anonymous GET of a non-public key returns 403. An expired presigned URL returns 403.
   RustFS checks the signature against the Host the client sent (`127.0.0.1:9100`, mapped to container port 9000).
6. Lifecycle.
   - suspend: `DELETE /<bucket>?policy`, then `PUT set-user-status?accessKey=…&status=disabled`. Both repeat safely.
     A disabled key gets **400 `InvalidRequest` / `ErrAccessKeyDisabled`**, not 403, on both signed requests and presigned URLs.
   - ensure: rerun create bucket, add-canned-policy, add-user, set-user-or-group-policy, bucket policy, and CORS.
     add-user overwrites the secret and sets `enabled`, so ensure with the stored secret also resumes. No separate enable call is needed.
   - destroy: ListObjectsV2 + `POST ?delete` (Content-MD5) per page, `DELETE /<bucket>`, `GET user-info` (404 means already gone),
     `DELETE remove-user`, `DELETE remove-canned-policy`. It repeats safely.
     `remove-user` on a missing user returns **500** "does not exist", so destroy checks `user-info` first.
     `remove-canned-policy` on a missing policy returns 200. After destroy, anonymous GET returns 403 (no existence leak) and a root GET returns 404.
7. Static server read. A root-signed GET of `pneuma-bundles/<sha>/assets/index.html` with `Range: bytes=10-99` returns 206 with the right bytes and the stored
   `Content-Type`. A missing path returns 404.

## Effect on the Provider design

- The ADR 0007 fallback is **not** needed. RustFS supports per-user, bucket-scoped policy through the MinIO admin API.
- DESIGN 1.3 says the Provider runs the object service's admin commands through `Runtime.run_job` in the infra container. The image has no admin CLI,
  and the madmin body cipher (argon2id + sio) cannot be produced with `curl`. The workable path is the gateway sending signed HTTP to the admin
  API with `node:crypto`. The gateway already needs the SigV4 signer for step 7 (static bundles), so this adds no new dependency. It does
  contradict "网关自身不带任何…存储驱动". The coordinator should decide whether to amend DESIGN or accept the deviation.
- The Provider must persist the app secret. ensure resends it, because add-user rotates to whatever secret it receives.
- The SDK may depend only on `pg` and `redis`, so it needs a hand-written presigner. `presign()` in `s3.ts` (about 15 lines plus the shared
  signing helpers) is that code. It must presign against `PNEUMA_OBJECT_PUBLIC_ENDPOINT`, because Host is signed.
- Treat `ErrAccessKeyDisabled` (400) as suspended. Do not expect 403.
