import os
import http.client
import io
import json
import threading
import unittest
import urllib.error
from contextlib import contextmanager
from unittest.mock import Mock, patch

os.environ.update(
    {
        "RUNTIME_INTERNAL_URL": "http://runtime.invalid",
        "API_INTERNAL_URL": "http://api.invalid",
        "INTERNAL_API_TOKEN": "test-internal-token",
    }
)

import worker


def lifecycle_fixture(agentRunId="agent_run_1"):
    digest = f"sha256:{'a' * 64}"
    job = {
        "jobId": f"agent_run.lifecycle:{agentRunId}",
        "jobKind": "agent_run.lifecycle",
        "sessionId": "sess_1",
        "payloadRef": f"record:agent_run:{agentRunId}",
        "idempotencyKey": f"agent_run.lifecycle:{agentRunId}:{digest}",
    }
    agentRunStart = {
        "agentRunId": agentRunId,
        "turnId": "turn_fixture",
        "authorizationDigest": digest,
    }
    return job, agentRunStart


class WorkerContractTests(unittest.TestCase):
    def test_remote_disconnect_is_dependency_unavailable(self):
        with patch("urllib.request.urlopen", side_effect=http.client.RemoteDisconnected()):
            with self.assertRaisesRegex(
                worker.DependencyUnavailable, "agent_run_step_unavailable"
            ):
                worker.agent_run_step_request({"schema": "runtime.agent_run.step.v1"})

    def test_structured_runtime_failure_is_not_dependency_unavailable(self):
        response = {
            "schema": "runtime.agent_run.step.failure.v1",
            "agentRunId": "agent_run_1",
            "failureClass": "runtime_panic",
            "retryable": False,
            "transitionReason": "runtime_failure_terminalization_failed",
            "error": "runtime_step_failed",
        }
        failure = urllib.error.HTTPError(
            "http://runtime.invalid/agent-runs/step",
            500,
            "Internal Server Error",
            None,
            io.BytesIO(json.dumps(response).encode()),
        )
        with patch("urllib.request.urlopen", side_effect=failure):
            with self.assertRaises(worker.RuntimeStepFailed) as raised:
                worker.agent_run_step_request(
                    {
                        "schema": "runtime.agent_run.step.v1",
                        "agentRunStart": {"agentRunId": "agent_run_1"},
                    }
                )

        self.assertFalse(raised.exception.retryable)
        self.assertEqual(str(raised.exception), "runtime_step_failed")

    def test_deterministic_job_failure_is_terminal_without_retry(self):
        job, _agent_run_start = lifecycle_fixture("agent_run_deterministic_failure")
        job.update({"retryCount": 0, "maxRetries": 10})
        with (
            patch.object(worker, "runtime_request", return_value={"disposition": "failed"}) as request,
            patch.object(worker, "transition_agent_run") as transition,
        ):
            self.assertTrue(
                worker.fail_claimed_job(
                    job,
                    "worker:test-owner",
                    "runtime_step_failed",
                    False,
                )
            )

        self.assertFalse(request.call_args.args[1]["retryable"])
        transition.assert_called_once_with(
            "agent_run_deterministic_failure", "failed", "runtime_step_failed"
        )

    def test_transient_job_failure_schedules_retry(self):
        job, _agent_run_start = lifecycle_fixture("agent_run_transient_failure")
        job.update({"retryCount": 0, "maxRetries": 2})
        with patch.object(
            worker,
            "runtime_request",
            return_value={"disposition": "retry_scheduled"},
        ) as request:
            self.assertFalse(
                worker.fail_job(
                    job,
                    "worker:test-owner",
                    "dependency_unavailable",
                    True,
                )
            )

        self.assertTrue(request.call_args.args[1]["retryable"])

    def test_agent_run_step_has_no_worker_socket_deadline(self):
        with patch.object(worker, "json_request", return_value={}) as request:
            worker.agent_run_step_request({"schema": "runtime.agent_run.step.v1"})

        self.assertIsNone(request.call_args.kwargs["timeout"])

    def test_knowledge_processing_has_no_worker_socket_deadline(self):
        with patch.object(worker, "json_request", return_value={}) as request:
            worker.runtime_knowledge_process_request(
                {"schema": "knowledge.process.request.v1"}
            )

        self.assertIsNone(request.call_args.kwargs["timeout"])

    def test_knowledge_process_job_uses_the_existing_runtime_job_worker(self):
        jobId = f"knowledge.process:{'a' * 64}"
        job = {
            "jobId": jobId,
            "jobKind": "knowledge.process",
            "sessionId": "sess_1",
            "payloadRef": "knowledge.process.v1:{}",
            "idempotencyKey": jobId,
        }
        with patch.object(
            worker,
            "runtime_knowledge_process_request",
            return_value={
                "schema": "knowledge.process.result.v1",
                "jobId": jobId,
                "representationId": f"representation:sha256:{'a' * 64}",
            },
        ) as request:
            worker.execute_knowledge_process_job(job, "worker:test-owner")

        self.assertEqual(
            request.call_args.args[0],
            {
                "schema": "knowledge.process.request.v1",
                "jobId": jobId,
                "leaseOwner": "worker:test-owner",
            },
        )

    def test_terminal_dispatcher_wakes_waiter_and_publishes_generation(self):
        calls = []

        def runtime_request(path, body=None):
            calls.append((path, body))
            if path.endswith("/pending"):
                return {
                    "events": [
                        {
                            "jobId": "job_1",
                            "eventType": "runtime_job.terminal",
                            "publishedAtMs": None,
                            "generation": 0,
                        }
                    ]
                }
            if path.endswith("/wake-waiter"):
                return {"disposition": "woken"}
            return {"disposition": "published"}

        with patch.object(worker, "runtime_request", side_effect=runtime_request):
            self.assertEqual(worker.dispatch_terminal_once(), 1)

        self.assertEqual(calls[1][0], "/internal/job-outbox/wake-waiter")
        self.assertEqual(
            set(calls[-1][1]),
            {"schema", "jobId", "eventType", "generation", "publishedAtMs"},
        )

    def test_direct_claim_requires_one_canonical_worker_job_kind(self):
        with patch.object(
            worker,
            "runtime_request",
            return_value={"jobs": []},
        ) as request:
            self.assertIsNone(worker.claim_job("agent_run.lifecycle", "worker:test-owner"))

        self.assertEqual(
            request.call_args.args[1],
            {
                "schema": "runtime.job.claim.v1",
                "workerId": "worker:test-owner",
                "jobId": None,
                "jobKind": "agent_run.lifecycle",
                "nowMs": request.call_args.args[1]["nowMs"],
                "leaseMs": worker.LEASE_MS,
                "limit": 1,
            },
        )
        for forbidden in ("provider.poll", "subagent.run", "banana"):
            with self.assertRaisesRegex(RuntimeError, "worker_job_kind_invalid"):
                worker.claim_job(forbidden, "worker:test-owner")

    def test_job_wait_uses_strict_v1_contract_and_longer_http_timeout(self):
        with patch.object(
            worker,
            "json_request",
            return_value={
                "schema": "runtime.job.wait.result.v1",
                "disposition": "timeout",
                "nextRunAtMs": None,
            },
        ) as request:
            self.assertEqual(worker.wait_for_jobs(), "timeout")

        self.assertEqual(
            request.call_args.args[1],
            {
                "schema": "runtime.job.wait.v1",
                "jobKinds": list(worker.WORKER_JOB_KINDS),
                "waitMs": 20_000,
            },
        )
        self.assertEqual(request.call_args.kwargs["timeout"], 25)
        self.assertGreater(
            worker.JOB_WAIT_HTTP_TIMEOUT_SECONDS,
            worker.JOB_WAIT_MS / 1000,
        )

    def test_job_wait_rejects_noncanonical_response(self):
        with patch.object(
            worker,
            "json_request",
            return_value={
                "schema": "runtime.job.wait.result.v1",
                "disposition": "ready",
                "nextRunAtMs": None,
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "runtime_job_wait_response_invalid"):
                worker.wait_for_jobs()

    def test_notification_path_rescans_without_fixed_sleep_and_is_quantified(self):
        stopped = Mock()
        stopped.is_set.side_effect = [False, False, True]
        fixture_clock_ms = [0]
        events = []

        def execute_next_job(_slot_index):
            events.append(("scan", fixture_clock_ms[0]))
            return len(events) == 3

        def wait_for_jobs():
            fixture_clock_ms[0] += 7
            events.append(("notified", fixture_clock_ms[0]))
            return "ready"

        with (
            patch.object(worker, "execute_next_job", side_effect=execute_next_job),
            patch.object(worker, "wait_for_jobs", side_effect=wait_for_jobs),
        ):
            worker.run_job_loop(0, stopped)

        self.assertEqual(events, [("scan", 0), ("notified", 7), ("scan", 7)])
        stopped.wait.assert_not_called()
        print("worker_notification_pickup_fixture_ms before<=1000 after=7")

    def test_wait_failure_uses_bounded_polling_fallback(self):
        stopped = Mock()
        stopped.is_set.side_effect = [False, True]
        with (
            patch.object(worker, "execute_next_job", return_value=False),
            patch.object(
                worker,
                "wait_for_jobs",
                side_effect=worker.DependencyUnavailable("disconnected"),
            ),
        ):
            worker.run_job_loop(0, stopped)

        stopped.wait.assert_called_once_with(worker.JOB_WAIT_FAILURE_BACKOFF_SECONDS)

    def test_idle_polling_amplification_is_quantified(self):
        old_scan_cycles = worker.WORKER_SLOT_COUNT * 60
        new_wait_requests = worker.WORKER_SLOT_COUNT * (60_000 // worker.JOB_WAIT_MS)
        old_claim_http = old_scan_cycles * len(worker.WORKER_JOB_KINDS)
        new_claim_http = new_wait_requests * len(worker.WORKER_JOB_KINDS)
        new_total_http = new_wait_requests + new_claim_http

        self.assertEqual((old_scan_cycles, new_wait_requests), (120, 6))
        self.assertEqual((old_claim_http, new_claim_http, new_total_http), (360, 18, 24))
        print(
            "worker_idle_per_min "
            f"scan_cycles={old_scan_cycles}->{new_wait_requests} "
            f"claim_http={old_claim_http}->{new_claim_http} "
            f"wait_http=0->{new_wait_requests} total_http={old_claim_http}->{new_total_http}"
        )

    def test_agent_run_lifecycle_wait_yields_without_completing_job(self):
        job, agentRunStart = lifecycle_fixture()
        waiting = {
            "schema": "runtime.agent_run.step.result.v1",
            "agentRunId": agentRunStart["agentRunId"],
            "disposition": "waiting",
            "terminalState": None,
            "transitionReason": "runtime_job_wait",
        }

        def api_request(path, *_args):
            if path.endswith("/resolve"):
                return {
                    "schema": "runtime.agent_run_lifecycle.resolved.v1",
                    "disposition": "ready",
                    "agentRunStart": agentRunStart,
                }
            return {"agentRunId": agentRunStart["agentRunId"], "state": "running"}

        with (
            patch.object(worker, "api_request", side_effect=api_request),
            patch.object(worker, "agent_run_step_request", return_value=waiting) as agentRunStep,
            patch.object(worker, "yield_job") as yield_job,
            patch.object(worker, "complete_job") as complete_job,
            patch.object(worker, "now_ms", return_value=1_000_000),
        ):
            self.assertFalse(
                worker.execute_agent_run_lifecycle_job(job, "worker:test-owner", lambda: None)
            )

        self.assertEqual(
            set(agentRunStep.call_args.args[0]),
            {"schema", "jobId", "leaseOwner", "agentRunStart"},
        )
        self.assertEqual(
            yield_job.call_args.args[2],
            1_000_000 + worker.RUNTIME_JOB_WAIT_RECHECK_MS,
        )
        complete_job.assert_not_called()

    def test_agent_run_lifecycle_accepts_all_canonical_waiting_reasons(self):
        for transition_reason in sorted(worker.AGENT_RUN_WAITING_TRANSITION_REASONS):
            with self.subTest(transition_reason=transition_reason):
                job, agentRunStart = lifecycle_fixture()
                waiting = {
                    "schema": "runtime.agent_run.step.result.v1",
                    "agentRunId": agentRunStart["agentRunId"],
                    "disposition": "waiting",
                    "terminalState": None,
                    "transitionReason": transition_reason,
                }

                def api_request(path, *_args):
                    if path.endswith("/resolve"):
                        return {
                            "schema": "runtime.agent_run_lifecycle.resolved.v1",
                            "disposition": "ready",
                            "agentRunStart": agentRunStart,
                        }
                    return {"agentRunId": agentRunStart["agentRunId"], "state": "running"}

                with (
                    patch.object(worker, "api_request", side_effect=api_request),
                    patch.object(worker, "agent_run_step_request", return_value=waiting),
                    patch.object(worker, "yield_job") as yield_job,
                    patch.object(worker, "complete_job") as complete_job,
                ):
                    self.assertFalse(
                        worker.execute_agent_run_lifecycle_job(
                            job,
                            "worker:test-owner",
                            lambda: None,
                        )
                    )

                yield_job.assert_called_once()
                complete_job.assert_not_called()

    def test_terminal_projects_and_tears_down_before_completing_job(self):
        job, agentRunStart = lifecycle_fixture("agent_run_terminal")
        terminal = {
            "schema": "runtime.agent_run.step.result.v1",
            "agentRunId": agentRunStart["agentRunId"],
            "disposition": "terminal",
            "terminalState": "completed",
            "transitionReason": "runtime_session_terminal_committed",
        }
        calls = []

        def api_request(path, *_args):
            if path.endswith("/resolve"):
                return {
                    "schema": "runtime.agent_run_lifecycle.resolved.v1",
                    "disposition": "ready",
                    "agentRunStart": agentRunStart,
                }
            raise AssertionError(path)

        with (
            patch.object(worker, "api_request", side_effect=api_request),
            patch.object(worker, "agent_run_step_request", return_value=terminal),
            patch.object(
                worker,
                "transition_agent_run",
                side_effect=lambda *_args: calls.append("transition"),
            ),
            patch.object(
                worker,
                "runtime_teardown_request",
                side_effect=lambda *_args: calls.append("teardown")
                or {
                    "schema": "runtime.agent_run.teardown.result.v1",
                    "agentRunId": agentRunStart["agentRunId"],
                    "status": "removed",
                },
            ),
            patch.object(
                worker,
                "complete_job",
                side_effect=lambda *_args: calls.append("complete"),
            ),
        ):
            self.assertFalse(
                worker.execute_agent_run_lifecycle_job(job, "worker:test-owner", lambda: None)
            )

        self.assertEqual(calls, ["transition", "transition", "teardown", "complete"])

    def test_committed_terminal_still_requires_teardown_before_job_completion(self):
        job, agentRunStart = lifecycle_fixture("agent_run_recovered_terminal")
        calls = []

        with (
            patch.object(
                worker,
                "api_request",
                return_value={
                    "schema": "runtime.agent_run_lifecycle.resolved.v1",
                    "disposition": "terminal",
                    "terminalState": "failed",
                    "agentRunStart": agentRunStart,
                },
            ),
            patch.object(
                worker,
                "transition_agent_run",
                side_effect=lambda *_args: calls.append("transition"),
            ),
            patch.object(
                worker,
                "runtime_teardown_request",
                side_effect=lambda *_args: calls.append("teardown")
                or {
                    "schema": "runtime.agent_run.teardown.result.v1",
                    "agentRunId": agentRunStart["agentRunId"],
                    "status": "removed",
                },
            ),
            patch.object(
                worker,
                "complete_job",
                side_effect=lambda *_args: calls.append("complete"),
            ),
        ):
            worker.execute_agent_run_lifecycle_job(job, "worker:test-owner", lambda: None)

        self.assertEqual(calls, ["transition", "teardown", "complete"])

    def test_teardown_failure_leaves_lifecycle_job_retryable(self):
        job, agentRunStart = lifecycle_fixture("agent_run_teardown_retry")
        with (
            patch.object(
                worker,
                "api_request",
                return_value={
                    "schema": "runtime.agent_run_lifecycle.resolved.v1",
                    "disposition": "terminal",
                    "terminalState": "completed",
                    "agentRunStart": agentRunStart,
                },
            ),
            patch.object(worker, "transition_agent_run"),
            patch.object(
                worker,
                "runtime_teardown_request",
                side_effect=worker.DependencyUnavailable("sandbox_teardown_failed"),
            ),
            patch.object(worker, "complete_job") as complete_job,
        ):
            with self.assertRaises(worker.DependencyUnavailable):
                worker.execute_agent_run_lifecycle_job(job, "worker:test-owner", lambda: None)

        complete_job.assert_not_called()

    def test_worker_allows_two_sessions_to_run(self):
        active = 0
        maxActive = 0
        lock = threading.Lock()
        barrier = threading.Barrier(worker.WORKER_SLOT_COUNT)

        @contextmanager
        def lease_heartbeats(_jobId, _leaseOwner):
            nonlocal active, maxActive
            with lock:
                active += 1
                maxActive = max(maxActive, active)
            barrier.wait(timeout=2)
            try:
                yield lambda: None
            finally:
                with lock:
                    active -= 1

        jobs = [
            {
                "jobId": f"worker.noop:{slot}",
                "jobKind": "worker.noop",
            }
            for slot in range(worker.WORKER_SLOT_COUNT)
        ]
        with (
            patch.object(worker, "start_job"),
            patch.object(worker, "complete_job"),
            patch.object(worker, "lease_heartbeats", side_effect=lease_heartbeats),
        ):
            threads = [
                threading.Thread(
                    target=worker.execute_claimed_job,
                    args=(job, f"worker:test-owner-{slot}"),
                )
                for slot, job in enumerate(jobs)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=3)

        self.assertEqual(worker.WORKER_SLOT_COUNT, 2)
        self.assertEqual(maxActive, 2)


if __name__ == "__main__":
    unittest.main()
