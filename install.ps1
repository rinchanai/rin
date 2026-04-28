[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$Stable,
  [switch]$Beta,
  [switch]$Nightly,
  [switch]$Git,
  [string]$Branch,
  [string]$Version,
  [Alias("h")]
  [switch]$Help,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { "" }
$mode = if ($env:RIN_BOOTSTRAP_WRAPPER_MODE) { $env:RIN_BOOTSTRAP_WRAPPER_MODE } else { "install" }
$localBootstrapScript = if ($scriptDir) { Join-Path $scriptDir "scripts/bootstrap-entrypoint.ps1" } else { "" }

function Build-BootstrapArgs {
  $args = @()
  if ($Stable) { $args += "--stable" }
  if ($Beta) { $args += "--beta" }
  if ($Nightly) { $args += "--nightly" }
  if ($Git) { $args += "--git" }
  if ($Branch) { $args += @("--branch", $Branch) }
  if ($Version) { $args += @("--version", $Version) }
  if ($Help) { $args += "--help" }
  $args += $RemainingArgs
  return $args
}

$bootstrapArgs = Build-BootstrapArgs

if ($localBootstrapScript -and (Test-Path -LiteralPath $localBootstrapScript)) {
  & $localBootstrapScript -Mode $mode @bootstrapArgs
  exit $LASTEXITCODE
}

$repoUrl = if ($env:RIN_INSTALL_REPO_URL) { $env:RIN_INSTALL_REPO_URL } else { "https://github.com/rinchanai/rin" }
$defaultBootstrapBranch = "bootstrap"
$bootstrapBranch = if ($env:RIN_BOOTSTRAP_BRANCH) { $env:RIN_BOOTSTRAP_BRANCH } else { $defaultBootstrapBranch }
$rawBase = ($repoUrl -replace "^https://github.com/", "https://raw.githubusercontent.com/") -replace "\.git$", ""
$bootstrapScriptUrl = if ($env:RIN_BOOTSTRAP_SCRIPT_URL) { $env:RIN_BOOTSTRAP_SCRIPT_URL } else { "$rawBase/$bootstrapBranch/scripts/bootstrap-entrypoint.ps1" }
$mainBootstrapScriptUrl = if ($env:RIN_BOOTSTRAP_SCRIPT_FALLBACK_URL) { $env:RIN_BOOTSTRAP_SCRIPT_FALLBACK_URL } else { "$rawBase/main/scripts/bootstrap-entrypoint.ps1" }
$cacheBase = if ($env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME } elseif ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$tempBase = if ($env:RIN_INSTALL_TMPDIR) { $env:RIN_INSTALL_TMPDIR } else { Join-Path $cacheBase "rin-install" }
New-Item -ItemType Directory -Force -Path $tempBase | Out-Null
$bootstrapScript = Join-Path $tempBase ("bootstrap-entrypoint.{0}.ps1" -f ([System.Guid]::NewGuid().ToString("N")))

function Fetch-File([string]$Url, [string]$OutFile) {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
}

try {
  try {
    Fetch-File $bootstrapScriptUrl $bootstrapScript
  } catch {
    if ($mainBootstrapScriptUrl -and $mainBootstrapScriptUrl -ne $bootstrapScriptUrl) {
      Fetch-File $mainBootstrapScriptUrl $bootstrapScript
    } else {
      throw
    }
  }

  & $bootstrapScript -Mode $mode @bootstrapArgs
  exit $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $bootstrapScript -Force -ErrorAction SilentlyContinue
}
