"""Portable JSON-record operations with optimistic concurrency, for trusted apps."""
import json
import re
from store import Database

IDENTIFIER = re.compile(r"^[a-zA-Z0-9_-]{1,80}$")
MAX_VALUE_BYTES = 65536


class RecordStore:
    """Create/get/list/replace/delete records. Revisions start at one."""
    def __init__(self, backend, path=None):
        self.database = Database(backend, path)
        self.placeholder = "?" if backend == "sqlite" else "%s"

    def _sql(self, query):
        return query.replace("?", self.placeholder)

    def _id(self, value):
        if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
            raise ValueError("collection and key must contain 1-80 ASCII letters, digits, underscores or hyphens")
        return value

    def _revision(self, value):
        if type(value) is not int or value < 1:
            raise ValueError("revision must be a positive integer")
        return value

    def _encode(self, value):
        try:
            result = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            raise ValueError("value must be valid JSON") from exc
        if len(result.encode("utf-8")) > MAX_VALUE_BYTES:
            raise ValueError("value exceeds 64 KiB")
        return result

    @staticmethod
    def _record(row):
        return None if row is None else {"key": row[0], "value": json.loads(row[1]), "revision": row[2]}

    def setup(self):
        with self.database.transaction() as db:
            db.execute("CREATE TABLE IF NOT EXISTS appbase_records (collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1), deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1)), PRIMARY KEY (collection, key))")

    def create(self, collection, key, value):
        args = (self._id(collection), self._id(key), self._encode(value))
        with self.database.transaction() as db:
            cursor = db.execute(self._sql("INSERT INTO appbase_records (collection, key, value, revision, deleted) VALUES (?, ?, ?, 1, 0) ON CONFLICT (collection, key) DO UPDATE SET value = excluded.value, revision = appbase_records.revision + 1, deleted = 0 WHERE appbase_records.deleted = 1"), args)
            return cursor.rowcount == 1

    def get(self, collection, key):
        with self.database.transaction() as db:
            row = db.execute(self._sql("SELECT key, value, revision FROM appbase_records WHERE collection = ? AND key = ? AND deleted = 0"), (self._id(collection), self._id(key))).fetchone()
        return self._record(row)

    def list(self, collection, after="", limit=100):
        self._id(collection)
        if after:
            self._id(after)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")
        with self.database.transaction() as db:
            rows = db.execute(self._sql("SELECT key, value, revision FROM appbase_records WHERE collection = ? AND deleted = 0 AND key > ? ORDER BY key LIMIT ?"), (collection, after, limit)).fetchall()
        return [self._record(row) for row in rows]

    def replace(self, collection, key, value, revision):
        args = (self._encode(value), self._id(collection), self._id(key), self._revision(revision))
        with self.database.transaction() as db:
            cursor = db.execute(self._sql("UPDATE appbase_records SET value = ?, revision = revision + 1 WHERE collection = ? AND key = ? AND revision = ? AND deleted = 0"), args)
            return cursor.rowcount == 1

    def delete(self, collection, key, revision):
        args = (self._id(collection), self._id(key), self._revision(revision))
        with self.database.transaction() as db:
            cursor = db.execute(self._sql("UPDATE appbase_records SET deleted = 1, revision = revision + 1 WHERE collection = ? AND key = ? AND revision = ? AND deleted = 0"), args)
            return cursor.rowcount == 1
