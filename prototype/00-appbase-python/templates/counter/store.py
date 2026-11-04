"""Small, deliberately narrow storage contract for the counter example."""
from contextlib import contextmanager
import sqlite3


class Database:
    def __init__(self, backend, path=None):
        self.backend = backend
        self.path = path
        if backend not in ("sqlite", "postgres"):
            raise ValueError("DB_BACKEND must be sqlite or postgres")
        if backend == "postgres":
            import psycopg
            self.psycopg = psycopg

    def connect(self):
        if self.backend == "sqlite":
            return sqlite3.connect(self.path, timeout=10)
        # Standard libpq environment variables select the server and user.
        # A user-provided pgpass file is read from the persistent app volume.
        return self.psycopg.connect(passfile="/data/.pgpass", connect_timeout=5)

    @contextmanager
    def transaction(self):
        db = self.connect()
        try:
            with db:
                yield db
        finally:
            db.close()



class CounterStore(Database):
    def setup(self):
        with self.transaction() as db:
            db.execute("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK(id = 1), value INTEGER NOT NULL CHECK(value >= 0))")
            db.execute("INSERT INTO counter (id, value) VALUES (1, 0) ON CONFLICT (id) DO NOTHING")

    def get(self):
        with self.transaction() as db:
            value = db.execute("SELECT value FROM counter WHERE id = 1").fetchone()[0]
        return value

    def increment(self):
        with self.transaction() as db:
            db.execute("UPDATE counter SET value = value + 1 WHERE id = 1")
