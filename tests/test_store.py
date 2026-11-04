import concurrent.futures
import importlib.util
import os
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("store", os.path.join(os.path.dirname(__file__), "..", "templates", "counter", "store.py"))
store_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store_module)


class SQLiteStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = os.path.join(self.temp.name, "counter.db")
        self.store = store_module.CounterStore("sqlite", self.path)
        self.store.setup()

    def test_persistence_and_atomic_concurrent_increments(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: self.store.increment(), range(40)))
        reopened = store_module.CounterStore("sqlite", self.path)
        reopened.setup()
        self.assertEqual(reopened.get(), 40)

    def test_transaction_rolls_back_and_constraints_hold(self):
        with self.assertRaises(sqlite3.IntegrityError):
            with self.store.transaction() as db:
                db.execute("UPDATE counter SET value = 5 WHERE id = 1")
                db.execute("UPDATE counter SET value = -1 WHERE id = 1")
        self.assertEqual(self.store.get(), 0)
        with self.assertRaises(sqlite3.IntegrityError):
            with self.store.transaction() as db:
                db.execute("INSERT INTO counter VALUES (2, 0)")

    def test_unknown_backend_is_rejected(self):
        with self.assertRaises(ValueError):
            store_module.CounterStore("not-a-backend", self.path)


if __name__ == "__main__":
    unittest.main()
