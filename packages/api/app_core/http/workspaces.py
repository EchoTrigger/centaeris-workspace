import base64
import json
import logging
from typing import Literal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from ninja import Router, Status
from ninja.responses import codes_4xx
from pydantic import Field, ValidationError, field_validator

from app_core.assets import MAX_DIRECT_INPUT_BYTES, captured_input_fields
from app_core.agent_identity import validate_agent_id
from app_core.models import (
    Agent,
    Session,
    SessionProject,
    ModelConfig,
    SessionAssetLink,
    SessionEvent,
    AgentRun,
    McpBearerCredential,
    Workspace,
    WorkspacePluginEnablement,
    validate_thinking_mode,
)
from app_core.plugin_catalog import (
    activation_digest,
    load_plugin_catalog,
    load_plugin_bearer_credential_refs,
    load_plugin_interfaces,
    plugin_lifecycle_lock,
    plugin_activation_for_workspace,
)
from app_core.agent_run_authorization_factory import create_agent_run_authorization
from app_core.agent_run_stream import (
    AgentRunStreamUnavailable,
    advance_overlay_barrier,
    encode_stream_cursor,
    live_overlay_is_superseded,
    load_live_text_state,
    load_session_high_water,
)
from app_core.runtime_client import (
    request_agent_run_cancellation,
    request_agent_run_supplement,
    request_workspace_skill_catalog,
    request_workspace_skill_detail,
    request_workspace_hook_catalog,
    request_workspace_mcp_catalog,
    request_execution_profile,
    schedule_agent_run_lifecycle,
)
from app_core.session_event import (
    committed_session_terminal_state,
    project_committed_agent_run,
)
from app_core.trash_retention import trash_is_restorable
from app_core.workspace_access import (
    WORKSPACE_ADMIN_ROLES,
    agent_run_membership_is_current,
    locked_workspace_membership_for,
    workspace_membership_for,
)

from .response_schema import (
    COMMON_ERROR_RESPONSES,
    DeletedResponse,
    SessionEnvelope,
    SessionProjectEnvelope,
    SessionProjectsEnvelope,
    SessionHistoryEnvelope,
    SessionContextUsageEnvelope,
    AgentRunAcceptedResponse,
    AgentRunCancellationResponse,
    AgentRunSupplementResponse,
    SessionsEnvelope,
    WorkspacesEnvelope,
    WorkspacePluginEnvelope,
    WorkspacePluginResponse,
    WorkspacePluginsEnvelope,
    WorkspaceSkillDetailEnvelope,
    WorkspaceSkillsEnvelope,
)
from .library import (
    _create_uploaded_library_objects,
    _delete_stored_upload_batch,
    _require_uploads,
    _store_upload_batch,
)
from .schema import ErrorResponse, StrictSchema
from .security import session_auth
from .serialization import (
    serialize_model,
    serialize_session,
    serialize_session_project,
    serialize_workspace,
)


logger = logging.getLogger(__name__)
router = Router(tags=["workspaces-sessions"], by_alias=True)
SESSION_HISTORY_SCHEMA = "session.history.page.v1"
SESSION_HISTORY_DEFAULT_LIMIT = 40
SESSION_HISTORY_MAX_LIMIT = 100
CONTEXT_COMPACTION_HEADROOM_TOKENS = 32_768


class AgentSessionCreationError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


class RewriteLastUserTailRequest(StrictSchema):
    type: Literal["rewriteLastUser"]
    target_message_id: str = Field(alias="targetMessageId", min_length=1, max_length=160)
    expected_tail_message_id: str = Field(alias="expectedTailMessageId", min_length=1, max_length=160)


class SessionMessageRequest(StrictSchema):
    text: str = ""
    agent_id: str | None = Field(default=None, alias="agentId")
    project_id: str | None = Field(default=None, alias="projectId")
    model_config_ref: str = Field(default="", alias="modelConfigRef")
    thinking_mode: str | None = Field(default=None, alias="thinkingMode")
    attachment_refs: list[str] = Field(
        default_factory=list,
        alias="attachmentRefs",
    )
    tail_action: RewriteLastUserTailRequest | None = Field(default=None, alias="tailAction")

    @field_validator("agent_id")
    @classmethod
    def validate_agent_identity(cls, value: str | None) -> str | None:
        return None if value is None else validate_agent_id(value)


class SessionCreateRequest(StrictSchema):
    agent_id: str = Field(alias="agentId")
    project_id: str | None = Field(default=None, alias="projectId")

    @field_validator("agent_id")
    @classmethod
    def validate_agent_identity(cls, value: str) -> str:
        return validate_agent_id(value)


class SessionProjectCreateRequest(StrictSchema):
    agent_id: str = Field(alias="agentId")
    name: str

    @field_validator("agent_id")
    @classmethod
    def validate_agent_identity(cls, value: str) -> str:
        return validate_agent_id(value)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 100 or not value.isprintable():
            raise ValueError("session_project_name_invalid")
        return value


class AgentRunSupplementRequest(StrictSchema):
    supplement_id: str = Field(alias="supplementId", min_length=1, max_length=64)
    message: str = Field(min_length=1)

    @field_validator("supplement_id")
    @classmethod
    def validate_supplement_id(cls, value: str) -> str:
        if (
            value != value.strip()
            or any(
                ord(character) < 32 or 127 <= ord(character) <= 159
                for character in value
            )
            or len(value.encode()) > 64
        ):
            raise ValueError("turn_supplement_id_invalid")
        return value

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("turn_supplement_message_required")
        if len(value.encode()) > 65_536:
            raise ValueError("turn_supplement_message_too_large")
        return value


class SessionMetadataRequest(StrictSchema):
    title: str | None = None
    is_pinned: bool | None = Field(default=None, alias="isPinned")
    is_unread: bool | None = Field(default=None, alias="isUnread")


class PluginEnablementRequest(StrictSchema):
    enabled: bool


@router.get(
    "/workspaces",
    auth=session_auth,
    response={200: WorkspacesEnvelope} | COMMON_ERROR_RESPONSES,
)
def list_workspaces(request):
    workspaces = [
        serialize_workspace(membership.workspace, membership.role)
        for membership in request.user.workspace_memberships.select_related(
            "workspace"
        ).filter(workspace__status="active")
    ]
    return {"workspaces": workspaces}


