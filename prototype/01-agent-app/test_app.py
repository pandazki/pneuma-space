import io
import os
import re
import tempfile
import unittest
from urllib.parse import urlencode

from app import make_handler
from records import RecordStore


class QuestionnaireTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.temp.name, 'data.sqlite3')
        self.start()

    def start(self):
        self.store = RecordStore('sqlite', self.path)
        self.store.setup()

    def stop(self):
        pass

    def tearDown(self):
        self.temp.cleanup()

    def request(self, method, path, data=None):
        body = urlencode(data).encode() if data is not None else b''
        request = (f"{method} {path} HTTP/1.0\r\nHost: localhost\r\n"
                   "X-Forwarded-Prefix: /apps/survey\r\n"
                   "Content-Type: application/x-www-form-urlencoded\r\n"
                   f"Content-Length: {len(body)}\r\n\r\n").encode() + body

        class Socket:
            def __init__(self):
                self.input = io.BytesIO(request)
                self.output = io.BytesIO()
            def makefile(self, mode, *args, **kwargs):
                if 'r' in mode:
                    return self.input
                class Output(io.BytesIO):
                    def close(inner):
                        self.output.write(inner.getvalue())
                return Output()
            def sendall(self, data):
                self.output.write(data)

        sock = Socket()
        class QuietHandler(make_handler(self.store)):
            def log_message(self, *args):
                pass
        QuietHandler(sock, ('127.0.0.1', 12345), object())
        head, content = sock.output.getvalue().split(b'\r\n\r\n', 1)
        lines = head.decode().split('\r\n')
        status = int(lines[0].split()[1])
        location = next((line.split(': ', 1)[1] for line in lines[1:] if line.lower().startswith('location: ')), None)
        return status, location, content.decode()

    def test_create_answer_conflict_and_restart(self):
        status, location, _ = self.request('POST', '/create', {'title': '<Ideas>', 'question': 'What next?'})
        self.assertEqual(status, 303)
        self.assertRegex(location, r'^/apps/survey/survey/[0-9a-f]{32}$')
        key = location.rsplit('/', 1)[1]
        status, _, page = self.request('GET', '/survey/' + key)
        self.assertEqual(status, 200)
        self.assertIn('&lt;Ideas&gt;', page)
        self.assertIn("action='/apps/survey/answer/", page)
        self.assertEqual(self.request('POST', '/answer/' + key, {'answer': '<hello>', 'revision': '1'})[0], 303)
        status, _, page = self.request('POST', '/answer/' + key, {'answer': 'late', 'revision': '1'})
        self.assertEqual(status, 409)
        self.assertIn('Your answer was not saved', page)
        self.assertIn('>late</textarea>', page)
        self.stop()
        self.start()
        status, _, page = self.request('GET', '/survey/' + key)
        self.assertEqual(status, 200)
        self.assertIn('&lt;hello&gt;', page)
        self.assertNotIn('<li>late</li>', page)
        self.assertIn('Answers (1)', page)
        self.assertIn('&lt;Ideas&gt;', self.request('GET', '/')[2])

    def test_validation_and_missing_survey(self):
        self.assertEqual(self.request('POST', '/create', {'title': ' ', 'question': 'Q'})[0], 400)
        self.assertEqual(self.request('GET', '/survey/' + 'a' * 32)[0], 404)
        self.assertEqual(self.request('GET', '/?after=bad%2Fcursor')[0], 400)
        self.assertEqual(self.request('POST', '/answer/' + 'a' * 32, {'answer': 'x', 'revision': '0'})[0], 400)

    def test_capacity_handles_worst_case_json_escaping(self):
        status, location, _ = self.request('POST', '/create', {'title': '\x01' * 120, 'question': '\x01' * 500})
        self.assertEqual(status, 303)
        key = location.rsplit('/', 1)[1]
        for revision in range(1, 51):
            self.assertEqual(self.request('POST', '/answer/' + key, {'answer': '\x01' * 200, 'revision': str(revision)})[0], 303)
        self.assertEqual(self.request('POST', '/answer/' + key, {'answer': 'one more', 'revision': '51'})[0], 409)


if __name__ == '__main__':
    unittest.main()
