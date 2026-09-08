import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("app_core", "0001_initial")]
    operations = [
        migrations.CreateModel(
            name="MaterialProcessingTask",
            fields=[
                ("representationId", models.CharField(max_length=96, primary_key=True, serialize=False)),
                ("processingSpecification", models.JSONField()),
                ("payload", models.JSONField()),
                ("status", models.CharField(db_index=True, default="pending", max_length=16)),
                ("errorCode", models.CharField(blank=True, default="", max_length=96)),
                ("createdAt", models.DateTimeField(auto_now_add=True)),
                ("updatedAt", models.DateTimeField(auto_now=True)),
            ],
        ),
        migrations.CreateModel(
            name="MaterialOperation",
            fields=[
                ("id", models.CharField(max_length=96, primary_key=True, serialize=False)),
                ("inputRef", models.CharField(max_length=1024)),
                ("cancelledAt", models.DateTimeField(blank=True, null=True)),
                ("createdAt", models.DateTimeField(auto_now_add=True)),
                ("agent_run", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="app_core.agentrun")),
                ("task", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="operations", to="app_core.materialprocessingtask")),
            ],
            options={"constraints": [models.UniqueConstraint(fields=("agent_run", "task"), name="unique_run_material_operation")]},
        ),
    ]
