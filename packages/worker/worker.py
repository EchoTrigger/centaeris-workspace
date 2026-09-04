import json
import os
import http.client
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager

RUNTIME_INTERNAL_URL = os.environ["RUNTIME_INTERNAL_URL"].rstrip("/")
API_INTERNAL_URL = os.environ["API_INTERNAL_URL"].rstrip("/")
INTERNAL_API_TOKEN = os.environ["INTERNAL_API_TOKEN"]
LEASE_MS = int(os.environ.get("WORKER_LEASE_MS", "60000"))
AGENT_RUN_LIFECYCLE_RECHECK_MS = int(os.environ.get("AGENT_RUN_LIFECYCLE_RECHECK_MS", "30000"))
RUNTIME_JOB_WAIT_RECHECK_MS = 5 * 60 * 1000
JOB_WAIT_MS = 20_000
JOB_WAIT_HTTP_TIMEOUT_SECONDS = 25
JOB_WAIT_FAILURE_BACKOFF_SECONDS = 1
OUTBOX_POLL_INTERVAL_SECONDS = 1
RECONCILE_INTERVAL_SECONDS = 5
WORKER_JOB_KINDS = ("agent_run.lifecycle", "knowledge.process", "worker.noop")
WORKER_SLOT_COUNT = 2
AGENT_RUN_WAITING_TRANSITION_REASONS = {
    "question_wait",
    "runtime_job_wait",
    "session_workspace_commit_unavailable",
    "session_workspace_resolve_unavailable",
}


class RuntimeJobCancelled(RuntimeError):
    pass


class DependencyUnavailable(RuntimeError):
    pass


class RuntimeStepFailed(RuntimeError):
    def __init__(self, reason, retryable, agent_run_id):
        super().__init__(reason)
        self.retryable = retryable
        self.agent_run_id = agent_run_id


def runtime_request(path, body=None):
    return json_request(
        f"{RUNTIME_INTERNAL_URL}{path}",
        body,
        "X-Internal-Token",
        INTERNAL_API_TOKEN,
        "runtime_job_request_failed",
    )


def agent_run_step_request(body):
    try:
        return json_request(
            f"{RUNTIME_INTERNAL_URL}/agent-runs/step",
            body,
            "X-Internal-Token",
            INTERNAL_API_TOKEN,
            "agent_run_step_unavailable",
            timeout=None,
        )
    except RuntimeStepFailed as error:
        if error.agent_run_id != body.get("agentRunStart", {}).get("agentRunId"):
            raise RuntimeError("runtime_step_failure_response_invalid") from error
        raise


def runtime_teardown_request(body):
    return json_request(
        f"{RUNTIME_INTERNAL_URL}/agent-runs/teardown",
        body,
        "X-Internal-Token",
        INTERNAL_API_TOKEN,
        "sandbox_teardown_failed",
        timeout=30,
    )


def runtime_knowledge_process_request(body):
    return json_request(
        f"{RUNTIME_INTERNAL_URL}/internal/knowledge/process",
        body,
        "X-Internal-Token",
        INTERNAL_API_TOKEN,
        "knowledge_processing_unavailable",
        timeout=None,
    )


def api_request(path, body, default_reason):
    return json_request(
        f"{API_INTERNAL_URL}{path}",
        body,
        "X-Internal-Token",
        INTERNAL_API_TOKEN,
        default_reason,
    )


