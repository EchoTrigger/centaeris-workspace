# Configuration

Copy `.env.example` to `.env` for local development. Empty required secrets
fail at startup; the example file intentionally contains no usable secret.

## Required secrets

| Variable | Purpose |
| --- | --- |
| `DJANGO_SECRET_KEY` | Django signing and security state |
| `INTERNAL_API_TOKEN` | API-to-Runtime and worker internal authentication |
| `AGENT_RUN_AUTHORIZATION_SIGNING_KEY` | Immutable AgentRun authorization signatures |
| `CREDENTIAL_ENCRYPTION_KEY` | Encryption of stored model and MCP credentials |
| `POSTGRES_PASSWORD` | PostgreSQL service authentication |
| `BOOTSTRAP_SUPERADMIN_PASSWORD` | Initial administrator bootstrap |

Do not reuse these values across environments. They must not enter Git, image
layers, browser responses, Session logs, Plugin packages, or test artifacts.

## Service addresses

The bundled Compose deployment owns internal service addresses: PostgreSQL is
`postgres:5432`, Redis is `redis:6379`, and API is `api:8000`. Both API and worker
Runtime URLs derive from `RUNTIME_PORT`. These internal addresses are not `.env`
knobs. `POSTGRES_DB`, `POSTGRES_USER`, published host ports, `API_BASE_URL`, and
`WEB_ORIGIN` remain deployment inputs.

Standalone processes still accept the application environment variables
`POSTGRES_HOST`, `POSTGRES_PORT`, `REDIS_URL`, `RUNTIME_URL`, and
`API_INTERNAL_URL`. External databases or custom network layouts require an
explicit Compose override updating every affected consumer; the bundled topology
gate does not certify those custom overrides. Production uses an external HTTPS
reverse proxy. Do not expose internal service tokens or database ports through it.

## Storage and concurrency

- Compose shares one storage-root anchor between API/GC configuration and their
  named-volume targets, and one Plugin-root anchor between API/init configuration
  and API/init/Runtime mounts. They are not independently configurable in `.env`.
  Standalone API processes still require `STORAGE_ROOT` and `PLUGIN_CATALOG_ROOT`.
- `STORAGE_STREAM_LANES` and `STORAGE_STREAM_CHUNK_BYTES` bound file streaming.
- `REDIS_BROWSER_MAX_CONNECTIONS` bounds browser streaming connections per API
  process.
- `API_WORKERS` must remain within the validated range.
- `REDIS_MAXMEMORY` bounds transient live state; Redis eviction does not delete
  PostgreSQL facts.

Invalid or unsafe budgets fail instead of falling back to an unbounded value.

## Execution and processing

`SANDBOX_MEMORY_BYTES`, `SANDBOX_CPU_MILLI`, `SANDBOX_PIDS_LIMIT`, and
`SANDBOX_DATA_TMPFS_BYTES` define the authorized AgentRun profile.
`OCI_RUNTIME` selects the configured container runtime.

Compose owns the processor image reference through one YAML anchor shared by
the build service and Runtime, just as it does for the general execution image.
`KNOWLEDGE_PROCESSOR_IMAGE` is not a Compose `.env` input. Both images are required
services and must be built before Runtime starts.

`KNOWLEDGE_PROCESSOR_DEVICE` is exactly `cpu` or `gpu:0`. One value configures
both the build and Runtime. The Dockerfile derives the installation extra from
that device (`cpu` or `gpu`); do not supply a separate `PROCESSOR_EXTRA`.
The shared `local` image tag deliberately does not encode `gpu:0`. Rebuild after
a device change. GPU deployment additionally requires compatible host hardware
and drivers, and a Compose override granting exactly one visible GPU to the
processor spec service. Configuration checks alone are not a GPU execution
certification.
The Docker release gate compares actual built/runtime image IDs and the image's
embedded device, so an existing stale image cannot satisfy the check.

## Email

Password-reset mail is disabled unless `PASSWORD_RESET_ENABLED=1` and the
separate mail-sender service has valid SMTP configuration. The API process does
not silently send mail through an unconfigured backend.

## Production review

Before deployment, set `DJANGO_DEBUG=0`, use explicit allowed hosts and web
origin, rotate all example values, verify HTTPS termination, and render the
complete Compose configuration with:

```powershell
docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml config
```
