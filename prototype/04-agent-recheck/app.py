"""A small task list for a trusted local Appbase installation."""
import html
import os
import re
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

from records import RecordStore

DATA_DIR = os.environ.get("DATA_DIR", "/data")
os.makedirs(DATA_DIR, exist_ok=True)
records = RecordStore(os.environ.get("DB_BACKEND", "sqlite"), os.path.join(DATA_DIR, "tasks.sqlite3"))
records.setup()


def all_tasks():
    tasks = []
    after = ""
    while True:
        page = records.list("tasks", after=after)
        tasks.extend(page)
        if len(page) < 100:
            return tasks
        after = page[-1]["key"]


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/":
            return self.reply(404, "Not found")
        prefix = html.escape(self.headers.get("X-Forwarded-Prefix", ""), quote=True)
        rows = []
        for task in all_tasks():
            key = task["key"]
            revision = task["revision"]
            title = html.escape(task["value"]["title"])
            done = task["value"]["done"]
            label = "Reopen" if done else "Complete"
            rows.append(f"<li><span>{'✓ ' if done else ''}{title}</span>"
                        f"<form method='post' action='{prefix}/toggle'><input type='hidden' name='key' value='{key}'>"
                        f"<input type='hidden' name='revision' value='{revision}'><button>{label}</button></form>"
                        f"<form method='post' action='{prefix}/delete'><input type='hidden' name='key' value='{key}'>"
                        f"<input type='hidden' name='revision' value='{revision}'><button>Delete</button></form></li>")
        page = ("<!doctype html><html lang='en'><meta charset='utf-8'><meta name='viewport' content='width=device-width'>"
                "<title>Task list</title><style>body{font:16px system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem}"
                "li{display:flex;gap:.5rem;align-items:center;margin:1rem 0}li span{flex:1}input{padding:.5rem}"
                "button{padding:.5rem}</style><main><h1>Task list</h1><p>Keep track of work on this local host.</p>"
                f"<form method='post' action='{prefix}/add'><label>New task <input name='title' maxlength='200' required></label>"
                " <button>Add task</button></form><ul>" + "".join(rows) + "</ul></main></html>")
        self.reply(200, page)

    def do_POST(self):
        if self.path not in ("/add", "/toggle", "/delete"):
            return self.reply(404, "Not found")
        try:
            if self.headers.get_content_type() != "application/x-www-form-urlencoded":
                return self.reply(415, "Form data required")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError("Invalid request size")
            fields = parse_qs(self.rfile.read(length).decode("utf-8"), keep_blank_values=True, max_num_fields=10)
            if self.path == "/add":
                title = fields.get("title", [""])[0].strip()
                if not 1 <= len(title) <= 200:
                    raise ValueError("Task title must contain 1–200 characters")
                if not records.create("tasks", uuid.uuid4().hex, {"title": title, "done": False}):
                    return self.reply(409, "Task already exists; retry")
            else:
                key = fields.get("key", [""])[0]
                if not re.fullmatch(r"[0-9a-f]{32}", key):
                    raise ValueError("Invalid task key")
                revision = int(fields.get("revision", [""])[0])
                if self.path == "/delete":
                    ok = records.delete("tasks", key, revision)
                else:
                    task = records.get("tasks", key)
                    ok = task is not None and records.replace("tasks", key,
                        {"title": task["value"]["title"], "done": not task["value"]["done"]}, revision)
                if not ok:
                    return self.reply(409, "Task changed or was removed; reload and try again")
        except (ValueError, UnicodeDecodeError, OverflowError):
            return self.reply(400, "Invalid task request")
        self.send_response(303)
        self.send_header("Location", self.headers.get("X-Forwarded-Prefix", "") + "/")
        self.send_header("Content-Length", "0")
        self.end_headers()


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
