from typing import Literal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from ninja import Router, Status
from pydantic import Field, field_validator

from app_core.agent_identity import (
    normalize_agent_description,
    normalize_agent_instructions,
    normalize_agent_name,
)
from app_core.models import Agent, AgentRun
from app_core.trash_retention import trash_is_restorable
from app_core.workspace_access import (
    locked_workspace_membership_for,
    workspace_membership_for,
)

from .response_schema import (
    AgentEnvelope,
    AgentsEnvelope,
    COMMON_ERROR_RESPONSES,
    DeletedResponse,
    SessionTrashEnvelope,
)
from .schema import StrictSchema
from .security import session_auth
from .serialization import serialize_agent, serialize_session
from .trash_pagination import read_trash_cursor, trash_page


router = Router(tags=["agents"], by_alias=True)


class CreateAgentRequest(StrictSchema):
    name: str
    description: str = ""
    instructions: str = ""
    avatar_kind: Literal["centaeris", "banana"] = Field(
        "centaeris",
        alias="avatarKind",
    )

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return normalize_agent_name(value)

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        return normalize_agent_description(value)

    @field_validator("instructions")
    @classmethod
    def validate_instructions(cls, value: str) -> str:
        return normalize_agent_instructions(value)


class UpdateAgentRequest(StrictSchema):
    name: str | None = None
    description: str | None = None
    instructions: str | None = None
    avatar_kind: Literal["centaeris", "banana"] | None = Field(
        None,
        alias="avatarKind",
    )

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str | None) -> str | None:
        return None if value is None else normalize_agent_name(value)

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str | None) -> str | None:
        return None if value is None else normalize_agent_description(value)

    @field_validator("instructions")
    @classmethod
    def validate_instructions(cls, value: str | None) -> str | None:
        return None if value is None else normalize_agent_instructions(value)


@router.get(
    "/workspaces/{workspace_id}/agents",
    auth=session_auth,
    response={200: AgentsEnvelope} | COMMON_ERROR_RESPONSES,
)
def list_agents(request, workspace_id: str):
    if workspace_membership_for(request.user, workspace_id) is None:
        return Status(404, {"error": "workspace_not_found"})
    agents = Agent.objects.filter(
        workspace_id=workspace_id,
        owner=request.user,
        status="active",
    ).order_by("createdAt", "id")
    return {"agents": [serialize_agent(agent) for agent in agents]}


@router.post(
    "/workspaces/{workspace_id}/agents",
    auth=session_auth,
    response={201: AgentEnvelope} | COMMON_ERROR_RESPONSES,
)
def create_agent(request, workspace_id: str, payload: CreateAgentRequest):
    with transaction.atomic():
        membership = locked_workspace_membership_for(request.user, workspace_id)
        if membership is None:
            return Status(404, {"error": "workspace_not_found"})
        agent = Agent.objects.create(
            workspace=membership.workspace,
            owner=request.user,
            name=payload.name,
            description=payload.description,
            instructions=payload.instructions,
            avatar_kind=payload.avatar_kind,
        )
    return Status(201, {"agent": serialize_agent(agent)})


@router.get(
    "/agents/{agent_id}",
    auth=session_auth,
    response={200: AgentEnvelope} | COMMON_ERROR_RESPONSES,
)
def get_agent(request, agent_id: str):
    agent = _owned_agent(request.user, agent_id)
    if agent is None or agent.status != "active":
        return Status(404, {"error": "agent_not_found"})
    return {"agent": serialize_agent(agent)}


@router.get(
    "/agents/{agent_id}/trash/sessions",
    auth=session_auth,
    response={200: SessionTrashEnvelope} | COMMON_ERROR_RESPONSES,
)
def list_trashed_agent_sessions(request, agent_id: str):
    agent = _owned_agent(request.user, agent_id)
    if agent is None:
        return Status(404, {"error": "agent_not_found"})
    if agent.status != "deleted":
        return Status(409, {"error": "agent_not_deleted"})
    if not trash_is_restorable(agent.deletedAt, agent.purgedAt):
        return Status(410, {"error": "agent_expired"})
    try:
        cursor = read_trash_cursor(
            request,
            f"agent:{agent_id}:sessions",
            {"isPinned", "updatedAt", "id"},
        )
        updated_at = parse_datetime(cursor["updatedAt"]) if cursor else None
        if cursor and (
            not isinstance(cursor["isPinned"], bool)
            or updated_at is None
            or not timezone.is_aware(updated_at)
            or not isinstance(cursor["id"], str)
            or not cursor["id"]
        ):
            raise ValueError("trash_cursor_invalid")
    except (TypeError, ValueError) as error:
        return Status(400, {"error": str(error)})
    sessions = agent.sessions.all()
    if cursor:
        same_pin_after = Q(isPinned=cursor["isPinned"]) & (
            Q(updatedAt__lt=updated_at)
            | Q(updatedAt=updated_at, id__gt=cursor["id"])
        )
        sessions = sessions.filter(
            same_pin_after | Q(isPinned=False)
            if cursor["isPinned"]
            else same_pin_after
        )
    sessions, next_cursor, has_more = trash_page(
        sessions.order_by("-isPinned", "-updatedAt", "id"),
        f"agent:{agent_id}:sessions",
        lambda session: {
            "isPinned": session.isPinned,
            "updatedAt": session.updatedAt.isoformat(),
            "id": session.id,
        },
    )
    running_session_ids = set(
        AgentRun.objects.filter(
            session__in=sessions,
            status__in={"queued", "running"},
        ).values_list("session_id", flat=True)
    )
    return {
        "sessions": [
            serialize_session(
                session,
                has_active_agent_run=session.id in running_session_ids,
            )
            for session in sessions
        ],
        "nextCursor": next_cursor,
        "hasMore": has_more,
    }


