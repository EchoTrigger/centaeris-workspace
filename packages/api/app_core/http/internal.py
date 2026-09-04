import hashlib
import json
import logging

from asgiref.sync import sync_to_async
from django.conf import settings
from django.core.files import File
from django.core.files.storage import default_storage
from django.db import connection, transaction
from django.http import JsonResponse
from django.utils import timezone
from ninja import Router

from app_core.artifact_publish import (
    ArtifactPublishError,
    publication_response,
    publish_artifact as publish_artifact_operation,
    published_artifact,
)
from app_core.assets import DeferredInputResolutionError, delete_stored_object
from app_core.deferred_input import (
    DeferredInputBindingError,
    resolve_deferred_input as resolve_deferred_input_operation,
    resolved_input_storage,
)
from app_core.models import Session, AgentRun
from app_core.knowledge import (
    KnowledgeError,
    commit_knowledge as commit_knowledge_operation,
    read_knowledge as read_knowledge_operation,
    search_knowledge as search_knowledge_operation,
)
from app_core.runtime_contract import (
    authorization_digest,
    require_opaque_ref,
    require_sha256,
    require_string,
    session_workspace_for_session,
    validate_agent_run_authorization_payload,
    validate_session_workspace,
    validate_virtual_path,
    verify_agent_run_authorization_signature,
)
from app_core.runtime_client import (
    build_agent_run_start,
    agent_run_lifecycle_job_id,
    schedule_agent_run_lifecycle,
)
from app_core.runtime_job_client import get_runtime_job
from app_core.session_event import (
    committed_session_terminal_state,
    project_committed_agent_run,
)
from app_core.workspace_access import agent_run_membership_is_current

from .json_body import decode_json_object
from .security import internal_token_auth
from .storage_stream import stored_file_response


logger = logging.getLogger(__name__)
router = Router(tags=["internal"], by_alias=True)
AGENT_RUN_LIFECYCLE_RECONCILE_LIMIT = 100
AGENT_RUN_LIFECYCLE_DEAD_LETTER_REASON = "agent_run_lifecycle_dead_lettered"
SESSION_WORKSPACE_RESOLVE_SCHEMA = "runtime.session_workspace.resolve.v1"
SESSION_WORKSPACE_RESOLVED_SCHEMA = "runtime.session_workspace.resolved.v1"
SESSION_WORKSPACE_DOWNLOAD_SCHEMA = "runtime.session_workspace.download.v1"
SESSION_WORKSPACE_COMMIT_SCHEMA = "runtime.session_workspace.commit.v1"
SESSION_WORKSPACE_COMMIT_RESULT_SCHEMA = "runtime.session_workspace.commit.result.v1"
EXECUTION_WORKSPACE_STAGE_SCHEMA = "runtime.execution_workspace.stage.v1"
EXECUTION_WORKSPACE_STAGE_RESULT_SCHEMA = "runtime.execution_workspace.stage.result.v1"
EXECUTION_WORKSPACE_DOWNLOAD_SCHEMA = "runtime.execution_workspace.download.v1"
SESSION_WORKSPACE_LEASE_FIELDS = {
    "schema",
    "jobId",
    "leaseOwner",
    "agentRunId",
    "authorizationDigest",
}
SESSION_WORKSPACE_COMMIT_FIELDS = SESSION_WORKSPACE_LEASE_FIELDS | {
    "snapshotSha256",
    "snapshotSizeBytes",
    "expandedSizeBytes",
    "fileCount",
}
EXECUTION_WORKSPACE_STAGE_FIELDS = SESSION_WORKSPACE_COMMIT_FIELDS | {
    "checkpointId",
}
EXECUTION_WORKSPACE_DOWNLOAD_FIELDS = SESSION_WORKSPACE_LEASE_FIELDS | {
    "checkpointId",
}
MAX_SESSION_WORKSPACE_METADATA_BYTES = 64 * 1024
MAX_SESSION_WORKSPACE_FILE_COUNT = 2_147_483_647
MAX_SESSION_WORKSPACE_MANIFEST_BYTES = 1024 * 1024
MAX_SESSION_WORKSPACE_PATH_BYTES = 4 * 1024
MAX_SESSION_WORKSPACE_PATH_DEPTH = 64
SESSION_WORKSPACE_SNAPSHOT_SCHEMA = "workspace.snapshot.v1"
SESSION_WORKSPACE_RESTORE_OVERHEAD_BYTES = 64 * 1024


def _internal_post(path: str):
    return router.post(
        path,
        auth=internal_token_auth,
        response=None,
        include_in_schema=False,
    )


class SessionWorkspaceError(Exception):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code = code
        self.status = status


def _workspace_lease_request(body: dict, schema: str, code: str) -> dict:
    if not isinstance(body, dict) or set(body) != SESSION_WORKSPACE_LEASE_FIELDS:
        raise SessionWorkspaceError(code, 400)
    if body["schema"] != schema:
        raise SessionWorkspaceError(code, 400)
    try:
        require_opaque_ref("agentRunId", body["agentRunId"])
        require_sha256("authorizationDigest", body["authorizationDigest"])
        require_string("jobId", body["jobId"])
        if (
            not isinstance(body["leaseOwner"], str)
            or not 16 <= len(body["leaseOwner"].encode("utf-8")) <= 160
            or any(ord(character) < 32 or 127 <= ord(character) < 160 for character in body["leaseOwner"])
            or body["jobId"] != agent_run_lifecycle_job_id(body["agentRunId"])
        ):
            raise ValueError
    except (TypeError, ValueError):
        raise SessionWorkspaceError(code, 400) from None
    return body


