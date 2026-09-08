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

Only Runtime mounts the Docker socket in the bundled Compose configuration.
That socket makes Runtime part of the host's trusted infrastructure; container
mount separation does not isolate other container secrets from a compromised
Docker controller. The deployment contract gate protects against accidentally
adding socket access to another service.

API owns credential storage, authorization decisions and credential release.
This does not mean it is the only process holding secrets: the shared API
environment also supplies the signing/encryption keys and database credentials
to api-init, gc and mail-sender. Runtime shares the HMAC authorization key and
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
the Docker Engine image-inspect API before binding its listener. The processor
image receives the same presence check without starting a processor container.
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

Rust packages currently resolve the public Runtime through explicit development
paths. Compose accepts the same source through a named build context. A release
must materialize one exact Runtime revision for both build paths; npm and Python
remain local to this repository.
