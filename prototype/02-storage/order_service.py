"""Identical order business interface on the two prototype SQL backends."""
from relational import RelationalDatabase


class _OutOfStock(Exception):
    pass


def _text(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 80 or '\x00' in value:
        raise ValueError('text must contain 1–80 characters and no NUL')
    return value


def _integer(value, minimum):
    if type(value) is not int or not minimum <= value <= 2147483647:
        raise ValueError('integer is outside the supported range')
    return value


class OrderService:
    def __init__(self, backend, path=None):
        self.db = RelationalDatabase(backend, path)

    def setup(self):
        with self.db.transaction() as tx:
            tx.execute('CREATE TABLE IF NOT EXISTS stock_items (sku TEXT PRIMARY KEY, category TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity >= 0), price_cents INTEGER NOT NULL CHECK(price_cents >= 0))')
            tx.execute('CREATE TABLE IF NOT EXISTS purchases (order_id TEXT PRIMARY KEY, sku TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0), price_cents INTEGER NOT NULL CHECK(price_cents >= 0))')

    def add_stock(self, sku, category, quantity, price_cents):
        _text(sku)
        _text(category)
        _integer(quantity, 0)
        _integer(price_cents, 0)
        with self.db.transaction() as tx:
            return tx.execute('INSERT INTO stock_items VALUES ({}, {}, {}, {}) ON CONFLICT (sku) DO NOTHING', sku, category, quantity, price_cents).rowcount == 1

    def purchase(self, order_id, sku, quantity):
        _text(order_id)
        _text(sku)
        _integer(quantity, 1)
        try:
            with self.db.transaction() as tx:
                if tx.execute('SELECT order_id FROM purchases WHERE order_id = {}', order_id).fetchone():
                    return 'duplicate'
                item = tx.execute('SELECT price_cents FROM stock_items WHERE sku = {}', sku).fetchone()
                if item is None:
                    return 'not_found'
                inserted = tx.execute('INSERT INTO purchases VALUES ({}, {}, {}, {}) ON CONFLICT (order_id) DO NOTHING', order_id, sku, quantity, item[0]).rowcount
                if not inserted:
                    return 'duplicate'
                changed = tx.execute('UPDATE stock_items SET quantity = quantity - {} WHERE sku = {} AND quantity >= {}', quantity, sku, quantity).rowcount
                if not changed:
                    raise _OutOfStock()
            return 'created'
        except _OutOfStock:
            return 'out_of_stock'

    def cancel(self, order_id):
        _text(order_id)
        with self.db.transaction() as tx:
            row = tx.execute('SELECT sku, quantity FROM purchases WHERE order_id = {}', order_id).fetchone()
            if row is None:
                return 'not_found'
            deleted = tx.execute('DELETE FROM purchases WHERE order_id = {}', order_id).rowcount
            if not deleted:
                return 'not_found'
            tx.execute('UPDATE stock_items SET quantity = quantity + {} WHERE sku = {}', row[1], row[0])
        return 'cancelled'

    def stock(self, sku):
        _text(sku)
        with self.db.transaction(write=False) as tx:
            row = tx.execute('SELECT quantity FROM stock_items WHERE sku = {}', sku).fetchone()
            return None if row is None else row[0]

    def find_orders(self, sku, minimum_quantity):
        _text(sku)
        _integer(minimum_quantity, 0)
        with self.db.transaction(write=False) as tx:
            return tx.execute('SELECT order_id, sku, quantity, price_cents FROM purchases WHERE sku = {} AND quantity >= {} ORDER BY order_id', sku, minimum_quantity).fetchall()

    def sales_by_category(self, category, minimum_units):
        _text(category)
        _integer(minimum_units, 0)
        with self.db.transaction(write=False) as tx:
            return tx.execute('SELECT s.category, SUM(p.quantity), SUM(p.quantity * p.price_cents) FROM purchases p JOIN stock_items s ON p.sku = s.sku WHERE s.category = {} GROUP BY s.category HAVING SUM(p.quantity) >= {}', category, minimum_units).fetchall()
