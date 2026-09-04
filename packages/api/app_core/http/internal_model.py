import json

from asgiref.sync import sync_to_async
from django.http import JsonResponse
from ninja import Router

from app_core.model_adapter import (
    ModelProviderError,
    run_model,
    safe_model_error_reason,
    stream_model_async,
    validate_prepared_prompt,
)
from app_core.models import ModelConfig, AgentRunAuthorization
from app_core.runtime_contract import (
    MODEL_RUN_SCHEMA,
    authorization_digest,
    validate_agent_run_authorization_payload,
)
from app_core.workspace_access import agent_run_membership_is_current

from .security import internal_token_auth
from .stream_response import OwnedAsyncStreamingHttpResponse


router = Router(tags=["internal"], by_alias=True)


@router.post(
    "/model-runs",
    auth=internal_token_auth,
    response=None,
    include_in_schema=False,
)
async def model_runs(request):
    try:
        body = json.loads(request.body.decode("utf-8")) if request.body else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        return JsonResponse({"error": "invalid_json"}, status=400)
    prepared = await _validate_model_run(body)
    if isinstance(prepared, JsonResponse):
        return prepared
    model_config_ref = prepared
    agent_run_id = str(body["agentRunId"])
    if request.headers.get("Accept") == "text/event-stream":
        response = OwnedAsyncStreamingHttpResponse(
            stream_model_async(agent_run_id, model_config_ref, body),
            content_type="text/event-stream",
        )
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        return response
    try:
        result = await sync_to_async(run_model, thread_sensitive=True)(
            agent_run_id=agent_run_id,
            model_config_ref=model_config_ref,
            request_body=body,
        )
    except ModelConfig.DoesNotExist:
        return JsonResponse({"error": "model_not_found"}, status=404)
    except Exception as error:
        return JsonResponse(
            {
                "error": "model_run_failed",
                "reasonType": safe_model_error_reason(error),
            },
            status=502,
        )
    return JsonResponse(result)


@sync_to_async(thread_sensitive=True)
def _validate_model_run(body):
    if not isinstance(body, dict):
        return JsonResponse({"error": "invalid_json"}, status=400)
    if body.get("schema") != MODEL_RUN_SCHEMA:
        return JsonResponse({"error": "schema_mismatch"}, status=400)
    allowed_model_run_fields = {
        "schema",
        "agentRunId",
        "modelConfigRef",
        "thinkingMode",
        "authorizationRef",
        "authorizationDigest",
        "maxOutputTokens",
        "preparedPrompt",
    }
    unexpected_model_run_fields = sorted(set(body) - allowed_model_run_fields)
    if unexpected_model_run_fields:
        return JsonResponse(
            {
                "error": "model_run_fields_invalid",
                "fields": unexpected_model_run_fields,
            },
            status=400,
        )
    authorization_ref = str(body.get("authorizationRef", "")).strip()
    expected_authorization_digest = str(body.get("authorizationDigest", "")).strip()
    if not authorization_ref:
        return JsonResponse({"error": "agent_run_authorization_required"}, status=400)
    if not expected_authorization_digest:
        return JsonResponse(
            {"error": "agent_run_authorization_digest_required"},
            status=400,
        )
    authorization = AgentRunAuthorization.objects.select_related(
        "agent_run",
        "agent_run__modelConfig",
        "agent_run__session",
    ).filter(
        id=authorization_ref,
        agent_run_id=str(body.get("agentRunId", "")),
        digest=expected_authorization_digest,
    ).first()
    if authorization is None:
        return JsonResponse({"error": "agent_run_authorization_not_found"}, status=404)
    if not agent_run_membership_is_current(authorization.agent_run):
        return JsonResponse({"error": "agent_run_authorization_not_found"}, status=404)
    try:
        validate_agent_run_authorization_payload(authorization.payload)
    except ValueError:
        return JsonResponse({"error": "agent_run_authorization_invalid"}, status=409)
    if authorization_digest(authorization.payload) != authorization.digest:
        return JsonResponse(
            {"error": "agent_run_authorization_digest_mismatch"},
            status=409,
        )
    if (
        authorization.payload["agentRunId"] != authorization.agent_run_id
        or authorization.payload["workspaceId"] != authorization.agent_run.workspace_id
        or authorization.payload["userId"] != str(authorization.agent_run.user_id)
        or authorization.payload["agentId"] != authorization.agent_run.session.agent_id
        or authorization.payload["sessionId"] != authorization.agent_run.session_id
        or authorization.payload["modelConfigRef"]
        != authorization.agent_run.modelConfig_id
        or str(body.get("modelConfigRef", ""))
        != authorization.payload["modelConfigRef"]
        or body.get("thinkingMode") != authorization.payload["thinkingMode"]
    ):
        return JsonResponse(
            {"error": "agent_run_authorization_binding_mismatch"},
            status=409,
        )
    max_output_tokens = body.get("maxOutputTokens")
    if (
        not isinstance(max_output_tokens, int)
        or isinstance(max_output_tokens, bool)
        or max_output_tokens <= 0
        or max_output_tokens > authorization.agent_run.modelConfig.maxOutputTokens
    ):
        return JsonResponse({"error": "model_output_limit_mismatch"}, status=409)
    prepared_prompt = body.get("preparedPrompt")
    if not isinstance(prepared_prompt, dict):
        return JsonResponse({"error": "prepared_prompt_required"}, status=400)
    if prepared_prompt.get("schema") != "prepared_prompt.v1":
        return JsonResponse(
            {"error": "prepared_prompt_schema_invalid"},
            status=400,
        )
    allowed_prepared_prompt_fields = {
        "schema",
        "systemPrompt",
        "messages",
        "toolDefinitions",
        "toolChoice",
        "maxOutputTokens",
    }
    unexpected_prepared_prompt_fields = sorted(
        set(prepared_prompt) - allowed_prepared_prompt_fields
    )
    if unexpected_prepared_prompt_fields:
        return JsonResponse(
            {
                "error": "prepared_prompt_fields_invalid",
                "fields": unexpected_prepared_prompt_fields,
            },
            status=400,
        )
    if not isinstance(prepared_prompt.get("messages"), list):
        return JsonResponse(
            {"error": "prepared_prompt_messages_invalid"},
            status=400,
        )
    if prepared_prompt.get("maxOutputTokens") != max_output_tokens:
        return JsonResponse(
            {"error": "prepared_prompt_output_limit_mismatch"},
            status=409,
        )
    try:
        validate_prepared_prompt(authorization.agent_run.modelConfig, body)
    except ModelProviderError as error:
        return JsonResponse({"error": error.reasonType}, status=400)
    return authorization.payload["modelConfigRef"]
