"""Small local questionnaire app using the template's record store."""
import html
import os
import re
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from records import RecordStore

COLLECTION = "surveys"
ID = re.compile(r"[0-9a-f]{32}\Z")
PREFIX = re.compile(r"/apps/[a-zA-Z0-9_-]{1,80}\Z")


def escape(value):
    return html.escape(str(value), quote=True)


def make_handler(records):
    class Handler(BaseHTTPRequestHandler):
        def prefix(self):
            value = self.headers.get("X-Forwarded-Prefix", "")
            return value if PREFIX.fullmatch(value) else ""

        def page(self, status, title, content):
            body = ("<!doctype html><html lang='en'><head><meta charset='utf-8'>"
                    "<meta name='viewport' content='width=device-width'>"
                    f"<title>{escape(title)}</title></head><body><main>{content}"
                    "</main></body></html>").encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def redirect(self, path):
            self.send_response(303)
            self.send_header("Location", self.prefix() + path)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def form(self):
            if self.headers.get_content_type() != "application/x-www-form-urlencoded":
                raise ValueError("Expected a form submission.")
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 8192:
                    raise ValueError("Invalid form size.")
                data = parse_qs(self.rfile.read(length).decode("utf-8"), keep_blank_values=True, max_num_fields=10)
            except (UnicodeError, ValueError) as exc:
                raise ValueError("Invalid form submission.") from exc
            if any(len(values) != 1 for values in data.values()):
                raise ValueError("Duplicate form fields.")
            return {key: values[0] for key, values in data.items()}

        def do_GET(self):
            parsed = urlsplit(self.path)
            prefix = escape(self.prefix())
            if parsed.path == "/":
                query = parse_qs(parsed.query)
                after = query.get("after", [""])[0]
                if after and not ID.fullmatch(after):
                    return self.page(400, "Invalid cursor", "<h1>Invalid cursor</h1>")
                surveys = records.list(COLLECTION, after, 100)
                items = "".join(f"<li><a href='{prefix}/survey/{row['key']}'>{escape(row['value']['title'])}</a></li>" for row in surveys)
                more = (f"<p><a href='{prefix}/?after={surveys[-1]['key']}'>Next page</a></p>" if len(surveys) == 100 else "")
                return self.page(200, "Questionnaires", "<h1>Questionnaires</h1>"
                    f"<form method='post' action='{prefix}/create'>"
                    "<p><label>Title <input name='title' maxlength='120' required></label></p>"
                    "<p><label>Question <input name='question' maxlength='500' required></label></p>"
                    "<button>Create questionnaire</button></form>"
                    f"<h2>Existing questionnaires</h2><ul>{items}</ul>{more}")
            match = re.fullmatch(r"/survey/([0-9a-f]{32})", parsed.path)
            if not match:
                return self.page(404, "Not found", "<h1>Not found</h1>")
            row = records.get(COLLECTION, match.group(1))
            if not row:
                return self.page(404, "Not found", "<h1>Questionnaire not found</h1>")
            value = row["value"]
            answers = "".join(f"<li>{escape(answer)}</li>" for answer in value["answers"])
            return self.page(200, value["title"], f"<p><a href='{prefix}/'>All questionnaires</a></p>"
                f"<h1>{escape(value['title'])}</h1><p>{escape(value['question'])}</p>"
                f"<form method='post' action='{prefix}/answer/{row['key']}'>"
                f"<input type='hidden' name='revision' value='{row['revision']}'>"
                "<p><label>Your answer <textarea name='answer' maxlength='200' required></textarea></label></p>"
                "<button>Submit answer</button></form>"
                f"<h2>Answers ({len(value['answers'])})</h2><ol>{answers}</ol>")

        def do_POST(self):
            path = urlsplit(self.path).path
            try:
                data = self.form()
                if path == "/create":
                    title, question = data.get("title", "").strip(), data.get("question", "").strip()
                    if not title or len(title) > 120 or not question or len(question) > 500:
                        raise ValueError("Provide a title (up to 120 characters) and question (up to 500 characters).")
                    key = uuid.uuid4().hex
                    if not records.create(COLLECTION, key, {"title": title, "question": question, "answers": []}):
                        return self.page(409, "Conflict", "<h1>Could not create questionnaire; try again.</h1>")
                    return self.redirect("/survey/" + key)
                match = re.fullmatch(r"/answer/([0-9a-f]{32})", path)
                if not match:
                    return self.page(404, "Not found", "<h1>Not found</h1>")
                answer = data.get("answer", "").strip()
                if not answer or len(answer) > 200:
                    raise ValueError("Provide an answer of up to 200 characters.")
                try:
                    revision = int(data.get("revision", ""))
                    if revision < 1:
                        raise ValueError
                except ValueError as exc:
                    raise ValueError("Invalid revision.") from exc
                key = match.group(1)
                row = records.get(COLLECTION, key)
                if not row:
                    return self.page(404, "Not found", "<h1>Questionnaire not found</h1>")
                if len(row["value"]["answers"]) >= 50:
                    return self.page(409, "Full", "<h1>This questionnaire has reached 50 answers.</h1>")
                row["value"]["answers"].append(answer)
                if not records.replace(COLLECTION, key, row["value"], revision):
                    prefix = escape(self.prefix())
                    return self.page(409, "Conflict", f"<h1>Questionnaire changed</h1><p>Your answer was not saved. Copy it, then <a href='{prefix}/survey/{key}'>reload and submit again</a>.</p><textarea readonly aria-label='Your unsaved answer'>{escape(answer)}</textarea>")
                return self.redirect("/survey/" + key)
            except ValueError as exc:
                return self.page(400, "Invalid submission", f"<h1>Invalid submission</h1><p>{escape(exc)}</p>")

    return Handler


def serve():
    data_dir = os.environ.get("DATA_DIR", "/data")
    os.makedirs(data_dir, exist_ok=True)
    records = RecordStore(os.environ.get("DB_BACKEND", "sqlite"), os.path.join(data_dir, "questionnaires.sqlite3"))
    records.setup()
    ThreadingHTTPServer(("0.0.0.0", 8000), make_handler(records)).serve_forever()


if __name__ == "__main__":
    serve()
