# Workspace release gate

Run from the repository root. Any failure blocks release.

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

The local gate includes `pwsh -NoProfile -File
scripts/agent-run-authorization-gate.ps1`. It checks the shared authorization
fixture and boundary corpus in Python and Rust, then verifies Python-generated
synthetic signatures in Rust. It requires a non-empty artifact and a Rust
consumption receipt; consumer failures block the gate. Vector tests use no
services, real Plugin content, or developer keys. Resource-builder tests isolate
asset and Plugin lookup while retaining production construction and validation.

The local gate also runs `scripts/deployment-contract.test.py` against rendered
Compose configuration with synthetic inputs. It covers processor build/Runtime
identity, device mapping, Runtime port propagation, volume-path agreement,
internal addresses, API security options, and exclusive Runtime socket access.
It needs the Docker Compose CLI, but not a running deployment.

The Docker fresh-start gate additionally verifies that Runtime references resolve
to the built processor/general image IDs and that processor device metadata
matches. It checks the API's actual capability sets and no-new-privileges, writes
synthetic upload and Plugin data, replaces the API container, and verifies reads
and removal. For a bounded local API-only reproduction, run
`uv run --frozen --package api python scripts/deployment-api-smoke.py`.
This uses a unique Compose project, fresh volumes and synthetic secrets, and
removes its containers, volumes and temporary API image after testing. Do not run
the full Docker release script on a host containing an existing deployment; its
disposable-host guard remains mandatory.

The local browser gate requires Playwright Chromium (`npx playwright install
chromium` once after installing dependencies). The local gate includes synthetic
Plugin isolation coverage: partial MCP/Hook failures, Runtime outages, recovery
actions, independent credentials, strict enablement, and stale inspection
responses.
The browser gate runs the complete Web suite, including context-panel clipping,
current status placement, streaming Markdown stability, tool disclosures across
updates and virtualized row recycling, attachment cards, and chat/settings route
continuity. Authentication, membership changes, and direct settings URLs remain
covered. It uses synthetic events and isolated API fixtures without model calls.

1. `pwsh -File scripts/ci.ps1`
2. `node scripts/performance-eval.mjs`; review the independent phase report in
   [PerformanceEvaluation.md](PerformanceEvaluation.md). The 4,095-observation
   storage-growth tests are intentionally excluded from the normal test suite;
   this command runs each one exactly once. The checked-in `Performance`
   workflow runs it for relevant pull requests and `main` changes, and supports
   an explicit manual run.
3. Populate a private `.env`, then run `docker compose config --quiet`.
4. On fresh Postgres, migrate from zero and confirm the Workspace app starts at
   its new `0001_initial`.
5. Build Runtime, API, worker, web, and execution images from root Compose
   contexts; verify health with an empty extension volume.
6. `docker compose config` must resolve project `centaeris-workspace` and only
   `centaeris-workspace_*` named volumes.

Gates must not read production data, real Plugin content, or developer secrets.
Sibling Rust paths must become exact Git revisions before distribution.

CI and Performance use the shared `Resolve public Core revision` workflow.
At the start of each workflow run it resolves the public Core `main` once;
all dependent jobs check out that full SHA. The run summary records a link to
the resolved commit, and Docker image labels retain the same SHA. A missing or
unavailable ref stops resolution without a fallback. Separate runs (including
full reruns) may resolve different Core revisions as `main` advances.

The local gate tests strict resolution, output recording, and public fetchability
with `node --test scripts/core-revision.test.mjs`; this requires network access.
In GitHub Actions, the live smoke test is skipped because the shared resolver
and downstream checkouts exercise it; unit tests run without resolving main again.
Local Rust checks still use the sibling Core checkout. To reproduce a CI run,
check out the Core SHA recorded in that run alongside the tested Workspace SHA.

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

The local gate also checks document streaming beyond 1000 PDF pages/image
frames, UTF-8 locations, bounded incremental output, and API manifest validation.
These are synthetic/native-parser checks; they do not replace user acceptance
with real Office documents or real OCR model measurements.
