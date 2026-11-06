import csv
import io
import json
import os
import re
import signal
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

DICT = {
    'en': {
        'title': 'Notes', 'notes': 'Your notes', 'about': 'Signed in as {name}. Each subject sees only its own notes.',
        'placeholder': 'Write a note', 'add': 'Add', 'empty': 'No notes yet.', 'time': 'Written (UTC)', 'note': 'Note',
        'export': 'Export', 'exportAbout': 'The export trigger writes notes.csv to /data every night at 03:00 UTC.',
        'database': 'Database: {engine}', 'exported': 'Exported {time} UTC', 'never': 'Not exported yet',
        'download': 'Download notes.csv', 'ownerOnly': 'Only the owner downloads the export.', 'signIn': 'Sign in first.',
    },
    'zh': {
        'title': '笔记', 'notes': '你的笔记', 'about': '当前身份 {name}。每个身份只能看到自己的笔记。',
        'placeholder': '写一条笔记', 'add': '添加', 'empty': '还没有笔记。', 'time': '写于（UTC）', 'note': '笔记',
        'export': '导出', 'exportAbout': '导出触发器每晚 03:00 UTC 把 notes.csv 写入 /data。',
        'database': '数据库：{engine}', 'exported': '导出于 {time} UTC', 'never': '尚未导出',
        'download': '下载 notes.csv', 'ownerOnly': '只有所有者可以下载导出文件。', 'signIn': '请先登录。',
    },
}
SHELL = {
    'en': {'language': 'Language', 'theme': 'Theme', 'light': 'Light', 'dark': 'Dark', 'footer': 'Runs on PneumaSpace'},
    'zh': {'language': '语言', 'theme': '主题', 'light': '浅色', 'dark': '深色', 'footer': '运行于 PneumaSpace'},
}
BADGE = '<div class="badge">pneuma-space-example-site</div>'
# Runs before the stylesheet so the first paint already has the right theme.
THEME = "try{var t=localStorage.getItem('pneuma-space-theme')}catch(e){}document.documentElement.dataset.theme=t||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')"
SUN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"/></svg>'
MOON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"/></svg>'


def esc(value):
    return escape(str(value), quote=True)


def page(prefix, path, lang, title, body):
    s = SHELL[lang]
    p = esc(prefix)
    current = ' aria-current="true"'
    langs = ''.join(f'<a href="{p}{esc(path)}?lang={code}"{current if code == lang else ""}>{label}</a>'
                    for code, label in (('zh', '中'), ('en', 'EN')))
    ui_dict = json.dumps(DICT[lang], ensure_ascii=False).replace('<', '\\u003c')
    return f'''<!doctype html>
<html lang="{lang}" data-prefix="{p}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<script>{THEME}</script>
<link rel="stylesheet" href="{p}/ui.css">
<link rel="stylesheet" href="{p}/app.css">
<script type="application/json" id="ui-dict">{ui_dict}</script>
<script defer src="{p}/ui.js"></script>
</head>
<body>
<div class="frame">
<header class="top">
<h1>{esc(title)}</h1>
<div class="controls">
<div class="seg" role="group" aria-label="{s['language']}">{langs}</div>
<div class="seg" role="group" aria-label="{s['theme']}"><button type="button" data-theme-set="light" aria-label="{s['light']}">{SUN}</button><button type="button" data-theme-set="dark" aria-label="{s['dark']}">{MOON}</button></div>
</div>
</header>
<main>{body}</main>
<footer>{s['footer']}</footer>
</div>{BADGE}
</body>
</html>'''


class Db:
    """`?` placeholders on both engines; the SQL is the subset SQLite and PostgreSQL share."""

    def __init__(self, url):
        self.url = url
        self.engine = url.split(':', 1)[0]
        if self.engine == 'postgresql':
            import psycopg
            self.connect = lambda: psycopg.connect(url)
        elif self.engine == 'sqlite':
            self.connect = lambda: sqlite3.connect(url.removeprefix('sqlite://'), timeout=10)
        else:
            raise ValueError(f'unsupported PNEUMA_SPACE_DB_URL scheme {self.engine}')

    def run(self, sql, params=()):
        conn = self.connect()
        try:
            cur = conn.execute(sql.replace('?', '%s') if self.engine == 'postgresql' else sql, params)
            rows = cur.fetchall() if cur.description else []
            conn.commit()
            return rows
        finally:
            conn.close()


def migrate(db):
    db.run('''CREATE TABLE IF NOT EXISTS note (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)''')


def spreadsheet_safe(value):
    return "'" + value if value[:1] in ('=', '+', '-', '@', '\t', '\r') else value


def export(db, files_dir):
    out = io.StringIO()
    writer = csv.writer(out, quoting=csv.QUOTE_ALL, lineterminator='\r\n')
    writer.writerow(['subject', 'name', 'created_at', 'body'])
    for row in db.run('SELECT subject, name, created_at, body FROM note ORDER BY created_at, id'):
        writer.writerow([spreadsheet_safe(v) for v in row])
    data = out.getvalue().encode()
    path = os.path.join(files_dir, 'notes.csv')
    try:
        with open(path, 'rb') as f:
            # A redelivery finds the same bytes and leaves the file, mtime included.
            if f.read() == data:
                return
    except FileNotFoundError:
        pass
    with open(path + '.tmp', 'wb') as f:
        f.write(data)
    os.replace(path + '.tmp', path)


