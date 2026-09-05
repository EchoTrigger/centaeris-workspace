"""Compose contract regressions using rendered configuration and synthetic values."""
import json
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RETIRED = {
    "KNOWLEDGE_PROCESSOR_IMAGE", "RUNTIME_URL", "API_INTERNAL_URL", "REDIS_URL",
    "POSTGRES_HOST", "POSTGRES_PORT", "STORAGE_ROOT", "PLUGIN_CATALOG_ROOT",
}


def compose_config(**overrides):
    values = {}
    for line in (ROOT / ".env.example").read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator and not key.startswith("#"):
            values[key] = value or "synthetic-test-only"
    values.update(overrides)
    env = {k: v for k, v in os.environ.items() if k not in values and k not in RETIRED}
    with tempfile.TemporaryDirectory(prefix="centaeris-compose-contract-") as temp:
        path = Path(temp) / "synthetic.env"
        path.write_text("\n".join(f"{k}={v}" for k, v in values.items()), encoding="utf-8")
        result = subprocess.run(
            ["docker", "compose", "--env-file", str(path), "-f", str(ROOT / "docker-compose.yml"),
             "config", "--format", "json"],
            cwd=ROOT, env=env, capture_output=True, text=True, check=True,
        )
    return json.loads(result.stdout)


class DeploymentContractTests(unittest.TestCase):
    def test_processor_build_extra_follows_exact_device(self):
        command = [os.sys.executable, str(ROOT / "packages/document_processor/processor_build_extra.py")]
        for device, extra in (("cpu", "cpu"), ("gpu:0", "gpu")):
            result = subprocess.run([*command, device], capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.strip(), extra)
        for device in ("gpu", "gpu:1", "CPU", ""):
            self.assertNotEqual(subprocess.run([*command, device], capture_output=True).returncode, 0)

    def test_image_gate_rejects_existing_wrong_image_and_device(self):
        spec = importlib.util.spec_from_file_location("image_gate", ROOT / "scripts/verify-deployment-images.py")
        gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gate)
        config = compose_config()
        services = config["services"]
        processor_ref = services["document-processor"]["image"]
        general_ref = services["workspace-general"]["image"]
        images = {
            processor_ref: {"Id": "sha256:processor", "Config": {"Env": ["CENTAERIS_PROCESSOR_DEVICE=cpu"]}},
            general_ref: {"Id": "sha256:general"},
            "old-but-present:tag": {"Id": "sha256:old"},
        }
        gate.verify_images(config, images.__getitem__)
        services["runtime"]["environment"]["KNOWLEDGE_PROCESSOR_IMAGE"] = "old-but-present:tag"
        with self.assertRaisesRegex(ValueError, "different image"):
            gate.verify_images(config, images.__getitem__)
        services["runtime"]["environment"]["KNOWLEDGE_PROCESSOR_IMAGE"] = processor_ref
        services["runtime"]["environment"]["KNOWLEDGE_PROCESSOR_DEVICE"] = "gpu:0"
        with self.assertRaisesRegex(ValueError, "built device differs"):
            gate.verify_images(config, images.__getitem__)

    def test_processor_build_and_runtime_have_one_identity(self):
        for device in ("cpu", "gpu:0"):
            with self.subTest(device=device):
                config = compose_config(KNOWLEDGE_PROCESSOR_DEVICE=device,
                                        KNOWLEDGE_PROCESSOR_IMAGE="stale-image:old")
                processor = config["services"]["document-processor"]
                runtime = config["services"]["runtime"]["environment"]
                self.assertEqual(processor["image"], runtime["KNOWLEDGE_PROCESSOR_IMAGE"])
                self.assertNotEqual(runtime["KNOWLEDGE_PROCESSOR_IMAGE"], "stale-image:old")
                self.assertEqual(processor["build"]["args"]["PROCESSOR_DEVICE"], device)
                self.assertEqual(runtime["KNOWLEDGE_PROCESSOR_DEVICE"], device)

    def test_runtime_port_change_reaches_api_and_worker(self):
        services = compose_config(RUNTIME_PORT="9100")["services"]
        runtime_url = f"http://runtime:{services['runtime']['environment']['RUNTIME_PORT']}"
        self.assertEqual(services["api"]["environment"]["RUNTIME_URL"], runtime_url)
        self.assertEqual(services["worker"]["environment"]["RUNTIME_INTERNAL_URL"], runtime_url)

    def test_compose_paths_remain_on_shared_named_volumes(self):
        services = compose_config(STORAGE_ROOT="/wrong/storage", PLUGIN_CATALOG_ROOT="/wrong/plugins")["services"]
        for name, variable, volume in [
            ("api", "STORAGE_ROOT", "storage-data"),
            ("gc", "STORAGE_ROOT", "storage-data"),
            ("api", "PLUGIN_CATALOG_ROOT", "plugin-data"),
            ("api-init", "PLUGIN_CATALOG_ROOT", "plugin-data"),
        ]:
            with self.subTest(service=name, variable=variable):
                service = services[name]
                mount = next(v for v in service["volumes"] if v["source"] == volume)
                self.assertEqual(service["environment"][variable], mount["target"])
        runtime_plugin = next(v for v in services["runtime"]["volumes"] if v["source"] == "plugin-data")
        self.assertTrue(runtime_plugin["read_only"])
        self.assertEqual(runtime_plugin["target"], services["api"]["environment"]["PLUGIN_CATALOG_ROOT"])

    def test_bundled_service_addresses_cannot_split(self):
        services = compose_config(API_INTERNAL_URL="http://wrong:1", REDIS_URL="redis://wrong:1",
                                  POSTGRES_HOST="wrong", POSTGRES_PORT="9999")["services"]
        for name in ("runtime", "worker"):
            self.assertEqual(services[name]["environment"]["API_INTERNAL_URL"], "http://api:8000")
        for name in ("api", "runtime"):
            self.assertEqual(services[name]["environment"]["REDIS_URL"], "redis://redis:6379/0")
        self.assertEqual(services["api"]["environment"]["POSTGRES_HOST"], "postgres")
        self.assertEqual(services["api"]["environment"]["POSTGRES_PORT"], "5432")
        self.assertIn("@postgres:5432/", services["runtime"]["environment"]["DATABASE_URL"])

    def test_api_drops_capabilities_and_blocks_privilege_gain(self):
        api = compose_config()["services"]["api"]
        self.assertEqual(api.get("cap_drop"), ["ALL"])
        self.assertIn("no-new-privileges:true", api.get("security_opt", []))

    def test_only_runtime_mounts_docker_socket(self):
        services = compose_config()["services"]
        holders = [name for name, service in services.items()
                   if any(v.get("source") == "/var/run/docker.sock" for v in service.get("volumes", []))]
        self.assertEqual(holders, ["runtime"])


if __name__ == "__main__":
    unittest.main()
