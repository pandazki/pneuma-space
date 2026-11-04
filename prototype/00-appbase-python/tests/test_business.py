import importlib.util
import os
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('business_probe', os.path.join(os.path.dirname(__file__), '..', '..', '02-storage', 'business_probe.py'))
business_probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(business_probe)


class BusinessTests(unittest.TestCase):
    def test_sqlite_survey_orders_and_transactions(self):
        with tempfile.TemporaryDirectory() as temp:
            business_probe.run('sqlite', os.path.join(temp, 'business.sqlite3'))


if __name__ == '__main__':
    unittest.main()