def _workspace_snapshot_upload_request(
    request, schema: str, fields: set[str], code: str
) -> dict:
    try:
        content_length = int(request.META.get("CONTENT_LENGTH"))
    except (TypeError, ValueError):
        raise SessionWorkspaceError(code, 400) from None
    if content_length < 4:
        raise SessionWorkspaceError(code, 400)
    prefix = _read_workspace_bytes(request, 4)
    metadata_length = int.from_bytes(prefix, "big")
    if not 0 < metadata_length <= MAX_SESSION_WORKSPACE_METADATA_BYTES:
        raise SessionWorkspaceError(code, 400)
    try:
        body = json.loads(_read_workspace_bytes(request, metadata_length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SessionWorkspaceError(code, 400) from None
    if not isinstance(body, dict) or set(body) != fields:
        raise SessionWorkspaceError(code, 400)
    lease = _workspace_lease_request(
        {name: body[name] for name in SESSION_WORKSPACE_LEASE_FIELDS},
        schema,
        code,
    )
    candidate = {
        "generation": 1,
        "snapshotSha256": body["snapshotSha256"],
        "snapshotSizeBytes": body["snapshotSizeBytes"],
        "expandedSizeBytes": body["expandedSizeBytes"],
        "fileCount": body["fileCount"],
    }
    try:
        validate_session_workspace(candidate)
        if candidate["fileCount"] > MAX_SESSION_WORKSPACE_FILE_COUNT:
            raise ValueError
        if content_length != 4 + metadata_length + candidate["snapshotSizeBytes"]:
            raise ValueError
    except (TypeError, ValueError):
        raise SessionWorkspaceError(code, 400) from None
    return lease | {name: body[name] for name in fields - SESSION_WORKSPACE_LEASE_FIELDS}


def _workspace_commit_request(request) -> dict:
    return _workspace_snapshot_upload_request(
        request,
        SESSION_WORKSPACE_COMMIT_SCHEMA,
        SESSION_WORKSPACE_COMMIT_FIELDS,
        "session_workspace_commit_invalid",
    )


def _read_workspace_bytes(request, size: int) -> bytes:
    chunks = []
    remaining = size
    while remaining:
        chunk = request.read(remaining)
        if not chunk:
            raise SessionWorkspaceError("session_workspace_commit_invalid", 400)
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class _WorkspaceSnapshotReader:
    def __init__(self, source, candidate: dict):
        self.source = source
        self.candidate = candidate
        self.remaining = candidate["snapshotSizeBytes"]
        self.digest = hashlib.sha256()
        self.header = bytearray()
        self.manifest = bytearray()
        self.manifestLength = None
        self.files = None
        self.fileIndex = 0
        self.fileRemaining = 0
        self.fileDigest = None

    def read(self, size: int = -1) -> bytes:
        if self.remaining == 0:
            return b""
        requested = self.remaining if size is None or size < 0 else min(size, self.remaining)
        chunk = self.source.read(requested)
        if not chunk:
            raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)
        self.remaining -= len(chunk)
        self.digest.update(chunk)
        self._consume(chunk)
        return chunk

    def _consume(self, chunk: bytes) -> None:
        offset = 0
        while offset < len(chunk):
            if len(self.header) < 4:
                count = min(4 - len(self.header), len(chunk) - offset)
                self.header.extend(chunk[offset : offset + count])
                offset += count
                if len(self.header) != 4:
                    continue
                self.manifestLength = int.from_bytes(self.header, "big")
                if not 0 < self.manifestLength <= MAX_SESSION_WORKSPACE_MANIFEST_BYTES:
                    raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)
                if 4 + self.manifestLength > self.candidate["snapshotSizeBytes"]:
                    raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)
            if len(self.manifest) < self.manifestLength:
                count = min(self.manifestLength - len(self.manifest), len(chunk) - offset)
                self.manifest.extend(chunk[offset : offset + count])
                offset += count
                if len(self.manifest) != self.manifestLength:
                    continue
                self.files = _workspace_snapshot_manifest(
                    bytes(self.manifest), self.candidate
                )
                self._advance_empty_files()
                continue
            self._advance_empty_files()
            if self.fileIndex == len(self.files):
                raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)
            count = min(self.fileRemaining, len(chunk) - offset)
            self.fileDigest.update(chunk[offset : offset + count])
            self.fileRemaining -= count
            offset += count
            self._advance_empty_files()

    def _advance_empty_files(self) -> None:
        while self.files is not None and self.fileIndex < len(self.files):
            if self.fileDigest is None:
                self.fileRemaining = self.files[self.fileIndex]["sizeBytes"]
                self.fileDigest = hashlib.sha256()
            if self.fileRemaining != 0:
                return
            if (
                f"sha256:{self.fileDigest.hexdigest()}"
                != self.files[self.fileIndex]["sha256"]
            ):
                raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)
            self.fileIndex += 1
            self.fileDigest = None

    def require_complete(self) -> None:
        if (
            self.remaining != 0
            or self.files is None
            or self.fileIndex != len(self.files)
            or f"sha256:{self.digest.hexdigest()}" != self.candidate["snapshotSha256"]
            or self.source.read(1)
        ):
            raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)


def _store_workspace_snapshot(request, candidate: dict, storage_key: str) -> None:
    if not candidate["snapshotSizeBytes"]:
        _require_workspace_eof(request)
        return
    reader = _WorkspaceSnapshotReader(request, candidate)
    if default_storage.exists(storage_key):
        digest = hashlib.sha256()
        size = 0
        with default_storage.open(storage_key, "rb") as source:
            while chunk := source.read(64 * 1024):
                size += len(chunk)
                if size > candidate["snapshotSizeBytes"]:
                    raise SessionWorkspaceError("session_workspace_snapshot_invalid")
                digest.update(chunk)
        if (
            size != candidate["snapshotSizeBytes"]
            or f"sha256:{digest.hexdigest()}" != candidate["snapshotSha256"]
        ):
            raise SessionWorkspaceError("session_workspace_snapshot_invalid")
        while reader.read(64 * 1024):
            pass
        reader.require_complete()
        return
    try:
        stored_key = default_storage.save(
            storage_key,
            File(reader, name="workspace.snapshot"),
        )
        if stored_key != storage_key:
            delete_stored_object(stored_key)
            raise SessionWorkspaceError("session_workspace_storage_key_conflict")
        reader.require_complete()
    except Exception:
        if default_storage.exists(storage_key):
            delete_stored_object(storage_key)
        raise


