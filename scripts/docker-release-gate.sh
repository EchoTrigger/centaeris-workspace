#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${CENTAERIS_CI_DESTRUCTIVE_DOCKER:-}" != "1" ]]; then
  echo "docker release gate requires an explicitly disposable CI Docker host" >&2
  exit 64
fi

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
core_root="$(cd "$workspace_root/../centaeris" && pwd)"
cd "$workspace_root"

: "${CENTAERIS_WORKSPACE_REVISION:?CENTAERIS_WORKSPACE_REVISION is required}"
: "${CENTAERIS_CORE_REVISION:?CENTAERIS_CORE_REVISION is required}"

if docker ps -aq --filter label=com.docker.compose.project=centaeris-workspace | grep -q .; then
  echo "refusing to reuse an existing centaeris-workspace Compose project" >&2
  exit 65
fi
if docker volume ls -q | grep -q '^centaeris-workspace_'; then
  echo "refusing to reuse existing centaeris-workspace volumes" >&2
  exit 65
fi

env_file="$(mktemp)"
compose=(docker compose --env-file "$env_file")

cleanup() {
  status=$?
  set +e
  if [[ $status -ne 0 ]]; then
    "${compose[@]}" ps
    "${compose[@]}" logs --no-color --tail=200
  fi
  "${compose[@]}" down --volumes --remove-orphans
  rm -f "$env_file"
  exit "$status"
}
trap cleanup EXIT

python3 - "$workspace_root/.env.example" "$env_file" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
target = Path(sys.argv[2])
values = {
    "DJANGO_SECRET_KEY": "ci-only-django-secret-key",
    "INTERNAL_API_TOKEN": "ci-only-internal-api-token",
    "AGENT_RUN_AUTHORIZATION_SIGNING_KEY": "ci-only-agent-run-signing-key",
    "CREDENTIAL_ENCRYPTION_KEY": "z5wA0vTzQGNG2LkVbNqnd3CPnGds4M8Xqy9lXgkqfZI=",
    "POSTGRES_PASSWORD": "ci-only-postgres-password",
    "BOOTSTRAP_SUPERADMIN_PASSWORD": "ci-only-bootstrap-password",
}
rendered = []
for line in source:
    key, separator, value = line.partition("=")
    if separator and key in values:
        line = f"{key}={values[key]}"
    rendered.append(line)
target.write_text("\n".join(rendered) + "\n", encoding="utf-8")
PY

"${compose[@]}" config --quiet
"${compose[@]}" config --format json | WORKSPACE_ROOT="$workspace_root" CORE_ROOT="$core_root" python3 -c '
import json, os, pathlib, sys
config = json.load(sys.stdin)
assert config["name"] == "centaeris-workspace"
required_builds = {"api", "document-processor", "runtime", "web", "worker", "workspace-general"}
assert required_builds <= {name for name, service in config["services"].items() if "build" in service}
for service_name in ("document-processor", "workspace-general"):
    service = config["services"][service_name]
    assert not service.get("profiles")
    assert service_name in config["services"]["runtime"]["depends_on"]
workspace = pathlib.Path(os.environ["WORKSPACE_ROOT"]).resolve()
core = pathlib.Path(os.environ["CORE_ROOT"]).resolve()
for name in required_builds:
    assert pathlib.Path(config["services"][name]["build"]["context"]).resolve() == workspace
for name in ("runtime", "workspace-general"):
    contexts = config["services"][name]["build"]["additional_contexts"]
    assert pathlib.Path(contexts["centaeris"]).resolve() == core
expected_volumes = {"agent-memory", "plugin-data", "postgres-data", "runtime-data", "storage-data"}
assert set(config["volumes"]) == expected_volumes
for key, value in config["volumes"].items():
    assert value["name"] == f"centaeris-workspace_{key}"
'

"${compose[@]}" build --pull document-processor workspace-general runtime api worker web
"${compose[@]}" up -d --wait --wait-timeout 420 postgres redis api runtime worker web

for service in postgres redis api runtime worker web; do
  "${compose[@]}" ps --status running --services | grep -Fx "$service" >/dev/null
done

"${compose[@]}" exec -T api python manage.py showmigrations app_core | grep -Eq '^[[:space:]]*\[X\][[:space:]]+0001_initial$'
"${compose[@]}" exec -T api python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5).read()"
"${compose[@]}" exec -T web wget -qO- http://127.0.0.1:3000/ >/dev/null

for service in document-processor workspace-general runtime api worker web; do
  image_id="$("${compose[@]}" images -q "$service" | head -n 1)"
  test -n "$image_id"
  test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.licenses" }}' "$image_id")" = "AGPL-3.0-only"
  test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image_id")" = "$CENTAERIS_WORKSPACE_REVISION"
  test "$(docker image inspect --format '{{ index .Config.Labels "io.centaeris.core.revision" }}' "$image_id")" = "$CENTAERIS_CORE_REVISION"
  docker run --rm --entrypoint /bin/sh "$image_id" -ec 'test -f /usr/share/licenses/centaeris-workspace/LICENSE'
done

echo "Workspace Docker fresh-start gate passed."
