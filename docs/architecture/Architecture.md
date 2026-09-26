# Workspace architecture

## Ownership

The external Runtime Framework owns Session, model, tool, continuation, and
runtime-event semantics. Workspace composes that Runtime with hosted identity,
authorization, storage, execution, and browser delivery. It does not redefine
Core behavior.

| Component | Responsibility |
| --- | --- |
| `packages/api` | Django identity, membership, workspace ACL, files, credentials, Plugin installation, AgentRun authorization, and durable product jobs |
| `packages/runtime_server` | Core composition, PostgreSQL RuntimeStore adapter, Redis live projection, and Docker execution binding |
| `packages/worker` | Bounded claim, lease, retry, and wake loop for product jobs |
| `packages/hosted_execution` | Fixed helper included in the AgentRun execution image |
| `packages/document_processor` | Office, PDF, and image inspection plus bounded canonical representations |
| `packages/web` | Browser product consuming REST and SSE |
| `skills/system` | First-party built-in behavior, separate from installable Plugin inventory |

Workspace owns Agent Memory behavior and storage. Public Core receives generic
execution file operations and mutation facts; it does not interpret the private
memory namespace.

This is a private Markdown directory protocol, not a background model maintaining
memory. The active model uses ordinary read/edit/write tools through
`plastic-memories://self/`, with MEMORY.md as an index and topics/*.md as detail.
Storage is scoped by user and Agent, across Sessions. The existing filesystem
lock and guarded write coordinate concurrent execution instances of that scope.
The helper consumes `WriteFile.observedFileHash` as its expected current version;
ordinary workspace files do not enforce this observation. The internal protocol
rename requires coordinated Core and Workspace updates, with no old-field alias.

## Request flow

1. Django authenticates the user and checks workspace membership and resource
   access.
2. The API creates an immutable AgentRun authorization containing the exact
   workspace, model, execution profile, files, and Plugin activation.
3. The worker claims the durable job and asks Runtime Server to start or resume
   the AgentRun.
4. Runtime Server validates the authorization and composes Core with the
   PostgreSQL store, model adapter, Plugin resources, and one execution binding.
5. Core drives model and tool continuation. Hosted execution and document
   processing remain adapters behind current contracts.
6. Durable events are committed to PostgreSQL. Redis carries bounded live state
   for connected browsers. The API exposes one ordered logical stream.

## Worker concurrency

`WORKER_SLOT_COUNT` sets concurrent jobs per worker process. It defaults to `8`
and accepts integers from `1` through `16`; invalid values fail at startup.
Compose forwards the setting from the deployment environment. Recreate the
worker container after changing it.

Slots are shared by lifecycle, knowledge-processing, and no-op jobs. This is
neither a per-tenant quota nor a fairness guarantee. Replicas multiply the total
slot budget; terminal dispatch and reconciliation remain separate control loops.
Size concurrency against sandbox memory, host CPU, and database capacity. The
configuration ceiling is not a claim that a host can sustain sixteen jobs.

The example deployment sets each execution sandbox's resource ceilings to
4 CPU cores (`SANDBOX_CPU_MILLI=4000`) and 8 GiB of memory
(`SANDBOX_MEMORY_BYTES=8589934592`). These are per-sandbox limits, not reserved
resources or a shared budget for the deployment.

For capacity comparisons, hold the revision, workload, replica count, and
historical-data baseline fixed while varying slots. Compare completed throughput,
queue age/depth, failures, and host/database resources; fast submission alone
does not establish sustainable capacity.

## Durable and live truth

PostgreSQL stores durable product and Runtime facts. Django application tables
and the Runtime schema have separate owners. Runtime schema v1 rejects unknown
or drifting identities.

Redis is not a job broker or history store. Live overlay generations are
discarded when a corresponding durable event establishes a supersession
barrier. Redis expiry or cleanup failure must not create or delete durable
history. The browser consumes API projections and never reads Redis directly.

## New user turn admission

The web transcript keeps its last readable snapshot when live updates fail.
Optional tool-detail projection cannot block canonical transcript patches.
Stream recovery reads a validated tail and active-run cursor before replacing
the view, then reconnects with bounded backoff; it never replays tool execution.
After repeated failures, only the current conversation offers a reconnect action.
Errors retain their original cause in developer diagnostics rather than becoming
a generic page-wide failure. Invalid transport identities still fail validation.

A new user turn is admitted only after Core has closed any unpaired tool call at
the tail of the session history. Hosts persist the accepted input (prompt,
attachments, identities), read the execution evidence, and ask Core for a
read-only closure plan; the plan carries the expected session head and the
evidence each closure was computed against.

The committing host writes the recovery facts and the new run's first batch in
one transaction, under the current lifecycle lease, with per-row attribution:

- `tool_call_closure` is a session-level recovery record (`session_level = true`,
  `agent_run_sequence = NULL`, not projected to the per-run stream). It
  references the original call's owning AgentRun without reopening it.
- ordinary records stay `session_level = false` with a positive run sequence.

A failure, cancellation, or interruption before admission writes nothing to the
model history; it stays in the AgentRun control plane. Re-delivery of an already
committed admission returns the stored receipt. A plan whose expected head no
longer matches an uncommitted batch is rejected.

Release order for a storage or transcript block-encoding change: schema first,
then readers, then the closure writer. A rollback must not hand a store that
contains closures to a reader that does not understand them.

## Files and processing

PostgreSQL stores file identities, ownership, grants, lifecycle, and processing
state. Original bytes and derived representations live in the configured
storage root. A database row is not a second copy of file contents.

Office, PDF, and image processing is lazy and version-bound. Long documents are
processed incrementally without a fixed page-count ceiling while retaining
pixel, output-size, timeout, and memory limits.

## Execution

Each AgentRun receives one frozen execution profile and temporary container.
Runtime resolves the configured image to an immutable Docker identity before a
run is authorized. The configured OCI runtime, mounts, work directory, process,
memory, CPU, PID, and network policy are Host facts. Core sees only the
`ExecutionHost` contract.

Runtime controls Docker through the host socket and is therefore a privileged
infrastructure component even when individual AgentRun containers drop
capabilities.

## Deployment trust boundary

Only Runtime and the dedicated material Worker mount the Docker socket.
That socket makes both services part of the host's trusted infrastructure; container
mount separation does not isolate other container secrets from a compromised
Docker controller. The deployment contract gate protects against accidentally
adding socket access to an API, lifecycle Worker or another service.

API owns credential storage, authorization decisions and credential release.
This does not mean it is the only process holding secrets: the shared API
environment also supplies the signing/encryption keys and database credentials
to api-init, gc, mail-sender and the material Worker. Runtime shares the HMAC authorization key and
receives authorized MCP bearer tokens for HTTP connections. Worker receives the
internal API token, not the HMAC key through Compose. Narrowing those inherited
credentials is a separate design and test task, not a guarantee of the current
layout.

The API service drops all Linux capabilities and enables no-new-privileges.
It still runs as the image's default user and retains access to its mounted data
and configured credentials. This limits process privileges; it does not defend
all data against API compromise. The production override removes the API host
port and exposes the Web service on loopback for a reverse proxy.

The Docker gate verifies actual process capabilities, fresh-volume startup,
upload storage and Plugin lifecycle writes, then replaces the API container and
checks persistence. Only Runtime inspection of a synthetic Plugin is mocked in
that probe; filesystem operations, catalog validation and database locking run
normally. Runtime `main()` already resolves the general image with
the Docker Engine image-inspect API before binding its listener. The material
Worker separately inspects its processor image and runs an isolated specification
check before claiming platform tasks.
Compose starts Runtime directly; it has no shell/CLI image preflight. Direct Runtime startup with
a missing image fails before listening; this does not depend on the Compose
entrypoint. No duplicate entrypoint check is needed.

## Plugins

Superusers install a validated package directory through a bounded ZIP carrier.
Installation, workspace enablement, credential resolution, and AgentRun
activation are separate steps. A run freezes exact package identities and
digests; package changes do not mutate a running request.

Plugin Skills, CLI paths, MCP tools, and Hooks reuse Core's existing composition
and execution paths. They cannot own a second Agent loop or bypass workspace
authorization. An empty installed catalog remains a valid startup state.

## Indexed waiting relationships

Core derives one `RuntimeJobWaiter` per tool-call wait from the validated
checkpoint contract. PostgreSQL and SQLite persist these rows in the same
transaction as the checkpoint. A cascading checkpoint foreign key removes them
on consumption or session deletion. No hosted adapter reinterprets model output
to reconstruct waiting semantics.

The source-job index bounds notification lookup to related waiters. The primary
key `(checkpoint_id, tool_call_id)` supports global and within-checkpoint
continuation without loading checkpoint payloads. Both request paths use bounded
pages and yield cursors; pending delivery is acknowledged only after its final
page. Reconciliation is proportional to current waiting relationships, not
historical completed notifications. A full pass can span multiple control ticks.

These tables belong to the existing clean-slate schema v1. Existing databases
with an older structure fail validation; there is no automatic migration or
compatibility path. Isolated verification must bootstrap the current schema.

## Safe replacement of a lost execution


At the next real model-request safe point, Runtime may replace a lost sandbox
only when the latest in-process checkpoint is followed by exactly one closed
bash call and a committed unsuccessful, non-executed receipt. Host evidence must
prove failure before process dispatch, owned missing/stopped container state,
and a quiesced workspace snapshot whose activity epoch has not changed. Open or
parallel calls, external tools, successful receipts, semantic facts, unknown
generation, identity mismatch, and uncertain dispatch prevent replacement.

User commands, hooks, snapshot restoration, and mutating helpers invalidate the
host witness before dispatch. MCP command builders conservatively disable this
automatic recovery path because their later process spawn is not owned by the
snapshot boundary. Witnesses are never transferred between host instances.

The advanced checkpoint covers the already committed failed receipt. Its
reference and the old Execution's `lost` end record commit in one transaction
under the lifecycle lease. Runtime then stops before sending the next model
request and yields to the worker's durable retry deadline. A replacement loads
the advanced model state; it never dispatches the recorded call again.
Preparation attempts are reserved durably and share the configured five-attempt
budget across restarts. Uncertain outcomes remain failures, not replay requests.

## Hosted execution capacity

Hosted admission is owned by the API; Workspace is its tenant boundary. A
transaction-level PostgreSQL admission lock protects counts and insertion across
API replicas. Only initial queued rows enter the partial-index count. Runtime
stores immutable job-to-tenant bindings alongside scheduled lifecycle jobs, and
serializes capacity-check plus lease acquisition across replicas. Generic Core
job-store semantics are unchanged. Notifications remain hints: a listener checks
both due time and capacity, and periodic reconciliation repairs expired leases.

Runtime HTTP handlers have separate ordinary, listener and control semaphores.
The cancellation handler receives a store view backed entirely by the shared
control connection pool; no preflight read borrows ordinary capacity. Absolute
response deadlines propagate to connection checkout/connect and statement waits.
A timed-out blocking handler retains its permit until actual completion, so
timeouts cannot multiply in-flight work or imply rollback of uncertain writes.

## Docker management boundary

`runtime_server::docker_engine` owns the shared local socket transport for Engine
info, image/container inspection, filtered listing, create, start and removal.
The execution host still owns authorization, container identity, resource and
mount policy, workspace sentinels and recovery decisions. Processor batch
start/exit/output collection also uses this transport. Attached exec carries
commands, hooks, MCP stdio, filesystem helpers, snapshots and the persistent
generation RPC. The processor uses archive upload/download instead of file-copy
subprocesses. No production Runtime Docker CLI branch remains.

Creation uses a stable name within an attempt. Both successful and uncertain
responses are followed by inspection of the returned immutable ID or that same
name. Adoption requires the requested image, labels and every supplied security,
resource and mount field to match. The SDK request is checked for field loss
before transmission. An uncertain create is never blindly repeated by the
transport. Start checks state and never restarts an exited container. Removal
requires an owned immutable ID and confirms absence; only an Engine 404 counts
as absence. This transport does not retry user commands or change Runtime
checkpoint semantics.

Exec requests validate the expected run/execution labels and bind a container
ID before creating an exec ID. Argument vectors, environment, user and working
directory are sent as structured fields with TTY and privileged mode disabled.
Each exec is created/started once. Attached stdout and stderr use bounded byte
pipes; input and output advance concurrently. EOF requires a confirmed exec exit
code. A stream error or unconfirmed exit remains an unknown outcome, not success
or permission to replay. Confirmed sandbox removal wins over attach/inspect
errors when reporting cancellation. Closing an MCP/RPC attachment alone does not
claim remote cancellation; the execution host retains teardown responsibility.

MCP raw-line framing and size enforcement remain in the public MCP adapter's
generic bounded byte-stream transport. Workspace supplies Engine streams and
owns their lifecycle. Snapshot frame length, digest and generation checks are
unchanged. Processor archives accept only the declared regular output files,
reject links/traversal/duplicates, enforce byte budgets and validate transport
completion before outputs can be committed.

## Source dependency

Rust packages resolve the public Runtime through exact Git revision dependencies.
Compose builds fetch the same locked source without an adjacent checkout. Pin,
manifest, lockfile and example image-label revisions are checked together; npm
and Python remain local to this repository.

## Hosted authorization verification

The API owns current membership and resource access. Rust validates the signed
startup envelope at its own service boundary. Neither boundary trusts a digest
supplied by a caller without computing it from the strict authorization payload.
The two implementations retain shared signature vectors and rejection cases.

Within one verification, canonical payload hashing is reused for signature
verification. API consumers share the six-field run binding (run, workspace,
session, user, agent and model configuration), while keeping endpoint errors and
resource-specific checks. The existing endpoint scopes are:

| API consumer | Digest | Signature | Six-field binding | Additional checks retained |
| --- | --- | --- | --- | --- |
| Runtime scheduling/start payload | Yes | Receiver verifies | Yes | Current membership, thinking mode |
| Deferred input | Yes | Yes | Yes | Current membership, declared input, live owner/generation/hash and blob availability |
| Material access | Yes | MCP credential wrapper verifies | Wrapper/input resolver verifies | Current membership, processing specification and representation |
| Platform MCP credential | Yes | Yes | Yes | Token scope and lifetime |
| Model proxy | Yes | No | Yes | Current membership, model/thinking mode and output budgets |
| Artifact publication | Yes | No | Existing publication/resource binding | Current membership, scope, publication identity and bytes |
| Workspace snapshot commit | Yes | Yes | Yes | Job lease, active session and compare-and-swap generation |

This consolidation does not add signature requirements to existing API endpoints
or treat their service authentication as proof of resource access. Snapshot
commit still checks the locked lease and generation before and after object
storage I/O. File-mutation event persistence and Memory coordination remain
separate responsibilities.

Input batch resolvers live for one request. They reuse only a verified snapshot
of the signed authorization facts, invalidating it when payload, digest,
signature, key or expected digest changes. Membership, run identity, source access,
version and storage existence are checked on each input, including after an
earlier item succeeded. No authorization cache survives into another tool call.
