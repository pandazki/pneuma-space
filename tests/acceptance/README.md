# Acceptance suite

Runs `docs/acceptance.md` against the real stack started with Docker Compose, never a mock.

    node --test 'tests/acceptance/**/*.test.ts'

Suites call `composeUp()` from `harness.ts`, which starts project `pneuma-acc` on network `pneuma-acc` and loopback ports 18080, 18081 and 19000 (override with `PNEUMA_ACC_HTTP_PORT`, `PNEUMA_ACC_ADMIN_PORT`, `PNEUMA_ACC_OBJECT_PORT`), so a developer's `pneuma` stack keeps running untouched. `composeDown()` keeps volumes.