@router.get(
    "/workspaces/{workspace_id}/plugins",
    auth=session_auth,
    response={200: WorkspacePluginsEnvelope} | COMMON_ERROR_RESPONSES,
)
def list_workspace_plugins(request, workspace_id: str):
    workspace = _workspace_for_user(request.user, workspace_id)
    if workspace is None:
        return Status(404, {"error": "workspace_not_found"})
    try:
        catalog = load_plugin_catalog(require_packages=False)
    except ValueError:
        logger.exception("Release Plugin catalog is invalid")
        return Status(503, {"error": "plugin_catalog_invalid"})
    enabled = set(
        workspace.pluginEnablements.values_list("pluginName", flat=True)
    )
    catalog_names = {package["name"] for package in catalog["packages"]}
    if enabled - catalog_names:
        return Status(409, {"error": "workspace_plugin_enablement_invalid"})
    return {
        "plugins": [
            _workspace_plugin(package, package["name"] in enabled)
            for package in catalog["packages"]
        ]
    }


@router.get(
    "/workspaces/{workspace_id}/plugins/{plugin_name}",
    auth=session_auth,
    response={200: WorkspacePluginEnvelope} | COMMON_ERROR_RESPONSES,
)
def get_workspace_plugin(request, workspace_id: str, plugin_name: str):
    workspace = _workspace_for_user(request.user, workspace_id)
    if workspace is None:
        return Status(404, {"error": "workspace_not_found"})
    try:
        catalog = load_plugin_catalog(require_packages=False)
    except ValueError:
        return Status(503, {"error": "plugin_catalog_invalid"})
    package = next((item for item in catalog["packages"] if item["name"] == plugin_name), None)
    if package is None:
        return Status(404, {"error": "plugin_not_found"})
    enabled = workspace.pluginEnablements.filter(pluginName=plugin_name).exists()
    return {"plugin": _workspace_plugin(package, enabled, inspect=True)}


@router.patch(
    "/workspaces/{workspace_id}/plugins/{plugin_name}",
    auth=session_auth,
    response={200: WorkspacePluginEnvelope} | COMMON_ERROR_RESPONSES,
)
def set_workspace_plugin_enabled(
    request,
    workspace_id: str,
    plugin_name: str,
    payload: PluginEnablementRequest,
):
    workspace = _workspace_for_user(
        request.user,
        workspace_id,
        allowed_roles=WORKSPACE_ADMIN_ROLES,
    )
    if workspace is None:
        return Status(404, {"error": "workspace_not_found"})
    try:
        catalog = load_plugin_catalog(require_packages=False)
        package = next(
            (
                item
                for item in catalog["packages"]
                if item["name"] == plugin_name
            ),
            None,
        )
    except ValueError:
        logger.exception("Release Plugin catalog is invalid")
        return Status(503, {"error": "plugin_catalog_invalid"})
    if package is None:
        return Status(404, {"error": "plugin_not_found"})
    plugin = _workspace_plugin(package, payload.enabled, inspect=payload.enabled)
    if payload.enabled and plugin["errors"]:
        return Status(409, {"error": "workspace_plugin_unavailable"})
    with plugin_lifecycle_lock():
        try:
            current = next((
                item for item in load_plugin_catalog(require_packages=False)["packages"]
                if item["name"] == plugin_name
            ), None)
        except ValueError:
            logger.exception("Release Plugin catalog is invalid")
            return Status(503, {"error": "plugin_catalog_invalid"})
        if current is None:
            return Status(404, {"error": "plugin_not_found"})
        if current != package:
            return Status(409, {"error": "workspace_plugin_package_changed"})
        with transaction.atomic():
            if payload.enabled:
                WorkspacePluginEnablement.objects.get_or_create(
                    workspace=workspace,
                    pluginName=plugin_name,
                )
            else:
                WorkspacePluginEnablement.objects.filter(
                    workspace=workspace,
                    pluginName=plugin_name,
                ).delete()
    return {"plugin": plugin}


@router.get(
    "/workspaces/{workspace_id}/skills",
    auth=session_auth,
    response={200: WorkspaceSkillsEnvelope} | COMMON_ERROR_RESPONSES,
)
def list_workspace_skills(request, workspace_id: str):
    workspace = _workspace_for_user(request.user, workspace_id)
    if workspace is None:
        return Status(404, {"error": "workspace_not_found"})
    try:
        return request_workspace_skill_catalog(plugin_activation_for_workspace(workspace))
    except (RuntimeError, ValueError):
        logger.exception("Workspace Skill catalog is unavailable")
        return Status(503, {"error": "workspace_skill_catalog_unavailable"})


@router.get(
    "/workspaces/{workspace_id}/skills/{skill_id}",
    auth=session_auth,
    response={200: WorkspaceSkillDetailEnvelope} | COMMON_ERROR_RESPONSES,
)
def get_workspace_skill(request, workspace_id: str, skill_id: str):
    workspace = _workspace_for_user(request.user, workspace_id)
    if workspace is None:
        return Status(404, {"error": "workspace_not_found"})
    try:
        return request_workspace_skill_detail(
            plugin_activation_for_workspace(workspace), skill_id
        )
    except LookupError:
        return Status(404, {"error": "skill_not_found"})
    except (RuntimeError, ValueError):
        logger.exception("Workspace Skill detail is unavailable")
        return Status(503, {"error": "workspace_skill_detail_unavailable"})


@router.get(
    "/workspaces/{workspace_id}/session-projects",
    auth=session_auth,
    response={200: SessionProjectsEnvelope} | COMMON_ERROR_RESPONSES,
)
def list_session_projects(request, workspace_id: str):
    workspace = _workspace_for_user(request.user, workspace_id)
    if workspace is None:
        return Status(404, {"error": "workspace_not_found"})
    if set(request.GET.keys()) != {"agentId"} or len(
        request.GET.getlist("agentId")
    ) != 1:
        return Status(400, {"error": "session_project_filter_invalid"})
    agent_id = request.GET["agentId"]
    try:
        validate_agent_id(agent_id)
    except ValueError:
        return Status(400, {"error": "agent_id_invalid"})
    if not Agent.objects.filter(
        id=agent_id,
        workspace=workspace,
        owner=request.user,
        status="active",
    ).exists():
        return Status(404, {"error": "agent_not_found"})
    projects = SessionProject.objects.filter(
        workspace=workspace,
        owner=request.user,
        agent_id=agent_id,
    ).order_by("created_at", "id")
    return {"projects": [serialize_session_project(project) for project in projects]}