def home(prefix, lang, subject, name, owner, db, files_dir):
    t = lambda key, **params: DICT[lang][key].format(**params)
    rows = db.run('SELECT created_at, body FROM note WHERE subject = ? ORDER BY created_at DESC LIMIT 50', (subject,))
    notes = ''.join(f'<tr><td class="mono">{esc(at[:16].replace("T", " "))}</td><td>{esc(body)}</td></tr>' for at, body in rows)
    table = (f'<table><thead><tr><th>{t("time")}</th><th>{t("note")}</th></tr></thead><tbody>{notes}</tbody></table>'
             if notes else f'<p class="empty">{t("empty")}</p>')
    path = os.path.join(files_dir, 'notes.csv')
    exported = (t('exported', time=datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).strftime('%Y-%m-%d %H:%M'))
                if os.path.exists(path) else t('never'))
    download = (f'<a class="btn" href="{esc(prefix)}/notes.csv">{t("download")}</a>' if owner
                else f'<span class="hint">{t("ownerOnly")}</span>')
    body = f'''<section>
<header><h2>{t("notes")}</h2><p>{esc(t("about", name=name))}</p></header>
<div class="card">
<form class="row" method="post" action="{esc(prefix)}/notes"><input name="body" required maxlength="500" autocomplete="off" placeholder="{t("placeholder")}"><button class="primary">{t("add")}</button></form>
{table}
</div>
</section>
<section>
<header><h2>{t("export")}</h2><p>{t("exportAbout")}</p></header>
<div class="card row export">
<span class="chip">{t("database", engine=db.engine)}</span>
<span class="status{" green" if os.path.exists(path) else ""}">{exported}</span>
{download}
</div>
</section>'''
    return page(prefix, '/', lang, t('title'), body)


def pick_lang(headers):
    cookie = re.search(r'(?:^|;\s*)lang=(en|zh)(?:;|$)', headers.get('Cookie', ''))
    if cookie:
        return cookie.group(1)
    return 'zh' if re.match(r'\s*zh', headers.get('Accept-Language', ''), re.I) else 'en'


class Handler(BaseHTTPRequestHandler):
    db = None
    files_dir = '/data'

    def do_GET(self):
        self.handle_request('GET')

    def do_POST(self):
        self.handle_request('POST')

    def reply(self, status, body=b'', content_type='text/plain; charset=utf-8', headers=()):
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_request(self, method):
        url = urlsplit(self.path)
        form = parse_qs(self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode()) if method == 'POST' else {}
        prefix = self.headers.get('X-Forwarded-Prefix', '')
        if method == 'POST' and url.path == '/_pneuma-space/trigger/export':
            export(self.db, self.files_dir)
            return self.reply(204)
        query = parse_qs(url.query)
        if method == 'GET' and query.get('lang', [''])[0] in DICT:
            lang = query.pop('lang')[0]
            rest = f'?{urlencode(query, doseq=True)}' if query else ''
            return self.reply(303, headers=(('Location', prefix + url.path + rest),
                                            ('Set-Cookie', f'lang={lang}; Path={prefix or "/"}; Max-Age=31536000; SameSite=Lax')))
        lang = pick_lang(self.headers)
        subject = self.headers.get('X-Pneuma-Space-Subject')
        if not subject:
            return self.reply(401, DICT[lang]['signIn'].encode())
        owner = self.headers.get('X-Pneuma-Space-Owner') == '1'
        route = f'{method} {url.path}'
        if route == 'GET /':
            name = self.headers.get('X-Pneuma-Space-Name', subject)
            return self.reply(200, home(prefix, lang, subject, name, owner, self.db, self.files_dir).encode(), 'text/html; charset=utf-8')
        if route == 'POST /notes':
            text = form.get('body', [''])[0].strip()[:500]
            if text:
                self.db.run('INSERT INTO note (id, subject, name, body, created_at) VALUES (?, ?, ?, ?, ?)',
                            (str(uuid.uuid4()), subject, self.headers.get('X-Pneuma-Space-Name', subject), text,
                             datetime.now(timezone.utc).isoformat(timespec='milliseconds')))
            return self.reply(303, headers=(('Location', f'{prefix}/'),))
        if route == 'GET /notes.csv':
            if not owner:
                return self.reply(403, DICT[lang]['ownerOnly'].encode())
            try:
                with open(os.path.join(self.files_dir, 'notes.csv'), 'rb') as f:
                    return self.reply(200, f.read(), 'text/csv; charset=utf-8')
            except FileNotFoundError:
                return self.reply(404, DICT[lang]['never'].encode())
        self.reply(404, b'not found')


def main():
    Handler.db = Db(os.environ['PNEUMA_SPACE_DB_URL'])
    Handler.files_dir = os.environ['PNEUMA_SPACE_FILES_DIR']
    migrate(Handler.db)
    server = ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PNEUMA_SPACE_PORT', '8000'))), Handler)
    # Non-daemon threads let server_close finish requests in flight when the platform retires the instance.
    server.daemon_threads = False
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
    print(f'notes-py on :{server.server_port} with {Handler.db.engine}', flush=True)
    server.serve_forever()
    server.server_close()


if __name__ == '__main__':
    main()
