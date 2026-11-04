import concurrent.futures
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'templates', 'counter')))
from records import RecordStore


class RecordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = os.path.join(self.temp.name, 'records.db')
        self.store = RecordStore('sqlite', self.path)
        self.store.setup()

    def test_crud_persistence_and_retries(self):
        self.assertTrue(self.store.create('notes', 'one', {'text': 'first'}))
        self.assertFalse(self.store.create('notes', 'one', {'text': 'duplicate'}))
        self.assertTrue(self.store.create('notes', 'two', [1, 2]))
        self.assertEqual(self.store.list('notes', limit=1)[0]['key'], 'one')
        self.assertEqual(self.store.list('notes', after='one')[0]['key'], 'two')
        record = self.store.get('notes', 'one')
        self.assertEqual(record, {'key': 'one', 'value': {'text': 'first'}, 'revision': 1})
        self.assertTrue(self.store.replace('notes', 'one', {'text': 'second'}, 1))
        self.assertFalse(self.store.replace('notes', 'one', {'text': 'duplicate retry'}, 1))
        reopened = RecordStore('sqlite', self.path)
        self.assertEqual(reopened.get('notes', 'one')['revision'], 2)
        self.assertFalse(reopened.delete('notes', 'one', 1))
        self.assertTrue(reopened.delete('notes', 'one', 2))
        self.assertFalse(reopened.delete('notes', 'one', 2))
        self.assertIsNone(reopened.get('notes', 'one'))
        self.assertTrue(reopened.create('notes', 'one', {'text': 'new'}))
        self.assertEqual(reopened.get('notes', 'one')['revision'], 4)
        self.assertFalse(reopened.replace('notes', 'one', {'text': 'stale'}, 1))

    def test_concurrent_updates_do_not_overwrite_each_other(self):
        self.store.create('notes', 'race', 0)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(lambda n: self.store.replace('notes', 'race', n, 1), range(20)))
        self.assertEqual(sum(outcomes), 1)
        self.assertEqual(self.store.get('notes', 'race')['revision'], 2)

    def test_validation(self):
        for invalid in ('', '../escape', 'x' * 81):
            with self.assertRaises(ValueError):
                self.store.create('notes', invalid, {})
        with self.assertRaises(ValueError):
            self.store.create('notes', 'large', 'x' * 65536)
        with self.assertRaises(ValueError):
            self.store.replace('notes', 'one', {}, True)
        with self.assertRaises(ValueError):
            self.store.create('notes', 'invalid-json', float('nan'))


if __name__ == '__main__':
    unittest.main()
