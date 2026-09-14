from django.db import migrations


def create_tool_result_lookup_index(_apps, schema_editor):
    if schema_editor.connection.vendor == "sqlite":
        return
    if schema_editor.connection.vendor != "postgresql":
        raise RuntimeError("session event tool-result index requires PostgreSQL")
    schema_editor.execute(
        """
        CREATE INDEX session_event_tool_result_lookup
        ON app_core_sessionevent (
            session_id,
            ((payload #>> '{payload,callId}'))
        )
        WHERE payload ->> 'type' = 'tool_result'
        """
    )


def drop_tool_result_lookup_index(_apps, schema_editor):
    if schema_editor.connection.vendor == "sqlite":
        return
    if schema_editor.connection.vendor != "postgresql":
        raise RuntimeError("session event tool-result index requires PostgreSQL")
    schema_editor.execute("DROP INDEX session_event_tool_result_lookup")


class Migration(migrations.Migration):
    dependencies = [("app_core", "0001_initial")]

    operations = [
        migrations.RunPython(
            create_tool_result_lookup_index,
            drop_tool_result_lookup_index,
        ),
    ]
