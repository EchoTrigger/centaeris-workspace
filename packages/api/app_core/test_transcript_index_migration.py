import importlib
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase


migration = importlib.import_module(
    "app_core.migrations.0002_session_event_tool_result_lookup"
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class RecordingSchemaEditor:
    def __init__(self, vendor):
        self.connection = SimpleNamespace(vendor=vendor)
        self.statements = []

    def execute(self, statement):
        self.statements.append(statement)


class TranscriptToolResultIndexMigrationTests(TestCase):
    def test_postgresql_creates_and_drops_the_expression_index(self):
        editor = RecordingSchemaEditor("postgresql")

        migration.create_tool_result_lookup_index(None, editor)
        migration.drop_tool_result_lookup_index(None, editor)

        self.assertEqual(len(editor.statements), 2)
        self.assertIn("CREATE INDEX session_event_tool_result_lookup", editor.statements[0])
        self.assertIn("payload #>> '{payload,callId}'", editor.statements[0])
        self.assertIn(
            "WHERE payload ->> 'type' = 'tool_result'",
            editor.statements[0],
        )
        self.assertEqual(
            editor.statements[1].strip(),
            "DROP INDEX session_event_tool_result_lookup",
        )

    def test_sqlite_records_the_migration_without_postgresql_sql(self):
        editor = RecordingSchemaEditor("sqlite")

        migration.create_tool_result_lookup_index(None, editor)
        migration.drop_tool_result_lookup_index(None, editor)

        self.assertEqual(editor.statements, [])


class MigrationBaselineTests(TestCase):
    def test_schema_history_includes_pre_admission_cancellation(self):
        migration_directory = Path(__file__).with_name("migrations")

        self.assertEqual(
            sorted(
                path.name
                for path in migration_directory.glob("[0-9][0-9][0-9][0-9]_*.py")
            ),
            [
                "0001_initial.py",
                "0002_session_event_tool_result_lookup.py",
                "0003_agentrun_pre_admission_cancelled.py",
            ],
        )

    def test_release_gate_checks_the_current_migration_leaf(self):
        release_gate = (
            REPOSITORY_ROOT / "scripts" / "docker-release-gate.sh"
        ).read_text(encoding="utf-8")

        self.assertIn("0003_agentrun_pre_admission_cancelled", release_gate)

    def test_cancellation_receipt_extends_the_existing_migration_chain(self):
        receipt = importlib.import_module(
            "app_core.migrations.0003_agentrun_pre_admission_cancelled"
        ).Migration
        self.assertEqual(receipt.dependencies, [
            ("app_core", "0002_session_event_tool_result_lookup")
        ])
        self.assertEqual(len(receipt.operations), 1)
        operation = receipt.operations[0]
        self.assertEqual((operation.model_name, operation.name),
                         ("agentrun", "preAdmissionCancelledAt"))
        self.assertTrue(operation.field.null)
        self.assertFalse(operation.field.editable)

    def test_postgresql_index_depends_directly_on_the_schema_baseline(self):
        self.assertEqual(migration.Migration.dependencies, [("app_core", "0001_initial")])
