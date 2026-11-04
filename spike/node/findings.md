# S3 Node relay spike

Run: `node spike/node/{proxy,ws,docker,sqlite}.ts`. Host is Node 25.1.0 on macOS; Node 24 numbers come from `node:24-alpine` (24.22.2, Linux) with this directory and the Docker socket mounted. Both runs pass every assertion.

`relay.ts` is the code to lift. It holds `forward` (path A), `tunnel` (path B) and `createRelay`. `serve.ts` runs the upstream and relay as child processes so the relay's RSS is measured on its own.

## Path A, streaming proxy (proxy.ts)

| | Node 25 macOS | Node 24 Linux |
| --- | --- | --- |
| 1 GiB download | 0.51 s, 2000 MiB/s | 0.79 s, 1294 MiB/s |
| relay RSS before / peak / 1 s after | 81.5 / 287.9 / 288.0 MiB | 84.4 / 181.1 / 89.9 MiB |
| RSS growth vs target < 64 MiB | 206 MiB, missed | 97 MiB, missed |
| 4 concurrent 1 GiB, RSS peak | 380 MiB | 252 MiB |
| 1 GiB to a client paused 3 s | +0.1 MiB | +64 MiB (my guess is earlier garbage) |
| 256 MiB chunked upload | byte count exact, 0.15 s | exact, 0.21 s |

- The growth is uncollected garbage, not buffering. Every socket read allocates a fresh Buffer. V8 frees them only when its external-memory counter crosses its GC threshold, and peak `external` tracks the Linux growth (103 MiB). A 4 GiB download peaked at 227 MiB of growth against 216 MiB for 1 GiB (macOS, separate probe), so growth is bounded rather than proportional. A stalled client adds nothing, so back-pressure holds. On Linux, RSS returns to baseline within 1 s. macOS malloc keeps the pages.
- Inferred, not measured: a target below 64 MiB is out of reach with `http` plus `pipe`, because V8's external-memory GC trigger is itself about 64 MiB. A bound of 128 MiB of growth per process, independent of response size, looks realistic.
- Chunked encoding: Node strips `transfer-encoding` as hop-by-hop and lets each leg pick its own framing. A chunked upstream response stays chunked to the client, and Content-Length passes through when the upstream sets it.
- Range: `Range` and `Content-Range` are end-to-end headers, so a 206 with the correct bytes passes through unchanged.
- The relay has to destroy the upstream request on `res` `close`. `pipeline(req, up)` has already finished for a GET, so a client that disconnects before the response arrives would otherwise leak the upstream socket.

## Path B, WebSocket tunnel (ws.ts)

- 1000 echoes of 32 bytes each. Node 25: direct median 29 us, through the relay 58 us, so the relay adds a median 29 us. Node 24 Linux adds 33 us (57 vs 90 us).
- Half-close works. `http.Server` sockets are `allowHalfOpen`, so a client `end()` reaches the upstream as FIN, the echo still comes back, and then the upstream's end closes the client. Do not `destroy()` one side on the other's `close`, because that drops bytes still buffered. Destroy only on `error`.
- `setNoDelay(true)` on both sockets is explicit. The upstream `net.connect` socket does not default to it.

## Docker Engine API over the unix socket (docker.ts)

- Engine 29.1.3 runs API 1.52. Unversioned paths work.
- Timings: create 17 to 58 ms, start 83 to 202 ms, inspect 2 ms, attached exec 33 to 49 ms, stop with `t=1` 109 to 176 ms. The `die` event arrives as the stop call returns.
- A second create of the same name returns 409, and a second start returns 304. Both map to "already exists" and "already started" in DESIGN 2.3.
- Surprise: API 1.52 events no longer carry the legacy `id` and `status` fields. Read `Action` and `Actor.ID`. Exit code is `Actor.Attributes.exitCode`.
- Surprise: top-level `NetworkSettings.IPAddress` is `""`. Read the IP from `NetworkSettings.Networks.<net>.IPAddress`, which for the gateway is `pneuma`.
- Docker Desktop adds the label `desktop.docker.io/ports.scheme`, so code should never compare the whole label set.
- Non-TTY exec output is multiplexed in 8-byte-header frames. `demux` in docker.ts parses them. Without an `Upgrade` header, attached exec start replies 200 and closes, so plain `http.request` is enough.

## node:sqlite (sqlite.ts)

- WAL and `synchronous=FULL` take effect. A throw after inserts into three tables rolls back all three. `BEGIN IMMEDIATE` with an explicit COMMIT or ROLLBACK is the whole transaction helper.
- 500 iterations of three inserts each in one transaction take 2.6 ms on Node 25 macOS and 3.5 ms on Node 24 Linux. 500 single-insert transactions take 0.08 ms per commit on macOS and 0.31 ms on Linux. On macOS that is plain fsync, not F_FULLFSYNC, so the macOS figure is not durable-write cost.
- Node 25.1 prints an `ExperimentalWarning` for `node:sqlite`. Node 24.22 does not. The gateway should run with `--disable-warning=ExperimentalWarning` or accept the line in its logs.
