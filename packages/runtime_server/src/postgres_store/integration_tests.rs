use centaeris_core::runtime::contracts::{CheckpointRecord, EventVisibility, RuntimeEvent};
use centaeris_core::session::reliability::{
    ClaimDueRuntimeJobsRequest, CompleteRuntimeJobRequest, RenewRuntimeJobLeaseRequest,
    RuntimeBackoffPolicy, RuntimeJobOutboxPort, RuntimeJobRecord, RuntimeJobStatus,
    RuntimeJobStorePort, ScheduleRuntimeJobRequest, StartRuntimeJobRequest, YieldRuntimeJobRequest,
};
use centaeris_core::session::store::{
    AgentRuntimeSnapshotStorePort, ConsumeWaitCheckpointRequest, RuntimeStore,
    RuntimeStoreTransactionPort, SaveWaitCheckpointRequest, SessionDataStorePort,
};
use centaeris_core::session::supplement::{
    AcknowledgeTurnSupplementsRequest, ClaimTurnSupplementsRequest,
    CloseTurnSupplementQueueRequest, EnqueueTurnSupplementDisposition,
    EnqueueTurnSupplementRequest, TurnSupplementStoreError, TurnSupplementStorePort,
};
use centaeris_core::session::{
    RuntimeJobLeaseFence, SequencedSessionRecord, SessionLogPort, SessionLogRecord,
    SessionRecordType, RUNTIME_JOB_LEASE_FENCE_REJECTED, SESSION_EVENT_SCHEMA_VERSION,
};
use postgres::fallible_iterator::FallibleIterator;
use postgres::{Client, NoTls};
use std::time::Duration;

use super::{PostgresRuntimeStore, PostgresSessionLog};
use centaeris_runtime_sqlite::SqliteRuntimeStore;

static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn test_url() -> String {
    assert_eq!(
        std::env::var("CENTAERIS_ALLOW_POSTGRES_TEST_RESET").as_deref(),
        Ok("1")
    );
    std::env::var("CENTAERIS_TEST_POSTGRES_URL").expect("CENTAERIS_TEST_POSTGRES_URL is required")
}

fn reset_store(url: &str) {
    let mut client = Client::connect(url, NoTls).expect("connect test Postgres");
    client
        .batch_execute("DROP SCHEMA IF EXISTS runtime CASCADE")
        .expect("reset runtime schema");
}

fn job(id: &str, key: &str) -> RuntimeJobRecord {
    RuntimeJobRecord {
        job_id: id.to_string(),
        job_kind: "contract.test".to_string(),
        status: RuntimeJobStatus::Queued,
        run_at_ms: 1,
        lease_owner: None,
        lease_expires_at_ms: None,
        heartbeat_at_ms: None,
        retry_count: 0,
        max_retries: 2,
        backoff_policy: RuntimeBackoffPolicy::default(),
        idempotency_key: key.to_string(),
        session_id: Some("session_pg".to_string()),
        branch_id: None,
        checkpoint_id: None,
        payload_ref: None,
        output_refs: vec![],
        last_error: None,
        created_at_ms: 1,
        updated_at_ms: 1,
    }
}

fn session_record(
    agent_run_id: &str,
    session_id: &str,
    sequence: u64,
    event_type: SessionRecordType,
    payload: serde_json::Value,
    at_ms: i64,
) -> SequencedSessionRecord {
    SequencedSessionRecord {
        sequence,
        event: SessionLogRecord {
            schema_version: SESSION_EVENT_SCHEMA_VERSION.to_string(),
            event_version: centaeris_core::session::SESSION_EVENT_VERSION,
            event_type,
            event_id: format!("event:{agent_run_id}:{sequence}"),
            session_id: session_id.to_string(),
            turn_id: Some("turn_pg_fenced_terminal".to_string()),
            agent_run_id: Some(agent_run_id.to_string()),
            created_at_ms: at_ms,
            payload,
        },
    }
}

fn shared_runtime_store_contract<S: RuntimeStore + AgentRuntimeSnapshotStorePort>(store: &S) {
    store
        .save_checkpoint(CheckpointRecord {
            checkpoint_id: "checkpoint:shared".to_string(),
            kind: centaeris_core::runtime::contracts::CheckpointKindV1::Wait,
            session_id: "shared_session".to_string(),
            turn_id: "shared_turn".to_string(),
            status: "running".to_string(),
            done_reason: None,
            updated_at_ms: 3,
            payload_json: "{\"shared\":true}".to_string(),
        })
        .expect("shared checkpoint");
    assert_eq!(
        store
            .load_latest_checkpoint("shared_session")
            .expect("shared load checkpoint")
            .expect("shared row")
            .turn_id,
        "shared_turn"
    );
    store
        .save_agent_runtime_snapshot("shared_session", "{\"sharedSnapshot\":true}", 4)
        .expect("shared snapshot");
    assert_eq!(
        store
            .load_agent_runtime_snapshot("shared_session")
            .expect("shared load snapshot")
            .as_deref(),
        Some("{\"sharedSnapshot\":true}")
    );
}

