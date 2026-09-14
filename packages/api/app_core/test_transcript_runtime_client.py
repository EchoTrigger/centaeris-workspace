import io
import json
import urllib.error
from unittest.mock import patch

from django.test import SimpleTestCase

from app_core.runtime_client import (
    TranscriptRuntimeError,
    request_transcript_page,
    request_transcript_patches,
)


def _http_conflict(payload: dict) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        url="http://runtime/internal/transcript/page",
        code=409,
        msg="Conflict",
        hdrs=None,
        fp=io.BytesIO(json.dumps(payload).encode()),
    )


class TranscriptRuntimeClientTests(SimpleTestCase):
    @patch("app_core.runtime_client.urllib.request.urlopen")
    def test_page_accepts_a_tool_summary_reference(self, urlopen):
        request = {
            "schema": "runtime.transcript.page.read.v1",
            "sessionId": "session-1",
            "projectionVersion": "transcript.projection.v1",
            "projectionGeneration": "generation-1",
            "sourceHighWater": "1",
            "olderCursor": None,
        }
        page = {
            "schema": "transcript.page.v1",
            "sessionId": "session-1",
            "projectionVersion": "transcript.projection.v1",
            "projectionGeneration": "generation-1",
            "sourceHighWater": "1",
            "blocks": [
                {
                    "blockId": "tool:call-1",
                    "blockRevision": "1",
                    "orderKey": {"sourceSequence": "1", "ordinal": 0},
                    "body": {
                        "kind": "tool",
                        "callId": "call-1",
                        "toolName": "read_file",
                        "status": "running",
                        "summary": None,
                        "summaryRef": {
                            "refId": "session-event:event-1:displayTarget",
                            "revision": "1",
                            "byteLength": "70000",
                        },
                        "outputRef": None,
                    },
                }
            ],
            "olderCursor": None,
            "hasOlder": False,
            "resumeCursors": [
                {"streamId": "workspace-transcript.v1", "cursor": "1"}
            ],
        }
        response = urlopen.return_value.__enter__.return_value
        response.read.return_value = json.dumps(page).encode()

        self.assertEqual(request_transcript_page(request), page)

    @patch("app_core.runtime_client.urllib.request.urlopen")
    def test_page_response_rejects_a_malformed_nested_block(self, urlopen):
        request = {
            "schema": "runtime.transcript.page.read.v1",
            "sessionId": "session-1",
            "projectionVersion": "transcript.projection.v1",
            "projectionGeneration": "generation-1",
            "sourceHighWater": "1",
            "olderCursor": None,
        }
        response = urlopen.return_value.__enter__.return_value
        response.read.return_value = json.dumps(
            {
                "schema": "transcript.page.v1",
                "sessionId": "session-1",
                "projectionVersion": "transcript.projection.v1",
                "projectionGeneration": "generation-1",
                "sourceHighWater": "1",
                "blocks": [
                    {
                        "blockId": "message-1",
                        "blockRevision": "1",
                        "orderKey": {"sourceSequence": "1", "ordinal": 0},
                        "body": {
                            "kind": "userText",
                            "content": {"inlineContent": "hello", "sourceRef": None},
                            "unknown": True,
                        },
                    }
                ],
                "olderCursor": None,
                "hasOlder": False,
                "resumeCursors": [
                    {"streamId": "workspace-transcript.v1", "cursor": "1"}
                ],
            }
        ).encode()

        with self.assertRaisesRegex(RuntimeError, "transcript_page_response_invalid"):
            request_transcript_page(request)

    @patch("app_core.runtime_client.urllib.request.urlopen")
    def test_page_not_ready_conflict_is_exact_and_bound_to_the_request(self, urlopen):
        request = {
            "schema": "runtime.transcript.page.read.v1",
            "sessionId": "session-1",
            "projectionVersion": "transcript.projection.v1",
            "projectionGeneration": None,
            "sourceHighWater": "9",
            "olderCursor": None,
        }
        payload = {
            "error": "transcript_projection_not_ready",
            "projectionGeneration": "generation-1",
            "sourceHighWater": "9",
            "projectedHighWater": "4",
        }
        urlopen.side_effect = _http_conflict(payload)

        with self.assertRaises(TranscriptRuntimeError) as raised:
            request_transcript_page(request)
        self.assertEqual(raised.exception.payload, payload)

    @patch("app_core.runtime_client.urllib.request.urlopen")
    def test_malformed_or_unbound_not_ready_conflict_is_not_forwarded(self, urlopen):
        request = {
            "schema": "runtime.transcript.patch.read.v1",
            "sessionId": "session-1",
            "projectionVersion": "transcript.projection.v1",
            "projectionGeneration": "generation-1",
            "afterSourceHighWater": "4",
            "throughSourceHighWater": "9",
        }
        urlopen.side_effect = _http_conflict(
            {
                "error": "transcript_projection_not_ready",
                "projectionGeneration": "other-generation",
                "sourceHighWater": "9",
                "projectedHighWater": "4",
            }
        )

        with self.assertRaisesRegex(RuntimeError, "transcript_runtime_request_failed"):
            request_transcript_patches(request)

    @patch("app_core.runtime_client.urllib.request.urlopen")
    def test_view_invalidation_conflict_rejects_unknown_fields(self, urlopen):
        request = {
            "schema": "runtime.transcript.page.read.v1",
            "sessionId": "session-1",
            "projectionVersion": "transcript.projection.v1",
            "projectionGeneration": "generation-1",
            "sourceHighWater": "9",
            "olderCursor": None,
        }
        urlopen.side_effect = _http_conflict(
            {"error": "transcript_view_invalidated", "retry": True}
        )

        with self.assertRaisesRegex(RuntimeError, "transcript_runtime_request_failed"):
            request_transcript_page(request)
