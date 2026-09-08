import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("app_core", "0002_materialprocessingtask_materialoperation")]
    operations = [migrations.CreateModel(
        name="MaterialEvidenceReceipt",
        fields=[
            ("id", models.CharField(max_length=96, primary_key=True, serialize=False)),
            ("authorizationDigest", models.CharField(max_length=71)),
            ("responseText", models.TextField()),
            ("evidence", models.JSONField()),
            ("createdAt", models.DateTimeField(auto_now_add=True)),
            ("call", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE,
                related_name="materialReceipt", to="app_core.sessionevent")),
        ],
    )]