#[test]
fn sqlite_runtime_store_passes_shared_contract() {
    let path = std::env::temp_dir().join(format!(
        "centaeris-shared-store-contract-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let store = SqliteRuntimeStore::new(&path).expect("open SQLite contract store");
    shared_runtime_store_contract(&store);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
#[ignore = "requires destructive dedicated Postgres test database"]
fn postgres_runtime_job_wait_is_notified_and_closes_lost_wakeups() {
    let _guard = TEST_LOCK.lock().expect("Postgres test lock");
    let url = test_url();
    reset_store(&url);
    let store = PostgresRuntimeStore::new(&url).expect("open Postgres store");
    let mut listener = Client::connect(&url, NoTls).expect("connect notification listener");
    listener
        .batch_execute("SET search_path TO runtime,public; LISTEN runtime_job_ready_v1")
        .expect("listen for runtime jobs");
    let now_ms = listener
        .query_one(
            "SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint",
            &[],
        )
        .expect("query database clock")
        .get::<_, i64>(0);

    let mut queued = job("worker.noop:wait", "worker.noop:wait");
    queued.job_kind = "worker.noop".to_string();
    queued.run_at_ms = now_ms;
    queued.created_at_ms = now_ms;
    queued.updated_at_ms = now_ms;
    store
        .schedule_runtime_job(ScheduleRuntimeJobRequest { job: queued })
        .expect("schedule queued worker job");
    let inserted = listener
        .notifications()
        .timeout_iter(Duration::from_secs(1))
        .next()
        .expect("read insert notification")
        .expect("insert must notify");
    assert_eq!(inserted.payload(), "");

    let kinds = vec!["worker.noop".to_string()];
    let after_consumed_notification = store
        .wait_for_runtime_jobs(kinds.as_slice(), Duration::from_millis(50))
        .expect("wait finds already-due job after notification was consumed");
    assert!(after_consumed_notification.ready);
    let claimed = store
        .claim_due_runtime_jobs(ClaimDueRuntimeJobsRequest {
            now_ms: now_ms + 1_000,
            worker_id: "worker:postgres-wait-test".to_string(),
            job_id: Some("worker.noop:wait".to_string()),
            job_kind: Some("worker.noop".to_string()),
            session_id: None,
            limit: 1,
            lease_ms: 60_000,
        })
        .expect("claim due job before transition test");
    assert_eq!(claimed.len(), 1);
    listener
        .execute(
            "UPDATE runtime_jobs SET status='queued',run_at_ms=$1,lease_owner=NULL,lease_expires_at_ms=NULL WHERE job_id=$2",
            &[&(now_ms + 60_000), &"worker.noop:wait"],
        )
        .expect("transition job back to queued");
    let transitioned = listener
        .notifications()
        .timeout_iter(Duration::from_secs(1))
        .next()
        .expect("read transition notification")
        .expect("transition to queued must notify");
    assert_eq!(transitioned.payload(), "");

    let future_now_ms = listener
        .query_one(
            "SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint",
            &[],
        )
        .expect("query future-job clock")
        .get::<_, i64>(0);
    let mut future = job("knowledge.process:wait", "knowledge.process:wait");
    future.job_kind = "knowledge.process".to_string();
    future.run_at_ms = future_now_ms + 100;
    future.created_at_ms = future_now_ms;
    future.updated_at_ms = future_now_ms;
    store
        .schedule_runtime_job(ScheduleRuntimeJobRequest { job: future })
        .expect("schedule future worker job");
    let future_kinds = vec!["knowledge.process".to_string()];
    assert!(
        store
            .wait_for_runtime_jobs(future_kinds.as_slice(), Duration::from_secs(1))
            .expect("future job timer")
            .ready
    );

    let sender_url = url.clone();
    let sender = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(10));
        Client::connect(&sender_url, NoTls)
            .expect("connect irrelevant notifier")
            .batch_execute("NOTIFY runtime_job_ready_v1, 'provider.poll'")
            .expect("send irrelevant notification");
    });
    let idle_kinds = vec!["agent_run.lifecycle".to_string()];
    let idle = store
        .wait_for_runtime_jobs(idle_kinds.as_slice(), Duration::from_millis(50))
        .expect("irrelevant notification remains a hint");
    sender.join().expect("join irrelevant notifier");
    assert!(!idle.ready);
    assert_eq!(idle.next_run_at_ms, None);
}

