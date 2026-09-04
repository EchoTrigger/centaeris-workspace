import json
import time
import urllib.error
import urllib.request

from django.conf import settings

from .runtime_contract import (
    AGENT_RUN_START_SCHEMA,
    authorization_digest,
    validate_agent_run_authorization_payload,
)
from .runtime_job_client import schedule_runtime_job
from .workspace_access import agent_run_membership_is_current


AGENT_RUN_LIFECYCLE_JOB_KIND = "agent_run.lifecycle"
AGENT_RUN_LIFECYCLE_SCHEDULE_SCHEMA = "runtime.job.schedule.v1"
WORKSPACE_SKILL_CATALOG_SCHEMA = "workspace.skill.catalog.v1"
WORKSPACE_SKILL_CATALOG_RESULT_SCHEMA = "workspace.skill.catalog.result.v1"
WORKSPACE_SKILL_DETAIL_SCHEMA = "workspace.skill.detail.v1"
WORKSPACE_SKILL_DETAIL_RESULT_SCHEMA = "workspace.skill.detail.result.v1"
WORKSPACE_MCP_CATALOG_SCHEMA = "workspace.mcp.catalog.v1"
WORKSPACE_MCP_CATALOG_RESULT_SCHEMA = "workspace.mcp.catalog.result.v1"
WORKSPACE_HOOK_CATALOG_SCHEMA = "workspace.hook.catalog.v1"
WORKSPACE_HOOK_CATALOG_RESULT_SCHEMA = "workspace.hook.catalog.result.v1"
WORKSPACE_MODEL_CATALOG_RESULT_SCHEMA = "workspace.model_catalog.result.v1"
WORKSPACE_PLUGIN_INSPECT_SCHEMA = "workspace.plugin.inspect.v1"
WORKSPACE_PLUGIN_INSPECT_RESULT_SCHEMA = "workspace.plugin.inspect.result.v1"
RUNTIME_EXECUTION_PROFILE_SCHEMA = "runtime.execution_profile.v1"


def request_execution_profile() -> dict:
    request = urllib.request.Request(
        f"{settings.RUNTIME_URL.rstrip('/')}/internal/execution-profile",
        headers={"X-Internal-Token": settings.INTERNAL_API_TOKEN},
        method="GET",
    )
    try:
        with urllib.request.urlopen(
            request, timeout=settings.RUNTIME_START_TIMEOUT_SECONDS
        ) as response:
            result = json.loads(response.read())
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError) as error:
        if isinstance(error, urllib.error.HTTPError):
            error.close()
        raise RuntimeError("runtime_execution_profile_request_failed") from error
    if (
        not isinstance(result, dict)
        or set(result) != {"schema", "imageCapability", "imageDigest"}
        or result["schema"] != RUNTIME_EXECUTION_PROFILE_SCHEMA
        or result["imageCapability"] != "workspace_general_v1"
        or not isinstance(result["imageDigest"], str)
        or len(result["imageDigest"]) != 71
        or not result["imageDigest"].startswith("sha256:")
        or any(character not in "0123456789abcdef" for character in result["imageDigest"][7:])
    ):
        raise RuntimeError("runtime_execution_profile_response_invalid")
    return result


def request_model_catalog() -> dict:
    request = urllib.request.Request(
        f"{settings.RUNTIME_URL.rstrip('/')}/internal/model-catalog",
        headers={"X-Internal-Token": settings.INTERNAL_API_TOKEN},
        method="GET",
    )
    try:
        with urllib.request.urlopen(
            request, timeout=settings.RUNTIME_START_TIMEOUT_SECONDS
        ) as response:
            result = json.loads(response.read())
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError) as error:
        raise RuntimeError("workspace_model_catalog_request_failed") from error
    if (
        not isinstance(result, dict)
        or set(result) != {"schema", "catalog"}
        or result["schema"] != WORKSPACE_MODEL_CATALOG_RESULT_SCHEMA
    ):
        raise RuntimeError("workspace_model_catalog_response_invalid")
    catalog = result["catalog"]
    if (
        not isinstance(catalog, dict)
        or set(catalog) != {"schema", "providers"}
        or catalog["schema"] != "centaeris.model_catalog.v1"
        or not isinstance(catalog["providers"], list)
    ):
        raise RuntimeError("workspace_model_catalog_response_invalid")
    return catalog


