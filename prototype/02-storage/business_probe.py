"""Business-level experiment for the two prototype database backends.

Run only against a disposable database: it creates and clears probe_* tables.
"""
import concurrent.futures
import os
import sqlite3
import sys

TEMPLATE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '00-appbase-python', 'templates', 'counter'))
if os.path.isdir(TEMPLATE):
    sys.path.insert(0, TEMPLATE)
from records import RecordStore
from store import Database


def run(backend, path):
    records = RecordStore(backend, path)
    records.setup()
    # A real query: count yes/no survey responses. The record API only lists by
    # collection/key, so filtering and aggregation must happen in application code.
    for i in range(111):
        assert records.create('survey_probe', 'response_%03d' % i, {'choice': 'yes' if i % 3 == 0 else 'no'})
    cursor, seen, yes = '', 0, 0
    while True:
        page = records.list('survey_probe', after=cursor, limit=50)
        if not page:
            break
        seen += len(page)
        yes += sum(row['value']['choice'] == 'yes' for row in page)
        cursor = page[-1]['key']
    assert (seen, yes) == (111, 37), (seen, yes)

    database = Database(backend, path)
    placeholder = '?' if backend == 'sqlite' else '%s'
    sql = lambda statement: statement.replace('?', placeholder)
    with database.transaction() as db:
        db.execute('CREATE TABLE probe_stock (sku TEXT PRIMARY KEY, quantity INTEGER NOT NULL CHECK(quantity >= 0))')
        db.execute('CREATE TABLE probe_orders (id TEXT PRIMARY KEY, sku TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty > 0))')
        db.execute(sql('INSERT INTO probe_stock VALUES (?, ?)'), ('item', 5))

    def place_order(order_id):
        with database.transaction() as db:
            changed = db.execute(sql('UPDATE probe_stock SET quantity = quantity - 1 WHERE sku = ? AND quantity > 0'), ('item',)).rowcount
            if not changed:
                return False
            db.execute(sql('INSERT INTO probe_orders VALUES (?, ?, ?)'), (order_id, 'item', 1))
            return True

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(lambda i: place_order('order-%d' % i), range(12)))
    assert sum(outcomes) == 5, outcomes
    with database.transaction() as db:
        stock = db.execute('SELECT quantity FROM probe_stock').fetchone()[0]
        count, quantity = db.execute('SELECT COUNT(*), SUM(qty) FROM probe_orders').fetchone()
        duplicate = db.execute('SELECT id FROM probe_orders ORDER BY id LIMIT 1').fetchone()[0]
        db.execute('UPDATE probe_stock SET quantity = 1')
    assert (stock, count, quantity) == (0, 5, 5)
    try:
        place_order(duplicate)
    except Exception as exc:
        expected = sqlite3.IntegrityError if backend == 'sqlite' else database.psycopg.errors.UniqueViolation
        if not isinstance(exc, expected):
            raise
    else:
        raise AssertionError('duplicate order was accepted')
    with database.transaction() as db:
        assert db.execute('SELECT quantity FROM probe_stock').fetchone()[0] == 1, 'rollback lost stock'
        assert db.execute('SELECT COUNT(*) FROM probe_orders').fetchone()[0] == 5
    print('%s: survey pagination/filter 111 responses; stock/order transaction, 12 concurrent orders, duplicate rollback passed' % backend, flush=True)


if __name__ == '__main__':
    import tempfile
    with tempfile.TemporaryDirectory() as temp:
        run('sqlite', os.path.join(temp, 'business.sqlite3'))
