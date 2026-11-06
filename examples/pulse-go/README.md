# pulse-go

A live counter in Go with no SDK: `main.go` reads the contract's variables and headers itself. `POST /pulse` adds one to a total in `kv`, every key under `PNEUMA_SPACE_KV_PREFIX`, and records who pressed, anonymous visitors included (`identity` with `required: false`); `GET /stream` pushes each pulse over server-sent events, which pass under `ws`; `SIGTERM` closes open streams and shuts down. The image is a static binary on distroless.

```sh
go test ./...                                                        # every link and form starts with X-Forwarded-Prefix
docker run -d --name dev-redis -p 127.0.0.1:6379:6379 redis:7-alpine
PNEUMA_SPACE_KV_URL=redis://127.0.0.1:6379 PNEUMA_SPACE_KV_PREFIX=dev: go run .   # then curl -H 'X-Forwarded-Prefix: /apps/dev' 127.0.0.1:8000/
node ../publish.ts pulse-go --owner user:<you>                       # docker build and publish
```
