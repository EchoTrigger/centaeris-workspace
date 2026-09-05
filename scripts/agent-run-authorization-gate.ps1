$ErrorActionPreference = "Stop"
$artifact = Join-Path ([System.IO.Path]::GetTempPath()) ("centaeris-authorization-" + [guid]::NewGuid() + ".json")
$receipt = "$artifact.receipt"
$previousArtifact = $env:AGENT_RUN_AUTHORIZATION_VECTORS
$previousReceipt = $env:AGENT_RUN_AUTHORIZATION_RECEIPT
Push-Location (Join-Path $PSScriptRoot "..")
try {
    $env:AGENT_RUN_AUTHORIZATION_VECTORS = $artifact
    $env:AGENT_RUN_AUTHORIZATION_RECEIPT = $receipt
    & uv run --frozen --package api python packages/api/manage.py test app_core.test_agent_run_authorization --noinput --settings=api.migration_test_settings
    if ($LASTEXITCODE -ne 0) { throw "Python authorization contract tests failed" }
    if (-not (Test-Path -LiteralPath $artifact)) { throw "Python emitted no authorization vectors" }
    & cargo test --locked -p runtime_server agent_run_authorization:: -- --nocapture
    if ($LASTEXITCODE -ne 0) { throw "Rust authorization contract tests failed" }
    if (-not (Test-Path -LiteralPath $receipt)) { throw "Rust did not consume Python vectors" }
    $consumed = 0
    if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $receipt), [ref]$consumed) -or $consumed -le 0) {
        throw "Rust consumed no Python vectors"
    }
    Write-Host "Authorization parity passed: $consumed Python-signed vectors verified by Rust."
}
finally {
    $env:AGENT_RUN_AUTHORIZATION_VECTORS = $previousArtifact
    $env:AGENT_RUN_AUTHORIZATION_RECEIPT = $previousReceipt
    Remove-Item -LiteralPath $artifact, $receipt -Force -ErrorAction SilentlyContinue
    Pop-Location
}
