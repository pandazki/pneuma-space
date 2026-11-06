import os
import re
import tempfile
import unittest

import app


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
