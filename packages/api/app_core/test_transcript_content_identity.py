"""Historical tool output must never resolve through a mutable workspace path."""

import hashlib
import json
import tempfile

from django.contrib.auth.models import User
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.test import TestCase, override_settings

from .models import AgentRun, ModelConfig, SessionEvent, Workspace
from .testing import create_session


class TranscriptContentIdentityTests(TestCase):
    def setUp(self):
        storage = tempfile.TemporaryDirectory(prefix="transcript-content-identity-")
        self.addCleanup(storage.cleanup)
        media = override_settings(MEDIA_ROOT=storage.name)
        media.enable()
        self.addCleanup(media.disable)
        self.owner = User.objects.create_user(username="content-identity-owner")
        self.workspace = Workspace.objects.create(name="Content", createdBy=self.owner)
        self.workspace.members.add(self.owner)
        self.session = create_session(workspace=self.workspace, owner=self.owner)
        self.run = AgentRun.objects.create(
            workspace=self.workspace, session=self.session, user=self.owner,
            modelConfig=ModelConfig.objects.create(displayName="Content"), prompt="read",
        )
        self.path = ".agent-tool-results/result.log"
        self.prefix = b"capture:"
        self.client.force_login(self.owner)
        self.url = f"/api/sessions/{self.session.id}/transcript/content"

    def commit_output(self, content, *, spilled):
        payload = {
            "callId": "call-history", "toolName": "shell", "resultState": "successWithOutput",
            "modelContent": "original preview" if spilled else content,
            "outputComplete": True, "outputByteLength": len(content.encode("utf-8")),
            "fullOutputPath": self.path if spilled else None,
            "outputStartByte": len(self.prefix) if spilled else None,
            "summary": "output", "operations": [], "modelInputImages": [], "latencyMs": 1,
        }
        event_id = f"event:{self.run.id}:1"
        SessionEvent.objects.create(
            eventId=event_id, workspace=self.workspace, session=self.session,
            agent_run=self.run, sequence=1, agent_run_sequence=1,
            projects_to_agent_run_stream=True, createdAtMs=1,
            payload={
                "schemaVersion": "session.event.v1", "eventVersion": 1,
                "eventId": event_id, "type": "tool_result", "sequence": 1,
                "sessionId": self.session.id, "agentRunId": self.run.id,
                "turnId": self.run.turn_id, "createdAtMs": 1, "payload": payload,
            },
        )
        return {
            "projectionGeneration": "generation-1", "refId": "tool-output:call-history",
            "revision": "2", "byteLength": str(payload["outputByteLength"]), "offset": "0",
        }

    def replace_snapshot(self, content):
        file_bytes = self.prefix + content.encode("utf-8")
        manifest = {
            "schema": "workspace.snapshot.v1",
            "files": [{
                "path": self.path, "sizeBytes": len(file_bytes),
                "sha256": f"sha256:{hashlib.sha256(file_bytes).hexdigest()}", "executable": False,
            }],
        }
        encoded = json.dumps(manifest, separators=(",", ":")).encode()
        snapshot = len(encoded).to_bytes(4, "big") + encoded + file_bytes
        self.session.workspaceGeneration += 1
        self.session.workspaceStorageKey = default_storage.save(
            f"snapshots/{self.session.workspaceGeneration}.snapshot", ContentFile(snapshot)
        )
        self.session.workspaceSnapshotSha256 = f"sha256:{hashlib.sha256(snapshot).hexdigest()}"
        self.session.workspaceSnapshotSizeBytes = len(snapshot)
        self.session.workspaceExpandedSizeBytes = len(file_bytes)
        self.session.workspaceFileCount = 1
        self.session.workspaceLastAdvancedAgentRun = self.run
        self.session.save(update_fields=[
            "workspaceGeneration", "workspaceStorageKey", "workspaceSnapshotSha256",
            "workspaceSnapshotSizeBytes", "workspaceExpandedSizeBytes", "workspaceFileCount",
            "workspaceLastAdvancedAgentRun",
        ])

    def assert_unavailable(self, response):
        self.assertEqual(response.status_code, 409, response.content[:200])
        self.assertEqual(response.json(), {"error": "transcript_content_unavailable"})
        self.assertEqual(response["Cache-Control"], "no-store")

    def test_unversioned_spill_never_reads_the_current_snapshot(self):
        original = "A" * (50 * 1024 + 1)
        query = self.commit_output(original, spilled=True)
        self.replace_snapshot(original)
        before = self.client.get(self.url, query)
        self.replace_snapshot("B" * len(original))
        after = self.client.get(self.url, query)
        # Path/length alone cannot prove even the first snapshot is the original.
        for label, response in (("original snapshot", before), ("replacement", after)):
            with self.subTest(snapshot=label):
                self.assert_unavailable(response)

    def test_spill_continuation_cannot_mix_snapshot_versions(self):
        original = "x" * (64 * 1024 - 2) + "世"
        query = self.commit_output(original, spilled=True)
        self.replace_snapshot(original)
        self.client.get(self.url, query)
        self.replace_snapshot("y" * (64 * 1024 - 2) + "界")
        response = self.client.get(self.url, {**query, "offset": str(64 * 1024 - 2)})
        self.assert_unavailable(response)

    def test_deleted_original_snapshot_does_not_rebind_old_spill(self):
        original = "A" * (50 * 1024 + 1)
        query = self.commit_output(original, spilled=True)
        self.replace_snapshot(original)
        default_storage.delete(self.session.workspaceStorageKey)
        self.replace_snapshot("B" * len(original))
        self.assert_unavailable(self.client.get(self.url, query))

    def test_spill_without_a_snapshot_is_explicitly_unavailable(self):
        query = self.commit_output("A" * (50 * 1024 + 1), spilled=True)
        self.assert_unavailable(self.client.get(self.url, query))

    def test_spill_reference_reauthorizes_before_reporting_unavailable(self):
        query = self.commit_output("A" * (50 * 1024 + 1), spilled=True)
        self.workspace.members.remove(self.owner)
        response = self.client.get(self.url, query)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"error": "session_not_found"})

    def test_inline_output_keeps_committed_bytes_across_snapshot_changes(self):
        query = self.commit_output("original output", spilled=False)
        self.replace_snapshot("unrelated current file")
        response = self.client.get(self.url, query)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["content"], "original output")
        self.assertEqual(response["Cache-Control"], "no-store")

    def test_inline_output_preserves_bounded_utf8_continuation(self):
        original = "x" * (64 * 1024 - 2) + "世"
        query = self.commit_output(original, spilled=False)
        first = self.client.get(self.url, query)
        self.assertEqual(first.status_code, 200, first.content[:200])
        self.assertEqual(first.json()["content"], "x" * (64 * 1024 - 2))
        self.assertEqual(first.json()["endOffset"], str(64 * 1024 - 2))
        self.assertTrue(first.json()["hasMore"])
        self.replace_snapshot("y" * (64 * 1024 - 2) + "界")
        second = self.client.get(self.url, {**query, "offset": first.json()["endOffset"]})
        self.assertEqual(second.status_code, 200, second.content)
        self.assertEqual(second.json()["content"], "世")
        self.assertFalse(second.json()["hasMore"])
        self.workspace.members.remove(self.owner)
        self.assertEqual(self.client.get(self.url, query).status_code, 404)

    def test_reference_length_must_match_the_committed_output(self):
        query = self.commit_output("original output", spilled=False)
        response = self.client.get(self.url, {**query, "byteLength": "3"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"error": "transcript_content_reference_stale"})
