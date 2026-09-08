from importlib import import_module

from django.apps import apps
from django.test import TestCase

from .models import MaterialProcessingTask


class MaterialCutoverTests(TestCase):
    def test_cutover_removes_waiter_credentials_and_invalidates_old_lease(self):
        identity = {"ownerKind": "sourceObject", "ownerId": "source-1",
                    "generation": 1, "sha256": "sha256:" + "a" * 64}
        task = MaterialProcessingTask.objects.create(
            representationId="representation:sha256:" + "b" * 64,
            executionBackend="runtime", processingSpecification={},
            status="running", leaseOwner="old-worker", leaseEpoch=7, attemptCount=2,
            payload={"schema": "knowledge.process.payload.v1", "agentRunId": "private",
                     "authorizationDigest": "private", "inputIdentity": identity,
                     "specDigest": "sha256:" + "c" * 64, "sizeBytes": 10},
        )
        migration = import_module("app_core.migrations.0006_platform_material_cutover")
        migration.transfer_tasks(apps, None)
        task.refresh_from_db()
        self.assertEqual(task.payload, {"schema": "workspace.material.processing.v1",
                                       "inputIdentity": identity, "specDigest": "sha256:" + "c" * 64,
                                       "sizeBytes": 10})
        self.assertEqual((task.executionBackend, task.status, task.leaseOwner,
                          task.leaseEpoch, task.attemptCount), ("platform", "pending", "", 8, 0))
        migration.transfer_tasks(apps, None)
        task.refresh_from_db()
        self.assertEqual(task.leaseEpoch, 8)
