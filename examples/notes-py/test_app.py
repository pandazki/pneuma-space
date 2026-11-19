import os
import re
import socket
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

import app

FORM = 'body=framed 审查 note'.encode()


def chunked(*pieces):
    return b''.join(b'%x\r\n%s\r\n' % (len(piece), piece) for piece in pieces)


def gateway_encode(name):
    """docs/app-contract.md: `%`, control characters and non-ASCII bytes as percent-encoded UTF-8, every other byte literal."""
    return ''.join(''.join(f'%{b:02X}' for b in ch.encode()) if ch == '%' or ord(ch) < 0x20 or ord(ch) >= 0x7f else ch
                   for ch in name)


class DisplayNameTest(unittest.TestCase):
    def test_the_gateway_encoding_round_trips(self):
        for name in ('alice', '审查用户', '100% real', 'a+b c', '日本語 & <b>', 'Ünï %41 码'):
            self.assertEqual(app.display_name(gateway_encode(name)), name)

    def test_a_value_that_is_not_valid_percent_encoding_is_kept_as_sent(self):
        for raw in ('%', '%E5%AE', '%ZZ', '%E5%AE%A1%ZZ'):
            self.assertEqual(app.display_name(raw), raw)


class BodyTest(unittest.TestCase):
    """A real http.server on a local port, sent raw bytes so the framing is exactly what a client chose."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.db = app.Db(f'sqlite://{self.dir}/app.sqlite3')
        app.migrate(self.db)
        handler = type('Handler', (app.Handler,), {'db': self.db, 'files_dir': self.dir, 'log_message': lambda *_: None})
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def post(self, framing, body):
        """POST /notes, then the end of the request side; the response status, or None when none came."""
        head = ('POST /notes HTTP/1.1\r\nHost: notes\r\nX-Forwarded-Prefix: /apps/notes-py\r\nX-Pneuma-Space-Subject: user:alice\r\n'
                f'X-Pneuma-Space-Name: alice\r\nContent-Type: application/x-www-form-urlencoded\r\n{framing}\r\n')
        response = b''
        with socket.create_connection(self.server.server_address) as client:
            client.sendall(head.encode() + body)
            client.shutdown(socket.SHUT_WR)
            while True:
                piece = client.recv(65536)
                if not piece:
                    break
                response += piece
        return int(response.split(b' ', 2)[1]) if response else None

    def notes(self):
        return [body for (body,) in self.db.run('SELECT body FROM note')]

    def test_a_chunked_form_saves_the_same_note_as_one_with_content_length(self):
        inside = FORM.index('审'.encode()) + 1
        body = b'4;name=value\r\n' + FORM[:4] + b'\r\n' + chunked(FORM[4:inside], FORM[inside:]) + b'0\r\nX-Checksum: 1\r\n\r\n'
        statuses = (self.post(f'Content-Length: {len(FORM)}\r\n', FORM), self.post('Transfer-Encoding: chunked\r\n', body))
        self.assertEqual(statuses, (303, 303))
        self.assertEqual(self.notes(), ['framed 审查 note'] * 2)

    def test_a_body_that_ends_early_or_has_a_bad_chunk_size_answers_400_and_saves_nothing(self):
        statuses = (
            self.post('Transfer-Encoding: chunked\r\n', chunked(FORM)),
            self.post('Transfer-Encoding: chunked\r\n', b'zz\r\n' + FORM + b'\r\n0\r\n\r\n'),
            self.post(f'Content-Length: {len(FORM) + 10}\r\n', FORM),
        )
        self.assertEqual(statuses, (400, 400, 400))
        self.assertEqual(self.notes(), [])

    def test_a_body_over_the_limit_answers_413_and_saves_nothing(self):
        big = b'body=' + b'x' * (8 * app.FORM_LIMIT)
        statuses = (self.post(f'Content-Length: {len(big)}\r\n', big), self.post('Transfer-Encoding: chunked\r\n', chunked(big) + b'0\r\n\r\n'))
        self.assertEqual(statuses, (413, 413))
        self.assertEqual(self.notes(), [])


class NotesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.db = app.Db(f'sqlite://{self.dir}/app.sqlite3')
        app.migrate(self.db)
        self.db.run('INSERT INTO note (id, subject, name, body, created_at) VALUES (?, ?, ?, ?, ?)',
                    ('n1', 'user:alice', 'alice', '=SUM(A1)', '2026-11-06T00:00:00.000+00:00'))

    def test_export_redelivery_leaves_the_file_unchanged(self):
        app.export(self.db, self.dir)
        path = os.path.join(self.dir, 'notes.csv')
        os.utime(path, ns=(1_000_000_000, 1_000_000_000))
        first = open(path, 'rb').read()
        app.export(self.db, self.dir)
        self.assertIn(b"\"'=SUM(A1)\"", first)
        self.assertEqual(open(path, 'rb').read(), first)
        self.assertEqual(os.stat(path).st_mtime_ns, 1_000_000_000)

    def test_every_link_and_form_starts_with_the_prefix(self):
        html = app.home('/apps/notes-py', 'en', 'user:alice', 'alice', True, self.db, self.dir)
        urls = re.findall(r'(?:href|src|action)="([^"]*)"', html)
        self.assertGreater(len(urls), 5)
        self.assertEqual([u for u in urls if not u.startswith('/apps/notes-py/')], [])


if __name__ == '__main__':
    unittest.main()
