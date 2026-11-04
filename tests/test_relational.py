import importlib.util
import os
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('order_probe', os.path.join(os.path.dirname(__file__), '..', 'prototype', '02-storage', 'order_probe.py'))
order_probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(order_probe)


class RelationalBusinessTest(unittest.TestCase):
    def test_sqlite_order_business_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            order_probe.run('sqlite', os.path.join(temp, 'orders.sqlite3'))


if __name__ == '__main__':
    unittest.main()
