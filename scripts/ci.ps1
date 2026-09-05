param(
    [switch]$InstallPlaywright
)

$ErrorActionPreference = "Stop"
if ($IsWindows) {
    $env:ComSpec = Join-Path $env:SystemRoot "System32\cmd.exe"
}

function Run([string]$Name, [scriptblock]$Command) {
    Write-Host "==> $Name"
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

Run "Public Core revision" { node --test scripts/core-revision.test.mjs }
Run "Rust check" { cargo check --workspace --locked }
Run "Rust tests" { cargo test --workspace --locked }
Run "AgentRun authorization parity" { pwsh -NoProfile -File scripts/agent-run-authorization-gate.ps1 }
Run "Deployment identity contracts" { uv run --frozen --package api python scripts/deployment-contract.test.py }
Run "Python discovery gate regressions" { python scripts/python_test_gate.py gate }
Run "Worker tests" { python scripts/python_test_gate.py worker }
Run "Document processor tests" { uv run --frozen --package centaeris-document-processor python scripts/python_test_gate.py document_processor }
Run "Django fresh migration" { uv run --frozen --package api python packages/api/manage.py migrate --noinput --settings=api.migration_test_settings }
Run "Django migration drift" { uv run --frozen --package api python packages/api/manage.py makemigrations --check --dry-run --settings=api.migration_test_settings --skip-checks }
Run "Full Django PostgreSQL suite" { uv run --frozen --package api python scripts/python_test_gate.py api }
Run "Node install" { npm ci }
if ($InstallPlaywright) {
    if ($IsLinux) {
        Run "Playwright Chromium install" { npx playwright install --with-deps chromium }
    } else {
        Run "Playwright Chromium install" { npx playwright install chromium }
    }
}
Run "Performance artifact validation" { node --test scripts/performance-eval-artifact.test.mjs }
Run "Web lint" { npm run lint }
Run "Web typecheck" { npm run typecheck }
Run "Web unit tests" { npm run test:unit --workspace packages/web }
Run "Web browser interactions" { npm run test:e2e --workspace packages/web }
Run "Compose structure" {
    $config = docker compose --env-file .env.example config --format json | ConvertFrom-Json
    foreach ($service in @("document-processor", "workspace-general")) {
        if (-not $config.services.PSObject.Properties.Name.Contains($service)) {
            throw "Required Runtime image service is missing: $service"
        }
        if ($config.services.$service.profiles) {
            throw "Required Runtime image service cannot be profile-gated: $service"
        }
        if (-not $config.services.runtime.depends_on.$service) {
            throw "Runtime must depend on required image service: $service"
        }
    }
}
