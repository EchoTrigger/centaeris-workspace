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

Run "Rust check" { cargo check --workspace --locked }
Run "Rust tests" { cargo test --workspace --locked }
Run "Worker tests" { python packages/worker/test_worker.py }
Run "Document processor tests" { uv run --frozen --package centaeris-document-processor python packages/document_processor/test_document_processor.py }
Run "Django fresh migration" { uv run --frozen --package api python packages/api/manage.py migrate --noinput --settings=api.migration_test_settings }
Run "Django migration drift" { uv run --frozen --package api python packages/api/manage.py makemigrations --check --dry-run --settings=api.migration_test_settings --skip-checks }
Run "Django Runtime client" { uv run --frozen --package api python packages/api/manage.py test app_core.test_http_modernization.ModelCatalogRuntimeClientTests --noinput --settings=api.migration_test_settings }
Run "Knowledge streaming validation" { uv run --frozen --package api python packages/api/manage.py test app_core.test_knowledge_streaming app_core.tests.WorkspaceAssetAcceptanceTests.test_knowledge_processor_device_identity_is_exact --noinput --settings=api.migration_test_settings }
Run "Plugin management and upload isolation" { uv run --frozen --package api python packages/api/manage.py test app_core.test_plugin_isolation app_core.test_plugin_upload --noinput --settings=api.migration_test_settings }
Run "Resource IDs and ownership" { uv run --frozen --package api python packages/api/manage.py test app_core.test_resource_ids app_core.test_bootstrap_superadmin.BootstrapSuperadminTests --noinput --settings=api.migration_test_settings }
Run "Node install" { npm ci }
if ($InstallPlaywright) {
    if ($IsLinux) {
        Run "Playwright Chromium install" { npx playwright install --with-deps chromium }
    } else {
        Run "Playwright Chromium install" { npx playwright install chromium }
    }
}
Run "Performance artifact validation" { node --test scripts/performance-eval-artifact.test.mjs }
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