def json_request(url, body, token_header, token, default_reason, timeout=10):
    method = "GET" if body is None else "POST"
    request = urllib.request.Request(
        url,
        data=None if body is None else json.dumps(body, separators=(",", ":")).encode(),
        headers={"Content-Type": "application/json", token_header: token},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        status = error.code
        try:
            payload = json.loads(error.read())
            reason = payload.get("error", default_reason)
        except (json.JSONDecodeError, AttributeError):
            payload = None
            reason = default_reason
        error.close()
        if isinstance(payload, dict) and payload.get("schema") == "runtime.agent_run.step.failure.v1":
            if set(payload) != {
                "schema",
                "agentRunId",
                "failureClass",
                "retryable",
                "transitionReason",
                "error",
            } or not (
                isinstance(payload.get("agentRunId"), str)
                and payload["agentRunId"]
                and isinstance(payload.get("failureClass"), str)
                and payload["failureClass"]
                and isinstance(payload.get("retryable"), bool)
                and isinstance(payload.get("transitionReason"), str)
                and payload["transitionReason"]
                and payload.get("error") == "runtime_step_failed"
            ):
                raise RuntimeError("runtime_step_failure_response_invalid") from error
            raise RuntimeStepFailed(
                reason, payload["retryable"], payload["agentRunId"]
            ) from error
        if status in {502, 503, 504}:
            raise DependencyUnavailable(reason) from error
        raise RuntimeError(reason) from error
    except (
        urllib.error.URLError,
        http.client.RemoteDisconnected,
        json.JSONDecodeError,
    ) as error:
        raise DependencyUnavailable(default_reason) from error


def now_ms():
    return time.time_ns() // 1_000_000


def heartbeat(job_id, lease_owner):
    try:
        runtime_request(
            "/internal/jobs/heartbeat",
            {
                "schema": "runtime.job.heartbeat.v1",
                "jobId": job_id,
                "leaseOwner": lease_owner,
                "heartbeatAtMs": now_ms(),
                "leaseMs": LEASE_MS,
            },
        )
    except RuntimeError as error:
        raise_if_job_cancelled(job_id, error, "job_heartbeat_rejected")


@contextmanager
def lease_heartbeats(job_id, lease_owner):
    heartbeat(job_id, lease_owner)
    stopped = threading.Event()
    errors = []

    def renew():
        while not stopped.wait(max(1, LEASE_MS // 3000)):
            try:
                heartbeat(job_id, lease_owner)
            except Exception as error:
                errors.append(error)
                return

    thread = threading.Thread(target=renew, daemon=True)
    thread.start()

    def require_healthy_lease():
        if errors:
            raise errors[0]

    try:
        yield require_healthy_lease
    finally:
        stopped.set()
        thread.join()


def complete_job(job_id, lease_owner, output_refs):
    try:
        runtime_request(
            "/internal/jobs/complete",
            {
                "schema": "runtime.job.complete.v1",
                "jobId": job_id,
                "leaseOwner": lease_owner,
                "completedAtMs": now_ms(),
                "outputRefs": output_refs,
            },
        )
    except RuntimeError as error:
        raise_if_job_cancelled(job_id, error, "job_complete_rejected")


def start_job(job_id, lease_owner):
    try:
        runtime_request(
            "/internal/jobs/start",
            {
                "schema": "runtime.job.start.v1",
                "jobId": job_id,
                "leaseOwner": lease_owner,
                "atMs": now_ms(),
            },
        )
    except RuntimeError as error:
        raise_if_job_cancelled(job_id, error, "job_start_rejected")


def yield_job(job_id, lease_owner, run_at_ms, transition_reason):
    try:
        runtime_request(
            "/internal/jobs/yield",
            {
                "schema": "runtime.job.yield.v1",
                "jobId": job_id,
                "leaseOwner": lease_owner,
                "yieldedAtMs": now_ms(),
                "runAtMs": run_at_ms,
                "transitionReason": transition_reason,
            },
        )
    except RuntimeError as error:
        raise_if_job_cancelled(job_id, error, "job_yield_rejected")


def raise_if_job_cancelled(job_id, error, rejected_reason):
    if str(error) != rejected_reason:
        raise error
    response = runtime_request(f"/internal/jobs/{job_id}")
    job = response.get("job") if isinstance(response, dict) else None
    if (
        not isinstance(job, dict)
        or job.get("jobId") != job_id
        or not isinstance(job.get("status"), str)
    ):
        raise RuntimeError("runtime_job_state_invalid") from error
    if job["status"] == "cancelled":
        raise RuntimeJobCancelled("job_cancelled_during_worker_lease") from error
    raise error


def fail_job(job, lease_owner, reason, retryable):
    retry_count = job.get("retryCount")
    max_retries = job.get("maxRetries")
    if (
        not isinstance(retry_count, int)
        or isinstance(retry_count, bool)
        or not isinstance(max_retries, int)
        or isinstance(max_retries, bool)
        or not 0 <= retry_count <= max_retries <= 10
    ):
        raise RuntimeError("runtime_job_retry_state_invalid")
    terminal = not retryable or retry_count + 1 > max_retries
    response = runtime_request(
        "/internal/jobs/fail",
        {
            "schema": "runtime.job.fail.v1",
            "jobId": job["jobId"],
            "leaseOwner": lease_owner,
            "failedAtMs": now_ms(),
            "error": reason,
            "retryable": retryable,
        },
    )
    disposition = response.get("disposition")
    expected_disposition = "failed" if not retryable else "dead_lettered" if terminal else "retry_scheduled"
    if disposition != expected_disposition:
        raise RuntimeError("runtime_job_fail_response_invalid")
    return terminal


def fail_claimed_job(job, lease_owner, reason, retryable):
    terminal = fail_job(job, lease_owner, reason, retryable)
    if terminal and job["jobKind"] == "agent_run.lifecycle":
        agent_run_id, _digest = agent_run_lifecycle_binding(job)
        transition_agent_run(
            agent_run_id,
            "failed",
            "agent_run_lifecycle_dead_lettered" if retryable else "runtime_step_failed",
        )
    return terminal


def transition_agent_run(agent_run_id, state, transition_reason):
    response = api_request(
        "/internal/agent-runs/transition",
        {
            "schema": "runtime.agent_run.transition.v1",
            "agentRunId": agent_run_id,
            "state": state,
            "transitionReason": transition_reason,
        },
        "agent_run_transition_unavailable",
    )
    if response != {"agentRunId": agent_run_id, "state": state} and not (
        state == "failed"
        and transition_reason == "agent_run_lifecycle_dead_lettered"
        and response == {"agentRunId": agent_run_id, "state": "completed"}
    ):
        raise RuntimeError("agent_run_transition_response_invalid")


def agent_run_lifecycle_binding(job):
    job_id = job.get("jobId")
    payload_ref = job.get("payloadRef")
    session_id = job.get("sessionId")
    idempotency_key = job.get("idempotencyKey")
    prefix = "agent_run.lifecycle:"
    if (
        not isinstance(job_id, str)
        or not job_id.startswith(prefix)
        or not isinstance(payload_ref, str)
        or not isinstance(session_id, str)
        or not session_id
        or not isinstance(idempotency_key, str)
    ):
        raise RuntimeError("agent_run_lifecycle_binding_invalid")
    agent_run_id = job_id[len(prefix) :]
    digest_prefix = f"agent_run.lifecycle:{agent_run_id}:"
    digest = (
        idempotency_key[len(digest_prefix) :]
        if idempotency_key.startswith(digest_prefix)
        else ""
    )
    if (
        not agent_run_id
        or payload_ref != f"record:agent_run:{agent_run_id}"
        or len(digest) != 71
        or not digest.startswith("sha256:")
        or any(character not in "0123456789abcdef" for character in digest[7:])
    ):
        raise RuntimeError("agent_run_lifecycle_binding_invalid")
    return agent_run_id, digest


def execute_agent_run_lifecycle_job(job, lease_owner, require_healthy_lease):
    agent_run_id, digest = agent_run_lifecycle_binding(job)
    resolved = api_request(
        "/internal/agent-run-lifecycle/resolve",
        {
            "schema": "runtime.agent_run_lifecycle.resolve.v1",
            "jobId": job["jobId"],
            "agentRunId": agent_run_id,
            "authorizationDigest": digest,
        },
        "agent_run_start_unavailable",
    )
    if (
        not isinstance(resolved, dict)
        or resolved.get("schema") != "runtime.agent_run_lifecycle.resolved.v1"
        or resolved.get("disposition") not in {"ready", "terminal"}
    ):
        raise RuntimeError("agent_run_lifecycle_resolve_response_invalid")
    agent_run_start = resolved.get("agentRunStart")
    if (
        not isinstance(agent_run_start, dict)
        or agent_run_start.get("agentRunId") != agent_run_id
        or agent_run_start.get("authorizationDigest") != digest
    ):
        raise RuntimeError("agent_run_lifecycle_resolve_response_invalid")
    if resolved["disposition"] == "terminal":
        if set(resolved) != {
            "schema",
            "disposition",
            "terminalState",
            "agentRunStart",
        } or resolved["terminalState"] not in {"completed", "failed", "cancelled"}:
            raise RuntimeError("agent_run_lifecycle_resolve_response_invalid")
        require_healthy_lease()
        finish_agent_run_lifecycle(job, lease_owner, agent_run_start, resolved["terminalState"])
        return False
    if set(resolved) != {"schema", "disposition", "agentRunStart"}:
        raise RuntimeError("agent_run_lifecycle_resolve_response_invalid")
    transition_agent_run(agent_run_id, "running", "agent_run_lifecycle_step_started")
    require_healthy_lease()
    result = agent_run_step_request(
        {
            "schema": "runtime.agent_run.step.v1",
            "jobId": job["jobId"],
            "leaseOwner": lease_owner,
            "agentRunStart": agent_run_start,
        }
    )
    require_healthy_lease()
    if (
        not isinstance(result, dict)
        or set(result)
        != {"schema", "agentRunId", "disposition", "terminalState", "transitionReason"}
        or result.get("schema") != "runtime.agent_run.step.result.v1"
        or result.get("agentRunId") != agent_run_id
        or result.get("disposition") not in {"waiting", "terminal"}
        or not isinstance(result.get("transitionReason"), str)
        or not result["transitionReason"]
    ):
        raise RuntimeError("agent_run_step_response_invalid")
    if result["disposition"] == "waiting":
        if (
            result["terminalState"] is not None
            or result["transitionReason"] not in AGENT_RUN_WAITING_TRANSITION_REASONS
        ):
            raise RuntimeError("agent_run_step_response_invalid")
        transition_agent_run(agent_run_id, "running", result["transitionReason"])
        require_healthy_lease()
        yielded_at_ms = now_ms()
        yield_job(
            job["jobId"],
            lease_owner,
            yielded_at_ms + RUNTIME_JOB_WAIT_RECHECK_MS
            if result["transitionReason"] == "runtime_job_wait"
            else yielded_at_ms + AGENT_RUN_LIFECYCLE_RECHECK_MS,
            result["transitionReason"],
        )
        return False
    if result["terminalState"] not in {"completed", "failed", "cancelled"}:
        raise RuntimeError("agent_run_step_response_invalid")
    require_healthy_lease()
    finish_agent_run_lifecycle(job, lease_owner, agent_run_start, result["terminalState"])
    return False


def finish_agent_run_lifecycle(job, lease_owner, agent_run_start, terminal_state):
    agent_run_id = agent_run_start["agentRunId"]
    transition_agent_run(
        agent_run_id,
        terminal_state,
        "agent_run_cancelled"
        if terminal_state == "cancelled"
        else "runtime_session_terminal_committed",
    )
    result = runtime_teardown_request(
        {
            "schema": "runtime.agent_run.teardown.v1",
            "jobId": job["jobId"],
            "leaseOwner": lease_owner,
            "agentRunStart": agent_run_start,
        }
    )
    if result != {
        "schema": "runtime.agent_run.teardown.result.v1",
        "agentRunId": agent_run_id,
        "status": "removed",
    }:
        raise RuntimeError("runtime_teardown_response_invalid")
    complete_job(job["jobId"], lease_owner, [])


def valid_runtime_job_id(value):
    return (
        isinstance(value, str)
        and 1 <= len(value) <= 160
        and all(
            character.isascii() and (character.isalnum() or character in "_-:.")
            for character in value
        )
    )


def execute_knowledge_process_job(job, lease_owner):
    job_id = job.get("jobId")
    if (
        not isinstance(job_id, str)
        or not job_id.startswith("knowledge.process:")
        or not isinstance(job.get("payloadRef"), str)
        or not job["payloadRef"].startswith("knowledge.process.v1:")
        or not isinstance(job.get("sessionId"), str)
        or not job["sessionId"]
        or job.get("idempotencyKey") != job_id
    ):
        raise RuntimeError("knowledge_process_binding_invalid")
    result = runtime_knowledge_process_request(
        {
            "schema": "knowledge.process.request.v1",
            "jobId": job_id,
            "leaseOwner": lease_owner,
        }
    )
    if (
        not isinstance(result, dict)
        or set(result) != {"schema", "jobId", "representationId"}
        or result.get("schema") != "knowledge.process.result.v1"
        or result.get("jobId") != job_id
        or not isinstance(result.get("representationId"), str)
    ):
        raise RuntimeError("knowledge_process_response_invalid")


def claim_job(job_kind, lease_owner):
    if job_kind not in WORKER_JOB_KINDS:
        raise RuntimeError("worker_job_kind_invalid")
    response = runtime_request(
        "/internal/jobs/claim",
        {
            "schema": "runtime.job.claim.v1",
            "workerId": lease_owner,
            "jobId": None,
            "jobKind": job_kind,
            "nowMs": now_ms(),
            "leaseMs": LEASE_MS,
            "limit": 1,
        },
    )
    if not isinstance(response, dict) or set(response) != {"jobs"}:
        raise RuntimeError("runtime_job_claim_response_invalid")
    jobs = response["jobs"]
    if not isinstance(jobs, list) or len(jobs) > 1:
        raise RuntimeError("runtime_job_claim_response_invalid")
    if not jobs:
        return None
    job = jobs[0]
    if (
        not isinstance(job, dict)
        or not valid_runtime_job_id(job.get("jobId"))
        or job.get("jobKind") != job_kind
        or job.get("leaseOwner") != lease_owner
        or job.get("status") != "leased"
    ):
        raise RuntimeError("runtime_job_claim_response_invalid")
    return job


def wait_for_jobs():
    response = json_request(
        f"{RUNTIME_INTERNAL_URL}/internal/jobs/wait",
        {
            "schema": "runtime.job.wait.v1",
            "jobKinds": list(WORKER_JOB_KINDS),
            "waitMs": JOB_WAIT_MS,
        },
        "X-Internal-Token",
        INTERNAL_API_TOKEN,
        "runtime_job_wait_unavailable",
        timeout=JOB_WAIT_HTTP_TIMEOUT_SECONDS,
    )
    if (
        not isinstance(response, dict)
        or set(response) != {"schema", "disposition", "nextRunAtMs"}
        or response.get("schema") != "runtime.job.wait.result.v1"
        or response.get("disposition") not in {"ready", "timeout"}
        or (
            response.get("disposition") == "ready"
            and response.get("nextRunAtMs") is None
        )
        or not (
            response.get("nextRunAtMs") is None
            or (
                isinstance(response.get("nextRunAtMs"), int)
                and not isinstance(response.get("nextRunAtMs"), bool)
            )
        )
    ):
        raise RuntimeError("runtime_job_wait_response_invalid")
    return response["disposition"]


def execute_claimed_job(job, lease_owner):
    try:
        start_job(job["jobId"], lease_owner)
        if job["jobKind"] not in WORKER_JOB_KINDS:
            raise RuntimeError("unknown_job_kind")
        with lease_heartbeats(job["jobId"], lease_owner) as require_healthy_lease:
            if job["jobKind"] == "worker.noop":
                output_refs = []
                completed = True
            elif job["jobKind"] == "knowledge.process":
                execute_knowledge_process_job(job, lease_owner)
                output_refs = []
                completed = True
            else:
                output_refs = []
                completed = execute_agent_run_lifecycle_job(job, lease_owner, require_healthy_lease)
            if completed:
                require_healthy_lease()
                complete_job(job["jobId"], lease_owner, output_refs)
    except RuntimeJobCancelled as error:
        print(
            f"worker job stopped: jobId={job['jobId']}; transitionReason={error}",
            flush=True,
        )
    except DependencyUnavailable:
        fail_claimed_job(job, lease_owner, "dependency_unavailable", True)
    except RuntimeStepFailed as error:
        fail_claimed_job(job, lease_owner, str(error), error.retryable)
    except RuntimeError as error:
        reason = str(error)
        if job["jobKind"] == "agent_run.lifecycle":
            if reason == "agent_run_lifecycle_lease_lost":
                print(
                    f"run lifecycle stopped after lease loss: jobId={job['jobId']}",
                    flush=True,
                )
                return
            print(
                f"run lifecycle attempt failed: jobId={job['jobId']}; reason={reason}",
                file=sys.stderr,
                flush=True,
            )
            fail_claimed_job(job, lease_owner, "agent_run_lifecycle_failed", False)
            return
        if job["jobKind"] == "knowledge.process":
            fail_claimed_job(job, lease_owner, "knowledge_processing_failed", False)
            return
        raise


def execute_next_job(slot_index):
    lease_owner = f"worker:{socket.gethostname()}:{uuid.uuid4().hex}"
    for offset in range(len(WORKER_JOB_KINDS)):
        job_kind = WORKER_JOB_KINDS[(slot_index + offset) % len(WORKER_JOB_KINDS)]
        job = claim_job(job_kind, lease_owner)
        if job is not None:
            execute_claimed_job(job, lease_owner)
            return True
    return False


def dispatch_terminal_once():
    events = runtime_request(
        "/internal/job-outbox/pending",
        {"schema": "runtime.job.outbox.pending.v1", "limit": 100},
    )["events"]
    for event in events:
        if (
            not isinstance(event, dict)
            or set(event) != {"jobId", "eventType", "publishedAtMs", "generation"}
            or not valid_runtime_job_id(event.get("jobId"))
            or event.get("eventType") != "runtime_job.terminal"
            or event.get("publishedAtMs") is not None
            or not isinstance(event.get("generation"), int)
            or isinstance(event.get("generation"), bool)
            or not 0 <= event["generation"] <= 4_294_967_295
        ):
            raise RuntimeError("runtime_job_outbox_event_invalid")
        wake = runtime_request(
            "/internal/job-outbox/wake-waiter",
            {
                "schema": "runtime.job.waiter_wake.v1",
                "jobId": event["jobId"],
                "generation": event["generation"],
            },
        )
        if wake.get("disposition") not in {
            "woken",
            "already_runnable",
            "active",
            "terminal",
            "no_waiter",
        }:
            raise RuntimeError("runtime_job_waiter_wake_response_invalid")
        published = runtime_request(
            "/internal/job-outbox/published",
            {
                "schema": "runtime.job.outbox.published.v1",
                "jobId": event["jobId"],
                "eventType": event["eventType"],
                "generation": event["generation"],
                "publishedAtMs": now_ms(),
            },
        )
        if published.get("disposition") not in {
            "published",
            "already_published",
            "stale",
        }:
            raise RuntimeError("runtime_job_outbox_publish_response_invalid")
    return len(events)


def reconcile_once():
    runtime = runtime_request(
        "/internal/jobs/reconcile",
        {"schema": "runtime.job.reconcile.v1", "nowMs": now_ms()},
    )
    lifecycle = api_request(
        "/internal/agent-run-lifecycle/reconcile",
        {"schema": "runtime.agent_run_lifecycle.reconcile.v1", "limit": 100},
        "agent_run_lifecycle_reconcile_unavailable",
    )
    waiters = runtime_request(
        "/internal/job-outbox/reconcile-waiters",
        {"schema": "runtime.job.waiters.reconcile.v1"},
    )
    if waiters.get("disposition") != "reconciled":
        raise RuntimeError("runtime_job_waiter_reconcile_response_invalid")
    return {"runtimeJobs": runtime, "runLifecycle": lifecycle, "waiters": waiters}


def run_loop(operation, interval_seconds, stopped=None):
    while stopped is None or not stopped.is_set():
        try:
            operation()
        except Exception as error:
            print(
                f"worker control loop failed: {type(error).__name__}",
                file=sys.stderr,
                flush=True,
            )
        if stopped is None:
            time.sleep(interval_seconds)
        else:
            stopped.wait(interval_seconds)


def run_job_loop(slot_index, stopped):
    while not stopped.is_set():
        try:
            worked = execute_next_job(slot_index)
            if not worked:
                wait_for_jobs()
        except Exception as error:
            print(
                f"worker job slot failed: slot={slot_index}; error={type(error).__name__}",
                file=sys.stderr,
                flush=True,
            )
            stopped.wait(JOB_WAIT_FAILURE_BACKOFF_SECONDS)


def run_worker_service():
    stopped = threading.Event()

    def stop_service(_signal_number, _frame):
        stopped.set()

    previous_handlers = {
        signal_number: signal.signal(signal_number, stop_service)
        for signal_number in (signal.SIGTERM, signal.SIGINT)
    }
    control_threads = [
        threading.Thread(
            target=run_loop,
            args=(dispatch_terminal_once, OUTBOX_POLL_INTERVAL_SECONDS, stopped),
            name="workspace-terminal-dispatcher",
        ),
        threading.Thread(
            target=run_loop,
            args=(reconcile_once, RECONCILE_INTERVAL_SECONDS, stopped),
            name="workspace-reconciler",
        ),
    ]
    job_threads = [
        threading.Thread(
            target=run_job_loop,
            args=(slot_index, stopped),
            name=f"workspace-job-slot-{slot_index}",
            daemon=True,
        )
        for slot_index in range(WORKER_SLOT_COUNT)
    ]
    for thread in control_threads + job_threads:
        thread.start()
    try:
        stopped.wait()
    finally:
        stopped.set()
        for thread in control_threads:
            thread.join()
        for signal_number, handler in previous_handlers.items():
            signal.signal(signal_number, handler)


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) == 2 else ""
    if command == "serve":
        run_worker_service()
    else:
        raise SystemExit("usage: worker.py serve")
