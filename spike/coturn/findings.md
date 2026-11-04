# S2 coturn spike findings

Run 2026-11-04, Docker 29.1.3 (Docker Desktop, macOS), coturn/coturn:4.6 (4.6.3), node 25.1 host, node:24-alpine stand-in gateway.

Start: `PNEUMA_RTC_SECRET=spike docker compose -p pneuma-s2 -f spike/coturn/compose.yaml --profile rtc up -d`.
Flags on the command line are enough; no turnserver.conf. `--no-cli` silences the telnet-password error.

## 1. coturn in Compose, loopback only
`docker compose ps`: `127.0.0.1:3478->3478/udp, 127.0.0.1:3478->3478/tcp, 127.0.0.1:49160-49200->49160-49200/udp`.
A STUN Binding request from the macOS host to 127.0.0.1:3478/udp got response type `0x101` (Binding Success).

## 2. mint.ts
`PNEUMA_RTC_SECRET=spike node spike/coturn/mint.ts [ttl] [userId]` prints `{"username":"1793810821:alice","credential":"3Vz49E9v9KHfDOFI+WXi9TyfsnU="}`. node:crypto only.

## 3. coturn accepts the minted credential
`docker exec pneuma-s2-coturn-1 sh -c "turnutils_uclient -y -n 5 -m 1 -u '<username>' -w '<credential>' \$(hostname -i)"`
Accepted: exit 0, `tot_send_msgs=20, tot_recv_msgs=20`, `Total lost packets 0`, data relayed client to client.
Target the container's eth0 address, not 127.0.0.1. Against 127.0.0.1 the Allocate succeeds but the relay is also loopback, and coturn's default no-loopback-peers rejects ChannelBind with `403 (Forbidden IP)`.
Rejected, each exit 255 `Cannot complete Allocation`; coturn logs `check_stun_auth: Cannot find credentials of user <...>`:
- credential minted with secret `other`;
- username userId changed alice to mallory, original credential;
- ttl -10 (expired).

## 4. Gateway detects the profile
From the gateway container, `dns.lookup("coturn")` returns `192.168.80.2` with the profile on and fails with `EAI_AGAIN` with it off.
The failure takes 5009 ms (three runs, 5009 to 5020 ms): Docker's resolver 127.0.0.11 forwards unknown names to the host resolver and waits.
Use `new dns.promises.Resolver({ timeout: 500, tries: 1 }).resolve4("coturn")` instead: profile on, 0 to 1 ms; off, `ETIMEOUT` in about 990 ms. Treat any error as off.
Because the name is forwarded upstream, a host or search domain that resolves `coturn` would read as on. Run the check at publish time, not gateway start (no network during start).
