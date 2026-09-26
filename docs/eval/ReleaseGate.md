# Workspace release gate

Run from the repository root. Any failure blocks release.

Sandbox-loss recovery requires an isolated-stack behavioral gate before release:
verify a pre-dispatch loss resumes from the advanced checkpoint with a new tool
call ID; the original failed call remains exactly once. Verify the recovery
checkpoint and old Execution end commit together, stale leases write neither,
and preparation failures/restarts retain the five-attempt budget. Post-dispatch
uncertainty, parallel/external tools, changed snapshot activity, deferred MCP
spawn, and foreign container identity must not trigger automatic replacement.
When concurrent child activity invalidates snapshot collection, the parent must
continue to its next model request without a new recovery checkpoint or reusable
snapshot witness. The safe-point commit and tool ledger remain intact; collection
errors still fail and foreign host evidence stays rejected. Verify that the parent
can reach durable waiting before injecting sandbox loss.
Compilation alone does not satisfy these checks.

Waiter-index acceptance must cover both PostgreSQL and SQLite: atomic index
creation and rollback, cascading removal on checkpoint consumption, targeted
source lookup, and more than 256 relationships inside one checkpoint. Worker
coverage must show cursor preservation after transient failures and no outbox
acknowledgement while `next` is non-null. Under load, unrelated historical rows
must not increase a source notification's lookup work; measure bounded pages
separately from the complete reconciliation pass.

Terminal waiter acceptance must reproduce sandbox loss while waiting for a runtime
job, followed by source completion and an unrecoverable parent failure. The
terminal session append must atomically write the Core `abandoned` event and
consume the checkpoint and waiter index. Cover completed, failed and cancelled
owners, rejected stale leases, transaction rollback on conflicting events, and
idempotent repair through the cancellation API for an already-terminal owner.
A live owner must not be consumed. Direct test-database cleanup is fixture
management only and cannot count as lifecycle acceptance. Record zero remaining
waiters before any manual cleanup, with no replayed tools or fabricated results.

The portable `python scripts/ci.py` gate runs `scripts/runtime_outbox_gate.py` in the API dependency
environment. It uses only `TEST_POSTGRES_*`, creates a random disposable database,
checks non-empty Rust test discovery, runs the PostgreSQL outbox regressions, and
drops only that database. Coverage includes acknowledged-history stability,
unacknowledged delivery across restart, duplicate/stale acknowledgement, active
wakes across yield, and concurrent late-waiter recovery across checkpoint pages.
The same disposable-database gate runs the PostgreSQL shared waiter contract and
cross-replica execution-capacity test. It pins execution limits to 8 global and 4
per tenant for that fixture. The controller's database-isolation and non-empty
discovery guard tests run before creating the disposable database.

The Python gate uses package-wide `test*.py` discovery, not a hand-maintained
list of API test labels. `scripts/python_test_gate.py api` runs Django's full
discovery against PostgreSQL, including transactional/locking behavior. The
`worker` and `document_processor` modes discover their respective packages in
their existing dependency environments. New tests must follow unittest/Django
discovery conventions (including importable package directories). Each run
reports discovered/executed counts and fails on an empty suite, duplicate IDs,
discovery/execution mismatch, import errors, skips, or expected failures.
`scripts/python_test_gate.py gate` exercises the guard's failure paths.

For local API tests, start the dedicated test PostgreSQL service; defaults are
`localhost:55432`, database/user/password `centaeris`. Override only with
`TEST_POSTGRES_HOST`, `TEST_POSTGRES_PORT`, `TEST_POSTGRES_DB`,
`TEST_POSTGRES_USER`, and `TEST_POSTGRES_PASSWORD` for another test instance.
The role needs permission to create databases. The runner uses a random test
database and temporary storage, cleans them after the run, and points unmocked
Runtime/Redis calls at a closed loopback port. It does not use deployed database
settings. CI provisions its own PostgreSQL 18 service. SQLite migration/drift
checks and the independent Python-to-Rust authorization gate remain in place.

The local gate includes `python scripts/agent-run-authorization-gate.py`. It checks the shared authorization
fixture and boundary corpus in Python and Rust, then verifies Python-generated
synthetic signatures in Rust. It requires a non-empty artifact and a Rust
consumption receipt; consumer failures block the gate. Vector tests use no
services, real Plugin content, or developer keys. Resource-builder tests isolate
asset and Plugin lookup while retaining production construction and validation.