@router.post(
    "/workspaces/{workspace_id}/session-projects",
    auth=session_auth,
    response={201: SessionProjectEnvelope} | COMMON_ERROR_RESPONSES,
)
def create_session_project(
    request, workspace_id: str, payload: SessionProjectCreateRequest
):
    workspace = _workspace_for_user(request.user, workspace_id)
    if workspace is None:
        return Status(404, {"error": "workspace_not_found"})
    with transaction.atomic():
        membership = locked_workspace_membership_for(request.user, workspace_id)
        if membership is None:
            return Status(404, {"error": "workspace_not_found"})
        workspace = membership.workspace
        agent = Agent.objects.select_for_update().filter(
            id=payload.agent_id,
            workspace=workspace,
            owner=request.user,
        ).first()
        if agent is None:
            return Status(404, {"error": "agent_not_found"})
        if agent.status == "deleted":
            return Status(410, {"error": "agent_deleted"})
        project = SessionProject.objects.create(
            workspace=workspace,
            owner=request.user,
            agent=agent,
            name=payload.name,
        )
    return Status(201, {"project": serialize_session_project(project)})


@router.get(
    "/workspaces/{workspace_id}/sessions",
    auth=session_auth,
    response={200: SessionsEnvelope} | COMMON_ERROR_RESPONSES,
)
def list_workspace_sessions(request, workspace_id: str):
    workspace = _workspace_for_user(request.user, workspace_id)
    if workspace is None:
        return Status(404, {"error": "workspace_not_found"})
    query_fields = set(request.GET.keys())
    if query_fields - {"agentId"} or any(
        len(request.GET.getlist(field)) != 1 for field in query_fields
    ):
        return Status(400, {"error": "session_filter_unsupported"})
    agent_id = request.GET.get("agentId")
    if agent_id is not None:
        try:
            validate_agent_id(agent_id)
        except ValueError:
            return Status(400, {"error": "agent_id_invalid"})
        agent = Agent.objects.filter(
            id=agent_id,
            workspace=workspace,
            owner=request.user,
            status="active",
        ).first()
        if agent is None:
            return Status(404, {"error": "agent_not_found"})
    sessions = list(
        Session.objects.filter(
            workspace=workspace,
            owner=request.user,
            status="active",
            agent__status="active",
            **({"agent_id": agent_id} if agent_id is not None else {}),
        ).order_by("-isPinned", "-updatedAt")
    )
    running_session_ids = set(
        AgentRun.objects.filter(
            session__in=sessions, status__in=["queued", "running"]
        ).values_list("session_id", flat=True)
    )
    return {
        "sessions": [
            serialize_session(session, has_active_agent_run=session.id in running_session_ids)
            for session in sessions
        ]
    }


@router.post(
    "/workspaces/{workspace_id}/sessions",
    auth=session_auth,
    response={201: SessionEnvelope} | COMMON_ERROR_RESPONSES,
)
def create_workspace_session(request, workspace_id: str, payload: SessionCreateRequest):
    workspace = _workspace_for_user(request.user, workspace_id)
    if workspace is None:
        return Status(404, {"error": "workspace_not_found"})
    with transaction.atomic():
        membership = locked_workspace_membership_for(request.user, workspace_id)
        if membership is None:
            return Status(404, {"error": "workspace_not_found"})
        workspace = membership.workspace
        agent = Agent.objects.select_for_update().filter(
            id=payload.agent_id,
            workspace=workspace,
            owner=request.user,
        ).first()
        if agent is None:
            return Status(404, {"error": "agent_not_found"})
        if agent.status == "deleted":
            return Status(410, {"error": "agent_deleted"})
        project = None
        if payload.project_id is not None:
            project = SessionProject.objects.filter(
                id=payload.project_id,
                workspace=workspace,
                owner=request.user,
                agent=agent,
            ).first()
            if project is None:
                return Status(404, {"error": "session_project_not_found"})
        session = Session.objects.create(
            workspace=workspace,
            owner=request.user,
            agent=agent,
            project=project,
        )
    return Status(201, {"session": serialize_session(session)})


@router.get(
    "/sessions/{session_id}",
    auth=session_auth,
    response={200: SessionEnvelope} | COMMON_ERROR_RESPONSES,
)
def get_session(request, session_id: str):
    session = _session_for_update(request.user, session_id, lock=False)
    if session is None:
        return Status(404, {"error": "session_not_found"})
    return {"session": serialize_session(session)}


@router.patch(
    "/sessions/{session_id}",
    auth=session_auth,
    response={200: SessionEnvelope} | COMMON_ERROR_RESPONSES,
)
def update_session_metadata(
    request, session_id: str, payload: SessionMetadataRequest
):
    fields = payload.model_fields_set
    if not fields or any(getattr(payload, field) is None for field in fields):
        return Status(400, {"error": "session_metadata_invalid"})
    with transaction.atomic():
        session = _session_for_update(request.user, session_id, lock=True)
        if session is None:
            return Status(404, {"error": "session_not_found"})
        update_fields = []
        if "title" in fields:
            title = payload.title.strip()
            if not title or len(title) > 200:
                return Status(400, {"error": "session_title_invalid"})
            session.title = title
            update_fields.append("title")
        if "is_pinned" in fields:
            session.isPinned = payload.is_pinned
            update_fields.append("isPinned")
        if "is_unread" in fields:
            session.isUnread = payload.is_unread
            update_fields.append("isUnread")
        session.save(update_fields=update_fields)
    return {"session": serialize_session(session)}


@router.delete(
    "/sessions/{session_id}",
    auth=session_auth,
    response={200: DeletedResponse} | COMMON_ERROR_RESPONSES,
)
def delete_session(request, session_id: str):
    with transaction.atomic():
        agent, session = _locked_owned_session(request.user, session_id)
        if session is None:
            return Status(404, {"error": "session_not_found"})
        if session.status == "deleted":
            return Status(410, {"error": "session_deleted"})
        if agent.status == "deleted":
            return Status(409, {"error": "agent_deleted"})
        active_agent_runs = list(
            session.agent_runs.select_for_update(of=("self",))
            .select_related("authorization", "modelConfig", "session")
            .filter(status__in={"queued", "running"})
        )
        for agent_run in active_agent_runs:
            try:
                cancellation = request_agent_run_cancellation(agent_run)
            except RuntimeError:
                logger.exception(
                    "Session deletion could not stop AgentRun",
                    extra={"agentRunId": agent_run.id, "sessionId": session.id},
                )
                return Status(503, {"error": "session_delete_cancel_unavailable"})
            if cancellation["disposition"] == "terminal":
                projected = project_committed_agent_run(
                    agent_run, cancellation["terminalState"]
                )
                if projected.status in {"queued", "running"}:
                    return Status(503, {"error": "session_delete_cancel_unavailable"})
            else:
                AgentRun.objects.filter(
                    id=agent_run.id, status__in={"queued", "running"}
                ).update(transitionReason="agent_run_cancel_requested")
        deleted_at = timezone.now()
        session.status = "deleted"
        session.deletedAt = deleted_at
        session.deletedBy = request.user
        session.purgedAt = deleted_at
        session.save(
            update_fields=[
                "status",
                "deletedAt",
                "deletedBy",
                "purgedAt",
                "updatedAt",
            ]
        )
    return {"deleted": True}


