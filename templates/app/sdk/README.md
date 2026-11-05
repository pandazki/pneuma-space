# SDK

A wrapper over the PneumaSpace app contract (`docs/app-contract.md`), vendored as plain TypeScript so the app directory is self-contained, as a code bundle or as a Docker build context. Node 24 runs it directly; there is no build step. The surface and the rules are in `../AGENTS.md`.

Each file wraps one part of the contract and is safe to delete if you do not use it:

- `env.ts` reads the `PNEUMA_SPACE_*` variables of declared capabilities.
- `serve.ts` parses `X-Forwarded-Prefix` and the `X-Pneuma-Space-*` identity headers and routes `/_pneuma-space/trigger/<name>`.
- `db.ts` opens `node:sqlite` or `pg` by the URL scheme and translates `?` to `$n` for PostgreSQL.
- `kv.ts` connects `redis` and prefixes keys and channels.
- `objects.ts` presigns S3 URLs with SigV4 against the public endpoint, using `node:crypto` only.
- `ws.ts` is an RFC 6455 server: text, binary, fragments, ping/pong and close.
- `rtc.ts` mints TURN REST credentials (`<expiry>:<user>`, HMAC-SHA1 of the shared secret).

`pg` and `redis` are the only packages. Tests: `npm test`. Another language needs only environment variables, headers and an HTTP server; these files show what to read.