The local gate also runs `scripts/deployment-contract.test.py` against rendered
Compose configuration with synthetic inputs. It covers processor build/material-Worker
identity, device mapping, Runtime port propagation, volume-path agreement,
internal addresses, API security options, and Docker socket access restricted to Runtime and the material Worker.
It needs the Docker Compose CLI, but not a running deployment.

The Docker fresh-start gate additionally verifies that the material Worker and Runtime reference
the built processor and general image IDs respectively and that processor device metadata
matches. It checks the API's actual capability sets and no-new-privileges, writes
synthetic upload and Plugin data, replaces the API container, and verifies reads
and removal. For a bounded local API-only reproduction, run
`uv run --frozen --package api python scripts/deployment-api-smoke.py`.
This uses a unique Compose project, fresh volumes and synthetic secrets, and
removes its containers, volumes and temporary API image after testing. Do not run
the full Docker release script on a host containing an existing deployment; its
disposable-host guard remains mandatory.

The local gate retains Web unit and contract tests. Playwright/E2E and visual
snapshot tests are not part of the repository; browser layout, interaction,
authentication, membership, and direct-route acceptance are verified manually.
GitHub Actions passes `-SkipFrontendTests`, so its Web portion is limited to
dependency installation, lint, typecheck, and production build. Backend,
Runtime, protocol, security, deployment, and performance gates remain automated.
Use [FrontendManualAcceptance.md](FrontendManualAcceptance.md) for the retained
browser interaction, authorization-UI, and appearance checks.

Hosted command acceptance tests must cover a committed-but-lost response,
concurrent identical submissions, retries after completion, changed input under
the same operation identity, authorization revocation and deleted resources,
upload content identity, transaction rollback, and scheduling failure. The
forward migration preserves existing business rows without fabricating old
receipts. Browser tests retain the operation identity across uncertain responses
and reloads, and distinguish receipt recovery from downstream projection or
material-link failures.

1. `python scripts/ci.py`
2. `node scripts/performance-eval.mjs`; review the independent phase report in
   [PerformanceEvaluation.md](PerformanceEvaluation.md). The 4,095-observation
   storage-growth tests are intentionally excluded from the normal test suite;
   this command runs each one exactly once. The checked-in `Performance`
   workflow runs it for relevant pull requests and `main` changes, and supports
   an explicit manual run.
3. Populate a private `.env`, then run `docker compose config --quiet`.
4. On fresh Postgres, migrate from zero through
   `0005_hosted_operation_receipt` and confirm the Workspace app starts
   from the current migration leaf. Existing credentials must retain their encrypted
   values and remain unconfigured until assigned an explicit quota domain.
5. Build Runtime, API, worker, web, and execution images from root Compose
   contexts; verify health with an empty extension volume.
6. `docker compose config` must resolve project `centaeris-workspace` and only
   `centaeris-workspace_*` named volumes.

Gates must not read production data, real Plugin content, or developer secrets.

Execution-capacity acceptance uses a fresh isolated database with the current
initial schema. Across independent API/Runtime/worker replicas, verify initial
queue limits (128 global, 32 per Workspace) and execution leases (8 global, 4 per
Workspace), concurrent submissions/claims, immutable tenant binding, and rollback
on rejected admission. Yield, terminal transitions and reconciled expiry must
release capacity; at saturation, job waits must not spin on unclaimable work.
Expired initial queues must request cancellation at the first-start gate; user
questions, runtime-job waits and recovery backoff must remain unaffected.

Fill ordinary HTTP and database capacity, then exercise cancellation preflight,
cancellation writes, heartbeat and job-status reads through control capacity.
Fill listeners independently. Check 503 plus Retry-After, body/handler deadlines,
and that timed-out blocking work retains its permit until exit. Long AgentRun
steps must not inherit the short-request deadline. Material processing runs in its
dedicated Worker with a bounded processing deadline, outside Runtime HTTP.
These are acceptance requirements, not a claim that an isolated run was executed.
Rust dependencies use exact public Git revisions in Cargo.toml and Cargo.lock.

CI and Performance use the shared pinned Core revision from `core-revision.txt`;
all dependent jobs resolve that full public SHA through Cargo. The run summary records a
link to it, and Docker image labels retain the same SHA. Source gates verify Cargo metadata and reject local patches; the Docker gate verifies manifest/lock/example pin parity. Core
`main` advancing does not silently change Workspace builds.

