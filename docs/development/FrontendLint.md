# Frontend lint policy

The Web lint gate distinguishes deterministic defects from audit signals. Hook
dependency diagnostics are investigation leads, not instructions to rewrite
dependency arrays.

## Blocking rules

Unreachable code, Hooks called outside the top level, debugger statements,
duplicate object keys, duplicate parameters, and explicit `any` annotations are
errors.

## Audit rules

Unused imports and variables and exhaustive Hook dependencies are warnings.
They remain visible in `npm run lint` but do not block the local build. Use
`npm run lint:hooks` and `npm run lint:unused` to inspect one category. The Web
package scripts delegate to the repository root so every invocation uses the
shared root configuration.

Never apply unsafe lint fixes to dependency arrays. A production Hook change
requires a focused failing test for the suspected stale closure, missed reload,
duplicate listener, connection churn, or rendering regression. Dependencies
used intentionally as change triggers remain until a test proves otherwise.

## Current audit inventory (2026-09-04)

### Completed unused cleanup

- Removed the unused file-preview catch binding from `AppRoute.jsx`.
- Removed the unused `selectedItem` binding from `LibraryRoute.jsx`.
- Removed the unused `Trash2` import from `ModelSettings.jsx`.

`npm run lint:unused` reports no remaining findings in this repository.

### Core chat type-checking

Compiler inspection corrected one part of the original finding: with
`allowJs: true`, `include: ["src"]` does collect `.mjs` files. Their function
bodies are nevertheless not checked while `checkJs` is false. A diagnostic run
with `checkJs` enabled found 155 strict diagnostics in the four original core
chat modules, so enabling it globally is not a safe one-line change.

The focused migration keeps the normal TypeScript gate green:

- `sessionEvents.ts`, `chatViewStore.ts`, `workspaceChatController.ts`, and
  `workspaceWebTransport.ts` are now strict TypeScript;
- their stream boundary uses explicit `StreamEntry` types and `unknown` for
  unvalidated event payloads;
- explicit `any` is a blocking lint diagnostic with a configuration test;
- a configuration test requires all four core implementations to remain `.ts`
  and keeps `strict` plus `noEmit` enabled.

Each conversion must preserve the existing unit and browser behavior tests. Do
not weaken strictness or introduce explicit `any` when adjacent chat modules are
migrated later. The original four-module core type-checking gap is now closed.

### Intentional-trigger candidates

The following warnings currently look like values used to trigger reset or
refresh behavior. Do not remove them mechanically:

- `AgentRunRow.jsx:145`: timer baseline changes with `startedAtMs`.
- `VirtualAgentRunList.tsx:184`, `:192`: session reset and streamed-size follow mode.
- `router.tsx:106`: navigation clears session-expiry state.
- `AppRoute.jsx:226`, `:256`, `:294`: model identity/version and requested project transitions.
- `LibraryRoute.jsx:153`: view changes reset local selection state.
- `PluginSettings.jsx:84`: credential revisions reload plugin state.
- `SearchOverlay.jsx:71`: query/result changes reset keyboard selection.
- `ShellSidebar.jsx:284`: navigation refreshes route-sensitive library notes.

### Test-first investigation results

| Priority | Locations | Evidence | Result |
| --- | --- | --- | --- |
| 1 | `AgentRunRow.jsx:195` | The existing browser telemetry test observes the streamed DOM before accepting the metric; the store unit test also requires the matching stream render revision and a paint boundary. | No stale DOM-commit telemetry reproduced. `agentRun` identity changes without a stream revision do not create pending telemetry. |
| 1 | `AppRoute.jsx:276` | The reference-preview browser test counts global keydown subscriptions, resizes the open panel, closes it with Escape, and checks one add/one remove. | The callback remains current and the listener is not re-registered on an unrelated render. |
| 1 | `AppRoute.jsx:294` | The project browser test switches between two `projectId` values while `new=1` stays constant, checks that drafts clear, and counts one sessions/projects load per transition. A separate test checks that an initially unread session is patched exactly once across later renders. | Project changes and read-state updates are correct; adding every captured function to the dependency list would risk redundant work without fixing a demonstrated defect. |
| 1 | `AppRoute.jsx:354` | The existing retained-chat browser test checks one stream connection, zero aborts, preserved DOM identity, and delivery while unrelated settings/navigation state changes. | No stale callback or reconnect churn reproduced. |
| 2 | `LibraryObjectRoute.jsx:91` | The note browser test counts object and note reads across sidebar and rename-state rerenders. | One object read and one note read; no loop or missed load. |
| 2 | `LibraryRoute.jsx:149` | A folder browser test measures relative request counts across root-to-folder navigation, selection-only rerenders, and return navigation. | Each folder input change loads once; selection changes do not reload. The root list and sidebar are separate legitimate consumers. |
| 2 | `ModelSettings.jsx:108` | The managed-provider browser test counts all three initial admin catalog reads across picker open/close rerenders. | Each endpoint loads once; no render-triggered request loop. |

No production failure was reproduced for these seven investigation groups, so
no Hook implementation was changed. The remaining exhaustive-dependency
warnings stay as audit signals rather than being silenced with unsafe rewrites.
Multiple diagnostics on one Hook should continue to be resolved by one
behavioral characterization, not by one edit per warning.
