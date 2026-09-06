"""Run the same provider reasoning corpus as the public Core, without services."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from django.test import SimpleTestCase

from .model_adapter import anthropic_messages, openai_completions, openai_responses
from . import model_adapter


CORPUS = Path(__file__).resolve().parents[4] / "centaeris/packages/core/tests/fixtures/model_reasoning.json"


async def events(values):
    for value in values:
        yield value


class ModelReasoningTests(SimpleTestCase):
    def test_live_reasoning_snapshot_and_signal_share_exact_contract(self):
        from types import SimpleNamespace
        from . import agent_run_stream

        reasoning = json.loads(CORPUS.with_name("live_reasoning.json").read_text(encoding="utf-8"))
        meta = {"messageId": "message:turn-1:assistant", "turnId": "turn-1", "afterSequence": "4", "revision": "2", "reasoning": json.dumps(reasoning)}
        state = agent_run_stream._live_state(meta, "answer")
        self.assertEqual(state["reasoning"], reasoning)
        self.assertEqual((state["revision"], state["text"]), (2, "answer"))
        signal = {"schema": "agent_run.transient.signal.v1", "kind": "live", "agentRunId": "run-1", **state}
        self.assertEqual(agent_run_stream._decode_signal(SimpleNamespace(id="run-1"), {"signal": json.dumps(signal)}), signal)
        for invalid in ({**reasoning, "duration": 1}, {**reasoning, "blockId": "wrong"}, {**reasoning, "text": 3}):
            with self.subTest(invalid=invalid), self.assertRaises((ValueError, RuntimeError)):
                agent_run_stream._live_state({**meta, "reasoning": json.dumps(invalid)}, "answer")

    def test_api_result_keeps_display_and_continuation_separate(self):
        with patch.object(model_adapter.ModelConfig.objects, "get", return_value=Mock()), patch.object(model_adapter.ModelRunLog.objects, "create"), patch.object(model_adapter, "call_model", return_value={
            "text": "done", "reasoningContent": "display", "continuationReasoningContent": "continuation",
            "toolCalls": [], "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
        }):
            result = model_adapter.run_model("run", "model", {})
        self.assertEqual(result["reasoningContent"], "display")
        self.assertEqual(result["continuationReasoningContent"], "continuation")

    def test_responses_requests_summary_when_reasoning_is_enabled(self):
        model = Mock(modelName="model")
        prompt = {"messages": [{"messageId": "user", "role": "user", "content": "hello"}], "maxOutputTokens": 128}
        for mode, expected in (("high", {"effort": "high", "summary": "auto"}), ("none", {"effort": "none"}), (None, None)):
            with self.subTest(mode=mode), patch.object(openai_responses, "validate_prepared_prompt", return_value=prompt), patch.object(openai_responses, "request_thinking_mode", return_value=mode):
                self.assertEqual(openai_responses.build_open_ai_responses_request(model, {}).get("reasoning"), expected)

    async def test_provider_reasoning_completion_corpus(self):
        adapters = {
            "anthropic": (anthropic_messages, "anthropic_messages", "parse_anthropic_message", "messages"),
            "responses": (openai_responses, "open_ai_responses", "parse_open_ai_responses_response", "responses"),
            "compatible": (openai_completions, "open_ai_completions", "parse_open_ai_completions_response", "chat.completions"),
        }
        for case in json.loads(CORPUS.read_text(encoding="utf-8")):
            module, name, parser, endpoint = adapters[case["protocol"]]
            for mode in ("json", "stream", "interrupted"):
                streaming = mode != "json"
                interrupted = mode == "interrupted"
                with self.subTest(case=case["id"], mode=mode):
                    async def run():
                        if not streaming:
                            return getattr(module, parser)(case["response"])
                        client = Mock()
                        target = client
                        for part in endpoint.split("."):
                            target = getattr(target, part)
                        frames = case["frames"][:-1] if interrupted else case["frames"]
                        target.create = AsyncMock(return_value=events(frames))
                        client.close = AsyncMock()
                        holder = {}
                        with patch.object(module, "async_" + name + "_client", new=AsyncMock(return_value=client)), patch.object(module, "build_" + name + "_request", return_value={}):
                            visible = [event async for event in getattr(module, "stream_" + name)(None, {}, holder, lambda kind, payload: (kind, payload))]
                        self.assertEqual("".join(payload["delta"] for kind, payload in visible if kind == "delta"), case["expectedText"])
                        thinking = [payload["text"] for kind, payload in visible if kind == "reasoning" and payload["text"]]
                        if "livePrefix" in case:
                            self.assertIn(case["livePrefix"], thinking)
                        self.assertEqual(thinking[-1] if thinking else None, case["expectedReasoning"])
                        client.close.assert_awaited_once()
                        return holder["result"]
                    if case["invalid"] or interrupted:
                        with self.assertRaises(RuntimeError):
                            await run()
                    else:
                        result = await run()
                        self.assertEqual(result.get("reasoningContent"), case["expectedReasoning"])
                        self.assertEqual(result.get("continuationReasoningContent"), case["expectedReasoning"] if case["protocol"] == "compatible" else None)
                        self.assertEqual(result["text"], case["expectedText"])
                        self.assertEqual(len(result["toolCalls"]), case["expectedToolCount"])