def agent_run_lifecycle_job_id(agent_run_id: str) -> str:
    if (
        not isinstance(agent_run_id, str)
        or not 1 <= len(agent_run_id) <= 128
        or any(
            not (character.isascii() and (character.isalnum() or character in "_-."))
            for character in agent_run_id
        )
    ):
        raise ValueError("agent_run_lifecycle_agent_run_id_invalid")
    return f"agent_run.lifecycle:{agent_run_id}"


def _validate_agent_run_binding(agent_run):
    if not agent_run_membership_is_current(agent_run):
        raise RuntimeError("AgentRun WorkspaceMembership is no longer current")
    authorization = agent_run.authorization
    validate_agent_run_authorization_payload(authorization.payload)
    if authorization_digest(authorization.payload) != authorization.digest:
        raise RuntimeError("AgentRun authorization digest mismatch")
    if (
        authorization.payload["agentRunId"] != agent_run.id
        or authorization.payload["sessionId"] != agent_run.session_id
        or authorization.payload["workspaceId"] != agent_run.workspace_id
        or authorization.payload["userId"] != str(agent_run.user_id)
        or authorization.payload["agentId"] != agent_run.session.agent_id
        or authorization.payload["modelConfigRef"] != agent_run.modelConfig_id
        or authorization.payload["thinkingMode"] != (agent_run.thinkingMode or None)
    ):
        raise RuntimeError("AgentRun authorization binding mismatch")
    return authorization


def build_agent_run_start(agent_run) -> dict:
    authorization = _validate_agent_run_binding(agent_run)
    return {
        "schema": AGENT_RUN_START_SCHEMA,
        "agentRunId": agent_run.id,
        "turnId": agent_run.turn_id,
        "prompt": agent_run.prompt,
        "agentInstructions": agent_run.agent_instructions,
        "modelContextTokens": agent_run.modelConfig.contextTokens,
        "modelMaxOutputTokens": agent_run.modelConfig.maxOutputTokens,
        "authorizationDigest": authorization.digest,
        "authorizationSignature": authorization.signature,
        "authorization": authorization.payload,
        "tailAction": (
            {"type": "append"}
            if agent_run.tailPolicy == "append"
            else {
                "type": "rewriteLastUser",
                "targetMessageId": agent_run.rewriteTargetMessageId,
                "expectedTailMessageId": agent_run.rewriteExpectedTailMessageId,
            }
        ),
    }


def schedule_agent_run_lifecycle(agent_run) -> str:
    authorization = _validate_agent_run_binding(agent_run)
    job_id = agent_run_lifecycle_job_id(agent_run.id)
    body = {
        "schema": AGENT_RUN_LIFECYCLE_SCHEDULE_SCHEMA,
        "jobId": job_id,
        "jobKind": AGENT_RUN_LIFECYCLE_JOB_KIND,
        "runAtMs": time.time_ns() // 1_000_000,
        "maxRetries": 10,
        "idempotencyKey": f"agent_run.lifecycle:{agent_run.id}:{authorization.digest}",
        "sessionId": agent_run.session_id,
        "payloadRef": f"record:agent_run:{agent_run.id}",
    }
    payload = schedule_runtime_job(body)
    job = payload.get("job") if isinstance(payload, dict) else None
    if (
        payload.get("disposition") not in {"inserted", "existing"}
        or not isinstance(job, dict)
        or job.get("jobId") != job_id
        or job.get("jobKind") != AGENT_RUN_LIFECYCLE_JOB_KIND
        or job.get("idempotencyKey") != body["idempotencyKey"]
        or job.get("sessionId") != agent_run.session_id
        or job.get("payloadRef") != body["payloadRef"]
        or job.get("status") not in {"queued", "leased", "running"}
    ):
        raise RuntimeError("agent_run_lifecycle_schedule_response_invalid")
    return payload["disposition"]


