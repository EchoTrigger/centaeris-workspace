"""Build and test API on fresh, uniquely named Compose volumes; never reuse a deployment."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
project = "centaeris-deploy-test-" + uuid.uuid4().hex[:12]
image = project + ":api"
values = {}
for line in (ROOT / ".env.example").read_text().splitlines():
    key, separator, value = line.partition("=")
    if separator and not key.startswith("#"):
        values[key] = value
values.update({
    "DJANGO_SECRET_KEY": "synthetic-deployment-test", "INTERNAL_API_TOKEN": "synthetic-token",
    "AGENT_RUN_AUTHORIZATION_SIGNING_KEY": "synthetic-signing-key",
    "CREDENTIAL_ENCRYPTION_KEY": "z5wA0vTzQGNG2LkVbNqnd3CPnGds4M8Xqy9lXgkqfZI=",
    "POSTGRES_PASSWORD": "synthetic-test-password", "BOOTSTRAP_SUPERADMIN_PASSWORD": "synthetic-test-password",
    "API_HOST_PORT": "0", "COMPOSE_PROJECT_NAME": project,
})
env = {k: v for k, v in os.environ.items() if k not in values}
env.update(CENTAERIS_WORKSPACE_REVISION="deployment-test", CENTAERIS_CORE_REVISION="deployment-test")

with tempfile.TemporaryDirectory(prefix=project) as temporary:
    root = Path(temporary)
    env_file = root / "synthetic.env"
    env_file.write_text("\n".join(f"{k}={v}" for k, v in values.items()), encoding="utf-8")
    override = root / "override.json"
    override.write_text(json.dumps({"services": {name: {"image": image} for name in ("api", "api-init")}}))
    compose = ["docker", "compose", "--project-name", project, "--env-file", str(env_file),
               "-f", str(ROOT / "docker-compose.yml"), "-f", str(override)]

    def run(*args):
        subprocess.run([*compose, *args], cwd=ROOT, env=env, check=True)

    try:
        run("build", "api")
        run("up", "--detach", "--no-build", "--wait", "--wait-timeout", "180", "api")
        run("exec", "-T", "api", "python", "/app/scripts/verify-api-deployment.py", "write")
        run("up", "--detach", "--no-build", "--no-deps", "--force-recreate", "--wait", "api")
        run("exec", "-T", "api", "python", "/app/scripts/verify-api-deployment.py", "read")
    finally:
        run("down", "--volumes", "--remove-orphans")
        subprocess.run(["docker", "image", "rm", image], check=True, capture_output=True)
print("API fresh-volume and container-replacement deployment smoke passed.")
