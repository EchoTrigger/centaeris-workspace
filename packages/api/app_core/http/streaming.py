from asgiref.sync import sync_to_async
from django.http import JsonResponse
from ninja import Router

from app_core.models import AgentRun
from app_core.agent_run_stream import (
    parse_last_event_cursor,
    require_cursor_not_future,
    stream_agent_run_session_items_async,
)
from app_core.workspace_access import (
    agent_run_membership_is_current,
    workspace_membership_for,
)
from .security import session_auth
from .stream_response import OwnedAsyncStreamingHttpResponse


router = Router(tags=["streaming"], by_alias=True)


@router.get(
    "/sessions/{session_id}/agent-runs/{agent_run_id}/events",
    auth=session_auth,
    response=None,
)
async def agent_run_events(request, session_id: str, agent_run_id: str):
    prepared = await _prepare_agent_run_stream(
        user_id=request.user.id,
        session_id=session_id,
        agent_run_id=agent_run_id,
        last_event_id=request.headers.get("Last-Event-ID", ""),
    )
    if isinstance(prepared, JsonResponse):
        return prepared
    agent_run, cursor = prepared
    response = OwnedAsyncStreamingHttpResponse(
        stream_agent_run_session_items_async(agent_run, cursor),
        content_type="text/event-stream",
    )
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"
    return response


@sync_to_async(thread_sensitive=True)
def _prepare_agent_run_stream(
    *,
    user_id: int,
    session_id: str,
    agent_run_id: str,
    last_event_id: str,
):
    try:
        agent_run = AgentRun.objects.select_related(
            "session",
            "workspace",
            "modelConfig",
            "user",
        ).get(
            id=agent_run_id,
            session_id=session_id,
            user_id=user_id,
        )
    except AgentRun.DoesNotExist:
        return JsonResponse({"error": "agent_run_not_found"}, status=404)
    if (
        agent_run.status in {"queued", "running"}
        and not agent_run_membership_is_current(agent_run)
    ) or (
        agent_run.status in {"completed", "failed", "cancelled"}
        and workspace_membership_for(agent_run.user, agent_run.workspace_id) is None
    ):
        return JsonResponse({"error": "agent_run_not_found"}, status=404)
    try:
        cursor = parse_last_event_cursor(last_event_id, agent_run.id)
        require_cursor_not_future(agent_run, cursor)
    except ValueError as error:
        return JsonResponse({"error": str(error)}, status=400)
    return agent_run, cursor