def request_agent_run_cancellation(agent_run) -> dict:
    body = {
        "schema": "runtime.agent_run.cancel.v1",
        "agentRunStart": build_agent_run_start(agent_run),
    }
    request = urllib.request.Request(
        f"{settings.RUNTIME_URL.rstrip('/')}/agent-runs/cancel",
        data=json.dumps(body, separators=(",", ":")).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Internal-Token": settings.INTERNAL_API_TOKEN,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request, timeout=settings.RUNTIME_START_TIMEOUT_SECONDS
        ) as response:
            result = json.loads(response.read())
    except (
        urllib.error.HTTPError,
        urllib.error.URLError,
        json.JSONDecodeError,
    ) as error:
        if isinstance(error, urllib.error.HTTPError):
            error.close()
        raise RuntimeError("agent_run_cancel_request_failed") from error
    if (
        not isinstance(result, dict)
        or set(result) != {"schema", "agentRunId", "disposition", "terminalState"}
        or result["schema"] != "runtime.agent_run.cancel.result.v1"
        or result["agentRunId"] != agent_run.id
        or result["disposition"] not in {"requested", "terminal"}
        or (
            result["disposition"] == "requested" and result["terminalState"] is not None
        )
        or (
            result["disposition"] == "terminal"
            and result["terminalState"] not in {"completed", "failed", "cancelled"}
        )
    ):
        raise RuntimeError("agent_run_cancel_response_invalid")
    return result


def request_agent_run_supplement(agent_run, supplement_id: str, message: str) -> dict:
    body = {
        "schema": "runtime.agent_run.supplement.v1",
        "supplementId": supplement_id,
        "jobId": agent_run_lifecycle_job_id(agent_run.id),
        "message": message,
        "agentRunStart": build_agent_run_start(agent_run),
    }
    request = urllib.request.Request(
        f"{settings.RUNTIME_URL.rstrip('/')}/internal/agent-runs/supplement",
        data=json.dumps(body, separators=(",", ":")).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Internal-Token": settings.INTERNAL_API_TOKEN,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request, timeout=settings.RUNTIME_START_TIMEOUT_SECONDS
        ) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read())
        except json.JSONDecodeError:
            payload = None
        finally:
            error.close()
        if (
            error.code == 409
            and isinstance(payload, dict)
            and set(payload) == {"error"}
            and isinstance(payload["error"], str)
            and payload["error"]
        ):
            raise ValueError(payload["error"]) from error
        raise RuntimeError("agent_run_supplement_request_failed") from error
    except (urllib.error.URLError, json.JSONDecodeError) as error:
        raise RuntimeError("agent_run_supplement_request_failed") from error
    if (
        not isinstance(result, dict)
        or set(result)
        != {
            "schema",
            "accepted",
            "disposition",
            "agentRunId",
            "sessionId",
            "supplementId",
            "queuedCount",
            "queueRevision",
        }
        or result["schema"] != "runtime.agent_run.supplement.result.v1"
        or result["accepted"] is not True
        or not isinstance(result["disposition"], str)
        or result["disposition"] not in {"accepted", "duplicate"}
        or result["agentRunId"] != agent_run.id
        or result["sessionId"] != agent_run.session_id
        or result["supplementId"] != supplement_id
        or type(result["queuedCount"]) is not int
        or not 0 <= result["queuedCount"] <= 8
        or type(result["queueRevision"]) is not int
        or result["queueRevision"] < 1
    ):
        raise RuntimeError("agent_run_supplement_response_invalid")
    return result


def request_workspace_skill_catalog(plugin_activation: dict) -> dict:
    return _request_workspace_projection(
        "/skills/catalog",
        {
            "schema": WORKSPACE_SKILL_CATALOG_SCHEMA,
            "pluginActivation": plugin_activation,
        },
        {"schema", "skills"},
        WORKSPACE_SKILL_CATALOG_RESULT_SCHEMA,
    )


