"""Minimal stateful app: writes only to the persistent /data volume."""
import html
import json
import os
import re
from urllib.parse import parse_qs, urlsplit
from store import CounterStore
from records import RecordStore
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = os.path.join(os.environ.get("DATA_DIR", "/data"), "counter.sqlite3")
os.makedirs(os.path.dirname(DB), exist_ok=True)
store = CounterStore(os.environ.get("DB_BACKEND", "sqlite"), DB)
store.setup()
records = RecordStore(os.environ.get("DB_BACKEND", "sqlite"), DB)
records.setup()


class Handler(BaseHTTPRequestHandler):
    def json_reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def record_request(self):
        parsed = urlsplit(self.path)
        match = re.fullmatch(r"/records/([a-zA-Z0-9_-]{1,80})(?:/([a-zA-Z0-9_-]{1,80}))?", parsed.path)
        if not match:
            return self.json_reply(404, {"error": "record path not found"})
        collection, key = match.groups()
        try:
            if self.command == "GET":
                if key:
                    record = records.get(collection, key)
                    return self.json_reply(200 if record else 404, record or {"error": "not found"})
                query = parse_qs(parsed.query)
                limit = int(query.get("limit", ["100"])[0])
                after = query.get("after", [""])[0]
                return self.json_reply(200, records.list(collection, after, limit))
            if not key:
                return self.json_reply(400, {"error": "key required"})
            if self.headers.get_content_type() != "application/json":
                return self.json_reply(415, {"error": "application/json required"})
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 131072:
                raise ValueError("invalid body size")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("body must be an object")
            if self.command == "POST":
                if "value" not in data:
                    raise ValueError("value is required")
                ok = records.create(collection, key, data["value"])
                return self.json_reply(201 if ok else 409, {"created": ok})
            if self.command == "PUT":
                if "value" not in data:
                    raise ValueError("value is required")
                ok = records.replace(collection, key, data["value"], data.get("revision"))
                return self.json_reply(200 if ok else 409, {"updated": ok})
            if self.command == "DELETE":
                ok = records.delete(collection, key, data.get("revision"))
                return self.json_reply(200 if ok else 409, {"deleted": ok})
            return self.json_reply(405, {"error": "method not supported"})
        except (ValueError, TypeError, OverflowError) as exc:
            return self.json_reply(400, {"error": str(exc)})

    def do_GET(self):
        if self.path.startswith("/records/"):
            return self.record_request()
        if self.path != "/":
            self.send_error(404)
            return
        value = store.get()
        prefix = html.escape(self.headers.get("X-Forwarded-Prefix", ""), quote=True)
        page = ("<!doctype html><html lang='en'><meta charset='utf-8'><meta name='viewport' content='width=device-width'>"
                "<title>Persistent counter</title><body><main><h1>Persistent counter</h1>"
                "<p>Count: <strong>%d</strong></p><form method='post' action='%s/increment'>"
                "<button type='submit'>Increment</button></form><p>Storage backend: %s.</p><p>Version: %s.</p>"
                "</main></body></html>" % (value, prefix, html.escape(store.backend), html.escape(os.environ.get("APP_RELEASE", "local")))).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def do_POST(self):
        if self.path.startswith("/records/"):
            return self.record_request()
        if self.path != "/increment":
            self.send_error(404)
            return
        store.increment()
        self.send_response(303)
        self.send_header("Location", self.headers.get("X-Forwarded-Prefix", "") + "/")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_PUT(self):
        return self.record_request()

    def do_DELETE(self):
        return self.record_request()


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
