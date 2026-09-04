import asyncio
import json

from asgiref.sync import sync_to_async
from django.conf import settings
from openai import AsyncOpenAI, OpenAI

from .common import (
    ModelConfig,
    ModelProviderError,
    build_messages,
    build_tool_choice,
    build_tools,
    model_payload,
    parse_tool_calls,
    provider_error,
    request_thinking_mode,
    resolve_model_route,
    resolve_model_secret,
    validate_prepared_prompt,
    validated_usage,
)


def open_ai_completions_client(model: ModelConfig) -> OpenAI:
    _, api_base = resolve_model_route(model)
    return OpenAI(
        api_key=resolve_model_secret(model),
        base_url=api_base,
        timeout=settings.MODEL_PROVIDER_TIMEOUT_SECONDS,
        max_retries=0,
    )


async def async_open_ai_completions_client(model: ModelConfig) -> AsyncOpenAI:
    _, api_base = await sync_to_async(resolve_model_route, thread_sensitive=True)(model)
    api_key = await sync_to_async(resolve_model_secret, thread_sensitive=True)(model)
    return AsyncOpenAI(
        api_key=api_key,
        base_url=api_base,
        timeout=settings.MODEL_PROVIDER_TIMEOUT_SECONDS,
        max_retries=0,
    )


def build_open_ai_completions_request(model: ModelConfig, request_body: dict) -> dict:
    prepared_prompt = validate_prepared_prompt(model, request_body)
    payload = {
        "model": model.modelName,
        "messages": build_messages(prepared_prompt),
        "max_tokens": prepared_prompt["maxOutputTokens"],
    }
    thinking_mode = request_thinking_mode(model, request_body)
    if thinking_mode is not None:
        payload["reasoning_effort"] = thinking_mode
    tools = build_tools(prepared_prompt.get("toolDefinitions", []))
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = build_tool_choice(prepared_prompt.get("toolChoice"))
    return payload


def call_open_ai_completions(model: ModelConfig, request_body: dict) -> dict:
    client = open_ai_completions_client(model)
    try:
        return parse_open_ai_completions_response(
            model_payload(
                client.chat.completions.create(
                    **build_open_ai_completions_request(model, request_body)
                )
            )
        )
    except Exception as error:
        mapped = provider_error(error)
        if mapped is not None:
            raise mapped from error
        raise
    finally:
        client.close()


async def stream_open_ai_completions(
    model: ModelConfig,
    request_body: dict,
    result_holder: dict,
    encode_event,
):
    text_parts = []
    reasoning_parts = []
    reasoning_field = None
    tool_calls = {}
    usage = {}
    saw_finish = False
    client = await async_open_ai_completions_client(model)
    try:
        request = build_open_ai_completions_request(model, request_body) | {"stream": True}
        request["stream_options"] = {"include_usage": True}
        stream = await client.chat.completions.create(**request)
        async for raw_chunk in stream:
            chunk = model_payload(raw_chunk)
            if isinstance(chunk.get("usage"), dict):
                usage = chunk["usage"]
            choices = chunk.get("choices") or []
            if not choices:
                continue
            choice = choices[0]
            saw_finish |= choice.get("finish_reason") is not None
            delta = choice.get("delta") or {}
            chunk_reasoning_field, chunk_reasoning = _openai_reasoning(delta)
            if chunk_reasoning_field is not None:
                if reasoning_field is not None and reasoning_field != chunk_reasoning_field:
                    raise RuntimeError("provider stream changed reasoning field names")
                reasoning_field = chunk_reasoning_field
                reasoning_parts.append(chunk_reasoning)
            content = delta.get("content")
            if content:
                if not isinstance(content, str):
                    raise RuntimeError("provider delta content must be a string")
                text_parts.append(content)
                yield encode_event("delta", {"delta": content})
            elif content is not None and not isinstance(content, str):
                raise RuntimeError("provider delta content must be a string")
            for call in delta.get("tool_calls") or []:
                index = call.get("index")
                if not isinstance(index, int):
                    raise RuntimeError("provider tool call delta index is required")
                aggregate = tool_calls.setdefault(index, {"id": "", "name": "", "argsJson": ""})
                if call.get("id"):
                    aggregate["id"] = call["id"]
                function = call.get("function") or {}
                if function.get("name"):
                    aggregate["name"] += function["name"]
                if function.get("arguments"):
                    aggregate["argsJson"] += function["arguments"]
    except asyncio.CancelledError:
        raise
    except Exception as error:
        mapped = provider_error(error)
        if mapped is not None:
            raise mapped from error
        raise
    finally:
        await client.close()
    if not saw_finish:
        raise ModelProviderError("provider_stream_interrupted")
    parsed_calls = []
    for index in sorted(tool_calls):
        call = tool_calls[index]
        if not call["id"] or not call["name"]:
            raise RuntimeError("provider tool call stream is incomplete")
        json.loads(call["argsJson"])
        parsed_calls.append(call)
    result_holder["result"] = {
        "text": "".join(text_parts),
        "reasoningContent": "".join(reasoning_parts) if reasoning_field is not None else None,
        "toolCalls": parsed_calls,
        "usage": validated_usage(usage),
    }


def parse_open_ai_completions_response(payload: dict) -> dict:
    choice = (payload.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    text = message.get("content") or ""
    if not isinstance(text, str):
        raise RuntimeError("model provider response message content must be a string")
    _, reasoning_content = _openai_reasoning(message)
    return {
        "text": text,
        "reasoningContent": reasoning_content,
        "toolCalls": parse_tool_calls(message.get("tool_calls")),
        "usage": validated_usage(payload.get("usage")),
    }


def _openai_reasoning(payload: dict) -> tuple[str | None, str | None]:
    values = [
        (field, payload[field])
        for field in ("reasoning", "reasoning_content")
        if field in payload and payload[field] is not None
    ]
    if len(values) > 1:
        raise RuntimeError("provider response contains both reasoning and reasoning_content")
    if not values:
        return None, None
    field, value = values[0]
    if not isinstance(value, str):
        raise RuntimeError(f"provider response field {field} must be a string or null")
    return field, value
