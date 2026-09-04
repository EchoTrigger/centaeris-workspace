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

Workspace, Agent, and Session creation generates `ws_`, `agent_`, and `session_`
identifiers followed by 16 case-sensitive Base64url characters (`A-Z`, `a-z`,
`0-9`, `-`, `_`), encoding 12 cryptographically random bytes without padding.
Other resource identifiers retain their own generation rules. Resource IDs are
opaque, immutable references: clients must not split, lowercase, or reinterpret
them. Creating these resources through the ORM retries generated primary-key
collisions up to three total attempts; explicit IDs and other integrity errors
fail. Possession of an ID does not grant access: ownership and workspace
membership checks still apply.

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
