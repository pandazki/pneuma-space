import concurrent.futures
import http.client
import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("gateway", os.path.join(os.path.dirname(__file__), "..", "gateway", "server.py"))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class FakeDocker:
    def __init__(self):
        self.containers = {}
        self.serial = 0

    def create(self, name, image, env):
        self.serial += 1
        container = "c%d" % self.serial
        self.containers[container] = False
        return container

    def start(self, container):
        self.containers[container] = True

    def stop(self, container):
        self.containers[container] = False

    def remove(self, container):
        self.containers.pop(container, None)

    def running(self, container):
        return self.containers[container]


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.docker = FakeDocker()
        self.registry = gateway.Registry(self.docker, self.temp.name, idle=1)

    def test_publish_wake_idle_and_reload(self):
        self.registry.publish("counter", "counter:v1")
        container = self.registry.acquire("counter")
        self.assertTrue(self.docker.running(container))
        self.registry.last["counter"] = time.monotonic() - 10
        self.registry.reap()
        self.assertTrue(self.docker.running(container), "active requests prevent idle stop")
        self.registry.release("counter")
        self.registry.last["counter"] = time.monotonic() - 10
        self.registry.reap()
        self.assertFalse(self.docker.running(container))
        reloaded = gateway.Registry(self.docker, self.temp.name, idle=1)
        self.assertEqual(reloaded.acquire("counter"), container)
        self.assertTrue(self.docker.running(container))
        reloaded.release("counter")

    def test_publish_replaces_container_and_remove_keeps_data(self):
        self.registry.publish("counter", "counter:v1")
        old = self.registry.apps["counter"]["container"]
        self.registry.publish("counter", "counter:v2")
        self.assertNotIn(old, self.docker.containers)
        self.assertEqual(self.registry.apps["counter"]["image"], "counter:v2")
        self.registry.remove("counter")
        self.assertEqual(self.registry.apps, {})
        self.assertEqual(self.docker.containers, {})

    def test_different_apps_start_without_global_lock(self):
        self.registry.publish("first", "image")
        self.registry.publish("second", "image")
        barrier = threading.Barrier(2, timeout=2)
        def start(container):
            barrier.wait()
            self.docker.containers[container] = True
        self.docker.start = start
        def request(name):
            container = self.registry.acquire(name)
            self.registry.release(name)
            return container
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(len(list(pool.map(request, ["first", "second"]))), 2)

    def test_running_app_skips_docker_start_and_recovers_after_failure(self):
        self.registry.publish("app", "image")
        calls = []
        real_start = self.docker.start
        def count_start(container):
            calls.append(container)
            real_start(container)
        self.docker.start = count_start
        container = self.registry.acquire("app")
        self.registry.release("app")
        self.assertEqual(self.registry.acquire("app"), container)
        self.registry.release("app")
        self.assertEqual(len(calls), 1)
        self.docker.stop(container)  # Simulate an external stop.
        self.registry.restart_after_connect_failure(container)
        self.assertTrue(self.docker.running(container))
        self.assertEqual(len(calls), 2)
        self.registry.last["app"] = time.monotonic() - 10
        self.registry.reap()
        self.registry.acquire("app")
        self.registry.release("app")
        self.assertEqual(len(calls), 3)

    def test_concurrent_first_requests_start_the_same_app_once(self):
        self.registry.publish("app", "image")
        calls, started, finish = [], threading.Event(), threading.Event()
        real_start = self.docker.start
        def slow_start(container):
            calls.append(container)
            started.set()
            if not finish.wait(2):
                raise TimeoutError("start was not released")
            real_start(container)
        self.docker.start = slow_start
        def request():
            container = self.registry.acquire("app")
            self.registry.release("app")
            return container
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(request) for _ in range(3)]
            try:
                self.assertTrue(started.wait(2))
            finally:
                finish.set()
            self.assertEqual(len({f.result(timeout=2) for f in futures}), 1)
        self.assertEqual(len(calls), 1)

    def test_start_in_progress_prevents_removal_and_idle_stop(self):
        self.registry.publish("app", "image")
        started, finish = threading.Event(), threading.Event()
        def slow_start(container):
            started.set()
            if not finish.wait(2):
                raise TimeoutError("start was not released")
            self.docker.containers[container] = True
        self.docker.start = slow_start
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.registry.acquire, "app")
            try:
                self.assertTrue(started.wait(2))
                self.registry.last["app"] = time.monotonic() - 10
                self.registry.reap()
                with self.assertRaises(ValueError):
                    self.registry.remove("app")
            finally:
                finish.set()
            self.assertEqual(future.result(timeout=2), self.registry.apps["app"]["container"])
            self.registry.release("app")

    def test_invalid_names_and_in_flight_replacement(self):
        with self.assertRaises(ValueError):
            self.registry.publish("../escape", "image")
        self.registry.publish("app", "image")
        self.registry.acquire("app")
        with self.assertRaises(ValueError):
            self.registry.publish("app", "new")
        with self.assertRaises(ValueError):
            self.registry.remove("app")
        self.registry.release("app")


