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
`docker image inspect` before binding its listener. Direct Runtime startup with
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

## Source dependency

Rust packages currently resolve the public Runtime through explicit development
paths. Compose accepts the same source through a named build context. A release
must materialize one exact Runtime revision for both build paths; npm and Python
remain local to this repository.
