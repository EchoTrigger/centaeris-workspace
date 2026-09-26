"""Export Core blocks and Workspace transcript envelopes from their owning types."""
import argparse
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "packages/api/app_core/generated/transcript_block.schema.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    def capture(command):
        return subprocess.run(command, cwd=ROOT, check=True, capture_output=True,
                              encoding="utf-8", env={**os.environ,
                              "CARGO_TARGET_DIR": os.environ.get("CARGO_TARGET_DIR", str(ROOT / "target"))}).stdout
    core = Path(capture(["node", "scripts/core-source.mjs"]).strip())
    command = [
        "cargo", "run", "--quiet", "--locked", "--manifest-path", str(core / "packages/core/Cargo.toml"),
        "--example", "transcript_schema", "--features", "contract-schema",
    ]
    artifacts = [(OUTPUT, json.loads(capture(command))),
                 (OUTPUT.with_name("transcript_block.samples.json"),
                  json.loads(capture(command + ["--", "--samples"])))]
    envelopes = json.loads(capture([
        "cargo", "run", "--quiet", "--locked", "-p", "runtime_server",
        "--example", "transcript_schema", "--features", "contract-schema",
    ]))
    artifacts.extend((OUTPUT.with_name(f"transcript_envelopes.{suffix}.json"), envelopes[key])
                     for suffix, key in [("schema", "schemas"), ("samples", "samples")])
    for output, value in artifacts:
        generated = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        if args.check:
            if output.read_text(encoding="utf-8") != generated:
                raise SystemExit("Transcript contract is stale; run python scripts/transcript-schema.py")
        else:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(generated, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
