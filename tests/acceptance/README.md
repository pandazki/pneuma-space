# Acceptance suite

Runs `docs/acceptance.md` against the real stack started with Docker Compose, never a mock. One test per row, named by its ID; `TH-*` tests measure the thresholds without an ID of their own.

    node --test tests/acceptance

`package.json` here points Node at `suite.ts`, so every family file runs in one process, one test at a time: rows restart the gateway, stop coturn and change global policy, which would break tests running beside them.

`setupSuite()` in `harness.ts` starts project `pneuma-space-acc` with the `postgres` and `rtc` profiles on network `pneuma-space-acc` and loopback ports 18080, 18081 and 19000 (override with `PNEUMA_SPACE_ACC_HTTP_PORT`, `PNEUMA_SPACE_ACC_ADMIN_PORT`, `PNEUMA_SPACE_ACC_OBJECT_PORT`), so a developer's `pneuma-space` stack keeps running untouched, and builds the fixture images. Every test removes and purges its apps; the suite removes the fixture images. `composeDown()` keeps volumes. AC-GAME-2 drives Chrome (`CHROME`, default the macOS install path).