#[test]
#[ignore = "requires destructive dedicated Postgres test database"]
fn postgres_runtime_store_persists_core_state_and_claims_jobs_once() {
    let _guard = TEST_LOCK.lock().expect("Postgres test lock");
    let url = test_url();
    reset_store(&url);
    let store = PostgresRuntimeStore::new(&url).expect("open Postgres store");
    shared_runtime_store_contract(&store);
    store
        .save_checkpoint(CheckpointRecord {
            checkpoint_id: "checkpoint:pg".to_string(),
            kind: centaeris_core::runtime::contracts::CheckpointKindV1::Wait,
            session_id: "session_pg".to_string(),
            turn_id: "turn_pg".to_string(),
            status: "running".to_string(),
            done_reason: None,
            updated_at_ms: 3,
            payload_json: "{\"ok\":true}".to_string(),
        })
        .expect("save checkpoint");
    assert_eq!(
        store
            .load_latest_checkpoint("session_pg")
            .expect("checkpoint")
            .expect("row")
            .turn_id,
        "turn_pg"
    );
    store
        .save_agent_runtime_snapshot("session_pg", "{\"snapshot\":true}", 4)
        .expect("snapshot");
    assert_eq!(
        store
            .load_agent_runtime_snapshot("session_pg")
            .expect("load snapshot")
            .as_deref(),
        Some("{\"snapshot\":true}")
    );
    let wait_checkpoint = CheckpointRecord {
        checkpoint_id: "checkpoint:wait-pg".to_string(),
        kind: centaeris_core::runtime::contracts::CheckpointKindV1::Wait,
        session_id: "session_pg".to_string(),
        turn_id: "turn_wait_pg".to_string(),
        status: "waiting".to_string(),
        done_reason: Some("question".to_string()),
        updated_at_ms: 5,
        payload_json: "{\"schema\":\"runtime.await_question.v1\"}".to_string(),
    };
    store
        .save_wait_checkpoint(SaveWaitCheckpointRequest {
            checkpoint: wait_checkpoint.clone(),
            event: RuntimeEvent {
                event_id: "runtime_wait_pg_waiting".to_string(),
                session_id: "session_pg".to_string(),
                task_id: Some("turn_wait_pg".to_string()),
                event_type: "runtime_wait_changed.v1".to_string(),
                at_ms: 5,
                visibility: EventVisibility::Internal,
                payload_json: "{\"status\":\"waiting\"}".to_string(),
            },
        })
        .expect("atomic wait transition");
    store
        .consume_wait_checkpoint(ConsumeWaitCheckpointRequest {
            checkpoint: wait_checkpoint,
            events: vec![RuntimeEvent {
                event_id: "runtime_wait_pg_resumed".to_string(),
                session_id: "session_pg".to_string(),
                task_id: Some("turn_wait_pg".to_string()),
                event_type: "runtime_wait_changed.v1".to_string(),
                at_ms: 6,
                visibility: EventVisibility::Internal,
                payload_json: "{\"status\":\"resumed\"}".to_string(),
            }],
        })
        .expect("atomic wait consumption");
    assert!(store
        .load_checkpoint_by_turn("session_pg", "turn_wait_pg")
        .expect("wait checkpoint removed")
        .is_none());
    assert_eq!(
        store
            .list_events("session_pg", 10, 0)
            .expect("runtime events")
            .len(),
        2
    );
    store
        .schedule_runtime_job(ScheduleRuntimeJobRequest {
            job: job("job_pg", "key_pg"),
        })
        .expect("schedule");
    store
        .schedule_runtime_job(ScheduleRuntimeJobRequest {
            job: job("job_pg_duplicate", "key_pg"),
        })
        .expect("idempotent schedule");
    let pending = store
        .list_pending_runtime_job_outbox(10)
        .expect("pending outbox");
    assert!(pending.is_empty());
    let request = ClaimDueRuntimeJobsRequest {
        now_ms: 10,
        worker_id: "worker_a".to_string(),
        job_id: Some("job_pg".to_string()),
        job_kind: None,
        session_id: None,
        limit: 1,
        lease_ms: 1000,
    };
    assert_eq!(
        store
            .claim_due_runtime_jobs(request.clone())
            .expect("first claim")
            .len(),
        1
    );
    assert!(store
        .claim_due_runtime_jobs(ClaimDueRuntimeJobsRequest {
            worker_id: "worker_b".to_string(),
            ..request
        })
        .expect("second claim")
        .is_empty());
    store
        .start_runtime_job(StartRuntimeJobRequest {
            job_id: "job_pg".to_string(),
            lease_owner: "worker_a".to_string(),
            started_at_ms: 11,
        })
        .expect("start job");
    store
        .renew_runtime_job_lease(RenewRuntimeJobLeaseRequest {
            job_id: "job_pg".to_string(),
            lease_owner: "worker_a".to_string(),
            heartbeat_at_ms: 20,
            lease_ms: 100,
        })
        .expect("heartbeat job");
    assert_eq!(
        store
            .reclaim_expired_runtime_job_leases(119)
            .expect("live lease"),
        0
    );
    assert!(store
        .complete_runtime_job(CompleteRuntimeJobRequest {
            job_id: "job_pg".to_string(),
            lease_owner: "worker_a".to_string(),
            output_refs: vec![],
            completed_at_ms: 120,
        })
        .is_err());
    assert_eq!(
        store
            .reclaim_expired_runtime_job_leases(120)
            .expect("expired lease"),
        1
    );
    assert_eq!(
        store
            .claim_due_runtime_jobs(ClaimDueRuntimeJobsRequest {
                now_ms: 120,
                worker_id: "worker_b".to_string(),
                job_id: Some("job_pg".to_string()),
                job_kind: None,
                session_id: None,
                limit: 1,
                lease_ms: 100,
            })
            .expect("reclaim job")
            .len(),
        1
    );
    assert!(store
        .complete_runtime_job(CompleteRuntimeJobRequest {
            job_id: "job_pg".to_string(),
            lease_owner: "worker_a".to_string(),
            output_refs: vec![],
            completed_at_ms: 121,
        })
        .is_err());
    store
        .complete_runtime_job(CompleteRuntimeJobRequest {
            job_id: "job_pg".to_string(),
            lease_owner: "worker_b".to_string(),
            output_refs: vec![],
            completed_at_ms: 121,
        })
        .expect("current owner completes job");
    let mut audit = Client::connect(&url, NoTls).expect("connect");
    let outbox = audit
        .query_one(
            "SELECT event_type,generation FROM runtime.runtime_job_outbox WHERE job_id='job_pg'",
            &[],
        )
        .expect("terminal outbox");
    let outbox_event_type: String = outbox.get(0);
    let outbox_generation: i64 = outbox.get(1);
    assert_eq!(outbox_event_type, "runtime_job.terminal");
    assert_eq!(outbox_generation, 0);
    let tables = audit
        .query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='runtime'",
            &[],
        )
        .expect("tables");
    assert_eq!(tables.len(), 14); // Includes session-scoped observation contents and manifests.
}

