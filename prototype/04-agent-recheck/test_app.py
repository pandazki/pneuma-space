"""Exercise real HTTP handler and SQLite without requiring a listening port."""
import importlib
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))


class RequestSocket:
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = bytearray()

    def makefile(self, mode, *args, **kwargs):
        return self.input

    def sendall(self, data):
        self.output.extend(data)


class TaskAppTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        os.environ["DATA_DIR"] = self.directory.name
        os.environ["DB_BACKEND"] = "sqlite"
        import app
        self.app = importlib.reload(app)

    def tearDown(self):
        self.directory.cleanup()

    def request(self, path="/", fields=None, prefix="/apps/tasks"):
        body = urlencode(fields).encode() if fields is not None else b""
        method = "POST" if fields is not None else "GET"
        raw = (f"{method} {path} HTTP/1.0\r\nHost: localhost\r\nX-Forwarded-Prefix: {prefix}\r\n"
               f"Content-Type: application/x-www-form-urlencoded\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body
        sock = RequestSocket(raw)
        self.app.Handler(sock, ("127.0.0.1", 1234), None)
        return bytes(sock.output).decode()

    def test_task_lifecycle_and_persistence(self):
        response = self.request("/add", {"title": "Buy <milk>"})
        self.assertIn("303 See Other", response)
        self.assertIn("Location: /apps/tasks/", response)
        page = self.request()
        self.assertIn("Buy &lt;milk&gt;", page)
        self.assertIn("action='/apps/tasks/toggle'", page)
        task = self.app.all_tasks()[0]
        key = task["key"]
        self.assertIn("303 See Other", self.request("/toggle", {"key": key, "revision": 1}))
        self.assertIn("Reopen", self.request())
        self.assertIn("409 Conflict", self.request("/delete", {"key": key, "revision": 1}))
        self.app = importlib.reload(self.app)
        self.assertTrue(self.app.all_tasks()[0]["value"]["done"])
        self.assertIn("303 See Other", self.request("/delete", {"key": key, "revision": 2}))
        self.assertEqual([], self.app.all_tasks())

    def test_validation(self):
        self.assertIn("400 Bad Request", self.request("/add", {"title": "  "}))
        self.assertIn("400 Bad Request", self.request("/add", {"title": "x" * 201}))
        self.assertIn("400 Bad Request", self.request("/toggle", {"key": "bad", "revision": 1}))
        self.assertIn("404 Not Found", self.request("/missing"))
        self.assertEqual([], self.app.all_tasks())

    def test_pagination(self):
        for n in range(101):
            self.app.records.create("tasks", f"{n:032x}", {"title": str(n), "done": False})
        self.assertEqual(101, len(self.app.all_tasks()))
        self.assertEqual(101, self.request().count("<li>"))


if __name__ == "__main__":
    unittest.main()
