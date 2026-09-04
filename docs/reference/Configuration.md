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

`POSTGRES_*`, `REDIS_URL`, `RUNTIME_URL`, `API_INTERNAL_URL`, `API_BASE_URL`, and
`WEB_ORIGIN` describe service connectivity and browser origin. Production uses
internal container addresses plus one external HTTPS reverse proxy. Do not
expose internal service tokens or database ports through that proxy.

## Storage and concurrency

- `STORAGE_ROOT` selects the API file-storage root.
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

`KNOWLEDGE_PROCESSOR_IMAGE` and `KNOWLEDGE_PROCESSOR_DEVICE` must describe the
image actually built and available to Runtime. The processor and general
execution images are required services.

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