@router.post(
    "/sessions/{session_id}/restore",
    auth=session_auth,
    response={200: SessionEnvelope} | COMMON_ERROR_RESPONSES,
)
def restore_session(request, session_id: str):
    with transaction.atomic():
        agent, session = _locked_owned_session(request.user, session_id)
        if session is None:
            return Status(404, {"error": "session_not_found"})
        if agent.status == "deleted":
            return Status(409, {"error": "agent_deleted"})
        if session.status != "deleted":
            return Status(409, {"error": "session_not_deleted"})
        if not trash_is_restorable(session.deletedAt, session.purgedAt):
            return Status(410, {"error": "session_expired"})
        if session.agent_runs.filter(status__in={"queued", "running"}).exists():
            return Status(409, {"error": "session_stop_pending"})
        session.status = "active"
        session.deletedAt = None
        session.deletedBy = None
        session.purgedAt = None
        session.save(
            update_fields=["status", "deletedAt", "deletedBy", "purgedAt", "updatedAt"]
        )
    return {"session": serialize_session(session, has_active_agent_run=False)}


@router.delete(
    "/sessions/{session_id}/trash",
    auth=session_auth,
    response={200: DeletedResponse} | COMMON_ERROR_RESPONSES,
)
def permanently_delete_session(request, session_id: str):
    with transaction.atomic():
        _agent, session = _locked_owned_session(request.user, session_id)
        if session is None:
            return Status(404, {"error": "session_not_found"})
        if session.status != "deleted":
            return Status(409, {"error": "session_not_deleted"})
        if session.purgedAt is not None:
            return Status(410, {"error": "session_purged"})
        session.purgedAt = timezone.now()
        session.save(update_fields=["purgedAt", "updatedAt"])
    return {"deleted": True}


@router.get(
    "/sessions/{session_id}/history",
    auth=session_auth,
    response={200: SessionHistoryEnvelope} | COMMON_ERROR_RESPONSES,
)
def session_history(request, session_id: str):
    try:
        session = Session.objects.select_related("workspace").get(
            id=session_id,
            owner=request.user,
            purgedAt__isnull=True,
            agent__purgedAt__isnull=True,
        )
    except Session.DoesNotExist:
        return Status(404, {"error": "session_not_found"})
    if workspace_membership_for(request.user, session.workspace_id) is None:
        return Status(404, {"error": "session_not_found"})
    query_fields = set(request.GET.keys())
    if not query_fields.issubset({"before", "limit"}):
        return Status(400, {"error": "session_history_query_invalid"})
    if any(len(request.GET.getlist(field)) != 1 for field in query_fields):
        return Status(400, {"error": "session_history_query_invalid"})
    raw_limit = request.GET.get("limit", str(SESSION_HISTORY_DEFAULT_LIMIT))
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError):
        return Status(400, {"error": "session_history_limit_invalid"})
    if limit < 1 or limit > SESSION_HISTORY_MAX_LIMIT or str(limit) != raw_limit:
        return Status(400, {"error": "session_history_limit_invalid"})
    before = request.GET.get("before")
    cursor = None
    if before is not None:
        try:
            cursor = _decode_session_history_cursor(before)
        except ValueError:
            return Status(400, {"error": "session_history_cursor_invalid"})

    agent_runs = []
    run_query = session.agent_runs.select_related(
        "modelConfig",
        "authorization",
    ).filter(
        Q(status__in={"queued", "running"})
        | Q(events__projects_to_agent_run_stream=True)
    ).distinct().order_by("-createdAt", "-id")
    if cursor is not None:
        run_query = run_query.filter(
            Q(createdAt__lt=cursor["createdAt"])
            | Q(createdAt=cursor["createdAt"], id__lt=cursor["id"])
        )
    page_descending = list(run_query[: limit + 1])
    has_more = len(page_descending) > limit
    page = list(reversed(page_descending[:limit]))
    for agent_run in page:
        try:
            terminal_agent_run = agent_run.status in {"completed", "failed", "cancelled"}
            if not terminal_agent_run and committed_session_terminal_state(agent_run) is not None:
                agent_run = project_committed_agent_run(agent_run)
                terminal_agent_run = True
            stream_cursor = "0-0"
            live_state = None
            stored_events = list(
                SessionEvent.objects.filter(
                    agent_run=agent_run,
                    projects_to_agent_run_stream=True,
                ).order_by("sequence", "eventId")
            )
            overlay_barriers = {}
            for stored in stored_events:
                advance_overlay_barrier(
                    overlay_barriers,
                    stored.payload,
                    stored.sequence,
                )
            if stored_events:
                stream_cursor = encode_stream_cursor(
                    agent_run.id,
                    stored_events[-1].sequence,
                )
            if not terminal_agent_run:
                try:
                    live_state = load_live_text_state(agent_run.id)
                except AgentRunStreamUnavailable as error:
                    if str(error) == "agent_run_live_state_invalid":
                        raise ValueError(str(error)) from error
                    logger.warning(
                        "Redis AgentRun buffer is unavailable; serving Postgres history only",
                        extra={"agentRunId": agent_run.id},
                    )
            if live_state is not None:
                if live_state["afterSequence"] > load_session_high_water(
                    agent_run.session_id
                ):
                    raise ValueError(
                        "live afterSequence exceeds PostgreSQL session high-water"
                    )
                if live_overlay_is_superseded(live_state, overlay_barriers):
                    live_state = None
            if live_state is not None:
                sealed = next(
                    (
                        stored.payload
                        for stored in stored_events
                        if stored.payload["type"] == "assistant_message"
                        and stored.payload["payload"]["messageId"]
                        == live_state["messageId"]
                    ),
                    None,
                )
                if sealed is not None:
                    if sealed["turnId"] != live_state["turnId"]:
                        raise ValueError(
                            "live assistant message identity conflicts with sealed history"
                        )
                    live_state = None
        except (RuntimeError, ValueError) as error:
            logger.exception(
                "Session history is invalid",
                extra={"agentRunId": agent_run.id},
            )
            return Status(409, {"error": str(error)})
        agent_runs.append(
            {
                "id": agent_run.id,
                "status": agent_run.status,
                "model": serialize_model(agent_run.modelConfig),
                "createdAt": agent_run.createdAt.isoformat(),
                "startedAt": agent_run.startedAt.isoformat() if agent_run.startedAt else None,
                "completedAt": (
                    agent_run.completedAt.isoformat() if agent_run.completedAt else None
                ),
                "events": [
                    {"sequence": stored.sequence, "event": stored.payload}
                    for stored in stored_events
                ],
                "live": live_state,
                "streamCursor": stream_cursor,
            }
        )
    next_cursor = _encode_session_history_cursor(page[0]) if has_more else None
    return {
        "schema": SESSION_HISTORY_SCHEMA,
        "session": serialize_session(session),
        "agentRuns": agent_runs,
        "nextCursor": next_cursor,
        "hasMore": has_more,
    }