def _workspace_snapshot_manifest(manifest_bytes: bytes, candidate: dict) -> list[dict]:
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
        canonical = json.dumps(
            manifest, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400) from None
    if canonical != manifest_bytes or not isinstance(manifest, dict) or set(manifest) != {
        "schema",
        "files",
    }:
        raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)
    files = manifest["files"]
    if manifest["schema"] != SESSION_WORKSPACE_SNAPSHOT_SCHEMA or not isinstance(files, list):
        raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)
    if len(files) != candidate["fileCount"] or not files:
        raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)
    previous = None
    expanded_size_bytes = 0
    for file in files:
        if not isinstance(file, dict) or set(file) != {
            "path",
            "sizeBytes",
            "sha256",
            "executable",
        }:
            raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)
        try:
            validate_virtual_path(file["path"])
            require_sha256("workspace snapshot file sha256", file["sha256"])
        except ValueError:
            raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400) from None
        if (
            len(file["path"].encode("utf-8")) > MAX_SESSION_WORKSPACE_PATH_BYTES
            or len(file["path"].split("/")) > MAX_SESSION_WORKSPACE_PATH_DEPTH
            or not isinstance(file["sizeBytes"], int)
            or isinstance(file["sizeBytes"], bool)
            or file["sizeBytes"] < 0
            or not isinstance(file["executable"], bool)
            or previous is not None
            and (
                previous >= file["path"]
                or file["path"].startswith(f"{previous}/")
            )
        ):
            raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)
        expanded_size_bytes += file["sizeBytes"]
        if expanded_size_bytes > candidate["expandedSizeBytes"]:
            raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)
        previous = file["path"]
    if expanded_size_bytes != candidate["expandedSizeBytes"]:
        raise SessionWorkspaceError("session_workspace_snapshot_invalid", 400)
    return files


def _require_workspace_eof(request) -> None:
    if request.read(1):
        raise SessionWorkspaceError("session_workspace_commit_invalid", 400)


def _locked_session_workspace_agent_run(body: dict) -> tuple[AgentRun, Session, dict]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT session_id FROM runtime.runtime_jobs "
            "WHERE job_id=%s AND job_kind='agent_run.lifecycle' AND status='running' "
            "AND lease_owner=%s AND payload_ref=%s AND idempotency_key=%s "
            "AND lease_expires_at_ms>(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint "
            "FOR UPDATE",
            [
                body["jobId"],
                body["leaseOwner"],
                f"record:agent_run:{body['agentRunId']}",
                f"agent_run.lifecycle:{body['agentRunId']}:{body['authorizationDigest']}",
            ],
        )
        job = cursor.fetchone()
    if job is None:
        raise SessionWorkspaceError("session_workspace_lease_lost")
    try:
        agent_run = (
            AgentRun.objects.select_for_update(of=("self",))
            .select_related("authorization")
            .get(id=body["agentRunId"])
        )
    except AgentRun.DoesNotExist:
        raise SessionWorkspaceError("session_workspace_agent_run_not_found") from None
    if not agent_run_membership_is_current(agent_run):
        raise SessionWorkspaceError("session_workspace_agent_run_not_found")
    if job[0] != agent_run.session_id:
        raise SessionWorkspaceError("session_workspace_lease_lost")
    try:
        session = Session.objects.select_for_update().get(id=agent_run.session_id)
    except Session.DoesNotExist:
        raise SessionWorkspaceError("session_workspace_session_unavailable") from None
    try:
        authorization = agent_run.authorization
        validate_agent_run_authorization_payload(authorization.payload)
        verify_agent_run_authorization_signature(
            authorization.payload,
            settings.AGENT_RUN_AUTHORIZATION_SIGNING_KEY,
            authorization.signature,
        )
        if (
            authorization_digest(authorization.payload) != authorization.digest
            or body["authorizationDigest"] != authorization.digest
            or authorization.payload["agentRunId"] != agent_run.id
            or authorization.payload["workspaceId"] != agent_run.workspace_id
            or authorization.payload["userId"] != str(agent_run.user_id)
            or authorization.payload["agentId"] != session.agent_id
            or authorization.payload["sessionId"] != agent_run.session_id
            or authorization.payload["modelConfigRef"] != agent_run.modelConfig_id
        ):
            raise ValueError
    except (AttributeError, ValueError):
        raise SessionWorkspaceError("session_workspace_authorization_invalid") from None
    if agent_run.status not in {"queued", "running"} or session.status != "active":
        raise SessionWorkspaceError("session_workspace_session_unavailable")
    return agent_run, session, authorization.payload["sessionWorkspace"]


def _require_workspace_baseline(session: Session, frozen: dict) -> None:
    if session_workspace_for_session(session) != frozen:
        raise SessionWorkspaceError("session_workspace_baseline_conflict")


