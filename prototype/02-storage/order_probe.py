"""Run this business-contract probe only against disposable databases."""
import concurrent.futures
import os
import sys

HERE = os.path.dirname(__file__)
TEMPLATE = os.path.abspath(os.path.join(HERE, '..', '..', 'templates', 'counter'))
for path in (HERE, TEMPLATE):
    if os.path.isdir(path):
        sys.path.insert(0, path)
from order_service import OrderService


def run(backend, path):
    service = OrderService(backend, path)
    service.setup()
    service.setup()  # Startup can run again after a container restart.
    assert service.add_stock('sku-a', "books'50%", 5, 125)
    assert not service.add_stock('sku-a', 'duplicate', 99, 999)
    assert service.add_stock('sku-b', "books'50%", 3, 200)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda i: service.purchase('order-%02d' % i, 'sku-a', 1), range(12)))
    assert results.count('created') == 5 and results.count('out_of_stock') == 7, results
    assert service.stock('sku-a') == 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        same = list(pool.map(lambda _: service.purchase('same-order', 'sku-b', 1), range(8)))
    assert same.count('created') == 1 and same.count('duplicate') == 7, same
    assert service.stock('sku-b') == 2
    assert len(service.find_orders('sku-a', 1)) == 5
    assert service.find_orders("sku-a' OR 1=1 --", 1) == []
    assert service.sales_by_category("books'50%", 6) == [("books'50%", 6, 825)]
    assert service.sales_by_category("books'50%", 7) == []
    try:
        with service.db.transaction() as tx:
            assert tx.execute('SELECT quantity FROM stock_items WHERE sku = {}', 'sku-b').fetchone()[0] == 2
            tx.execute('UPDATE stock_items SET quantity = quantity - {} WHERE sku = {}', 1, 'sku-b')
            tx.execute('INSERT INTO purchases VALUES ({}, {}, {}, {})', 'rollback', 'sku-b', 1, 200)
            raise RuntimeError('deliberate rollback')
    except RuntimeError as exc:
        assert str(exc) == 'deliberate rollback'
    assert service.stock('sku-b') == 2
    assert all(row[0] != 'rollback' for row in service.find_orders('sku-b', 1))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        cancellations = list(pool.map(lambda _: service.cancel('same-order'), range(4)))
    assert cancellations.count('cancelled') == 1 and cancellations.count('not_found') == 3, cancellations
    assert service.cancel('same-order') == 'not_found'
    assert service.stock('sku-b') == 3
    assert service.find_orders('sku-b', 1) == []
    assert service.sales_by_category("books'50%", 5) == [("books'50%", 5, 625)]
    with service.db.transaction(write=False) as tx:
        assert tx.execute("SELECT {}, '50%', '{{}}'", "O'Reilly").fetchone() == ("O'Reilly", '50%', '{}')
        try:
            tx.execute('SELECT {}, {}', 1)
        except ValueError:
            pass
        else:
            raise AssertionError('mismatched bind parameters accepted')
    print(backend + ': shared SQL API; atomic multi-row order transactions; concurrency, duplicate, rollback, CRUD, filtering and aggregation passed', flush=True)
