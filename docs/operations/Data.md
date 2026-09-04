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

## File identity

Database rows identify and authorize files; bytes remain in Storage. A complete
backup therefore includes PostgreSQL and every persistent file volume. Backing
up only one side can leave valid metadata without bytes or unowned bytes without
metadata.

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
