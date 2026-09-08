# Workspace API

This document owns only Workspace transports. Exact fields are enforced by the
Django and Rust definitions in this repository.

Browser REST and SSE routes are rooted at `/api`. Postgres is truth; Redis holds
bounded transient live projection. Unknown fields and schemas fail. Public
Runtime event and tool semantics belong only to the exact public Cargo revision.

## Model input images

Internal model requests consume Core's `prepared_prompt.v1`.
The authenticated `/internal/model-runs` JSON body is limited to
128 MiB (134,217,728 bytes), including base64 and history text; oversized bodies
return HTTP 413 with `model_run_request_too_large` before JSON parsing or provider
execution. This does not change Django's limits for other API endpoints.

The prompt supports optional `inputImages`. Each image has exactly
`messageId`, `contentType`, `placeholder`,
and `dataBase64`. Images bind to a unique placeholder in a user message. The API
validates canonical base64, PNG/JPEG/WebP headers, declared media type, positive
dimensions, at most 100,000,000 pixels, and at most 10 MiB (10,485,760 decoded
bytes) per image before provider execution. Header inspection is not full pixel
decoding. Unknown fields remain errors.

Provider adapters replace placeholders in text order with Chat Completions
`image_url`, Responses `input_image`, or Anthropic base64 `image` content blocks.
Core-generated image fixtures protect cross-language contracts and limit parity.

## Trash pagination

`GET /api/workspaces/{workspaceId}/trash` orders entries by deletion time
descending, then kind and ID ascending. ID ordering and cursor comparisons use
PostgreSQL `C` collation, matching the Python merge independently of the database
default locale. IDs are tie-breakers, not timestamps. Each kind contributes at
most 51 candidates and the response contains at most 50 entries. Permissions,
filters, and cursor fields are unchanged by the choice of database locale.

## Workspace citation presentation

Each history AgentRun requires `citations` and `citationSequence`, including an
empty array and zero for an empty run. Citation summaries have exactly
`citationId`, `inputRef`, `displayName`, `sourceToolCallId`, and `sourceUrl`.
Source URLs are first-party `/api/citations/{citationId}` detail routes, not
arbitrary model-supplied links. Preview authorization is checked on every access.

`GET /api/sessions/{sessionId}/agent-runs/{agentRunId}/citations` returns a no-store
snapshot with exactly `schema: "workspace.citations.v1"`, `sessionId`, `agentRunId`,
`throughSequence`, and `citations`. It requires the run owner and current workspace
membership; unknown query parameters fail. The snapshot rebuilds verified
projections from committed events through a captured sequence, under the run
projection lock, so it works before terminal lifecycle reconciliation.

History and live refresh use the same snapshot service. The web view replaces
its citation collection after tool-result batches and termination, coalesces
in-flight refreshes, bounds each request to ten seconds, ignores obsolete or
cross-session responses, and preserves existing citations on refresh failure.
Snapshots do not advance the Session stream cursor. Historical Core citation
events remain validated but no longer independently populate browser citations.
API and web strict schemas must be released together; no old-field aliases exist.

Internal REST calls require `X-Internal-Token`; there is no anonymous fallback.
The first-party MCP transport `/internal/mcp` is an exception: it accepts only a
short-lived scoped Bearer credential, not the global internal token. The host
issues one through `POST /internal/mcp/credential` with exact fields
`schema: "workspace.mcp.credential.issue.v1"`, `agentRunId`,
`authorizationDigest`, `processingSpecification`, and `specDigest`.
The no-store response has `schema: "workspace.mcp.credential.result.v1"`,
`accessToken`, and `expiresAt` (Unix seconds, five-minute lifetime).
Both entries reject browser Origin headers. See
[Platform materials and MCP](../architecture/PlatformMaterials.md#mcp-connection-and-authorization)
for transport constraints and the platform processing lifecycle.

The authenticated host may send `X-Workspace-Tool-Call-Id` (one nonempty ASCII
value, at most 160 bytes), never a model argument. The server verifies the
authorized run's committed tool call, exact arguments and reserved
`workspace.materials` provider. Eligible ready results then include `receiptId`
and `citationIds` backed by immutable server receipts. These IDs are provisional:
only an exact matching durable successful MCP result can publish citation rows.
Missing headers allow diagnostic material access but create no receipt. The
Runtime registers the five first-party material tools for runs with declared
material inputs. There is no opt-in legacy reader or plugin activation. Runtime freezes the discovered catalog and verifies it before each
call, obtains a new short-lived credential per invocation, and isolates call
headers on separate connections. Configure API allowed hostnames for the private
connection explicitly; this checkpoint does not change deployed environments.

MCP read/search can now return durable `operations` with exact fields
`operationId`, `inputRef`, `status`, and nullable `errorCode`. Status is one of
`pending`, `running`, `completed`, `failed`, `cancelled`.
`get_operation(operation_id)` and `cancel_operation(operation_id)` are scoped to
the authenticated run. Cancellation withdraws that operation only, not shared
background processing. Completed operations require a new read/search call.
The dedicated platform material Worker claims these tasks directly under database
leases; Runtime has no material scheduling or processing endpoint.
`POST /internal/materials/processor` accepts exact
`{schema:"workspace.material.processor.v1"}` under `X-Internal-Token` and returns
`{schema:"workspace.material.processor.result.v1",processingSpecification,specDigest}`.
This identifies the processor registered by the platform Worker.
Retired Knowledge read/search/commit and material reconciliation routes return 404.
`GET /internal/model-catalog` returns exact
`{schema:"workspace.model_catalog.result.v1",catalog}` from the public Rust model
catalog crate. Django does not parse or duplicate catalog files. Other internal
AgentRun, workspace file, Skill, MCP, and Hook transports use the
exact v1 schemas in code.

Nonzero Session stream cursors use the exact `v1.<base64url>` wire prefix with
payload schema `session.stream.cursor.v1`; `0-0` is the only initial sentinel.
AgentRun authorization uses schema `workspace.agent_run_authorization.v1` and
signature domain `workspace:agent-run-authorization:v1`. Knowledge processing
specifications use the immutable Centaeris processor version `1.0.0`.

Secrets never belong in ordinary responses, logs, documentation, or checked-in
examples. Explicit credential-delivery endpoints are restricted to their
authenticated caller and return no-store responses.

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

### Bounded material tool results

`read_material` and `search_materials` preserve each completed request as an immutable, session-owned result snapshot before returning a bounded page. The model receives one structured result, without a duplicated text projection. English `message` text reports delivered line and UTF-8 byte ranges; byte-range ends are exclusive. `completeResultSaved` describes storage completeness, not model reading coverage.

The response carries `resultRef`, `resultSha256`, and `continuation` (either null or an exact `tool` / `arguments` pair). `read_material_result(result_ref, cursor)` retrieves the next page of the same saved result. Treat its cursor as opaque. It does not rerun a search. When a document window is exhausted, continuation can point to `read_material` with the next zero-based line offset. Single long lines are paged at UTF-8 character boundaries. Only the returned content is eligible for a citation.

Snapshots remain with the source SessionEvent and survive API/runtime restarts. Every continuation rechecks the current run's source permissions, generation, processing identity, and session ownership. Corrupt snapshots, revoked access, and invalid cursors fail explicitly; they are not reported as a successful partial result. Existing citation projections are retained during the schema migration. Roll out API migrations and the matching Runtime tool catalog together, after active runs drain.
