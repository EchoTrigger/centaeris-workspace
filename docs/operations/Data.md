# Data and recovery

## Persistent stores

| Store | Contents |
| --- | --- |
| `postgres-data` | Identity, membership, ACL, AgentRun, durable jobs, Runtime facts, and file metadata |
| `storage-data` | Original files and API-owned stored objects |
| `runtime-data` | Runtime-private durable state and generated runtime files |
| `plugin-data` | Installed Plugin directories and catalog |
| `agent-memory` | Agent memory files owned by the hosted memory boundary |

Redis carries bounded transient browser and Runtime live state. Its loss can
interrupt a live connection but must not erase durable history or jobs.

## Command receipts

Hosted command receipts retain their request digest and accepted result IDs in
PostgreSQL. They do not store prompts, uploaded bytes, or credentials. Their
deduplication identity does not expire by time in v1, and deleting a Session or
Run must not remove that identity and turn a replay into a new command. Permanent
deletion of the owning user or Workspace may remove its scoped receipts; those
scope identities must never be reused.

The forward migration adds receipt storage without inventing receipts for
historical Sessions or Runs. API clients must send the new required operation
identity when the server is upgraded. Backups and restores include receipts
with business rows; restoring only one side loses the acceptance guarantee.

## File identity

Database rows identify and authorize files; bytes remain in Storage. A complete
backup therefore includes PostgreSQL and every persistent file volume. Backing
up only one side can leave valid metadata without bytes or unowned bytes without
metadata.

Library and session file uploads reuse the earliest ready library object with
the same SHA-256 for the same user, regardless of filename or folder. Reuse
preserves its name and location and cleans up the newly uploaded storage copy.
Other users and deleted objects are excluded. Different content with a conflicting
name in the target folder receives `(1)`, `(2)`, etc. before the extension.
This does not merge historical duplicates or change manual note/artifact workflows.

Historical tool spill references containing only a workspace path and byte
range cannot prove the original output. The transcript content API returns
`transcript_content_unavailable` for them, including records written before the
fix. This reader policy needs no database migration and does not rewrite or
delete Session events, snapshots, or published artifacts. It does not backfill
old references from current workspace bytes. Committed previews are retained,
and complete inline output remains readable subject to current authorization. Restoring the
old snapshot reader would reintroduce incorrect historical content; reverting
code is not a content-recovery procedure. Full-output retention requires a
separate immutable capture contract.

## Trash and deletion

Supported product objects use a 30-day trash lifecycle where defined by their
model. The server-side `gc` service reclaims objects after the durable deadline.
Removing a browser row, Redis key, container, or local cache does not perform
permanent deletion.

Plugin uninstall and credential deletion follow separate lifecycle and audit
rules. A running AgentRun keeps its frozen activation and must finish or stop
before required package bytes are removed.

## Backup

Take a consistent PostgreSQL backup and snapshot persistent volumes while
writes are stopped or through a tested coordinated snapshot mechanism. Record
the source revision, migration state, image identities, and volume set with the
backup. Do not copy secrets into a public test report.

## Restore

Restore into an isolated environment first. Use the exact source and image
revision compatible with the backup, restore PostgreSQL and file volumes, then
run read-only integrity checks before accepting new work. A restore drill must
verify login, Session history, file download, Plugin catalog, and one Runtime
request without production model credentials.

No current command promises point-in-time recovery or cross-version downgrade.
Those claims require a dedicated tested implementation.
