param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$localBootstrap = if ($scriptRoot) {
  Join-Path $scriptRoot 'scripts/bootstrap-entrypoint.ps1'
} else {
  ''
}

if ($localBootstrap -and (Test-Path -LiteralPath $localBootstrap)) {
  & $localBootstrap -Mode update @RemainingArgs
  exit $LASTEXITCODE
}

$repoUrl = if ($env:RIN_INSTALL_REPO_URL) {
  $env:RIN_INSTALL_REPO_URL.Trim()
} else {
  'https://github.com/rinchanai/rin'
}
$rawBase = ($repoUrl -replace '\.git$', '') -replace '^https://github.com/', 'https://raw.githubusercontent.com/'
$bootstrapUrl = "$rawBase/main/scripts/bootstrap-entrypoint.ps1"
$bootstrap = (Invoke-WebRequest -UseBasicParsing -Uri $bootstrapUrl).Content
& ([scriptblock]::Create($bootstrap)) -Mode update @RemainingArgs
exit $LASTEXITCODE
