# Workspace API

This document owns only Workspace transports. Exact fields are enforced by the
Django and Rust definitions in this repository.

Browser REST and SSE routes are rooted at `/api`. Postgres is truth; Redis holds
bounded transient live projection. Unknown fields and schemas fail. Public
Runtime event and tool semantics belong only to the exact public Cargo revision.

Internal calls require `X-Internal-Token`; there is no anonymous fallback.
`GET /internal/model-catalog` returns exact
`{schema:"workspace.model_catalog.result.v1",catalog}` from the public Rust model
catalog crate. Django does not parse or duplicate catalog files. Other internal
AgentRun, workspace file, knowledge, Skill, MCP, and Hook transports use the
exact v1 schemas in code.

Nonzero Session stream cursors use the exact `v1.<base64url>` wire prefix with
payload schema `session.stream.cursor.v1`; `0-0` is the only initial sentinel.
AgentRun authorization uses schema `workspace.agent_run_authorization.v1` and
signature domain `workspace:agent-run-authorization:v1`. Knowledge processing
specifications use the immutable Centaeris processor version `1.0.0`.

Secrets never belong in responses, logs, documentation, or checked-in examples.

Hosted message submission atomically enforces the Workspace initial-queue budget
and the global initial-queue budget. A full Workspace returns HTTP 429 with
`workspace_execution_queue_full`; global saturation returns HTTP 503 with
`execution_queue_full`. Contention on the cross-replica admission transaction
returns HTTP 503 with `execution_admission_busy`. These responses carry
`Retry-After: 5`; a rejected request creates no Session, AgentRun or authorization.
An initially queued run that expires records `execution_queue_expired` and follows
Runtime's normal cancellation protocol; logical waits do not expire this way.

`POST /internal/jobs/schedule` keeps `runtime.job.schedule.v1`. For
`agent_run.lifecycle`, `workspaceId` is required and commits with the job as an
immutable tenant binding. Other kinds omit it. Reusing an idempotency key with a
different job, session, payload reference or tenant fails. Hosted lifecycle claim
and wait routes enforce the shared execution limits; saturation returns an empty
claim result, not a failed job. Capacity release wakes existing job listeners.
Contention on the atomic claim transaction returns HTTP 503
`execution_claim_busy` with `Retry-After: 5`; worker slots back off before claiming
again rather than spinning on a due job whose claim transaction is still locked.

Runtime HTTP saturation returns HTTP 503 `runtime_busy` with `Retry-After: 5`.
An absolute handler response deadline returns HTTP 504
`request_deadline_exceeded`; a body deadline returns HTTP 408. Timeout does not
establish whether a write committed. Cancellation, heartbeat and job-status RPCs
use reserved HTTP capacity and the reserved database pool for their complete path,
including cancellation's terminal-state preflight reads.

`POST /internal/agent-run-lifecycle/reconcile` accepts
`runtime.agent_run_lifecycle.reconcile.v1`, `limit` (1–100), and optional
`activeAfter` / `deadLetterAfter` cursors. Each cursor is null (start a pass) or
`{createdAt, id}` with an offset-aware timestamp. Unknown fields and malformed
cursors fail. The response contains `scheduled`, `terminalized`, `pending`,
`activeNext`, and `deadLetterNext`. The two populations advance independently in
`(createdAt, id)` order, with at most `limit` attempts per population per call.
Null next cursors finish that population's pass; the next tick starts a new pass.
Failed individual attempts still advance the page and retry on a later pass.
The worker retains cursors across ticks, including when later waiter recovery
fails, and starts from null after process restart. These are scan-progress hints,
not execution checkpoints; durable jobs and session facts remain authoritative.

`POST /internal/jobs/reconcile` accepts `runtime.job.reconcile.v1` with `nowMs`
and returns `{reclaimed}` for expired job leases. It does not reactivate published
terminal notifications. Pending outbox deliveries persist until generation-checked
acknowledgement, which follows durable waiter wake handling. A crash before that
acknowledgement permits duplicate delivery; duplicate wake and acknowledgement
remain idempotent.

`POST /internal/job-outbox/reconcile-waiters` recovers late or missed wakes from
the durable waiting-relationship index and terminal source jobs, including
waiters registered after notification acknowledgement. Both this endpoint and
`POST /internal/job-outbox/wake-waiter` accept `after`: null or an exact object
`{checkpointId, toolCallId}`. Wake requests additionally retain `jobId` and
`generation`; their lookup selects only that source job's indexed relationships.

Responses contain exactly `disposition`, `checked`, `waiters`, and `next`.
`next` is null at the end of a pass, otherwise it is the cursor to send as
`after`. A request processes at most 256 relationships and yields after a 200ms
scheduling budget between operations. It always finishes at least one available
relationship; this budget does not interrupt database transactions or impose a
hard request deadline. Large checkpoints paginate within their tool-call set.