#[test]
#[ignore = "requires destructive dedicated Postgres test database"]
fn postgres_runtime_job_yield_requeues_same_job_without_queued_outbox_and_fences_old_owner() {
    let _guard = TEST_LOCK.lock().expect("Postgres test lock");
    let url = test_url();
    reset_store(&url);
    let store = PostgresRuntimeStore::new(&url).expect("open Postgres store");
    store
        .schedule_runtime_job(ScheduleRuntimeJobRequest {
            job: job("job_pg_yield", "key_pg_yield"),
        })
        .expect("schedule job");
    store
        .claim_due_runtime_jobs(ClaimDueRuntimeJobsRequest {
            now_ms: 10,
            worker_id: "worker_pg_yield_owner".to_string(),
            job_id: Some("job_pg_yield".to_string()),
            job_kind: None,
            session_id: None,
            limit: 1,
            lease_ms: 1_000,
        })
        .expect("claim job");
    store
        .start_runtime_job(StartRuntimeJobRequest {
            job_id: "job_pg_yield".to_string(),
            lease_owner: "worker_pg_yield_owner".to_string(),
            started_at_ms: 11,
        })
        .expect("start job");
    let request = YieldRuntimeJobRequest {
        job_id: "job_pg_yield".to_string(),
        lease_owner: "worker_pg_yield_owner".to_string(),
        yielded_at_ms: 20,
        run_at_ms: 40,
        transition_reason: "waiting_for_durable_input".to_string(),
    };
    store.yield_runtime_job(request.clone()).expect("yield job");
    let cross_lease_error = store
        .yield_runtime_job(YieldRuntimeJobRequest {
            lease_owner: "worker_pg_other_owner".to_string(),
            ..request.clone()
        })
        .expect_err("same millisecond from another lease is not idempotent");
    assert!(cross_lease_error.contains("idempotency conflict"));
    store
        .yield_runtime_job(request)
        .expect("duplicate yield is idempotent");

    let yielded = store
        .get_runtime_job("job_pg_yield")
        .expect("load yielded job")
        .expect("yielded job exists");
    assert_eq!(yielded.status, RuntimeJobStatus::Queued);
    assert_eq!(yielded.run_at_ms, 40);
    assert_eq!(yielded.retry_count, 0);
    let pending = store
        .list_pending_runtime_job_outbox(10)
        .expect("load terminal-only outbox");
    assert!(pending.is_empty());

    let old_owner_error = store
        .yield_runtime_job(YieldRuntimeJobRequest {
            job_id: "job_pg_yield".to_string(),
            lease_owner: "worker_pg_old_owner".to_string(),
            yielded_at_ms: 21,
            run_at_ms: 41,
            transition_reason: "waiting_for_durable_input".to_string(),
        })
        .expect_err("old owner must be fenced");
    assert!(old_owner_error.contains("lease mismatch or expired"));
}

#[test]
#[ignore = "requires destructive dedicated Postgres test database"]
fn postgres_turn_supplement_queue_is_lease_fenced_and_cancel_closes_admission() {
    let _guard = TEST_LOCK.lock().expect("Postgres test lock");
    let url = test_url();
    reset_store(&url);
    let store = PostgresRuntimeStore::new(&url).expect("open Postgres store");
    let agent_run_id = "agent_run_pg_supplement";
    let session_id = "session_pg_supplement";
    let digest = "digest_pg_supplement";
    let job_id = format!("agent_run.lifecycle:{agent_run_id}");
    let owner = "worker_pg_supplement";
    let mut lifecycle_job = job(job_id.as_str(), "unused");
    lifecycle_job.job_kind =
        centaeris_core::session::reliability::AGENT_RUN_LIFECYCLE_JOB_KIND.to_string();
    lifecycle_job.idempotency_key = format!("agent_run.lifecycle:{agent_run_id}:{digest}");
    lifecycle_job.session_id = Some(session_id.to_string());
    lifecycle_job.payload_ref = Some(format!("record:agent_run:{agent_run_id}"));
    store
        .schedule_runtime_job(ScheduleRuntimeJobRequest { job: lifecycle_job })
        .expect("schedule lifecycle job");
    store
        .claim_due_runtime_jobs(ClaimDueRuntimeJobsRequest {
            now_ms: 10,
            worker_id: owner.to_string(),
            job_id: Some(job_id.clone()),
            job_kind: None,
            session_id: None,
            limit: 1,
            lease_ms: 1_000,
        })
        .expect("claim lifecycle job");
    store
        .start_runtime_job(StartRuntimeJobRequest {
            job_id: job_id.clone(),
            lease_owner: owner.to_string(),
            started_at_ms: 11,
        })
        .expect("start lifecycle job");
    let enqueue = |supplement_id: &str, message: &str, at_ms: i64| {
        store.enqueue_turn_supplement(EnqueueTurnSupplementRequest {
            agent_run_id: agent_run_id.to_string(),
            lifecycle_job_id: job_id.clone(),
            session_id: session_id.to_string(),
            authorization_digest: digest.to_string(),
            supplement_id: supplement_id.to_string(),
            message: message.to_string(),
            created_at_ms: at_ms,
        })
    };
    assert_eq!(
        enqueue("supplement-pg-1", "first", 12)
            .expect("enqueue first supplement")
            .disposition,
        EnqueueTurnSupplementDisposition::Accepted
    );
    let claimed = store
        .claim_turn_supplements(ClaimTurnSupplementsRequest {
            agent_run_id: agent_run_id.to_string(),
            lifecycle_job_id: job_id.clone(),
            session_id: session_id.to_string(),
            authorization_digest: digest.to_string(),
            lease_owner: owner.to_string(),
            claim_token: "claim-pg-1".to_string(),
            now_ms: 13,
            close_if_empty: false,
            limit: 8,
        })
        .expect("claim first supplement");
    assert_eq!(claimed.len(), 1);
    store
        .acknowledge_turn_supplements(AcknowledgeTurnSupplementsRequest {
            agent_run_id: agent_run_id.to_string(),
            lifecycle_job_id: job_id.clone(),
            session_id: session_id.to_string(),
            authorization_digest: digest.to_string(),
            lease_owner: owner.to_string(),
            claim_token: "claim-pg-1".to_string(),
            supplement_ids: vec!["supplement-pg-1".to_string()],
            acknowledged_at_ms: 14,
        })
        .expect("ack first supplement");
    enqueue("supplement-pg-2", "second", 15).expect("enqueue before cancel");
    store
        .request_agent_run_cancellation(agent_run_id, session_id, digest, 16)
        .expect("cancel run");
    assert_eq!(
        enqueue("supplement-pg-3", "banana", 17).expect_err("cancel closes supplement admission"),
        TurnSupplementStoreError::AdmissionClosed
    );
    store
        .close_turn_supplement_queue(CloseTurnSupplementQueueRequest {
            agent_run_id: agent_run_id.to_string(),
            lifecycle_job_id: job_id,
            session_id: session_id.to_string(),
            authorization_digest: digest.to_string(),
            lease_owner: Some(owner.to_string()),
            reason: "agent_run_terminal".to_string(),
            closed_at_ms: 18,
        })
        .expect("terminal close remains idempotent after cancel");
}

