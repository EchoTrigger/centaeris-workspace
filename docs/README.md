# Workspace documentation

This index separates product architecture, transport, operations, security
boundaries, and release verification.

## Architecture and reference

- [Architecture](architecture/Architecture.md): component ownership and request
  flow.
- [API](reference/API.md): REST, SSE, and internal service contracts.
- [Configuration](reference/Configuration.md): environment variables and secret
  boundaries.

## Operations

- [Deployment](operations/Deployment.md): build, initialization, health, update,
  and production topology.
- [Data](operations/Data.md): volumes, persistence, deletion, backup, and
  recovery boundaries.
- [Plugins](operations/Plugins.md): ZIP upload through uninstall.
- [Document processing](operations/DocumentProcessing.md): required images,
  bounded streaming, and current measurement limits.

## Security and release

- [Security model](security/Model.md): trust boundaries, credentials, execution,
  and Plugin risk.
- [Release gate](eval/ReleaseGate.md): required source and deployment checks.
- [Performance evaluation](eval/PerformanceEvaluation.md): reproducible measurement
  definitions without local run receipts.
- [Third-party notices](../THIRD_PARTY_NOTICES.md): bundled font licenses.

Runtime semantics remain in the external public Runtime Framework and are not
copied into Workspace documentation.
