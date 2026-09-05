# Centaeris Workspace

Hosted product for running Centaeris agents with workspace membership, durable
jobs, managed execution, document processing, a Django control plane, and a web
client. The public source is developed under `AGPL-3.0-only`.

The host-agnostic Runtime Framework remains an external Rust source dependency.
The current development checkout resolves it through explicit Cargo paths and a
named Docker build context. A reproducible release must materialize one exact
public Runtime revision for both paths. There is no npm or Python
cross-repository source dependency.

Compose passes only the Runtime source through an additional named build
context for Rust service images. The API image context contains only this
repository. Superusers install or update Plugins by uploading a validated ZIP;
extension source repositories are not included in a Workspace image context.

## Develop

```powershell
Copy-Item .env.example .env
# Fill every blank secret.
uv sync --locked
npm ci
cargo check --workspace --locked
docker compose config --quiet
```

Start the complete local stack:

```powershell
pwsh -File scripts\start-local.ps1
```

The start script builds required execution and document-processor images before
starting persistent services. These images are part of normal operation, not
optional development extras. Runtime resolves the configured execution image to
an immutable Docker identity before authorizing an AgentRun.

Run all local gates with `pwsh -File scripts/ci.ps1`. Start documentation at
[docs/README.md](docs/README.md).

Bundled web font copyright, source, and license records are indexed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the linked license files are
included in the deployed web artifact.

## Contributing

Issues are welcome for bug reports, natural-language reproduction steps,
redacted logs, feature requests, and high-level design suggestions. External
code, patches, documentation drafts, and other works for incorporation into
the project are temporarily not accepted. Pull requests are limited to
collaborators for maintainer development.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the temporary policy and plans for
future contributions and commercial licensing.

## License

Except where a file or notice says otherwise, this repository's original source
code and documentation are licensed under the
[GNU Affero General Public License v3.0 only](LICENSE).

The Centaeris name, logo, and official visual identity are not licensed under
the AGPL, and the software license grants no trademark rights. Third-party
materials remain under their stated licenses.