@router.patch(
    "/agents/{agent_id}",
    auth=session_auth,
    response={200: AgentEnvelope} | COMMON_ERROR_RESPONSES,
)
def update_agent(request, agent_id: str, payload: UpdateAgentRequest):
    fields = payload.model_fields_set
    if not fields or any(getattr(payload, field) is None for field in fields):
        return Status(400, {"error": "agent_invalid"})
    with transaction.atomic():
        agent = _owned_agent(request.user, agent_id, lock=True)
        if agent is None:
            return Status(404, {"error": "agent_not_found"})
        if agent.status == "deleted":
            return Status(410, {"error": "agent_deleted"})
        if all(getattr(agent, field) == getattr(payload, field) for field in fields):
            return Status(409, {"error": "agent_unchanged"})
        update_fields = []
        if "name" in fields:
            agent.name = payload.name
            update_fields.append("name")
        if "description" in fields:
            agent.description = payload.description
            update_fields.append("description")
        if "instructions" in fields:
            agent.instructions = payload.instructions
            update_fields.append("instructions")
        if "avatar_kind" in fields:
            agent.avatar_kind = payload.avatar_kind
            update_fields.append("avatar_kind")
        agent.save(update_fields=[*update_fields, "updatedAt"])
    return {"agent": serialize_agent(agent)}


@router.delete(
    "/agents/{agent_id}",
    auth=session_auth,
    response={200: DeletedResponse} | COMMON_ERROR_RESPONSES,
)
def delete_agent(request, agent_id: str):
    with transaction.atomic():
        agent = _owned_agent(request.user, agent_id, lock=True)
        if agent is None:
            return Status(404, {"error": "agent_not_found"})
        if agent.status == "deleted":
            return Status(410, {"error": "agent_deleted"})
        if agent.sessions.filter(
            agent_runs__status__in={"queued", "running"}
        ).exists():
            return Status(409, {"error": "agent_has_active_agent_run"})
        agent.status = "deleted"
        agent.deletedAt = timezone.now()
        agent.deletedBy = request.user
        agent.save(update_fields=["status", "deletedAt", "deletedBy", "updatedAt"])
    return {"deleted": True}


@router.post(
    "/agents/{agent_id}/restore",
    auth=session_auth,
    response={200: AgentEnvelope} | COMMON_ERROR_RESPONSES,
)
def restore_agent(request, agent_id: str):
    with transaction.atomic():
        agent = _owned_agent(request.user, agent_id, lock=True)
        if agent is None:
            return Status(404, {"error": "agent_not_found"})
        if agent.status != "deleted":
            return Status(409, {"error": "agent_not_deleted"})
        if not trash_is_restorable(agent.deletedAt, agent.purgedAt):
            return Status(410, {"error": "agent_expired"})
        agent.status = "active"
        agent.deletedAt = None
        agent.deletedBy = None
        agent.purgedAt = None
        agent.save(
            update_fields=["status", "deletedAt", "deletedBy", "purgedAt", "updatedAt"]
        )
    return {"agent": serialize_agent(agent)}


@router.delete(
    "/agents/{agent_id}/trash",
    auth=session_auth,
    response={200: DeletedResponse} | COMMON_ERROR_RESPONSES,
)
def permanently_delete_agent(request, agent_id: str):
    with transaction.atomic():
        agent = _owned_agent(request.user, agent_id, lock=True)
        if agent is None:
            return Status(404, {"error": "agent_not_found"})
        if agent.status != "deleted":
            return Status(409, {"error": "agent_not_deleted"})
        if agent.purgedAt is not None:
            return Status(410, {"error": "agent_purged"})
        agent.purgedAt = timezone.now()
        agent.save(update_fields=["purgedAt", "updatedAt"])
    return {"deleted": True}


def _owned_agent(user, agent_id: str, *, lock: bool = False) -> Agent | None:
    agent_scope = Agent.objects.filter(id=agent_id, owner=user).values_list(
        "workspace_id",
        flat=True,
    ).first()
    if agent_scope is None:
        return None
    if lock:
        if locked_workspace_membership_for(user, agent_scope) is None:
            return None
        return Agent.objects.select_for_update().filter(
            id=agent_id,
            owner=user,
            workspace_id=agent_scope,
        ).first()
    if workspace_membership_for(user, agent_scope) is None:
        return None
    return Agent.objects.filter(
        id=agent_id,
        owner=user,
        workspace_id=agent_scope,
    ).first()