@router.get(
    "/sessions/{session_id}/context-usage",
    auth=session_auth,
    response={200: SessionContextUsageEnvelope} | COMMON_ERROR_RESPONSES,
)
def session_context_usage(request, session_id: str):
    session = _session_for_update(request.user, session_id, lock=False)
    if session is None:
        return Status(404, {"error": "session_not_found"})
    boundaries = (
        SessionEvent.objects.filter(
            session=session,
            payload__type="model_request_started",
        )
        .select_related("agent_run__modelConfig")
    )
    event = boundaries.filter(payload__payload__purpose="main").order_by("-sequence").first()
    latest_boundary = boundaries.order_by("-sequence").first()
    try:
        is_compacting = bool(
            latest_boundary
            and latest_boundary.payload["payload"]["purpose"] == "compaction"
            and latest_boundary.agent_run.status == "running"
        )
        context_usage = None if event is None else _context_usage(event, is_compacting)
    except (KeyError, TypeError, ValueError):
        logger.exception("Session context usage is invalid", extra={"sessionId": session_id})
        return Status(409, {"error": "session_context_usage_invalid"})
    return {
        "schema": "session.context_usage.v1",
        "sessionId": session.id,
        "contextUsage": context_usage,
    }


def _encode_session_history_cursor(agent_run: AgentRun) -> str:
    payload = json.dumps(
        {"createdAt": agent_run.createdAt.isoformat(), "id": agent_run.id},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_session_history_cursor(value: str) -> dict:
    if not value or len(value) > 1024:
        raise ValueError("session history cursor length is invalid")
    try:
        padding = "=" * (-len(value) % 4)
        raw = base64.b64decode(
            f"{value}{padding}",
            altchars=b"-_",
            validate=True,
        )
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("session history cursor is invalid") from error
    if not isinstance(payload, dict) or set(payload) != {"createdAt", "id"}:
        raise ValueError("session history cursor fields are invalid")
    try:
        created_at = (
            parse_datetime(payload["createdAt"])
            if isinstance(payload["createdAt"], str)
            else None
        )
    except ValueError as error:
        raise ValueError("session history cursor timestamp is invalid") from error
    agent_run_id = payload["id"]
    if created_at is None or not timezone.is_aware(created_at):
        raise ValueError("session history cursor timestamp is invalid")
    if not isinstance(agent_run_id, str) or not agent_run_id or len(agent_run_id) > 128:
        raise ValueError("session history cursor AgentRun id is invalid")
    canonical = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    if canonical != value:
        raise ValueError("session history cursor encoding is not canonical")
    return {"createdAt": created_at, "id": agent_run_id}


@router.post(
    "/workspaces/{workspace_id}/sessions/{session_id}/messages",
    auth=session_auth,
    response={
        202: AgentRunAcceptedResponse,
        codes_4xx: ErrorResponse,
        503: ErrorResponse,
    },
)
def create_session_message(
    request,
    workspace_id: str,
    session_id: str,
):
    workspace = _workspace_for_user(request.user, workspace_id)
    if workspace is None:
        return Status(404, {"error": "session_not_found"})
    payload, uploads, request_error = _parse_session_message_request(request)
    if request_error:
        return Status(400, {"error": request_error})
    prompt = payload.text.strip()
    if not prompt:
        return Status(400, {"error": "empty_message"})
    attachment_refs = payload.attachment_refs
    if (
        not isinstance(attachment_refs, list)
        or any(
            not isinstance(item, str) or not item.strip() for item in attachment_refs
        )
        or attachment_refs != sorted(set(attachment_refs))
    ):
        return Status(400, {"error": "invalid_attachment_refs"})
    try:
        model = ModelConfig.objects.get(
            id=payload.model_config_ref,
            enabled=True,
            isCurrent=True,
        )
    except ModelConfig.DoesNotExist:
        return Status(400, {"error": "model_not_found"})
    thinking_mode = model.thinkingMode
    if payload.thinking_mode is not None:
        try:
            validate_thinking_mode(payload.thinking_mode)
        except ValueError:
            return Status(400, {"error": "model_thinking_mode_unsupported"})
        if payload.thinking_mode not in model.thinkingModes:
            return Status(400, {"error": "model_thinking_mode_unsupported"})
        thinking_mode = payload.thinking_mode
    if session_id != "new" and uploads:
        return Status(400, {"error": "message_upload_requires_new_session"})
    if session_id != "new" and payload.project_id is not None:
        return Status(400, {"error": "session_project_requires_new_session"})
    if session_id == "new" and attachment_refs:
        return Status(403, {"error": "attachment_not_accessible"})
    if session_id == "new" and payload.tail_action is not None:
        return Status(400, {"error": "rewrite_requires_existing_session"})
    if session_id == "new" and payload.agent_id is None:
        return Status(400, {"error": "agent_id_required"})
    if session_id == "new":
        requested_agent = Agent.objects.filter(
            id=payload.agent_id,
            workspace=workspace,
            owner=request.user,
        ).first()
        if requested_agent is None:
            return Status(404, {"error": "agent_not_found"})
        if requested_agent.status == "deleted":
            return Status(410, {"error": "agent_deleted"})
        if payload.project_id is not None and not SessionProject.objects.filter(
            id=payload.project_id,
            workspace=workspace,
            owner=request.user,
            agent=requested_agent,
        ).exists():
            return Status(404, {"error": "session_project_not_found"})
    else:
        # Reject inaccessible sessions before contacting Runtime; the transaction
        # below still revalidates the session under a row lock before any write.
        requested_session = Session.objects.select_related("agent").filter(
            id=session_id, workspace=workspace, owner=request.user, status="active"
        ).first()
        if requested_session is None:
            return Status(404, {"error": "session_not_found"})
        if requested_session.agent.status == "deleted":
            return Status(410, {"error": "agent_deleted"})
    try:
        execution_profile = request_execution_profile()
    except RuntimeError:
        logger.exception("Runtime execution profile is unavailable")
        return Status(503, {"error": "runtime_execution_profile_unavailable"})
    stored = []
    if uploads:
        try:
            if any(upload.size > MAX_DIRECT_INPUT_BYTES for upload in uploads):
                raise ValueError("attachment_too_large")
            stored = _store_upload_batch(
                uploads,
                f"users/{request.user.id}/library",
            )
        except ValueError as error:
            return Status(400, {"error": str(error)})
    try:
        with transaction.atomic():
            membership = locked_workspace_membership_for(request.user, workspace_id)
            if membership is None:
                raise AgentSessionCreationError(404, "session_not_found")
            workspace = membership.workspace
            if session_id == "new":
                agent = Agent.objects.select_for_update().filter(
                    id=payload.agent_id,
                    workspace=workspace,
                    owner=request.user,
                ).first()
                if agent is None:
                    raise AgentSessionCreationError(404, "agent_not_found")
                if agent.status == "deleted":
                    raise AgentSessionCreationError(410, "agent_deleted")
                project = None
                if payload.project_id is not None:
                    project = SessionProject.objects.filter(
                        id=payload.project_id,
                        workspace=workspace,
                        owner=request.user,
                        agent=agent,
                    ).first()
                    if project is None:
                        raise AgentSessionCreationError(
                            404, "session_project_not_found"
                        )
                session = Session.objects.create(
                    workspace=workspace,
                    owner=request.user,
                    agent=agent,
                    project=project,
                )
                library_objects = _create_uploaded_library_objects(request.user, stored)
                asset_links = []
                for library_object in library_objects:
                    asset_link, _created = SessionAssetLink.objects.get_or_create(
                        workspace=workspace,
                        session=session,
                        userLibraryObject=library_object,
                        attachedBy=request.user,
                        **captured_input_fields(library_object),
                        defaults={
                            "capturedDisplayName": library_object.displayName,
                            "capturedContentType": library_object.contentType,
                        },
                    )
                    asset_links.append(asset_link)
                attachment_refs = sorted(link.id for link in asset_links)
            else:
                try:
                    session = Session.objects.select_for_update().select_related(
                        "agent"
                    ).get(
                        id=session_id,
                        workspace=workspace,
                        owner=request.user,
                        status="active",
                    )
                except Session.DoesNotExist:
                    return Status(404, {"error": "session_not_found"})
                if session.agent.status == "deleted":
                    return Status(410, {"error": "agent_deleted"})
                if payload.agent_id is not None and payload.agent_id != session.agent_id:
                    return Status(409, {"error": "session_agent_mismatch"})
                if session.agent_runs.filter(status__in={"queued", "running"}).exists():
                    return Status(409, {"error": "session_has_active_agent_run"})
                linked_attachment_refs = set(
                    session.assetLinks.filter(id__in=attachment_refs).values_list(
                        "id",
                        flat=True,
                    )
                )
                if linked_attachment_refs != set(attachment_refs):
                    return Status(403, {"error": "attachment_not_accessible"})
            agent_run = AgentRun.objects.create(
                workspace=workspace,
                session=session,
                user=request.user,
                modelConfig=model,
                thinkingMode=thinking_mode,
                prompt=prompt,
                agent_instructions=session.agent.instructions,
                tailPolicy=("rewriteLastUser" if payload.tail_action else "append"),
                rewriteTargetMessageId=(payload.tail_action.target_message_id if payload.tail_action else ""),
                rewriteExpectedTailMessageId=(payload.tail_action.expected_tail_message_id if payload.tail_action else ""),
            )
            create_agent_run_authorization(
                agent_run,
                message_asset_refs=attachment_refs,
                image_digest=execution_profile["imageDigest"],
            )
            if session.title == "New chat":
                session.title = prompt[:80]
            session.updatedAt = timezone.now()
            session.save(update_fields=["title", "updatedAt"])
    except AgentSessionCreationError as database_error:
        try:
            _delete_stored_upload_batch(stored)
        except RuntimeError as cleanup_error:
            raise cleanup_error from database_error
        return Status(database_error.status, {"error": database_error.code})
    except Exception as database_error:
        try:
            _delete_stored_upload_batch(stored)
        except RuntimeError as cleanup_error:
            raise cleanup_error from database_error
        raise
    try:
        schedule_agent_run_lifecycle(agent_run)
    except Exception:
        logger.exception(
            "Workspace AgentRun lifecycle scheduling is pending reconciliation",
            extra={"agentRunId": agent_run.id},
        )
        AgentRun.objects.filter(id=agent_run.id, status="queued").update(
            transitionReason="agent_run_lifecycle_schedule_pending"
        )
    return Status(
        202,
        {
            "agentRunId": agent_run.id,
            "turnId": agent_run.turn_id,
            "sessionId": session.id,
            "session": serialize_session(session),
            "status": "queued",
        },
    )


def _parse_session_message_request(request):
    uploads = []
    if request.content_type == "application/json":
        try:
            value = json.loads(request.body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, uploads, "invalid_json"
    elif request.content_type == "multipart/form-data":
        try:
            uploads = _require_uploads(
                request,
                {"text", "modelConfigRef", "agentId", "projectId", "thinkingMode"},
            )
        except ValueError as error:
            return None, uploads, str(error)
        if (
            not {"text", "modelConfigRef", "agentId"}.issubset(request.POST)
            or not set(request.POST).issubset(
                {"text", "modelConfigRef", "agentId", "projectId", "thinkingMode"}
            )
            or len(request.POST.getlist("text")) != 1
            or len(request.POST.getlist("modelConfigRef")) != 1
            or len(request.POST.getlist("agentId")) != 1
            or len(request.POST.getlist("projectId")) > 1
            or len(request.POST.getlist("thinkingMode")) > 1
        ):
            return None, uploads, "message_fields_invalid"
        value = {
            "text": request.POST["text"],
            "modelConfigRef": request.POST["modelConfigRef"],
            "agentId": request.POST["agentId"],
        }
        if "thinkingMode" in request.POST:
            value["thinkingMode"] = request.POST["thinkingMode"]
        if "projectId" in request.POST:
            value["projectId"] = request.POST["projectId"]
    else:
        return None, uploads, "message_content_type_unsupported"
    try:
        return SessionMessageRequest.model_validate(value), uploads, None
    except ValidationError as error:
        code = (
            "invalid_attachment_refs"
            if any("attachmentRefs" in item["loc"] for item in error.errors())
            else "request_invalid"
        )
        return None, uploads, code


@router.post(
    "/sessions/{session_id}/agent-runs/{agent_run_id}/supplements",
    auth=session_auth,
    response={
        202: AgentRunSupplementResponse,
        codes_4xx: ErrorResponse,
    },
)
def supplement_agent_run(
    request,
    session_id: str,
    agent_run_id: str,
    payload: AgentRunSupplementRequest,
):
    try:
        agent_run = AgentRun.objects.select_related(
            "authorization", "modelConfig", "session"
        ).get(
            id=agent_run_id,
            session_id=session_id,
            status__in={"queued", "running"},
            session__owner=request.user,
        )
    except AgentRun.DoesNotExist:
        return Status(404, {"error": "active_agent_run_not_found"})
    if not agent_run_membership_is_current(agent_run):
        return Status(404, {"error": "active_agent_run_not_found"})
    try:
        result = request_agent_run_supplement(agent_run, payload.supplement_id, payload.message)
    except ValueError as error:
        return Status(409, {"error": str(error)})
    except RuntimeError:
        logger.exception(
            "Workspace AgentRun supplement request failed", extra={"agentRunId": agent_run.id}
        )
        return Status(503, {"error": "agent_run_supplement_unavailable"})
    return Status(
        202,
        {
            "agentRunId": agent_run.id,
            "sessionId": agent_run.session_id,
            "supplementId": payload.supplement_id,
            "disposition": result["disposition"],
            "queuedCount": result["queuedCount"],
        },
    )


@router.post(
    "/sessions/{session_id}/agent-runs/{agent_run_id}/cancel",
    auth=session_auth,
    response={
        200: AgentRunCancellationResponse,
        202: AgentRunCancellationResponse,
        codes_4xx: ErrorResponse,
    },
)
def cancel_agent_run(request, session_id: str, agent_run_id: str):
    try:
        agent_run = AgentRun.objects.select_related(
            "authorization", "modelConfig", "session"
        ).get(
            id=agent_run_id,
            session_id=session_id,
            session__owner=request.user,
        )
    except AgentRun.DoesNotExist:
        return Status(404, {"error": "agent_run_not_found"})
    if not agent_run_membership_is_current(agent_run):
        return Status(404, {"error": "agent_run_not_found"})
    if agent_run.status in {"completed", "failed", "cancelled"}:
        return {
            "agentRunId": agent_run.id,
            "status": agent_run.status,
            "disposition": "terminal",
        }
    try:
        cancellation = request_agent_run_cancellation(agent_run)
    except RuntimeError:
        logger.exception(
            "Workspace AgentRun cancellation request failed", extra={"agentRunId": agent_run.id}
        )
        return Status(503, {"error": "agent_run_cancel_unavailable"})
    if cancellation["disposition"] == "terminal":
        projected = project_committed_agent_run(agent_run, cancellation["terminalState"])
        return {
            "agentRunId": projected.id,
            "status": projected.status,
            "disposition": "terminal",
        }
    AgentRun.objects.filter(id=agent_run.id, status__in={"queued", "running"}).update(
        transitionReason="agent_run_cancel_requested"
    )
    agent_run.refresh_from_db(fields=["status"])
    return Status(
        202,
        {
            "agentRunId": agent_run.id,
            "status": agent_run.status,
            "disposition": "requested",
        },
    )


def _workspace_for_user(
    user,
    workspace_id: str,
    *,
    allowed_roles=None,
) -> Workspace | None:
    options = {} if allowed_roles is None else {"allowed_roles": allowed_roles}
    membership = workspace_membership_for(user, workspace_id, **options)
    return membership.workspace if membership else None


def _workspace_mcp_servers(catalog: dict) -> dict[str, list[dict]]:
    result = request_workspace_mcp_catalog(catalog)
    plugins = result.get("plugins")
    if not isinstance(plugins, list):
        raise ValueError("workspace_mcp_catalog_plugins_invalid")
    by_name = {}
    for plugin in plugins:
        if (
            not isinstance(plugin, dict)
            or set(plugin) != {"pluginName", "servers"}
            or not isinstance(plugin["pluginName"], str)
            or not isinstance(plugin["servers"], list)
            or plugin["pluginName"] in by_name
        ):
            raise ValueError("workspace_mcp_catalog_plugin_invalid")
        by_name[plugin["pluginName"]] = plugin["servers"]
    expected = {package["name"] for package in catalog["packages"]}
    if set(by_name) != expected:
        raise ValueError("workspace_mcp_catalog_plugin_mismatch")
    return by_name


def _workspace_hooks(catalog: dict) -> dict[str, list[dict]]:
    result = request_workspace_hook_catalog(catalog)
    plugins = result.get("plugins")
    if not isinstance(plugins, list):
        raise ValueError("workspace_hook_catalog_plugins_invalid")
    by_name = {}
    supported_events = {
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "PreCompact",
        "PostCompact",
        "SubagentStart",
        "SubagentStop",
    }
    for plugin in plugins:
        if (
            not isinstance(plugin, dict)
            or set(plugin) != {"pluginName", "hooks"}
            or not isinstance(plugin["pluginName"], str)
            or not isinstance(plugin["hooks"], list)
            or plugin["pluginName"] in by_name
        ):
            raise ValueError("workspace_hook_catalog_plugin_invalid")
        hook_ids = set()
        for hook in plugin["hooks"]:
            if (
                not isinstance(hook, dict)
                or set(hook) != {"id", "event", "matcher", "timeoutMs"}
                or not isinstance(hook["id"], str)
                or not hook["id"]
                or hook["id"] in hook_ids
                or hook["event"] not in supported_events
                or (hook["matcher"] is not None and not isinstance(hook["matcher"], str))
                or type(hook["timeoutMs"]) is not int
                or not 1 <= hook["timeoutMs"] <= 10_000
            ):
                raise ValueError("workspace_hook_catalog_hook_invalid")
            hook_ids.add(hook["id"])
        by_name[plugin["pluginName"]] = plugin["hooks"]
    expected = {package["name"] for package in catalog["packages"]}
    if set(by_name) != expected:
        raise ValueError("workspace_hook_catalog_plugin_mismatch")
    return by_name


def _workspace_plugin(package: dict, enabled: bool, *, inspect: bool = False) -> dict:
    catalog = {
        "schema": "plugin_activation_snapshot_v1",
        "digest": activation_digest([package]),
        "packages": [package],
    }
    errors = []
    try:
        interface = load_plugin_interfaces(catalog)[package["name"]]
    except (OSError, ValueError):
        logger.exception("Plugin manifest is unavailable: %s", package["name"])
        interface = {"displayName": package["name"], "shortDescription": "", "capabilities": []}
        errors.append("plugin_manifest_invalid")
    plugin = _serialize_workspace_plugin(package, interface, enabled, None, None, set())
    plugin["errors"] = errors
    if not errors:
        try:
            plugin["mcpCredentialRefs"] = load_plugin_bearer_credential_refs(package)
        except (OSError, ValueError):
            logger.exception("Plugin credential metadata is unavailable: %s", package["name"])
            errors.append("plugin_credentials_unavailable")
    if inspect and "plugin_manifest_invalid" not in errors:
        configured = set(McpBearerCredential.objects.values_list("plugin_name", "credential_ref"))
        for field, contribution, loader, code in (
            (
                "mcpServers",
                "mcpServers",
                _workspace_mcp_servers,
                "workspace_mcp_catalog_unavailable",
            ),
            ("hooks", "hooks", _workspace_hooks, "workspace_hook_catalog_unavailable"),
        ):
            if not package[contribution]:
                plugin[field] = []
                continue
            try:
                values = loader(catalog)[package["name"]]
                projected = _serialize_workspace_plugin(
                    package, interface, enabled,
                    values if field == "mcpServers" else None,
                    values if field == "hooks" else None,
                    configured,
                )
                WorkspacePluginResponse.model_validate(projected)
                plugin[field] = projected[field]
            except (OSError, RuntimeError, ValueError, KeyError, TypeError):
                logger.exception("Plugin inspection failed: %s %s", package["name"], field)
                errors.append(code)
    return plugin


def _serialize_workspace_plugin(
    package: dict,
    interface: dict,
    enabled: bool,
    mcp_servers: list[dict] | None,
    hooks: list[dict] | None,
    configured_credentials: set[tuple[str, str]],
) -> dict:
    projected_servers = []
    for server in mcp_servers or []:
        auth = server["auth"]
        credential_ref = auth["credentialRef"]
        projected_servers.append(
            {
                **server,
                "auth": {
                    **auth,
                    "credentialConfigured": (
                        None
                        if auth["type"] == "none"
                        else (package["name"], credential_ref)
                        in configured_credentials
                    ),
                },
            }
        )
    return {
        "name": package["name"],
        **interface,
        "version": package["version"],
        "packageDigest": package["packageDigest"],
        "enabled": enabled,
        "skills": package["skills"],
        "cli": package["cli"],
        "mcpServers": None if mcp_servers is None else projected_servers,
        "mcpCredentialRefs": None,
        "hooks": hooks,
        "errors": [],
    }


def _context_usage(event: SessionEvent, is_compacting: bool) -> dict:
    payload = event.payload["payload"]
    purpose = payload["purpose"]
    estimate = payload["contextTokenEstimate"]
    breakdown = payload["contextTokenBreakdown"]
    expected_breakdown_fields = {
        "systemPromptTokens",
        "systemToolTokens",
        "mcpToolTokens",
        "skillsTokens",
        "messageTokens",
        "mcpTools",
    }
    if (
        purpose != "main"
        or type(estimate) is not int
        or estimate < 0
        or not isinstance(breakdown, dict)
        or set(breakdown) != expected_breakdown_fields
    ):
        raise ValueError("session_context_usage_payload_invalid")
    token_fields = expected_breakdown_fields - {"mcpTools"}
    if any(type(breakdown[field]) is not int or breakdown[field] < 0 for field in token_fields):
        raise ValueError("session_context_usage_breakdown_invalid")
    if sum(breakdown[field] for field in token_fields) != estimate:
        raise ValueError("session_context_usage_total_mismatch")
    mcp_tools = breakdown["mcpTools"]
    if not isinstance(mcp_tools, list) or any(
        not isinstance(tool, dict)
        or set(tool) != {"providerId", "name", "tokens"}
        or not isinstance(tool["providerId"], str)
        or not tool["providerId"].strip()
        or not isinstance(tool["name"], str)
        or not tool["name"].strip()
        or type(tool["tokens"]) is not int
        or tool["tokens"] < 0
        for tool in mcp_tools
    ):
        raise ValueError("session_context_usage_mcp_tools_invalid")
    if len({(tool["providerId"], tool["name"]) for tool in mcp_tools}) != len(mcp_tools):
        raise ValueError("session_context_usage_mcp_tool_identity_duplicate")
    if sum(tool["tokens"] for tool in mcp_tools) != breakdown["mcpToolTokens"]:
        raise ValueError("session_context_usage_mcp_total_mismatch")
    max_context_tokens = event.agent_run.modelConfig.contextTokens
    auto_compact_buffer_tokens = min(
        max(max_context_tokens - estimate, 0),
        CONTEXT_COMPACTION_HEADROOM_TOKENS,
    )
    used_tokens = min(estimate + auto_compact_buffer_tokens, max_context_tokens)
    return {
        "usedTokens": used_tokens,
        "maxContextTokens": max_context_tokens,
        "usedPercentage": min(
            (used_tokens * 100 + max_context_tokens // 2) // max_context_tokens,
            100,
        ),
        "updatedAt": event.createdAtMs,
        "isCompacting": is_compacting,
        "breakdown": {
            **breakdown,
            "autoCompactBufferTokens": auto_compact_buffer_tokens,
            "freeSpaceTokens": max(max_context_tokens - used_tokens, 0),
        },
    }


def _session_for_update(user, session_id: str, *, lock: bool):
    query = Session.objects
    if lock:
        query = query.select_for_update()
    try:
        session = query.select_related("workspace", "agent").get(
            id=session_id,
            owner=user,
            status="active",
            agent__status="active",
        )
    except Session.DoesNotExist:
        return None
    return session if workspace_membership_for(user, session.workspace_id) else None


def _locked_owned_session(user, session_id: str):
    scope = Session.objects.filter(id=session_id, owner=user).values_list(
        "workspace_id",
        "agent_id",
    ).first()
    if scope is None:
        return None, None
    workspace_id, agent_id = scope
    if locked_workspace_membership_for(user, workspace_id) is None:
        return None, None
    agent = Agent.objects.select_for_update().filter(
        id=agent_id,
        workspace_id=workspace_id,
        owner=user,
    ).first()
    if agent is None:
        return None, None
    session = Session.objects.select_for_update().filter(
        id=session_id,
        workspace_id=workspace_id,
        owner=user,
        agent_id=agent_id,
    ).first()
    return agent, session