class Backend(BaseHTTPRequestHandler):
    def do_GET(self):
        body = (self.path + "|" + self.headers.get("X-Forwarded-Prefix", "")).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class RuntimeHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.docker = FakeDocker()
        self.registry = gateway.Registry(self.docker, self.temp.name, idle=1)
        self.backend = self.start_server(Backend)
        self.old_port = gateway.APP_PORT
        gateway.APP_PORT = self.backend.server_port
        self.addCleanup(setattr, gateway, "APP_PORT", self.old_port)
        # Simulate Docker DNS resolving the app container to the backend.
        self.docker.create = lambda name, image, env: "127.0.0.1"
        self.registry.publish("demo", "demo:local")
        self.docker.containers["127.0.0.1"] = False
        self.proxy = self.start_server(gateway.Proxy, self.registry)
        self.admin = self.start_server(gateway.Admin, self.registry)

    def start_server(self, handler, registry=None):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server.registry = registry
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def request(self, server, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        self.addCleanup(conn.close)
        conn.request(method, path, body, headers or {})
        response = conn.getresponse()
        return response.status, response.read()

    def test_proxy_wakes_and_forwards_prefix_and_query(self):
        status, body = self.request(self.proxy, "GET", "/apps/demo/hello?q=1", headers={"X-Forwarded-Prefix": "/forged"})
        self.assertEqual(status, 200)
        self.assertEqual(body, b"/hello?q=1|/apps/demo")
        self.assertTrue(self.docker.running("127.0.0.1"))
        status, _ = self.request(self.proxy, "GET", "/apps/missing/")
        self.assertEqual(status, 404)

    def test_timing_header_is_opt_in(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=5)
        self.addCleanup(conn.close)
        conn.request("GET", "/apps/demo/")
        response = conn.getresponse()
        response.read()
        self.assertIsNone(response.getheader("X-Appbase-Timings"))
        self.proxy.trace_timings = True
        conn.request("GET", "/apps/demo/")
        response = conn.getresponse()
        response.read()
        timing = response.getheader("X-Appbase-Timings")
        self.assertIsNotNone(timing)
        self.assertTrue({"acquire", "lock", "docker", "connect", "upstream", "total"} <= {part.split("=")[0] for part in timing.split(";")})

    def test_admin_rejects_browser_cross_origin_and_bad_host(self):
        headers = {"Host": "localhost:8081", "Origin": "https://attacker.example", "Content-Type": "application/json"}
        status, _ = self.request(self.admin, "POST", "/apps/remove", json.dumps({"name": "demo"}), headers)
        self.assertEqual(status, 403)
        status, _ = self.request(self.admin, "GET", "/apps", headers={"Host": "attacker.example"})
        self.assertEqual(status, 403)
        status, body = self.request(self.admin, "GET", "/apps", headers={"Host": "localhost:8081"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)[0]["name"], "demo")


if __name__ == "__main__":
    unittest.main()
