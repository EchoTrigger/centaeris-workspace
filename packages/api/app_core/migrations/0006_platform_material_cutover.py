"""One-way cutover. Stop old Runtime/material dispatchers before applying."""
from django.db import migrations, models


def transfer_tasks(apps, schema_editor):
    Task = apps.get_model("app_core", "MaterialProcessingTask")
    Representation = apps.get_model("app_core", "DerivedRepresentation")
    for task in Task.objects.filter(executionBackend="runtime").iterator():
        old = task.payload
        if old.get("schema") != "knowledge.process.payload.v1":
            raise ValueError("Cannot migrate unknown material task payload")
        task.payload = {"schema": "workspace.material.processing.v1",
                        "inputIdentity": old["inputIdentity"],
                        "specDigest": old["specDigest"], "sizeBytes": old["sizeBytes"]}
        task.executionBackend = "platform"
        task.status = "completed" if Representation.objects.filter(pk=task.pk).exists() else "pending"
        task.errorCode = ""
        task.leaseOwner, task.leaseExpiresAt = "", None
        task.leaseEpoch += 1
        task.attemptCount = 0
        task.save(update_fields=["payload", "executionBackend", "status", "errorCode",
                                "leaseOwner", "leaseExpiresAt", "leaseEpoch", "attemptCount"])


class Migration(migrations.Migration):
    dependencies = [("app_core", "0005_materialprocessor_materialstagedobject")]
    operations = [
        migrations.RunPython(transfer_tasks),
        migrations.AlterField(
            model_name="materialprocessingtask", name="executionBackend",
            field=models.CharField(max_length=16, default="platform", db_index=True),
        ),
    ]