#[test]
#[ignore = "requires destructive dedicated Postgres test database"]
fn postgres_session_terminal_append_fences_reclaimed_lease_owner() {
    let _guard = TEST_LOCK.lock().expect("Postgres test lock");
    let url = test_url();
    reset_store(&url);
    let mut setup = Client::connect(&url, NoTls).expect("connect test Postgres");
    setup
        .batch_execute(
            r#"
            DROP TABLE IF EXISTS public.app_core_sessionevent;
            DROP TABLE IF EXISTS public.app_core_session CASCADE;
            CREATE TABLE public.app_core_session(
                id varchar(64) PRIMARY KEY,
                workspace_id varchar(64) NOT NULL
            );
            CREATE TABLE public.app_core_sessionevent(
                "eventId" varchar(160) PRIMARY KEY,
                workspace_id varchar(64) NOT NULL,
                session_id varchar(64) NOT NULL,
                agent_run_id varchar(64) NOT NULL,
                sequence integer NOT NULL,
                agent_run_sequence integer NOT NULL,
                projects_to_agent_run_stream boolean NOT NULL,
                payload jsonb NOT NULL,
                "createdAtMs" bigint NOT NULL,
                "insertedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
                UNIQUE(session_id, sequence),
                UNIQUE(agent_run_id, agent_run_sequence)
            );
            INSERT INTO public.app_core_session(id, workspace_id)
            VALUES('session_fenced_terminal', 'workspace_fenced_terminal');
            "#,
        )
        .expect("create session event table");
    drop(setup);
    let store = PostgresRuntimeStore::new(&url).expect("open Postgres store");
    let now_ms = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_millis(),
    )
    .expect("timestamp");
    let agent_run_id = "agent_run_fenced_terminal";
    let session_id = "session_fenced_terminal";
    let mut lifecycle_job = job(
        "agent_run.lifecycle:agent_run_fenced_terminal",
        "fenced-terminal",
    );
    lifecycle_job.job_kind = "agent_run.lifecycle".to_string();
    lifecycle_job.session_id = Some(session_id.to_string());
    lifecycle_job.run_at_ms = now_ms;
    lifecycle_job.created_at_ms = now_ms;
    lifecycle_job.updated_at_ms = now_ms;
    store
        .schedule_runtime_job(ScheduleRuntimeJobRequest { job: lifecycle_job })
        .expect("schedule lifecycle job");
    store
        .claim_due_runtime_jobs(ClaimDueRuntimeJobsRequest {
            now_ms,
            worker_id: "old_owner".to_string(),
            job_id: Some("agent_run.lifecycle:agent_run_fenced_terminal".to_string()),
            job_kind: None,
            session_id: None,
            limit: 1,
            lease_ms: 10,
        })
        .expect("claim old lease");
    store
        .start_runtime_job(StartRuntimeJobRequest {
            job_id: "agent_run.lifecycle:agent_run_fenced_terminal".to_string(),
            lease_owner: "old_owner".to_string(),
            started_at_ms: now_ms,
        })
        .expect("start old lease");
    let session_log = PostgresSessionLog::new(
        url.clone(),
        "workspace_fenced_terminal".to_string(),
        session_id.to_string(),
        "fence terminal".to_string(),
    );
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    runtime
        .block_on(session_log.append_session_records(
            agent_run_id,
            &[
                session_record(
                    agent_run_id,
                    session_id,
                    1,
                    SessionRecordType::AgentRunStarted,
                    serde_json::json!({"userObjective": "fence terminal"}),
                    now_ms,
                ),
                session_record(
                    agent_run_id,
                    session_id,
                    2,
                    SessionRecordType::UserMessage,
                    serde_json::json!({
                        "messageId": "message:agent_run_fenced_terminal:user",
                        "text": "fence terminal",
                        "attachments": []
                    }),
                    now_ms,
                ),
            ],
        ))
        .expect("append started records");
    store
        .reclaim_expired_runtime_job_leases(now_ms + 11)
        .expect("reclaim old lease");
    store
        .claim_due_runtime_jobs(ClaimDueRuntimeJobsRequest {
            now_ms: now_ms + 11,
            worker_id: "new_owner".to_string(),
            job_id: Some("agent_run.lifecycle:agent_run_fenced_terminal".to_string()),
            job_kind: None,
            session_id: None,
            limit: 1,
            lease_ms: 60_000,
        })
        .expect("claim replacement lease");
    store
        .start_runtime_job(StartRuntimeJobRequest {
            job_id: "agent_run.lifecycle:agent_run_fenced_terminal".to_string(),
            lease_owner: "new_owner".to_string(),
            started_at_ms: now_ms + 12,
        })
        .expect("start replacement lease");
    let final_assistant = session_record(
        agent_run_id,
        session_id,
        3,
        SessionRecordType::AssistantMessage,
        serde_json::json!({
            "messageId": "message:turn_pg_fenced_terminal:assistant",
            "modelMarkdown": "done",
            "artifactRefs": [],
            "status": "done"
        }),
        now_ms + 13,
    );
    let terminal = [
        final_assistant,
        session_record(
            agent_run_id,
            session_id,
            4,
            SessionRecordType::AgentRunCompleted,
            serde_json::json!({"doneReason": "finalized"}),
            now_ms + 13,
        ),
    ];
    let old_error = runtime
        .block_on(session_log.append_session_records_with_runtime_job_lease(
            agent_run_id,
            &terminal,
            &RuntimeJobLeaseFence {
                job_id: "agent_run.lifecycle:agent_run_fenced_terminal".to_string(),
                job_kind: "agent_run.lifecycle".to_string(),
                lease_owner: "old_owner".to_string(),
            },
        ))
        .expect_err("reclaimed owner must not commit terminal records");
    assert_eq!(old_error, RUNTIME_JOB_LEASE_FENCE_REJECTED);

    runtime
        .block_on(session_log.append_session_records_with_runtime_job_lease(
            agent_run_id,
            &terminal,
            &RuntimeJobLeaseFence {
                job_id: "agent_run.lifecycle:agent_run_fenced_terminal".to_string(),
                job_kind: "agent_run.lifecycle".to_string(),
                lease_owner: "new_owner".to_string(),
            },
        ))
        .expect("current owner commits terminal records");
    let mut audit = Client::connect(&url, NoTls).expect("connect audit");
    let count: i64 = audit
        .query_one(
            "SELECT COUNT(*) FROM public.app_core_sessionevent WHERE agent_run_id=$1",
            &[&agent_run_id],
        )
        .expect("count session records")
        .get(0);
    assert_eq!(count, 4);
}

