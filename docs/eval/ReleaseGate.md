# Workspace release gate

Run from the repository root. Any failure blocks release.

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
