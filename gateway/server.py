"""Trusted, local-only application gateway; see SCOPE.md."""
import http.client
import json
import os
import re
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, urlsplit

LIMIT = 8 * 1024 * 1024
NAME = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
NETWORK = os.environ.get("APP_NETWORK", "appbase-local")
DATA_DIR = os.environ.get("DATA_DIR", "/data")
IDLE = int(os.environ.get("IDLE_SECONDS", "60"))
APP_PORT = 8000
TRACE_TIMINGS = os.environ.get("APPBASE_TRACE", "0") == "1"
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"}


class UnixHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        self.sock.connect(os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock"))


class Docker:
    def request(self, method, path, data=None, accepted=(200,)):
        conn = UnixHTTPConnection("localhost", timeout=30)
        body = json.dumps(data).encode() if data is not None else None
        try:
            conn.request(method, "/v1.44" + path, body, {"Content-Type": "application/json"})
            res = conn.getresponse()
            raw = res.read()
            if res.status not in accepted:
                raise RuntimeError("Docker %s: %s" % (res.status, raw.decode(errors="replace")[:500]))
            return json.loads(raw) if raw else None
        finally:
            conn.close()

    def create(self, name, image, env):
        container = "appbase-" + name + "-" + uuid.uuid4().hex[:12]
        data = {"Image": image, "Env": [k + "=" + v for k, v in env.items()], "Labels": {"appbase.name": name}, "ExposedPorts": {"8000/tcp": {}},
                "HostConfig": {"NetworkMode": NETWORK, "Binds": ["appbase-data-" + name + ":/data"]}}
        self.request("POST", "/containers/create?name=" + quote(container), data, (201,))
        return container

    def start(self, container):
        self.request("POST", "/containers/" + container + "/start", accepted=(204, 304))

    def stop(self, container):
        self.request("POST", "/containers/" + container + "/stop?t=5", accepted=(204, 304, 404))

    def remove(self, container):
        self.request("DELETE", "/containers/" + container + "?force=true", accepted=(204, 404))

    def running(self, container):
        try:
            return bool(self.request("GET", "/containers/" + container + "/json")["State"]["Running"])
        except RuntimeError as exc:
            if str(exc).startswith("Docker 404:"):
                return False
            raise


class Registry:
    def __init__(self, docker, data_dir=DATA_DIR, idle=IDLE):
        self.docker, self.idle = docker, idle
        self.path = os.path.join(data_dir, "apps.json")
        self.lock = threading.RLock()
        self.active, self.last = {}, {}
        self.start_locks, self.start_epoch = {}, {}
        os.makedirs(data_dir, exist_ok=True)
        try:
            with open(self.path, encoding="utf-8") as f:
                self.apps = json.load(f)
        except FileNotFoundError:
            self.apps = {}
        # A restarted gateway cannot know when an already running app was last used.
        self.last = {name: time.monotonic() for name in self.apps}

    def save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.apps, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    def publish(self, name, image, env=None):
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise ValueError("name must start with a lowercase letter and contain only lowercase letters, digits or hyphens (max 40)")
        if not isinstance(image, str) or not image.strip() or len(image) > 255:
            raise ValueError("a local image name is required")
        env = env or {}
        allowed = {"DB_BACKEND", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGSSLMODE"}
        if not isinstance(env, dict) or any(k not in allowed or not isinstance(v, str) or len(v) > 255 for k, v in env.items()):
            raise ValueError("invalid environment: only documented non-secret database settings are allowed")
        with self.lock:
            if self.active.get(name, 0):
                raise ValueError("app has active requests; retry after they finish")
            container = self.docker.create(name, image, env)
            old = self.apps.get(name)
            self.apps[name] = {"image": image, "container": container, "env": env}
            try:
                self.save()
            except Exception:
                if old is None:
                    del self.apps[name]
                else:
                    self.apps[name] = old
                self.docker.remove(container)
                raise
            self.last[name] = time.monotonic()
            if old:
                self.docker.remove(old["container"])
                self.start_epoch.pop(old["container"], None)
                self.start_locks.pop(old["container"], None)

    def remove(self, name):
        with self.lock:
            if name not in self.apps:
                raise KeyError(name)
            if self.active.get(name, 0):
                raise ValueError("app has active requests; retry after they finish")
            old = self.apps.pop(name)
            try:
                self.save()
            except Exception:
                self.apps[name] = old
                raise
            self.docker.remove(old["container"])
            self.start_epoch.pop(old["container"], None)
            self.start_locks.pop(old["container"], None)
            self.last.pop(name, None)

    def ensure_started(self, container, expected_epoch=None):
        # One starter per container; unrelated apps never share this lock.
        with self.lock:
            start_lock = self.start_locks.setdefault(container, threading.Lock())
        with start_lock:
            with self.lock:
                epoch = self.start_epoch.get(container, 0)
                if expected_epoch is None and epoch:
                    return
                if expected_epoch is not None and epoch != expected_epoch:
                    return
            self.docker.start(container)
            with self.lock:
                self.start_epoch[container] = epoch + 1

    def restart_after_connect_failure(self, container):
        # Only called before sending an HTTP request, so no mutation is replayed.
        with self.lock:
            epoch = self.start_epoch.get(container, 0)
        self.ensure_started(container, expected_epoch=epoch)

    def acquire(self, name, timing=None):
        lock_started = time.monotonic()
        with self.lock:
            app = self.apps.get(name)
            if not app:
                raise KeyError(name)
            self.active[name] = self.active.get(name, 0) + 1
            container = app["container"]
        lock_finished = time.monotonic()
        # A request counts as active before the lock is released, preventing
        # replacement or idle-stop while Docker starts this container.
        try:
            self.ensure_started(container)
        except Exception:
            with self.lock:
                self.active[name] -= 1
            raise
        if timing is not None:
            timing['lock'] = (lock_finished - lock_started) * 1000
            timing['docker'] = (time.monotonic() - lock_finished) * 1000
        return container

    def release(self, name):
        with self.lock:
            self.active[name] -= 1
            self.last[name] = time.monotonic()

    def reap(self):
        with self.lock:
            now = time.monotonic()
            for name, app in list(self.apps.items()):
                if not self.active.get(name, 0) and now - self.last.get(name, now) >= self.idle:
                    self.docker.stop(app["container"])
                    self.start_epoch.pop(app["container"], None)
                    self.last[name] = now

    def listing(self):
        with self.lock:
            apps = [(name, app.copy()) for name, app in sorted(self.apps.items())]
        return [{"name": n, "image": a["image"], "running": self.docker.running(a["container"]),
                 "url": "/apps/" + n + "/"} for n, a in apps]


def reply(handler, status, body, content_type="application/json"):
    raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(raw)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(raw)


class Admin(BaseHTTPRequestHandler):
    def valid_host(self):
        return self.headers.get("Host", "") in ("localhost:8081", "127.0.0.1:8081")

    def do_GET(self):
        if not self.valid_host():
            return reply(self, 403, {"error": "invalid host"})
        if self.path == "/":
            with open(os.path.join(os.path.dirname(__file__), "admin.html"), "rb") as page:
                return reply(self, 200, page.read(), "text/html; charset=utf-8")
        if self.path != "/apps":
            return reply(self, 404, {"error": "not found"})
        try:
            reply(self, 200, self.server.registry.listing())
        except Exception as exc:
            reply(self, 500, {"error": str(exc)})

    def do_POST(self):
        if not self.valid_host():
            return reply(self, 403, {"error": "invalid host"})
        origin = self.headers.get("Origin")
        if origin and origin not in ("http://localhost:8081", "http://127.0.0.1:8081"):
            return reply(self, 403, {"error": "invalid origin"})
        if self.headers.get_content_type() != "application/json":
            return reply(self, 415, {"error": "application/json required"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 16384:
                raise ValueError("invalid request size")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("expected a JSON object")
            if self.path == "/apps/publish":
                self.server.registry.publish(data.get("name"), data.get("image"), data.get("env"))
            elif self.path == "/apps/remove":
                self.server.registry.remove(data.get("name"))
            else:
                return reply(self, 404, {"error": "not found"})
            reply(self, 200, {"ok": True})
        except (ValueError, KeyError, TypeError) as exc:
            reply(self, 400, {"error": str(exc)})
        except Exception as exc:
            reply(self, 500, {"error": str(exc)})


class Proxy(BaseHTTPRequestHandler):
    def forward(self):
        request_started = time.monotonic()
        parsed = urlsplit(self.path)
        match = re.match(r"^/apps/([a-z][a-z0-9-]{0,39})(/.*)?$", parsed.path)
        if not match:
            return reply(self, 404, {"error": "use /apps/<name>/"})
        name, path = match.group(1), match.group(2)
        if path is None:
            self.send_response(308)
            self.send_header("Location", parsed.path + "/" + ("?" + parsed.query if parsed.query else ""))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.headers.get("Transfer-Encoding"):
            return reply(self, 501, {"error": "chunked requests are not supported"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 0 or size > LIMIT:
                return reply(self, 413, {"error": "request too large"})
        except ValueError:
            return reply(self, 400, {"error": "invalid content length"})
        body = self.rfile.read(size) if size else None
        acquire_started = time.monotonic()
        trace_enabled = getattr(self.server, 'trace_timings', TRACE_TIMINGS)
        acquire_timing = {} if trace_enabled else None
        try:
            container = self.server.registry.acquire(name, acquire_timing)
        except KeyError:
            return reply(self, 404, {"error": "app not found"})
        except Exception as exc:
            return reply(self, 502, {"error": str(exc)})
        acquired = time.monotonic()
        try:
            target = path + ("?" + parsed.query if parsed.query else "")
            connection_tokens = {v.strip().lower() for v in self.headers.get("Connection", "").split(",")}
            headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP | connection_tokens | {"host", "x-forwarded-prefix", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"}}
            headers["X-Forwarded-Prefix"] = "/apps/" + name
            # Only retry connection failures, before sending an HTTP request, to avoid replaying mutations.
            connect_started = time.monotonic()
            deadline = connect_started + 15
            restarted = False
            while True:
                conn = http.client.HTTPConnection(container, APP_PORT, timeout=20)
                try:
                    conn.connect()
                    break
                except OSError:
                    conn.close()
                    if time.monotonic() >= deadline:
                        raise
                    if not restarted:
                        self.server.registry.restart_after_connect_failure(container)
                        restarted = True
                    time.sleep(0.2)
            connected = time.monotonic()
            try:
                conn.request(self.command, target, body=body, headers=headers)
                response = conn.getresponse()
                raw = response.read(LIMIT + 1)
                if len(raw) > LIMIT:
                    return reply(self, 502, {"error": "response too large"})
                upstream_done = time.monotonic()
                self.send_response(response.status)
                response_tokens = {v.strip().lower() for v in response.getheader("Connection", "").split(",")}
                excluded = {"content-length", "server", "date"} | ({"x-appbase-timings"} if trace_enabled else set())
                for key, value in response.getheaders():
                    if key.lower() not in HOP | response_tokens | excluded:
                        self.send_header(key, value)
                if trace_enabled:
                    ms = lambda seconds: round(seconds * 1000, 2)
                    self.send_header('X-Appbase-Timings', 'acquire=%.2f;lock=%.2f;docker=%.2f;connect=%.2f;upstream=%.2f;total=%.2f' % (
                        ms(acquired - acquire_started), acquire_timing['lock'], acquire_timing['docker'], ms(connected - connect_started),
                        ms(upstream_done - connected), ms(upstream_done - request_started)))
                self.send_header("Content-Length", response.getheader("Content-Length", "0") if self.command == "HEAD" else str(len(raw)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(raw)
            finally:
                conn.close()
        except (OSError, RuntimeError, http.client.HTTPException) as exc:
            reply(self, 502, {"error": "app unavailable: " + str(exc)})
        finally:
            self.server.registry.release(name)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = forward


def serve():
    registry = Registry(Docker())
    admin = ThreadingHTTPServer(("0.0.0.0", 8081), Admin)
    proxy = ThreadingHTTPServer(("0.0.0.0", 8080), Proxy)
    admin.registry = proxy.registry = registry
    def reaper():
        while True:
            time.sleep(max(1, min(IDLE, 10)))
            try:
                registry.reap()
            except Exception as exc:
                print("idle reaper:", exc, flush=True)
    threading.Thread(target=reaper, daemon=True).start()
    threading.Thread(target=admin.serve_forever, daemon=True).start()
    proxy.serve_forever()


if __name__ == "__main__":
    serve()
