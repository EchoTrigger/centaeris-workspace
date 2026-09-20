from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("app_core", "0002_session_event_tool_result_lookup")]
    operations = [migrations.AddField(
        model_name="agentrun", name="preAdmissionCancelledAt",
        field=models.DateTimeField(null=True, blank=True, editable=False),
    )]