The local gate tests strict pin parsing, output recording, and public fetchability
with `node --test scripts/core-revision.test.mjs`; this requires network access.
In GitHub Actions, the live smoke test is skipped because the downstream
checkouts exercise it. To reproduce a CI run, check out the pinned Core SHA
through Cargo from the tested Workspace SHA.

The checked-in CI workflow runs the source, browser, and Compose gates from a
clean checkout. Required status checks must be enabled on the public `main`
branch before external pull requests are accepted.

The root license, first-party Rust/npm/Python package metadata, README, and
contribution policy must consistently identify `AGPL-3.0-only`. Third-party and
brand-asset exceptions remain explicit. The README, contribution guide, and issue
template must consistently describe the temporary restriction on external works.
Pull request creation is limited to collaborators. Any future reopening of
external contributions requires the published contributor agreement and explicit
contributor acceptance described in the contribution guide.
Every distributed image or application must identify the AGPL license and the
complete corresponding source for its exact released revision. A modified
network-interactive deployment must offer that corresponding source to users
interacting with it remotely, as required by AGPL section 13.

Docker management transport acceptance requires both source/build checks and
an isolated daemon gate. Source checks cover request field preservation, sandbox
limits/mount isolation, processor CPU/GPU configuration, and structured missing
container errors. Production management, exec and archive operations must have
no Docker CLI branch, and the Runtime image must not copy a Docker CLI binary.
Check rendered Compose entrypoint/command as well as the image. With a missing
processor image, material Worker startup must fail through Engine inspection;
Runtime must not contain a processor preflight or processing route. No external entrypoint override may be used for acceptance.
Verify both explicit and omitted false for Mount.ReadOnly after create and start;
a required read-only mount must still reject omission/false, and mismatched
volume identity/subpath and missing security fields must still fail.

The isolated daemon gate must exercise root preparation/sentinel verification,
processor specification and document processing, nonzero batch exit/output,
resource/security/mount inspection, owned-ID cleanup, and a lost create/start
response. Unknown outcomes must not cause duplicate creation or process restart;
foreign containers and daemon failures must not be treated as missing containers.
The Debian/production-Engine gate also covers binary/interleaved exec output,
nonzero exit and missing exit confirmation, stdin EOF, 8 MiB output truncation,
confirmed cancellation versus unknown transport failure, and no command replay
after an exec-start response is lost. Verify MCP discovery/line limits/close,
persistent generation RPC reuse, snapshot upload/restore hashes, and processor
archive traversal/link/size rejection plus large-file streaming. Run these on
an isolated stack with the CLI-free Runtime image; host-side probes may use CLI.
Compilation alone does not satisfy this behavior gate. No throughput or latency
improvement is certified without a separately recorded measurement.

The local gate also checks document streaming beyond 1000 PDF pages/image
frames, UTF-8 locations, bounded incremental output, and API manifest validation.
These are synthetic/native-parser checks; they do not replace user acceptance
with real Office documents or real OCR model measurements.

## Authorization consolidation acceptance (2026-09-15)

`scripts/ci.ps1 -SkipFrontendTests` passed against a dedicated disposable local
PostgreSQL container: 467 API tests executed with no skips or expected failures,
Rust workspace checks/tests and PostgreSQL outbox gates, 14 Python-signed Rust
verification vectors, deployment contracts, migrations, worker/processor tests,
MCP client checks, Web production build and Compose structure. Frontend unit tests
were not rerun for this backend change. Core's focused `query_loop` also passed.

The 27 focused Python tests include digest/signature/binding rejection order,
per-input membership and generation checks, in-place authorization tampering,
blob disappearance and request-local digest reuse. Rust startup rejection order
is characterized separately. No real runsc isolation claim is derived from these
checks. The temporary PostgreSQL container and its volume were removed.

An additional `cargo clippy --workspace --all-targets --locked -- -D warnings`
run remains blocked by two unchanged `main.rs` findings: `too_many_arguments` in
`terminalize_agent_run_failure`, and `collapsible_match` in the live reasoning
handler. They were not suppressed or mixed into this authorization change.
The Rust toolchain and both pinned Rust build images now use 1.95.0 to match Core.