def request_workspace_skill_detail(plugin_activation: dict, skill_id: str) -> dict:
    if not isinstance(skill_id, str) or not skill_id.strip():
        raise ValueError("workspace_skill_id_invalid")
    return _request_workspace_projection(
        "/skills/detail",
        {
            "schema": WORKSPACE_SKILL_DETAIL_SCHEMA,
            "pluginActivation": plugin_activation,
            "skillId": skill_id,
        },
        {"schema", "skill", "content"},
        WORKSPACE_SKILL_DETAIL_RESULT_SCHEMA,
        not_found_error="skill_not_found",
    )


def request_workspace_mcp_catalog(plugin_activation: dict) -> dict:
    return _request_workspace_projection(
        "/mcp/catalog",
        {
            "schema": WORKSPACE_MCP_CATALOG_SCHEMA,
            "pluginActivation": plugin_activation,
        },
        {"schema", "plugins"},
        WORKSPACE_MCP_CATALOG_RESULT_SCHEMA,
    )


def request_workspace_hook_catalog(plugin_activation: dict) -> dict:
    return _request_workspace_projection(
        "/hooks/catalog",
        {
            "schema": WORKSPACE_HOOK_CATALOG_SCHEMA,
            "pluginActivation": plugin_activation,
        },
        {"schema", "plugins"},
        WORKSPACE_HOOK_CATALOG_RESULT_SCHEMA,
    )


def request_plugin_inspection(package_path: str) -> dict:
    if (
        not isinstance(package_path, str)
        or not package_path
        or package_path.startswith("/")
        or "\\" in package_path
        or ":" in package_path
        or any(part in {"", ".", ".."} for part in package_path.split("/"))
    ):
        raise ValueError("plugin_inspection_path_invalid")
    body = {
        "schema": WORKSPACE_PLUGIN_INSPECT_SCHEMA,
        "packagePath": package_path,
    }
    request = urllib.request.Request(
        f"{settings.RUNTIME_URL.rstrip('/')}/internal/plugins/inspect",
        data=json.dumps(body, separators=(",", ":")).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Internal-Token": settings.INTERNAL_API_TOKEN,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request, timeout=settings.RUNTIME_START_TIMEOUT_SECONDS
        ) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read())
        except json.JSONDecodeError:
            payload = None
        finally:
            error.close()
        if error.code == 400 and payload == {"error": "plugin_package_invalid"}:
            raise ValueError("plugin_package_invalid") from error
        raise RuntimeError("plugin_inspection_request_failed") from error
    except (urllib.error.URLError, json.JSONDecodeError) as error:
        raise RuntimeError("plugin_inspection_request_failed") from error
    if (
        not isinstance(result, dict)
        or set(result) != {"schema", "package"}
        or result["schema"] != WORKSPACE_PLUGIN_INSPECT_RESULT_SCHEMA
        or not isinstance(result["package"], dict)
    ):
        raise RuntimeError("plugin_inspection_response_invalid")
    return result["package"]


def _request_workspace_projection(
    path: str,
    body: dict,
    expected_fields: set[str],
    expected_schema: str,
    *,
    not_found_error: str | None = None,
) -> dict:
    request = urllib.request.Request(
        f"{settings.RUNTIME_URL.rstrip('/')}{path}",
        data=json.dumps(body, separators=(",", ":")).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Internal-Token": settings.INTERNAL_API_TOKEN,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request, timeout=settings.RUNTIME_START_TIMEOUT_SECONDS
        ) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read())
        except json.JSONDecodeError:
            payload = None
        finally:
            error.close()
        if error.code == 404 and payload == {"error": not_found_error}:
            raise LookupError(not_found_error) from error
        raise RuntimeError("workspace_runtime_projection_request_failed") from error
    except (urllib.error.URLError, json.JSONDecodeError) as error:
        raise RuntimeError("workspace_runtime_projection_request_failed") from error
    if (
        not isinstance(result, dict)
        or set(result) != expected_fields
        or result.get("schema") != expected_schema
    ):
        raise RuntimeError("workspace_runtime_projection_response_invalid")
    return result
