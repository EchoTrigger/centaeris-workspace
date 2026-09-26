"""Exercise snapshot publication across real, independently committed lease changes."""

import hashlib
import json
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event, current_thread
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth.models import User
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import connection, connections
from django.test import Client, TransactionTestCase, override_settings

from .agent_run_authorization_factory import create_agent_run_authorization
from .http import internal
from .models import AgentRun, ModelConfig, Workspace
from .testing import create_session


class ExecutionPublicationFencingTests(TransactionTestCase):
    serialized_rollback = True

    def setUp(self):
        super().setUp()
        storage = tempfile.TemporaryDirectory(prefix="execution-publication-")
        self.storage_root = Path(storage.name)
        self.addCleanup(storage.cleanup)
        self.enterContext(override_settings(MEDIA_ROOT=storage.name))
        user = User.objects.create_user(username="publication-owner")
        workspace = Workspace.objects.create(name="Publication fencing", createdBy=user)
        workspace.members.add(user)
        model = ModelConfig.objects.create(id="publication-model", displayName="Publication")
        self.session = create_session(workspace=workspace, owner=user)
        self.run = AgentRun.objects.create(
            workspace=workspace, session=self.session, user=user,
            modelConfig=model, prompt="persist files", status="running",
        )
        self.authorization = create_agent_run_authorization(
            self.run, image_digest="sha256:" + "a" * 64,
        )
        self.job_id = f"agent_run.lifecycle:{self.run.id}"
        self.owner = "worker:publication-first"
        self.replacement = "worker:publication-replacement"
        with connection.cursor() as cursor:
            # The API test database has no Runtime migrations. Match the lease
            # fields read by this API, as in the existing internal CAS fixture.
            cursor.execute("CREATE SCHEMA IF NOT EXISTS runtime")
            cursor.execute(
                "CREATE TABLE IF NOT EXISTS runtime.runtime_jobs("
                "job_id text PRIMARY KEY, job_kind text NOT NULL, status text NOT NULL, "
                "lease_owner text, lease_expires_at_ms bigint, idempotency_key text NOT NULL, "
                "session_id text, payload_ref text)"
            )
            cursor.execute(
                "INSERT INTO runtime.runtime_jobs(job_id,job_kind,status,lease_owner,"
                "lease_expires_at_ms,idempotency_key,session_id,payload_ref) "
                "VALUES(%s,'agent_run.lifecycle','running',%s,"
                "(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint+60000,%s,%s,%s)",
                [self.job_id, self.owner, f"{self.job_id}:{self.authorization.digest}",
                 self.session.id, f"record:agent_run:{self.run.id}"],
            )
            cursor.execute("SELECT pg_backend_pid()")
            self.main_connection_pid = cursor.fetchone()[0]
        self.addCleanup(self._delete_job)

    def _delete_job(self):
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM runtime.runtime_jobs WHERE job_id=%s", [self.job_id])

    def _lease(self, owner, *, expired=False):
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE runtime.runtime_jobs SET lease_owner=%s, lease_expires_at_ms="
                "(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint+%s WHERE job_id=%s",
                [owner, -1 if expired else 60000, self.job_id],
            )

    def _body(self, content=b"AAA", *, owner=None):
        manifest = json.dumps({
            "schema": "workspace.snapshot.v1",
            "files": [{"path": "notes.txt", "sizeBytes": len(content),
                       "sha256": "sha256:" + hashlib.sha256(content).hexdigest(),
                       "executable": False}],
        }, separators=(",", ":")).encode()
        snapshot = len(manifest).to_bytes(4, "big") + manifest + content
        metadata = json.dumps({
            "schema": "runtime.session_workspace.commit.v1",
            "jobId": self.job_id, "leaseOwner": owner or self.owner,
            "agentRunId": self.run.id, "authorizationDigest": self.authorization.digest,
            "snapshotSha256": "sha256:" + hashlib.sha256(snapshot).hexdigest(),
            "snapshotSizeBytes": len(snapshot), "expandedSizeBytes": len(content),
            "fileCount": 1,
        }, separators=(",", ":")).encode()
        return len(metadata).to_bytes(4, "big") + metadata + snapshot, snapshot

    def _post(self, body):
        return Client().post(
            "/internal/agent-runs/session-workspace/commit", data=body,
            content_type="application/octet-stream",
            HTTP_X_INTERNAL_TOKEN=settings.INTERNAL_API_TOKEN,
        )

    def _thread_post(self, body):
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                self.assertNotEqual(cursor.fetchone()[0], self.main_connection_pid)
            return self._post(body)
        finally:
            connections.close_all()

    def _during_upload(self, change):
        """Let storage finish, change committed facts, then allow publication."""
        uploaded, release = Event(), Event()
        real_store = internal._store_workspace_snapshot
        caller = current_thread()

        def paused_store(*args):
            real_store(*args)
            if current_thread() is not caller:
                uploaded.set()
                if not release.wait(10):
                    raise TimeoutError("Snapshot publication test was not released")

        with patch.object(internal, "_store_workspace_snapshot", paused_store):
            with ThreadPoolExecutor(max_workers=1) as executor:
                pending = executor.submit(self._thread_post, self._body()[0])
                try:
                    self.assertTrue(uploaded.wait(5), "Snapshot did not finish uploading")
                    change()
                finally:
                    release.set()
                return pending.result(timeout=10)

    def _assert_error(self, response, error):
        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(response.json(), {"error": error})

    def _assert_snapshot(self, expected):
        self.session.refresh_from_db()
        self.assertEqual(self.session.workspaceGeneration, 1)
        self.assertEqual(self.session.workspaceLastAdvancedAgentRun_id, self.run.id)
        self.assertTrue(default_storage.exists(self.session.workspaceStorageKey))
        with default_storage.open(self.session.workspaceStorageKey, "rb") as stored:
            self.assertEqual(stored.read(), expected)

    def _assert_no_upload_temporaries(self):
        self.assertEqual(list(self.storage_root.rglob(".centaeris-immutable-*.tmp")), [])

    def _snapshot_key(self, snapshot):
        return (
            f"workspaces/{self.run.workspace_id}/sessions/{self.session.id}/snapshots/1/"
            f"{hashlib.sha256(snapshot).hexdigest()}.snapshot"
        )

    def test_replaced_lease_rejects_late_upload_and_new_owner_can_publish_same_run(self):
        replacement_body, replacement_snapshot = self._body(b"BBB", owner=self.replacement)

        def replace_and_publish():
            self._lease(self.replacement)
            committed = self._post(replacement_body)
            self.assertEqual(committed.status_code, 201, committed.content)

        stale = self._during_upload(replace_and_publish)
        self._assert_error(stale, "session_workspace_lease_lost")
        self._assert_snapshot(replacement_snapshot)
        self.authorization.refresh_from_db()
        self.assertEqual(self.authorization.payload["sessionWorkspace"]["generation"], 0)

    def test_lease_expiry_after_upload_prevents_publication(self):
        stale = self._during_upload(lambda: self._lease(self.owner, expired=True))
        self._assert_error(stale, "session_workspace_lease_lost")
        self.session.refresh_from_db()
        self.assertEqual(self.session.workspaceGeneration, 0)
        self.assertEqual(self.session.workspaceStorageKey, "")

    def test_changed_baseline_after_upload_prevents_overwrite(self):
        replacement_body, replacement_snapshot = self._body(b"BBB")

        def publish_other_snapshot():
            committed = self._post(replacement_body)
            self.assertEqual(committed.status_code, 201, committed.content)

        stale = self._during_upload(publish_other_snapshot)
        self._assert_error(stale, "session_workspace_baseline_conflict")
        self._assert_snapshot(replacement_snapshot)

    def test_terminal_run_after_upload_prevents_publication(self):
        stale = self._during_upload(
            lambda: AgentRun.objects.filter(id=self.run.id).update(status="completed")
        )
        self._assert_error(stale, "session_workspace_session_unavailable")
        self.session.refresh_from_db()
        self.run.refresh_from_db()
        self.assertEqual(self.session.workspaceGeneration, 0)
        self.assertEqual(self.run.status, "completed")

    def test_replay_keeps_one_generation_and_terminal_run_cannot_republish(self):
        body, snapshot = self._body()
        committed = self._post(body)
        self.assertEqual(committed.status_code, 201, committed.content)
        replay = self._post(body)
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["disposition"], "idempotent")
        self._assert_snapshot(snapshot)
        AgentRun.objects.filter(id=self.run.id).update(status="completed")
        self._assert_error(self._post(body), "session_workspace_session_unavailable")
        self._assert_snapshot(snapshot)

    def test_stale_lease_cannot_start_upload(self):
        self._lease(self.replacement)
        with patch.object(internal, "_store_workspace_snapshot") as upload:
            self._assert_error(self._post(self._body()[0]), "session_workspace_lease_lost")
        upload.assert_not_called()

    def test_replaced_lease_identical_upload_cannot_delete_committed_snapshot(self):
        self._competing_identical_upload()

    def test_invalid_stale_upload_cannot_delete_replacement_snapshot(self):
        self._competing_identical_upload(invalid_content=True)

    def _competing_identical_upload(self, *, invalid_content=False):
        # Both requests have passed the absent-object check. The first request
        # pauses after observing absence; the second publishes that same
        # content-addressed key under a new lease. Stale cleanup must not delete
        # the winner even though the stale request began while its lease held.
        observed_absence, release = Event(), Event()
        real_exists = default_storage.exists
        caller = current_thread()

        def paused_exists(*args, **kwargs):
            exists = real_exists(*args, **kwargs)
            if current_thread() is not caller and not observed_absence.is_set():
                self.assertFalse(exists)
                observed_absence.set()
                if not release.wait(10):
                    raise TimeoutError("Competing snapshot upload was not released")
            return exists

        body, snapshot = self._body()
        competing_body = body[:-1] + b"X" if invalid_content else body
        with patch.object(default_storage, "exists", paused_exists):
            with ThreadPoolExecutor(max_workers=1) as executor:
                pending = executor.submit(self._thread_post, competing_body)
                try:
                    self.assertTrue(observed_absence.wait(5), "Upload did not check storage")
                    self._lease(self.owner, expired=True)
                    self._lease(self.replacement)
                    committed = self._post(self._body(owner=self.replacement)[0])
                    self.assertEqual(committed.status_code, 201, committed.content)
                    self._assert_snapshot(snapshot)
                finally:
                    release.set()
                competing = pending.result(timeout=10)
        if invalid_content:
            self.assertEqual(competing.status_code, 400, competing.content)
            self.assertEqual(competing.json(), {"error": "session_workspace_snapshot_invalid"})
        else:
            self._assert_error(competing, "session_workspace_lease_lost")
        self._assert_snapshot(snapshot)
        self._assert_no_upload_temporaries()

    def test_truncated_upload_leaves_no_published_object_and_valid_retry_succeeds(self):
        body, snapshot = self._body()
        self._invalid_upload_then_retry(body[:-1], body, snapshot)

    def test_trailing_bytes_leave_no_published_object_and_valid_retry_succeeds(self):
        body, snapshot = self._body()
        self._invalid_upload_then_retry(body + b"unexpected", body, snapshot)

    def test_corrupt_upload_leaves_no_published_object_and_same_candidate_retry_succeeds(self):
        body, snapshot = self._body()
        # Preserve both declared and actual length so validation reaches the
        # streamed snapshot rather than rejecting the metadata envelope.
        self._invalid_upload_then_retry(
            body[:-1] + b"X", body, snapshot,
            error="session_workspace_snapshot_invalid",
        )

    def _invalid_upload_then_retry(
        self, invalid_body, valid_body, snapshot, *, error="session_workspace_commit_invalid"
    ):
        invalid = self._post(invalid_body)
        self.assertEqual(invalid.status_code, 400, invalid.content)
        self.assertEqual(invalid.json(), {"error": error})
        self.session.refresh_from_db()
        self.assertEqual(self.session.workspaceGeneration, 0)
        storage_key = self._snapshot_key(snapshot)
        self.assertFalse(default_storage.exists(storage_key))
        self._assert_no_upload_temporaries()
        committed = self._post(valid_body)
        self.assertEqual(committed.status_code, 201, committed.content)
        self._assert_snapshot(snapshot)
        self._assert_no_upload_temporaries()

    def test_interrupted_upload_cleans_partial_bytes_and_valid_retry_succeeds(self):
        body, snapshot = self._body(b"A" * (128 * 1024))
        real_read = internal._WorkspaceSnapshotReader.read
        chunks_read = 0

        def interrupted_read(reader, size=-1):
            nonlocal chunks_read
            if chunks_read:
                raise OSError("Simulated upload disconnect after one chunk")
            chunk = real_read(reader, size)
            self.assertTrue(chunk)
            self.assertGreater(reader.remaining, 0)
            chunks_read += 1
            return chunk

        with patch.object(internal._WorkspaceSnapshotReader, "read", interrupted_read):
            with self.assertLogs(internal.logger, level="ERROR"):
                failed = self._post(body)
        self.assertEqual(failed.status_code, 500, failed.content)
        self.assertEqual(failed.json(), {"error": "session_workspace_commit_failed"})
        self.assertEqual(chunks_read, 1)
        self.session.refresh_from_db()
        self.assertEqual(self.session.workspaceGeneration, 0)
        self.assertFalse(default_storage.exists(self._snapshot_key(snapshot)))
        self._assert_no_upload_temporaries()
        committed = self._post(body)
        self.assertEqual(committed.status_code, 201, committed.content)
        self._assert_snapshot(snapshot)
        self._assert_no_upload_temporaries()

    def test_existing_corrupt_snapshot_is_rejected_without_deleting_or_overwriting_it(self):
        body, snapshot = self._body()
        key = self._snapshot_key(snapshot)
        corrupt = snapshot[:-1] + b"X"
        self.assertEqual(default_storage.save(key, ContentFile(corrupt)), key)
        self._assert_error(self._post(body), "session_workspace_snapshot_invalid")
        # Also cover another writer occupying the key after the absence check.
        with patch.object(default_storage, "exists", return_value=False):
            self._assert_error(self._post(body), "session_workspace_snapshot_invalid")
        with default_storage.open(key, "rb") as stored:
            self.assertEqual(stored.read(), corrupt)
        self.session.refresh_from_db()
        self.assertEqual(self.session.workspaceGeneration, 0)
        self._assert_no_upload_temporaries()

    def test_execution_checkpoint_stage_stores_immutable_bytes_without_publishing_session(self):
        body, snapshot = self._body()
        metadata_size = int.from_bytes(body[:4], "big")
        metadata = json.loads(body[4:4 + metadata_size])
        metadata.update(schema="runtime.execution_workspace.stage.v1", checkpointId="checkpoint:stage-test")
        encoded = json.dumps(metadata, separators=(",", ":")).encode()
        stage_body = len(encoded).to_bytes(4, "big") + encoded + snapshot
        expected_key = (
            f"workspaces/{self.run.workspace_id}/sessions/{self.session.id}/"
            f"agent-runs/{self.run.id}/execution-checkpoints/"
            f"{hashlib.sha256(metadata['checkpointId'].encode()).hexdigest()}/"
            f"{hashlib.sha256(snapshot).hexdigest()}.snapshot"
        )
        for _ in range(2):
            staged = self.client.post(
                "/internal/agent-runs/execution-workspace/stage", data=stage_body,
                content_type="application/octet-stream",
                HTTP_X_INTERNAL_TOKEN=settings.INTERNAL_API_TOKEN,
            )
            self.assertEqual(staged.status_code, 201, staged.content)
            self.assertEqual(staged.json()["objectRef"], expected_key)
            with default_storage.open(expected_key, "rb") as stored:
                self.assertEqual(stored.read(), snapshot)
        self.session.refresh_from_db()
        self.assertEqual(self.session.workspaceGeneration, 0)
        self.assertEqual(self.session.workspaceStorageKey, "")
        self._assert_no_upload_temporaries()