def _recovery_checkpoint_workspace(body: dict, agent_run: AgentRun) -> dict:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT payload_json FROM runtime.checkpoints "
            "WHERE checkpoint_id=%s AND kind='recovery' AND status='committed'",
            [body["checkpointId"]],
        )
        row = cursor.fetchone()
    if row is None:
        raise SessionWorkspaceError("execution_workspace_checkpoint_not_found", 404)
    try:
        payload = json.loads(row[0])
        if (
            payload["schema"] != "runtime.recovery_checkpoint.v1"
            or payload["checkpointId"] != body["checkpointId"]
            or payload["agentRunId"] != body["agentRunId"]
            or payload["sessionId"] != str(agent_run.session_id)
            or payload["authorizationDigest"] != body["authorizationDigest"]
        ):
            raise ValueError
        snapshot = payload["workspaceSnapshot"]
        candidate = {
            "generation": 1,
            "snapshotSha256": snapshot["snapshotSha256"],
            "snapshotSizeBytes": snapshot["snapshotSizeBytes"],
            "expandedSizeBytes": snapshot["expandedSizeBytes"],
            "fileCount": snapshot["fileCount"],
        }
        validate_session_workspace(candidate)
        require_string("objectRef", snapshot["objectRef"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        raise SessionWorkspaceError("execution_workspace_checkpoint_invalid") from None
    return snapshot


def _is_workspace_commit_replay(
    session: Session,
    candidate: dict,
    agent_run: AgentRun,
    storage_key: str,
) -> bool:
    return (
        session_workspace_for_session(session) == candidate
        and session.workspaceStorageKey == storage_key
        and session.workspaceLastAdvancedAgentRun_id == agent_run.id
    )


def _workspace_advanced_by_agent_run(session: Session, frozen: dict, agent_run: AgentRun) -> bool:
    current = session_workspace_for_session(session)
    return (
        current["generation"] == frozen["generation"] + 1
        and session.workspaceLastAdvancedAgentRun_id == agent_run.id
    )


def _workspace_tmpfs_fits(agent_run: AgentRun, expanded_size_bytes: int) -> bool:
    inputs_size_bytes = sum(
        item["sizeBytes"] for item in agent_run.authorization.payload["assetRefs"]
    )
    return (
        expanded_size_bytes
        + inputs_size_bytes
        + SESSION_WORKSPACE_RESTORE_OVERHEAD_BYTES
        <= agent_run.authorization.payload["resources"]["dataTmpfsBytes"]
    )


@_internal_post("/agent-runs/session-workspace/resolve")
def resolve_session_workspace(request):
    try:
        body = _workspace_lease_request(
            decode_json_object(request),
            SESSION_WORKSPACE_RESOLVE_SCHEMA,
            "session_workspace_resolve_invalid",
        )
        with transaction.atomic():
            agent_run, session, frozen = _locked_session_workspace_agent_run(body)
            if _workspace_advanced_by_agent_run(session, frozen, agent_run):
                disposition = "advanced"
                resolved = session_workspace_for_session(session)
            else:
                _require_workspace_baseline(session, frozen)
                disposition = "empty" if frozen["snapshotSizeBytes"] == 0 else "download"
                resolved = frozen
    except SessionWorkspaceError as error:
        return JsonResponse({"error": error.code}, status=error.status)
    except Exception:
        logger.exception("Session workspace resolve failed")
        return JsonResponse({"error": "session_workspace_resolve_failed"}, status=500)
    return JsonResponse(
        {
            "schema": SESSION_WORKSPACE_RESOLVED_SCHEMA,
            "disposition": disposition,
            "sessionWorkspace": resolved,
        }
    )


@_internal_post("/agent-runs/session-workspace/download")
async def download_session_workspace(request):
    prepared = await _prepare_session_workspace_download(request)
    if isinstance(prepared, JsonResponse):
        return prepared
    frozen, storage_key = prepared
    response = await stored_file_response(
        storage_key,
        "application/vnd.centaeris.workspace-snapshot",
        f"workspace-{frozen['generation']}.snapshot",
        as_attachment=False,
        content_length=frozen["snapshotSizeBytes"],
    )
    if response.status_code == 200:
        response["X-Content-Sha256"] = frozen["snapshotSha256"]
    return response


@sync_to_async(thread_sensitive=True)
def _prepare_session_workspace_download(request):
    try:
        body = _workspace_lease_request(
            decode_json_object(request),
            SESSION_WORKSPACE_DOWNLOAD_SCHEMA,
            "session_workspace_download_invalid",
        )
        with transaction.atomic():
            _run, session, frozen = _locked_session_workspace_agent_run(body)
            _require_workspace_baseline(session, frozen)
            if frozen["snapshotSizeBytes"] == 0 or not session.workspaceStorageKey:
                raise SessionWorkspaceError("session_workspace_snapshot_empty")
    except SessionWorkspaceError as error:
        return JsonResponse({"error": error.code}, status=error.status)
    except Exception:
        logger.exception("Session workspace download preparation failed")
        return JsonResponse({"error": "session_workspace_download_failed"}, status=500)
    return frozen, session.workspaceStorageKey


@_internal_post("/agent-runs/session-workspace/commit")
def commit_session_workspace(request):
    try:
        body = _workspace_commit_request(request)
        with transaction.atomic():
            agent_run, session, frozen = _locked_session_workspace_agent_run(body)
            max_bytes = agent_run.authorization.payload["resources"]["dataTmpfsBytes"]
            if (
                body["snapshotSizeBytes"] > max_bytes
                or body["expandedSizeBytes"] > max_bytes
                or not _workspace_tmpfs_fits(agent_run, body["expandedSizeBytes"])
            ):
                raise SessionWorkspaceError("session_workspace_commit_invalid", 400)
            candidate = {
                "generation": frozen["generation"] + 1,
                "snapshotSha256": body["snapshotSha256"],
                "snapshotSizeBytes": body["snapshotSizeBytes"],
                "expandedSizeBytes": body["expandedSizeBytes"],
                "fileCount": body["fileCount"],
            }
            storage_key = (
                ""
                if candidate["snapshotSizeBytes"] == 0
                else (
                    f"workspaces/{agent_run.workspace_id}/sessions/{agent_run.session_id}/"
                    f"snapshots/{candidate['generation']}/"
                    f"{candidate['snapshotSha256'].removeprefix('sha256:')}.snapshot"
                )
            )
            if (
                session_workspace_for_session(session) != frozen
                and not _is_workspace_commit_replay(session, candidate, agent_run, storage_key)
            ):
                raise SessionWorkspaceError("session_workspace_baseline_conflict")

        _store_workspace_snapshot(request, candidate, storage_key)

        with transaction.atomic():
            agent_run, session, frozen = _locked_session_workspace_agent_run(body)
            if _is_workspace_commit_replay(session, candidate, agent_run, storage_key):
                disposition = "idempotent"
            else:
                _require_workspace_baseline(session, frozen)
                session.workspaceGeneration = candidate["generation"]
                session.workspaceStorageKey = storage_key
                session.workspaceSnapshotSha256 = candidate["snapshotSha256"]
                session.workspaceSnapshotSizeBytes = candidate["snapshotSizeBytes"]
                session.workspaceExpandedSizeBytes = candidate["expandedSizeBytes"]
                session.workspaceFileCount = candidate["fileCount"]
                session.workspaceLastAdvancedAgentRun = agent_run
                session.save(
                    update_fields=[
                        "workspaceGeneration",
                        "workspaceStorageKey",
                        "workspaceSnapshotSha256",
                        "workspaceSnapshotSizeBytes",
                        "workspaceExpandedSizeBytes",
                        "workspaceFileCount",
                        "workspaceLastAdvancedAgentRun",
                        "updatedAt",
                    ]
                )
                disposition = "committed"
    except SessionWorkspaceError as error:
        return JsonResponse({"error": error.code}, status=error.status)
    except Exception:
        logger.exception("Session workspace commit failed")
        return JsonResponse({"error": "session_workspace_commit_failed"}, status=500)
    return JsonResponse(
        {
            "schema": SESSION_WORKSPACE_COMMIT_RESULT_SCHEMA,
            "disposition": disposition,
            "sessionWorkspace": candidate,
        },
        status=201 if disposition == "committed" else 200,
    )


@_internal_post("/agent-runs/execution-workspace/stage")
def stage_execution_workspace(request):
    try:
        body = _workspace_snapshot_upload_request(
            request,
            EXECUTION_WORKSPACE_STAGE_SCHEMA,
            EXECUTION_WORKSPACE_STAGE_FIELDS,
            "execution_workspace_stage_invalid",
        )
        require_opaque_ref("checkpointId", body["checkpointId"])
        with transaction.atomic():
            agent_run, _session, _frozen = _locked_session_workspace_agent_run(body)
            if not _workspace_tmpfs_fits(agent_run, body["expandedSizeBytes"]):
                raise SessionWorkspaceError("execution_workspace_stage_invalid", 400)
        candidate = {
            "generation": 1,
            "snapshotSha256": body["snapshotSha256"],
            "snapshotSizeBytes": body["snapshotSizeBytes"],
            "expandedSizeBytes": body["expandedSizeBytes"],
            "fileCount": body["fileCount"],
        }
        storage_key = ""
        if candidate["snapshotSizeBytes"]:
            checkpoint_key = hashlib.sha256(body["checkpointId"].encode("utf-8")).hexdigest()
            storage_key = (
                f"workspaces/{agent_run.workspace_id}/sessions/{agent_run.session_id}/"
                f"agent-runs/{agent_run.id}/execution-checkpoints/{checkpoint_key}/"
                f"{candidate['snapshotSha256'].removeprefix('sha256:')}.snapshot"
            )
        _store_workspace_snapshot(request, candidate, storage_key)
    except SessionWorkspaceError as error:
        return JsonResponse({"error": error.code}, status=error.status)
    except (TypeError, ValueError):
        return JsonResponse({"error": "execution_workspace_stage_invalid"}, status=400)
    except Exception:
        logger.exception("Execution workspace stage failed")
        return JsonResponse({"error": "execution_workspace_stage_failed"}, status=500)
    return JsonResponse(
        {
            "schema": EXECUTION_WORKSPACE_STAGE_RESULT_SCHEMA,
            "objectRef": storage_key or None,
            "snapshotSha256": candidate["snapshotSha256"],
            "snapshotSizeBytes": candidate["snapshotSizeBytes"],
            "expandedSizeBytes": candidate["expandedSizeBytes"],
            "fileCount": candidate["fileCount"],
        },
        status=201,
    )


@_internal_post("/agent-runs/execution-workspace/download")
async def download_execution_workspace(request):
    prepared = await _prepare_execution_workspace_download(request)
    if isinstance(prepared, JsonResponse):
        return prepared
    body = prepared
    response = await stored_file_response(
        body["objectRef"],
        "application/vnd.centaeris.workspace-snapshot",
        "execution-workspace.snapshot",
        as_attachment=False,
        content_length=body["snapshotSizeBytes"],
    )
    if response.status_code == 200:
        response["X-Content-Sha256"] = body["snapshotSha256"]
    return response


@sync_to_async(thread_sensitive=True)
def _prepare_execution_workspace_download(request):
    try:
        body = decode_json_object(request)
        if not isinstance(body, dict) or set(body) != EXECUTION_WORKSPACE_DOWNLOAD_FIELDS:
            raise SessionWorkspaceError("execution_workspace_download_invalid", 400)
        _workspace_lease_request(
            {name: body[name] for name in SESSION_WORKSPACE_LEASE_FIELDS},
            EXECUTION_WORKSPACE_DOWNLOAD_SCHEMA,
            "execution_workspace_download_invalid",
        )
        require_opaque_ref("checkpointId", body["checkpointId"])
        with transaction.atomic():
            agent_run, _session, _frozen = _locked_session_workspace_agent_run(body)
            snapshot = _recovery_checkpoint_workspace(body, agent_run)
        body.update(snapshot)
        object_ref_prefix = (
            f"workspaces/{agent_run.workspace_id}/sessions/{agent_run.session_id}/"
            f"agent-runs/{agent_run.id}/execution-checkpoints/"
        )
        object_ref_suffix = body["objectRef"].removeprefix(object_ref_prefix)
        object_ref_parts = object_ref_suffix.split("/")
        checkpoint_key = object_ref_parts[0] if len(object_ref_parts) == 2 else ""
        expected_file = f"{body['snapshotSha256'].removeprefix('sha256:')}.snapshot"
        if (
            body["snapshotSizeBytes"] == 0
            or not body["objectRef"].startswith(object_ref_prefix)
            or len(checkpoint_key) != 64
            or any(character not in "0123456789abcdef" for character in checkpoint_key)
            or len(object_ref_parts) != 2
            or object_ref_parts[1] != expected_file
            or not default_storage.exists(body["objectRef"])
        ):
            raise SessionWorkspaceError("execution_workspace_download_invalid", 400)
    except SessionWorkspaceError as error:
        return JsonResponse({"error": error.code}, status=error.status)
    except (TypeError, ValueError):
        return JsonResponse({"error": "execution_workspace_download_invalid"}, status=400)
    except Exception:
        logger.exception("Execution workspace download preparation failed")
        return JsonResponse({"error": "execution_workspace_download_failed"}, status=500)
    return body


@_internal_post("/artifacts/publish")
def publish_artifact(request):
    try:
        publication, artifact = publish_artifact_operation(request)
    except ArtifactPublishError as error:
        return JsonResponse({"error": error.code}, status=error.status)
    except Exception:
        logger.exception("Artifact publication failed")
        return JsonResponse({"error": "artifact_publication_failed"}, status=500)
    return JsonResponse(publication_response(publication, artifact), status=201)


@_internal_post("/artifacts/status")
def artifact_status(request):
    try:
        result = published_artifact(decode_json_object(request))
    except ValueError:
        return JsonResponse({"error": "invalid_json"}, status=400)
    except ArtifactPublishError as error:
        return JsonResponse({"error": error.code}, status=error.status)
    except Exception:
        logger.exception("Artifact publication status failed")
        return JsonResponse({"error": "artifact_publication_status_failed"}, status=500)
    if result is None:
        return JsonResponse({"error": "artifact_publication_not_found"}, status=404)
    publication, artifact = result
    return JsonResponse(publication_response(publication, artifact))


@_internal_post("/knowledge/read")
def read_knowledge(request):
    try:
        return JsonResponse(read_knowledge_operation(decode_json_object(request)))
    except KnowledgeError as error:
        return JsonResponse({"error": error.code}, status=error.status)
    except Exception:
        logger.exception("Knowledge read failed")
        return JsonResponse({"error": "knowledge_read_failed"}, status=500)


@_internal_post("/knowledge/search")
def search_knowledge(request):
    try:
        return JsonResponse(search_knowledge_operation(decode_json_object(request)))
    except KnowledgeError as error:
        return JsonResponse({"error": error.code}, status=error.status)
    except Exception:
        logger.exception("Knowledge search failed")
        return JsonResponse({"error": "knowledge_search_failed"}, status=500)


@_internal_post("/knowledge/commit")
def commit_knowledge(request):
    try:
        return JsonResponse(commit_knowledge_operation(request), status=201)
    except KnowledgeError as error:
        return JsonResponse({"error": error.code}, status=error.status)
    except Exception:
        logger.exception("Knowledge commit failed")
        return JsonResponse({"error": "knowledge_commit_failed"}, status=500)


@_internal_post("/agent-runs/resolve-input")
def resolve_deferred_input(request):
    try:
        body = decode_json_object(request)
        if (
            set(body) != {"schema", "agentRunId", "authorizationDigest", "inputRef"}
            or body["schema"] != "runtime.deferred_input.resolve.v1"
        ):
            raise ValueError("deferred_input_request_invalid")
        require_string("agentRunId", body["agentRunId"])
        require_string("authorizationDigest", body["authorizationDigest"])
        require_string("inputRef", body["inputRef"])
        agent_run_id = body["agentRunId"]
        digest = body["authorizationDigest"]
        input_ref = body["inputRef"]
        if not agent_run_id or not digest or not input_ref:
            raise ValueError("deferred_input_request_invalid")
        with transaction.atomic():
            agent_run = (
                AgentRun.objects.select_for_update(of=("self",))
                .select_related("authorization")
                .get(id=agent_run_id)
            )
            resolved_input = resolve_deferred_input_operation(agent_run, input_ref, digest)
    except AgentRun.DoesNotExist:
        return JsonResponse({"error": "asset_unavailable"}, status=409)
    except DeferredInputResolutionError as error:
        return JsonResponse({"error": error.errorCode}, status=409)
    except (ValueError, TypeError) as error:
        return JsonResponse({"error": str(error)}, status=400)
    except DeferredInputBindingError as error:
        logger.error("Deferred input resolution failed: %s", error)
        return JsonResponse(
            {"error": "deferred_input_binding_invalid"},
            status=500,
        )
    return JsonResponse(
        {
            "schema": "runtime.deferred_input.resolve.v1",
            "resolvedInput": resolved_input,
        }
    )


@_internal_post("/agent-runs/read-input")
async def read_deferred_input(request):
    prepared = await _prepare_deferred_input_read(request)
    if isinstance(prepared, JsonResponse):
        return prepared
    resolved_input, storage_key = prepared
    response = await stored_file_response(
        storage_key,
        resolved_input["contentType"],
        resolved_input["displayName"],
        as_attachment=False,
        content_length=resolved_input["sizeBytes"],
    )
    if response.status_code == 200:
        response["X-Content-Sha256"] = resolved_input["sha256"]
        response["X-Source-Version"] = resolved_input["sourceVersion"]
    return response


@sync_to_async(thread_sensitive=True)
def _prepare_deferred_input_read(request):
    try:
        body = decode_json_object(request)
        if (
            set(body)
            != {
                "schema",
                "agentRunId",
                "authorizationDigest",
                "inputRef",
                "sourceVersion",
                "sha256",
            }
            or body["schema"] != "runtime.deferred_input.read.v1"
        ):
            raise ValueError("deferred_input_read_invalid")
        with transaction.atomic():
            agent_run = (
                AgentRun.objects.select_for_update(of=("self",))
                .select_related("authorization")
                .get(id=str(body["agentRunId"]))
            )
            resolved_input, storage_key = resolved_input_storage(
                agent_run,
                str(body["inputRef"]),
                str(body["authorizationDigest"]),
            )
            if (
                resolved_input["sourceVersion"] != body["sourceVersion"]
                or resolved_input["sha256"] != body["sha256"]
            ):
                return JsonResponse({"error": "stale_generation"}, status=409)
    except AgentRun.DoesNotExist:
        return JsonResponse({"error": "asset_unavailable"}, status=409)
    except DeferredInputResolutionError as error:
        return JsonResponse({"error": error.errorCode}, status=409)
    except (DeferredInputBindingError, ValueError, TypeError):
        return JsonResponse({"error": "deferred_input_read_invalid"}, status=400)
    return resolved_input, storage_key


@_internal_post("/agent-runs/validate-inputs")
def validate_projected_inputs(request):
    try:
        body = decode_json_object(request)
        if (
            set(body) != {"schema", "agentRunId", "authorizationDigest", "inputs"}
            or body["schema"] != "runtime.projected_input.validate.v1"
            or not isinstance(body["inputs"], list)
            or len(body["inputs"]) > 128
        ):
            raise ValueError("projected_input_validation_invalid")
        expected_fields = {
            "inputRef",
            "virtualPath",
            "sizeBytes",
            "sha256",
            "sourceVersion",
        }
        if any(
            not isinstance(item, dict) or set(item) != expected_fields
            for item in body["inputs"]
        ):
            raise ValueError("projected_input_validation_invalid")
        if any(
            not isinstance(item["sizeBytes"], int)
            or isinstance(item["sizeBytes"], bool)
            or not 0 <= item["sizeBytes"] <= 64 * 1024 * 1024
            for item in body["inputs"]
        ):
            raise ValueError("projected_input_validation_invalid")
        require_opaque_ref("agentRunId", body["agentRunId"])
        require_sha256("authorizationDigest", body["authorizationDigest"])
        for item in body["inputs"]:
            require_opaque_ref("inputRef", item["inputRef"])
            validate_virtual_path(item["virtualPath"])
            require_sha256("sha256", item["sha256"])
            require_string("sourceVersion", item["sourceVersion"])
        input_refs = [item["inputRef"] for item in body["inputs"]]
        if input_refs != sorted(set(input_refs)):
            raise ValueError("projected_input_validation_invalid")
        with transaction.atomic():
            agent_run = (
                AgentRun.objects.select_for_update(of=("self",))
                .select_related("authorization")
                .get(id=str(body["agentRunId"]))
            )
            states = []
            for expected in body["inputs"]:
                try:
                    current, _storage_key = resolved_input_storage(
                        agent_run,
                        expected["inputRef"],
                        str(body["authorizationDigest"]),
                    )
                    state = (
                        "active"
                        if all(
                            current[name] == expected[name] for name in expected_fields
                        )
                        else "stale_generation"
                    )
                except DeferredInputResolutionError as error:
                    if error.errorCode in {
                        "asset_removed",
                        "access_revoked",
                        "source_deleted",
                        "stale_generation",
                    }:
                        state = error.errorCode
                    elif error.errorCode == "asset_unavailable":
                        state = "access_revoked"
                    else:
                        raise
                states.append({"inputRef": expected["inputRef"], "state": state})
    except AgentRun.DoesNotExist:
        return JsonResponse({"error": "projected_input_validation_invalid"}, status=409)
    except (DeferredInputBindingError, ValueError, TypeError):
        return JsonResponse({"error": "projected_input_validation_invalid"}, status=400)
    return JsonResponse(
        {
            "schema": "runtime.projected_input.validate.v1",
            "inputs": states,
        }
    )


@_internal_post("/agent-run-lifecycle/resolve")
def resolve_agent_run_lifecycle(request):
    try:
        body = decode_json_object(request)
        if (
            set(body) != {"schema", "jobId", "agentRunId", "authorizationDigest"}
            or body["schema"] != "runtime.agent_run_lifecycle.resolve.v1"
        ):
            raise ValueError("agent_run_lifecycle_resolve_invalid")
        require_string("agentRunId", body["agentRunId"])
        require_string("jobId", body["jobId"])
        require_string("authorizationDigest", body["authorizationDigest"])
        agent_run_id = body["agentRunId"]
        job_id = body["jobId"]
        digest = body["authorizationDigest"]
        if not agent_run_id or job_id != agent_run_lifecycle_job_id(agent_run_id) or not digest:
            raise ValueError("agent_run_lifecycle_resolve_invalid")
        with transaction.atomic():
            agent_run = (
                AgentRun.objects.select_for_update(of=("self",))
                .select_related("authorization", "modelConfig", "session")
                .get(id=agent_run_id)
            )
            if agent_run.authorization.digest != digest:
                return JsonResponse(
                    {"error": "agent_run_lifecycle_binding_mismatch"}, status=409
                )
            terminal_state = committed_session_terminal_state(agent_run)
            if terminal_state is None:
                if agent_run.status not in {"queued", "running"}:
                    return JsonResponse(
                        {"error": "agent_run_lifecycle_binding_mismatch"}, status=409
                    )
            agent_run_start = build_agent_run_start(agent_run)
    except AgentRun.DoesNotExist:
        return JsonResponse({"error": "agent_run_not_found"}, status=404)
    except (RuntimeError, ValueError, TypeError):
        return JsonResponse({"error": "agent_run_start_invalid"}, status=409)
    if terminal_state is not None:
        return JsonResponse(
            {
                "schema": "runtime.agent_run_lifecycle.resolved.v1",
                "disposition": "terminal",
                "terminalState": terminal_state,
                "agentRunStart": agent_run_start,
            }
        )
    return JsonResponse(
        {
            "schema": "runtime.agent_run_lifecycle.resolved.v1",
            "disposition": "ready",
            "agentRunStart": agent_run_start,
        }
    )


@_internal_post("/agent-run-lifecycle/reconcile")
def reconcile_agent_run_lifecycle(request):
    try:
        body = decode_json_object(request)
        if (
            set(body) != {"schema", "limit"}
            or body["schema"] != "runtime.agent_run_lifecycle.reconcile.v1"
        ):
            raise ValueError
        limit = body["limit"]
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= AGENT_RUN_LIFECYCLE_RECONCILE_LIMIT
        ):
            raise ValueError
    except (ValueError, TypeError):
        return JsonResponse({"error": "agent_run_lifecycle_reconcile_invalid"}, status=400)

    scheduled = 0
    terminalized = 0
    pending = 0
    active_agent_runs = list(
        AgentRun.objects.filter(status__in={"queued", "running"})
        .select_related("authorization", "modelConfig", "session")
        .order_by("createdAt", "id")[:limit]
    )
    dead_letter_agent_runs = list(
        AgentRun.objects.filter(
            status="failed",
            transitionReason=AGENT_RUN_LIFECYCLE_DEAD_LETTER_REASON,
            events__payload__type__in={
                "agent_run_completed",
                "agent_run_failed",
                "agent_run_interrupted",
            },
        )
        .select_related("authorization", "modelConfig", "session")
        .order_by("createdAt", "id")
        .distinct()[:limit]
    )
    agent_runs = dead_letter_agent_runs + active_agent_runs
    for agent_run in agent_runs:
        try:
            if agent_run.status == "failed":
                if committed_session_terminal_state(agent_run) is not None:
                    projected = project_committed_agent_run(agent_run)
                    projected.transitionReason = "runtime_session_terminal_committed"
                    projected.save(update_fields=["transitionReason", "updatedAt"])
                    terminalized += 1
                continue
            job = get_runtime_job(agent_run_lifecycle_job_id(agent_run.id))
            if job is not None and job.get("status") in {"failed", "dead_lettered"}:
                _fail_agent_run_lifecycle(agent_run.id)
                terminalized += 1
                continue
            if job is not None and job.get("status") == "succeeded":
                projected = project_committed_agent_run(agent_run)
                if projected.status not in {"completed", "failed", "cancelled"}:
                    raise RuntimeError(
                        "agent_run_lifecycle_completed_without_session_terminal"
                    )
                terminalized += 1
                continue
            schedule_agent_run_lifecycle(agent_run)
            scheduled += 1
        except Exception:
            pending += 1
            logger.exception(
                "Run lifecycle reconciliation remains pending",
                extra={"agentRunId": agent_run.id},
            )
            AgentRun.objects.filter(
                id=agent_run.id, status__in={"queued", "running"}
            ).update(transitionReason="agent_run_lifecycle_reconcile_pending")
    return JsonResponse(
        {"scheduled": scheduled, "terminalized": terminalized, "pending": pending}
    )


def _fail_agent_run_lifecycle(agent_run_id: str) -> AgentRun:
    with transaction.atomic():
        agent_run = AgentRun.objects.select_for_update().get(id=agent_run_id)
        if agent_run.status in {"completed", "cancelled"} or (
            agent_run.status == "failed"
            and agent_run.transitionReason != AGENT_RUN_LIFECYCLE_DEAD_LETTER_REASON
        ):
            return agent_run
        if committed_session_terminal_state(agent_run) is not None:
            projected = project_committed_agent_run(agent_run)
            if projected.status in {"completed", "failed", "cancelled"}:
                projected.transitionReason = "runtime_session_terminal_committed"
                projected.save(update_fields=["transitionReason", "updatedAt"])
                return projected
        if agent_run.status == "failed":
            return agent_run
        agent_run.status = "failed"
        agent_run.transitionReason = AGENT_RUN_LIFECYCLE_DEAD_LETTER_REASON
        agent_run.completedAt = timezone.now()
        agent_run.save(
            update_fields=["status", "transitionReason", "completedAt", "updatedAt"]
        )
        return agent_run


@_internal_post("/agent-runs/transition")
def transition_agent_run(request):
    try:
        body = decode_json_object(request)
        if set(body) != {"schema", "agentRunId", "state", "transitionReason"}:
            raise ValueError("fields_mismatch")
        if body["schema"] != "runtime.agent_run.transition.v1":
            raise ValueError("schema_mismatch")
        require_string("agentRunId", body["agentRunId"])
        require_string("state", body["state"])
        require_string("transitionReason", body["transitionReason"])
        agent_run_id = body["agentRunId"]
        state = body["state"]
        reason = body["transitionReason"]
        if (
            not agent_run_id
            or not reason
            or state
            not in {
                "running",
                "completed",
                "failed",
                "cancelled",
            }
        ):
            raise ValueError("transition_invalid")
        with transaction.atomic():
            agent_run = AgentRun.objects.select_for_update().get(id=agent_run_id)
            if state == "running":
                if agent_run.status == "running":
                    agent_run.transitionReason = reason
                    agent_run.save(update_fields=["transitionReason", "updatedAt"])
                    return JsonResponse({"agentRunId": agent_run.id, "state": agent_run.status})
                if agent_run.status != "queued":
                    return JsonResponse(
                        {"error": "agent_run_transition_conflict"},
                        status=409,
                    )
                agent_run.status = "running"
                agent_run.transitionReason = reason
                agent_run.startedAt = timezone.now()
                agent_run.save(
                    update_fields=[
                        "status",
                        "transitionReason",
                        "startedAt",
                        "updatedAt",
                    ]
                )
            else:
                if state == "failed" and reason == AGENT_RUN_LIFECYCLE_DEAD_LETTER_REASON:
                    agent_run = _fail_agent_run_lifecycle(agent_run.id)
                    return JsonResponse({"agentRunId": agent_run.id, "state": agent_run.status})
                expected = state
                projected = project_committed_agent_run(agent_run, expected)
                if projected.status != expected:
                    return JsonResponse(
                        {"error": "semantic_terminal_missing"},
                        status=409,
                    )
                projected.transitionReason = reason
                projected.save(update_fields=["transitionReason", "updatedAt"])
                agent_run = projected
    except AgentRun.DoesNotExist:
        return JsonResponse({"error": "agent_run_not_found"}, status=404)
    except (ValueError, TypeError) as error:
        return JsonResponse({"error": str(error)}, status=400)
    return JsonResponse({"agentRunId": agent_run.id, "state": agent_run.status})
