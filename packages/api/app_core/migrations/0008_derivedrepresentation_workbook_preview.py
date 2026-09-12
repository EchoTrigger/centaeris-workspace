from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("app_core", "0007_materialresultsnapshot")]

    operations = [
        migrations.AddField(
            model_name="derivedrepresentation",
            name="workbookPreviewKey",
            field=models.CharField(blank=True, default="", max_length=1000),
        ),
        migrations.AddField(
            model_name="derivedrepresentation",
            name="workbookPreviewSizeBytes",
            field=models.PositiveBigIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="derivedrepresentation",
            name="workbookPreviewSha256",
            field=models.CharField(blank=True, default="", max_length=71),
        ),
    ]
