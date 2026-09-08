import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'harness' / 'control.py'
spec = importlib.util.spec_from_file_location('perf_control', SOURCE)
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class IsolationTests(unittest.TestCase):
    def test_terminal_accounting_is_exact_and_cancellation_is_not_completion(self):
        self.assertEqual(control.account_runs(['a', 'b'], [{'id': 'a', 'status': 'completed'}, {'id': 'b', 'status': 'completed'}]), {'completed': 2})
        for rows in ([{'id': 'a', 'status': 'completed'}],
                     [{'id': 'a', 'status': 'completed'}, {'id': 'b', 'status': 'cancelled'}]):
            with self.assertRaises(RuntimeError):
                control.account_runs(['a', 'b'], rows)
        with self.assertRaises(RuntimeError):
            control.account_runs(['a'], [{'id': 'a', 'status': 'completed'}], accepted_count=2)

    def test_rendered_compose_is_isolated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.env.example').write_text((control.ROOT / '.env.example').read_text())
            env_file = control.initialize(root)
            command, env = control.compose_command(control.ROOT, env_file, ['config', '--format', 'json'])
            config = json.loads(control.run(command, env=env))
            control.validate_config(config, control.ROOT)
            self.assertEqual(config['services']['api']['image'], 'centaeris-perf-api:local')
            self.assertEqual(config['services']['material-worker']['image'], 'centaeris-perf-api:local')
            self.assertEqual(config['services']['material-worker']['environment']['MATERIAL_PROCESSOR_IMAGE'],
                             config['services']['document-processor']['image'])
            self.assertEqual(config['services']['runtime']['environment']['PLUGIN_VOLUME_NAME'], 'centaeris-perf_plugin-data')

    def test_smoke_rejects_unsuccessful_terminals(self):
        spec = importlib.util.spec_from_file_location('perf_bootstrap', SOURCE.parent / 'bootstrap.py')
        bootstrap = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bootstrap)
        self.assertTrue(bootstrap.completed_terminal('completed'))
        self.assertFalse(bootstrap.completed_terminal('running'))
        for state in ('failed', 'cancelled', 'interrupted'):
            with self.assertRaises(RuntimeError):
                bootstrap.completed_terminal(state)

    def test_environment_is_generated_without_reading_private_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.env.example').write_text('COMPOSE_PROJECT_NAME=centaeris-workspace\nPOSTGRES_PASSWORD=\nAPI_HOST_PORT=8000\n')
            (root / '.env').write_text('POSTGRES_PASSWORD=production-secret')
            result = control.initialize(root)
            values = control.read_env(result)
            self.assertEqual(values['COMPOSE_PROJECT_NAME'], 'centaeris-perf')
            self.assertNotEqual(values['POSTGRES_PASSWORD'], 'production-secret')
            self.assertEqual((root / '.env').read_text(), 'POSTGRES_PASSWORD=production-secret')
            with self.assertRaises(FileExistsError):
                control.initialize(root)

    def test_compose_command_pins_every_input_and_clears_ambient_overrides(self):
        with patch.dict('os.environ', {'COMPOSE_FILE': 'production.yml', 'POSTGRES_PASSWORD': 'secret', 'WORKER_SLOT_COUNT': '16'}):
            command, env = control.compose_command(Path('/repo'), Path('/repo/perf/.state/test.env'), ['config'])
        self.assertIn('centaeris-perf', command)
        self.assertIn('/repo/perf/compose.perf.yml', command)
        self.assertIn('/repo/perf/.state/test.env', command)
        self.assertNotIn('COMPOSE_FILE', env)
        self.assertNotIn('POSTGRES_PASSWORD', env)
        self.assertNotIn('WORKER_SLOT_COUNT', env)

    def test_validation_rejects_production_resources_and_missing_tls(self):
        valid = {
            'name': 'centaeris-perf',
            'volumes': {'data': {'name': 'centaeris-perf_data'}},
            'networks': {'default': {'name': 'centaeris-perf_default'}},
            'services': {name: {'environment': {'SSL_CERT_FILE': '/perf-certs/mock-ca.crt'},
                'volumes': [{'type': 'bind', 'source': '/repo/perf/certs/out/isolated/mock-ca.crt', 'target': '/perf-certs/mock-ca.crt', 'read_only': True}]}
                for name in ('api', 'runtime')},
        }
        control.validate_config(valid, Path('/repo'))
        for mutate in (
            lambda c: c.update(name='centaeris-workspace'),
            lambda c: c['volumes']['data'].update(name='centaeris-workspace_data'),
            lambda c: c['volumes']['data'].update(external=True),
            lambda c: c['services']['api']['environment'].clear(),
            lambda c: c['services']['api']['volumes'].clear(),
            lambda c: c['services']['api'].update(container_name='production-api'),
        ):
            config = json.loads(json.dumps(valid))
            mutate(config)
            with self.assertRaises(ValueError):
                control.validate_config(config, Path('/repo'))

    def test_switch_slots_preserves_nonworker_identity_and_refuses_busy_stack(self):
        fake = unittest.mock.Mock()
        fake.quiet.return_value = True
        fake.identities.return_value = {'api': 'a', 'runtime': 'r'}
        control.switch_slots(fake, 6)
        fake.compose.assert_called_once_with(['up', '-d', '--no-deps', '--force-recreate', 'worker'], slots=6)
        fake.verify_slots.assert_called_once_with(6)
        fake.quiet.return_value = False
        fake.compose.reset_mock()
        with self.assertRaises(RuntimeError):
            control.switch_slots(fake, 2)
        fake.compose.assert_not_called()
        fake.quiet.return_value = True
        fake.identities.side_effect = [{'api': 'a'}, {'api': 'b'}]
        with self.assertRaises(RuntimeError):
            control.switch_slots(fake, 2)

    def test_resource_parser_rejects_missing_or_invalid_samples(self):
        row = {'Name': 'centaeris-perf-api-1', 'CPUPerc': '12.5%', 'MemUsage': '20MiB / 1GiB'}
        self.assertEqual(control.parse_stats(json.dumps(row), {'centaeris-perf-api-1'})[0]['cpuPercent'], 12.5)
        for text in ('', '{}', json.dumps({**row, 'CPUPerc': '--'})):
            with self.assertRaises((ValueError, KeyError)):
                control.parse_stats(text, {'centaeris-perf-api-1'})


if __name__ == '__main__':
    unittest.main()
