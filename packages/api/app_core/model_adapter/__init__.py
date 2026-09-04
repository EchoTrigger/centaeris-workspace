import asyncio
import json
from copy import copy

from asgiref.sync import sync_to_async

from ..credentials import encrypt_credential_secret
from ..models import ModelConfig, ModelRunLog
from .anthropic_messages import call_anthropic_messages, stream_anthropic_messages
from .common import (
    MODEL_STREAM_SCHEMA,
    ModelProviderError,
    build_messages,
    build_tool_choice,
    build_tools,
    credential_for_model,
    credential_for_provider,
    fake_model_response,
    model_payload,
    record_model_run,
    record_model_run_cancellation_safe,
    resolve_model_route,
    resolve_model_secret,
    safe_model_error_reason,
    validate_prepared_prompt,
    validated_usage,
)
from .openai_completions import (
    async_open_ai_completions_client,
    build_open_ai_completions_request,
    call_open_ai_completions,
    open_ai_completions_client,
    stream_open_ai_completions,
)
from .openai_responses import call_open_ai_responses, stream_open_ai_responses


def encode_model_stream_event(event_type: str, payload: dict) -> bytes:
    event = {"schema": MODEL_STREAM_SCHEMA, "type": event_type} | payload
    body = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event_type}\ndata: {body}\n\n".encode("utf-8")


def call_model(model: ModelConfig, request_body: dict) -> dict:
    if model.provider_id is None:
        return fake_model_response(model, request_body)
    api, _ = resolve_model_route(model)
    if api == "openai-completions":
        return call_open_ai_completions(model, request_body)
    if api == "openai-responses":
        return call_open_ai_responses(model, request_body)
    if api == "anthropic-messages":
        return call_anthropic_messages(model, request_body)
    raise ModelProviderError("provider_api_unsupported")


def run_model(agent_run_id: str, model_config_ref: str, request_body: dict) -> dict:
    model = ModelConfig.objects.get(id=model_config_ref)
    try:
        result = call_model(model, request_body)
        usage = validated_usage(result.get("usage"))
        ModelRunLog.objects.create(
            agentRunId=agent_run_id,
            modelConfig=model,
            status="success",
            promptTokens=usage.get("prompt_tokens"),
            completionTokens=usage.get("completion_tokens"),
            totalTokens=usage.get("total_tokens"),
            promptCacheHitTokens=usage.get("prompt_cache_hit_tokens"),
            promptCacheMissTokens=usage.get("prompt_cache_miss_tokens"),
        )
        return {
            "text": result["text"],
            "reasoningContent": result.get("reasoningContent"),
            "toolCalls": result.get("toolCalls", []),
            "usage": usage,
        }
    except Exception as error:
        ModelRunLog.objects.create(
            agentRunId=agent_run_id,
            modelConfig=model,
            status="error",
            error=safe_model_error_reason(error),
        )
        raise


async def stream_model_async(agent_run_id: str, model_config_ref: str, request_body: dict):
    model = await sync_to_async(ModelConfig.objects.get, thread_sensitive=True)(id=model_config_ref)
    terminal_delivered = False
    provider_stream = None
    try:
        if model.provider_id is None:
            result = await sync_to_async(fake_model_response, thread_sensitive=True)(model, request_body)
            text = result["text"]
            for index in range(0, len(text), 4):
                await asyncio.sleep(0.02)
                yield encode_model_stream_event("delta", {"delta": text[index : index + 4]})
        else:
            api, _ = await sync_to_async(resolve_model_route, thread_sensitive=True)(model)
            result_holder = {}
            if api == "openai-completions":
                provider_stream = stream_open_ai_completions(model, request_body, result_holder, encode_model_stream_event)
            elif api == "openai-responses":
                provider_stream = stream_open_ai_responses(model, request_body, result_holder, encode_model_stream_event)
            elif api == "anthropic-messages":
                provider_stream = stream_anthropic_messages(model, request_body, result_holder, encode_model_stream_event)
            else:
                raise ModelProviderError("provider_api_unsupported")
            async for event in provider_stream:
                yield event
            result = result_holder["result"]
        usage = validated_usage(result.get("usage"))
        yield encode_model_stream_event(
            "result",
            {
                "text": result["text"],
                "reasoningContent": result.get("reasoningContent"),
                "toolCalls": result.get("toolCalls", []),
                "usage": usage,
            },
        )
        terminal_delivered = True
        await record_model_run_cancellation_safe(agent_run_id=agent_run_id, model=model, status="success", usage=usage)
    except (asyncio.CancelledError, GeneratorExit):
        if not terminal_delivered:
            try:
                await record_model_run_cancellation_safe(
                    agent_run_id=agent_run_id,
                    model=model,
                    status="error",
                    error="provider_stream_cancelled",
                )
            except (asyncio.CancelledError, GeneratorExit):
                pass
        raise
    except Exception as error:
        if terminal_delivered:
            raise
        await record_model_run(
            agent_run_id=agent_run_id,
            model=model,
            status="error",
            error=safe_model_error_reason(error),
        )
        raise
    finally:
        if provider_stream is not None:
            await provider_stream.aclose()


def test_model_config(model: ModelConfig) -> dict:
    probe_model = copy(model)
    probe_model.maxOutputTokens = min(model.maxOutputTokens, 32)
    request_body = {
        "preparedPrompt": {
            "schema": "prepared_prompt.v1",
            "messages": [{"messageId": "health", "role": "user", "content": "health check"}],
            "toolDefinitions": [],
            "toolChoice": {"type": "none"},
            "maxOutputTokens": probe_model.maxOutputTokens,
        }
    }
    if model.thinkingMode:
        request_body["thinkingMode"] = model.thinkingMode
    result = call_model(
        probe_model,
        request_body,
    )
    validated_usage(result.get("usage"))
    return result
