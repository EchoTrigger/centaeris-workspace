import os
import unittest
from unittest.mock import patch

import runtime_outbox_gate as gate


class OutboxGateTests(unittest.TestCase):
    def test_database_target_ignores_deployment_settings(self):
        with patch.dict(os.environ, {'DATABASE_URL': 'postgresql://production', 'POSTGRES_PASSWORD': 'production', 'CENTAERIS_TEST_POSTGRES_URL': 'postgresql://production'}, clear=True):
            self.assertEqual(gate.database_settings(), {'host': 'localhost', 'port': '55432', 'dbname': 'centaeris', 'user': 'centaeris', 'password': 'centaeris'})

    def test_empty_discovery_cannot_pass(self):
        with self.assertRaises(RuntimeError):
            gate.discovered_tests('0 tests, 0 benchmarks')
        self.assertEqual(gate.discovered_tests('postgres_store::tests::postgres_outbox_case: test\n'), ['postgres_store::tests::postgres_outbox_case'])


if __name__ == '__main__':
    unittest.main()