The worker retains independent cursors for reconciliation and each pending
notification generation. It does not acknowledge a notification until `next`
is null. Failed requests repeat their last page safely. A worker restart begins
new idempotent passes from null; durable pending notifications and waiting
relationships remain authoritative. Late registrations behind a cursor are
covered on the next reconciliation pass, without replaying terminal history.

Model completion results carry optional `reasoningContent` for display and
`continuationReasoningContent` for provider-approved plain-text continuation.
These fields are independent; Runtime must not reconstruct continuation from
display text. OpenAI-compatible adapters preserve their existing continuation
text, while Responses summaries and Anthropic thinking text are display only.
Neither field carries opaque reasoning, encrypted data, or provider signatures.
Both the ordinary result and `api.model.stream.v1` terminal `result` use these
exact camelCase names; unknown result fields and non-string, non-null reasoning
values fail. The stream emits answer `delta`, full-attempt `reasoning` snapshots
(`schema`, `type`, `text`), and terminal `result`. Runtime submits Core-owned
`reasoning_block` records on success (`done`), failure, or cancellation
(`interrupted`), keeping each retry under a separate Core request identity.
Postgres history and committed SSE carry these records through the existing
Session transport; Web reconstructs reasoning blocks in source sequence order.
The payload is exactly `blockId`, `requestId`, `text`, and `status`, with identity
and lifecycle validation owned by Core. No duration field is added.
Schema identifiers remain v1.

Redis live snapshots and SSE signals carry optional `reasoning` alongside the
answer under one monotonic revision. Its exact fields are `blockId`, `requestId`,
and `text`. Atomic Redis writes update the cached snapshot and signal together;
browser restoration reads both body and reasoning from that snapshot. Committed
seals replace matching live blocks without changing their disclosure identity.
Runtime restart recovers available cached partial reasoning through Core before
settling the interrupted run. Missing or expired cache does not fabricate text.

Workspace, Agent, and Session creation generates `ws_`, `agent_`, and `session_`
identifiers followed by 16 case-sensitive Base64url characters (`A-Z`, `a-z`,
`0-9`, `-`, `_`), encoding 12 cryptographically random bytes without padding.
Other resource identifiers retain their own generation rules. Resource IDs are
opaque, immutable references: clients must not split, lowercase, or reinterpret
them. Creating these resources through the ORM retries generated primary-key
collisions up to three total attempts; explicit IDs and other integrity errors
fail. Possession of an ID does not grant access: ownership and workspace
membership checks still apply.

## Execution recovery scheduling

The internal `runtime.agent_run.step.result.v1` response requires `retryAtMs`
(a nonnegative integer Unix timestamp in milliseconds) when `transitionReason`
is `execution_recovery_checkpoint_committed`. This response has `disposition`
`waiting` and `terminalState` null. Other step outcomes omit `retryAtMs`.
The worker yields its current lease until that deadline while keeping the
AgentRun running. The Runtime derives the deadline from committed recovery
facts, reserves an attempt under the lifecycle lease before preparation, and
terminalizes exhaustion as `execution_recovery_exhausted`. Retry scheduling
does not permit replaying tool calls beyond a checkpoint.

## Plugin management isolation

`GET /api/workspaces/{workspaceId}/plugins` returns the validated inventory and
per-package interface errors without calling Runtime. `mcpServers` and `hooks`
are `null` until inspected, not empty success results. The required `errors`
array is scoped to each plugin. `GET .../plugins/{pluginName}` independently
inspects that package through the existing exact v1 MCP and Hook projections;
unavailable or invalid contributions remain `null` with explicit error codes.

Enabling validates only the target package and rejects errors with
`workspace_plugin_unavailable`. A package changed during validation requires a
new inspection. Disabling does not contact Runtime. Global catalog integrity
errors still fail the request; missing package files are isolated in management
but remain errors for execution. Enabled invalid packages are never silently
removed from AgentRun activations.

Bearer credential management loads independently. `mcpCredentialRefs` contains
deduplicated references read from digest-verified installed v1 transport metadata,
independent of full tool contract validation or Runtime availability. Unreadable
credential metadata returns `null` with `plugin_credentials_unavailable`, not an
invented reference. The UI supplies references automatically and shows one Token
input per reference; shared references do not create duplicate inputs.

Create and rotate accept either a bare Token or `Bearer <Token>`, trim surrounding
whitespace, and encrypt only the Token. Empty values, embedded whitespace/control
characters, and full `Authorization:` header lines are rejected. Saved credentials
remain manageable if declarations fail. Saving credentials does not establish
tool availability or bypass contract validation; execution remains strict v1.