#[test]
#[ignore = "requires destructive dedicated Postgres test database"]
fn postgres_model_request_batch_deduplicates_and_hydrates_observations() {
    let _guard = TEST_LOCK.lock().expect("Postgres test lock");
    let url = test_url();
    reset_store(&url);
    let mut setup = Client::connect(&url, NoTls).expect("connect test Postgres");
    setup
        .batch_execute(
            r#"
            DROP TABLE IF EXISTS public.app_core_sessionevent;
            DROP TABLE IF EXISTS public.app_core_session CASCADE;
            CREATE TABLE public.app_core_session(
                id varchar(64) PRIMARY KEY,
                workspace_id varchar(64) NOT NULL
            );
            CREATE TABLE public.app_core_sessionevent(
                "eventId" varchar(160) PRIMARY KEY,
                workspace_id varchar(64) NOT NULL,
                session_id varchar(64) NOT NULL,
                agent_run_id varchar(64) NOT NULL,
                sequence integer NOT NULL,
                agent_run_sequence integer NOT NULL,
                projects_to_agent_run_stream boolean NOT NULL,
                payload jsonb NOT NULL,
                "createdAtMs" bigint NOT NULL,
                "insertedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
                UNIQUE(session_id, sequence),
                UNIQUE(agent_run_id, agent_run_sequence)
            );
            INSERT INTO public.app_core_session(id, workspace_id)
            VALUES('session_model_request', 'workspace_model_request');
            "#,
        )
        .expect("create session event table");
    drop(setup);
    let store = PostgresRuntimeStore::new(&url).expect("open Postgres store");
    let session_id = "session_model_request";
    let agent_run_id = "agent_run_model_request";
    let session_log = PostgresSessionLog::new(
        url.clone(),
        "workspace_model_request".to_string(),
        session_id.to_string(),
        "dedup".to_string(),
    );
    let digest = format!("sha256:{}", "a".repeat(64));
    let composition = centaeris_core::extension::composition::resolve_agent_composition(
        centaeris_core::extension::composition::AgentCompositionInputsV1 {
            prompt_digest: digest.clone(),
            model_binding: centaeris_core::extension::composition::ResolvedModelBindingV1 {
                provider_id: "test-provider".to_string(),
                model_name: "test-model".to_string(),
                wire_protocol: "test-wire".to_string(),
                config_digest: digest.clone(),
            },
            skill_catalog_digest: digest.clone(),
            plugin_activation_digest: digest.clone(),
            hook_composition_digest: digest.clone(),
            execution_profile_digest: digest,
            policy_version: "test-v1".to_string(),
        },
        std::iter::empty(),
    )
    .expect("composition");
    let request = |sequence: u64, request_id: &str, message_id: &str| {
        session_record(
            agent_run_id,
            session_id,
            sequence,
            SessionRecordType::ModelRequestStarted,
            serde_json::json!({
                "requestId": request_id,
                "purpose": "main",
                "loopIndex": sequence,
                "toolChoice": {"type": "none"},
                "maxOutputTokens": 1024,
                "promptCacheKey": null,
                "promptCacheRetention": null,
                "preparedPromptSchema": "prepared_prompt.v1",
                "contextTokenEstimate": 0,
                "contextTokenBreakdown": {
                    "systemPromptTokens": 0,
                    "systemToolTokens": 0,
                    "mcpToolTokens": 0,
                    "skillsTokens": 0,
                    "messageTokens": 0,
                    "mcpTools": [],
                },
                "agentComposition": composition.clone(),
                "observations": [
                    {"kind": "system_prompt", "content": "stable secret prompt"},
                    {"kind": "message", "message": {
                        "messageId": message_id,
                        "role": "user",
                        "content": format!("context for {message_id}")
                    }}
                ]
            }),
            i64::try_from(sequence).expect("timestamp"),
        )
    };
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    runtime
        .block_on(session_log.append_session_records(
            agent_run_id,
            &[
                session_record(
                    agent_run_id,
                    session_id,
                    1,
                    SessionRecordType::AgentRunStarted,
                    serde_json::json!({"userObjective": "dedup"}),
                    1,
                ),
                session_record(
                    agent_run_id,
                    session_id,
                    2,
                    SessionRecordType::UserMessage,
                    serde_json::json!({
                        "messageId": format!("message:{agent_run_id}:user"),
                        "text": "dedup",
                        "attachments": []
                    }),
                    1,
                ),
            ],
        ))
        .expect("append start");
    let first = request(3, "request_1", "context_1");
    let second = request(4, "request_2", "context_2");
    runtime
        .block_on(session_log.append_session_records(agent_run_id, std::slice::from_ref(&first)))
        .expect("append first request");
    runtime
        .block_on(session_log.append_session_records(agent_run_id, std::slice::from_ref(&second)))
        .expect("append second request");
    let retry = runtime
        .block_on(session_log.append_session_records(agent_run_id, std::slice::from_ref(&second)))
        .expect("idempotent hydrated retry");
    assert_eq!(retry.records[0].event, second.event);

    let mut audit = Client::connect(&url, NoTls).expect("connect audit");
    let raw_requests = audit
        .query(
            "SELECT payload::text FROM public.app_core_sessionevent WHERE payload->>'type'='model_request_started' ORDER BY sequence",
            &[],
        )
        .expect("load stored requests");
    assert_eq!(raw_requests.len(), 2);
    assert!(raw_requests.iter().all(|row| {
        let payload = row.get::<_, String>(0);
        !payload.contains("stable secret prompt")
            && payload.contains("manifestDigest")
            && !payload.contains("contentDigest")
    }));
    let content_count = audit
        .query_one(
            "SELECT COUNT(*) FROM runtime.model_observation_contents WHERE session_id=$1",
            &[&session_id],
        )
        .expect("count unique observation contents")
        .get::<_, i64>(0);
    assert_eq!(content_count, 3);
    let session_rows = audit
        .query_one(
            "SELECT COUNT(*) FROM public.app_core_sessionevent WHERE session_id=$1",
            &[&session_id],
        )
        .expect("count session rows")
        .get::<_, i64>(0);
    let commit_rows = audit
        .query_one(
            "SELECT COUNT(*) FROM runtime.runtime_events WHERE session_id=$1 AND event_type='session_record_committed'",
            &[&session_id],
        )
        .expect("count commit rows")
        .get::<_, i64>(0);
    assert_eq!((session_rows, commit_rows), (4, 4));
    assert_eq!(
        audit
            .query_one(
                "SELECT COUNT(*) FROM runtime.model_observation_manifests WHERE session_id=$1",
                &[&session_id],
            )
            .expect("count manifest nodes")
            .get::<_, i64>(0),
        2
    );

    // Real append/UNNEST/CAS/hydration growth, excluding the two fixtures above.
    let storage_totals = |audit: &mut Client| {
        let row = audit.query_one(
            "SELECT (SELECT COUNT(*) FROM runtime.model_observation_manifests WHERE session_id=$1),(SELECT COALESCE(SUM(jsonb_array_length(manifest_json::jsonb->'changes')),0)::bigint FROM runtime.model_observation_manifests WHERE session_id=$1),(SELECT COALESCE(SUM(manifest_bytes),0)::bigint FROM runtime.model_observation_manifests WHERE session_id=$1),(SELECT COUNT(*) FROM runtime.model_observation_contents WHERE session_id=$1),(SELECT COALESCE(SUM(content_bytes),0)::bigint FROM runtime.model_observation_contents WHERE session_id=$1),(SELECT COALESCE(SUM(octet_length(payload::text)),0)::bigint FROM public.app_core_sessionevent WHERE session_id=$1 AND payload->>'type'='model_request_started'),(SELECT COALESCE(SUM(octet_length(payload_json)),0)::bigint FROM runtime.runtime_events WHERE session_id=$1 AND event_type='session_record_committed' AND payload_json::jsonb->>'sessionRecordType'='model_request_started'),(SELECT COUNT(*) FROM runtime.runtime_events WHERE session_id=$1 AND event_type='session_record_committed' AND payload_json::jsonb->>'sessionRecordType'='model_request_started')",
            &[&session_id],
        ).expect("measure stored observation payloads");
        [
            row.get::<_, i64>(0),
            row.get(1),
            row.get(2),
            row.get(3),
            row.get(4),
            row.get(5),
            row.get(6),
            row.get(7),
        ]
    };
    let baseline = storage_totals(&mut audit);
    let mut observations = vec![
        serde_json::json!({"kind": "system_prompt", "content": "growth stable system"}),
        serde_json::json!({"kind": "message", "message": {"messageId": "runtime-context", "role": "user", "content": "context 0"}}),
        serde_json::json!({"kind": "message", "message": {"messageId": "stable-context", "role": "user", "content": "stable prior context"}}),
    ];
    let mut curve = Vec::new();
    let mut latest = second.clone();
    for round in 1..=2046usize {
        observations[1]["message"]["content"] =
            serde_json::json!(format!("runtime context {round}"));
        for role in ["user", "assistant"] {
            observations.push(serde_json::json!({"kind": "message", "message": {
                "messageId": format!("growth-{round}-{role}"), "role": role,
                "content": format!("{round}:{role}:{}", "m".repeat(64)),
            }}));
        }
        latest = request(
            round as u64 + 4,
            &format!("growth-request-{round}"),
            "unused",
        );
        latest.event.payload["observations"] = serde_json::json!(observations);
        runtime
            .block_on(
                session_log.append_session_records(agent_run_id, std::slice::from_ref(&latest)),
            )
            .expect("append growth request");
        if [20, 81, 512, 2046].contains(&round) {
            let measured = storage_totals(&mut audit);
            let values = std::array::from_fn::<_, 8, _>(|index| measured[index] - baseline[index]);
            assert_eq!(values[0], round as i64);
            assert_eq!(values[1], (3 * round + 2) as i64);
            assert_eq!(values[3], (3 * round + 2) as i64);
            assert_eq!(values[7], round as i64);
            curve.push(
                serde_json::json!({"rounds": round, "observationCount": observations.len(),
                "manifestNodes": values[0], "manifestRefs": values[1], "manifestBytes": values[2],
                "uniqueContents": values[3], "contentBytes": values[4], "eventRootBytes": values[5],
                "commitPayloadBytes": values[6], "commitRows": values[7],
                "physicalRows": values[0] + values[3] + 2 * values[7],
                "physicalPayloadBytes": values[2] + values[4] + values[5] + values[6]}),
            );
        }
    }
    let before_retry = storage_totals(&mut audit);
    let retry = runtime
        .block_on(session_log.append_session_records(agent_run_id, std::slice::from_ref(&latest)))
        .expect("retry long-chain request");
    assert_eq!(retry.records[0].event, latest.event);
    assert_eq!(storage_totals(&mut audit), before_retry);
    println!(
        "RUNTIME_01_ARTIFACT {}",
        serde_json::json!({
            "gate": "postgres_manifest_database_growth", "measurement": "actual_postgres_rows_and_payload_bytes_excludes_indexes_mvcc_relation_overhead",
            "workload": "early_runtime_context_replaced_and_two_tail_observations_appended_per_round", "curve": curve,
        })
    );
    let stored_root = audit.query_one(
        "SELECT payload::text FROM public.app_core_sessionevent WHERE session_id=$1 AND payload->>'type'='model_request_started' ORDER BY sequence DESC LIMIT 1", &[&session_id],
    ).expect("read last compact root").get::<_, String>(0);
    let mut other_wire: serde_json::Value = serde_json::from_str(&stored_root).unwrap();
    other_wire["sessionId"] = serde_json::json!("session_other");
    assert!(super::runtime::hydrate_session_wire_values(
        &mut audit,
        std::slice::from_mut(&mut other_wire)
    )
    .expect_err("cross-session manifest must fail")
    .contains("missing"));
    let root: serde_json::Value = serde_json::from_str(&stored_root).unwrap();
    let digest = root["payload"]["observations"]["manifestDigest"]
        .as_str()
        .unwrap();
    let original = audit.query_one("SELECT manifest_json,manifest_bytes FROM runtime.model_observation_manifests WHERE session_id=$1 AND manifest_digest=$2", &[&session_id, &digest]).unwrap();
    audit.execute("UPDATE runtime.model_observation_manifests SET manifest_json='{}',manifest_bytes=2 WHERE session_id=$1 AND manifest_digest=$2", &[&session_id, &digest]).unwrap();
    assert!(runtime
        .block_on(session_log.append_session_records(agent_run_id, std::slice::from_ref(&latest)))
        .expect_err("tampered manifest must fail")
        .contains("digest mismatch"));
    audit.execute("UPDATE runtime.model_observation_manifests SET manifest_json=$3,manifest_bytes=$4 WHERE session_id=$1 AND manifest_digest=$2", &[&session_id, &digest, &original.get::<_, String>(0), &original.get::<_, i64>(1)]).unwrap();
    let content_digest = audit.query_one("SELECT content_digest FROM runtime.model_observation_contents WHERE session_id=$1 AND kind='system_prompt' ORDER BY first_seen_at_ms DESC LIMIT 1", &[&session_id]).unwrap().get::<_, String>(0);
    audit.execute("DELETE FROM runtime.model_observation_contents WHERE session_id=$1 AND content_digest=$2", &[&session_id, &content_digest]).unwrap();
    let next = request(2051, "after-missing-content", "unused");
    assert!(runtime
        .block_on(session_log.append_session_records(agent_run_id, &[next]))
        .expect_err("new append must not silently heal missing content")
        .contains("incomplete"));

    store
        .delete_session_data(session_id)
        .expect("delete runtime session data");
    assert_eq!(
        audit
            .query_one(
                "SELECT COUNT(*) FROM runtime.model_observation_contents WHERE session_id=$1",
                &[&session_id],
            )
            .expect("count deleted contents")
            .get::<_, i64>(0),
        0
    );
    assert_eq!(
        audit
            .query_one(
                "SELECT COUNT(*) FROM runtime.model_observation_manifests WHERE session_id=$1",
                &[&session_id],
            )
            .expect("count deleted manifests")
            .get::<_, i64>(0),
        0
    );
}

#[test]
#[ignore = "requires destructive dedicated Postgres test database"]
fn postgres_runtime_store_rejects_schema_drift() {
    let _guard = TEST_LOCK.lock().expect("Postgres test lock");
    let url = test_url();
    reset_store(&url);
    PostgresRuntimeStore::new(&url).expect("create schema");
    let mut client = Client::connect(&url, NoTls).expect("connect");
    client
        .batch_execute("ALTER TABLE runtime.runtime_jobs ALTER COLUMN last_error TYPE varchar(40)")
        .expect("corrupt schema");
    let error = PostgresRuntimeStore::new(&url).expect_err("schema drift must fail");
    assert!(error.contains("table definition mismatch"));
}
