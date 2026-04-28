[CmdletBinding(PositionalBinding = $false)]
param(
  [ValidateSet("install", "update")]
  [string]$Mode = "install",
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

if ($Mode -eq "update") {
  $prefix = "rin-update"
  $workPrefix = "rin-update"
  $fetchLabel = "Fetching updater source"
  $prepLabel = "Preparing updater source"
  $buildLabel = "Building updater"
  $launchLabel = "Launching updater..."
} else {
  $prefix = "rin-install"
  $workPrefix = "rin-install"
  $fetchLabel = "Fetching installer source"
  $prepLabel = "Preparing installer source"
  $buildLabel = "Building installer"
  $launchLabel = "Launching installer..."
}

$repoUrl = if ($env:RIN_INSTALL_REPO_URL) { $env:RIN_INSTALL_REPO_URL } else { "https://github.com/rinchanai/rin" }
$bootstrapBranch = if ($env:RIN_BOOTSTRAP_BRANCH) { $env:RIN_BOOTSTRAP_BRANCH } else { "bootstrap" }
$cacheBase = if ($env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME } elseif ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$tempBase = if ($env:RIN_INSTALL_TMPDIR) { $env:RIN_INSTALL_TMPDIR } else { Join-Path $cacheBase "rin-install" }
New-Item -ItemType Directory -Force -Path $tempBase | Out-Null
$workDir = Join-Path $tempBase ("{0}.{1}" -f $workPrefix, [System.Guid]::NewGuid().ToString("N"))
$archive = Join-Path $workDir "rin.tar.gz"
$srcDir = Join-Path $workDir "src"
$manifestPath = Join-Path $workDir "release-manifest.json"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

$channel = "stable"
$branch = ""
$version = ""
$gitSelector = ""
$explicitChannel = ""
$expectGitSelector = $false

function Build-ParsedArgs {
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

function Say([string]$Message) {
  Write-Host "[$prefix] $Message"
}

function Fetch-File([string]$Url, [string]$OutFile) {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
}

function Url-Encode-Path([string]$Value) {
  (($Value -split "/") | ForEach-Object { [System.Uri]::EscapeDataString($_) }) -join "/"
}

function Looks-Like-Git-Ref([string]$Value) {
  return $Value -match "^(refs/|v[0-9]|.*[~^:].*)" -or $Value -match "^[0-9a-fA-F]{7,40}$"
}

function Set-Channel([string]$Requested) {
  if ($script:explicitChannel -and $script:explicitChannel -ne $Requested) {
    throw "cannot combine conflicting release channel selectors"
  }
  $script:channel = $Requested
  $script:explicitChannel = $Requested
}

function Parse-Args([string[]]$Args) {
  for ($i = 0; $i -lt $Args.Count; $i++) {
    $arg = $Args[$i]
    switch ($arg) {
      "--stable" { Set-Channel "stable"; $script:expectGitSelector = $false; continue }
      "--beta" { Set-Channel "beta"; $script:expectGitSelector = $false; continue }
      "--nightly" { Set-Channel "nightly"; $script:expectGitSelector = $false; continue }
      "--git" { Set-Channel "git"; $script:expectGitSelector = $true; continue }
      "--branch" {
        if ($i + 1 -ge $Args.Count) { throw "missing value for --branch" }
        $script:branch = $Args[++$i]
        $script:expectGitSelector = $false
        continue
      }
      "--version" {
        if ($i + 1 -ge $Args.Count) { throw "missing value for --version" }
        $script:version = $Args[++$i]
        $script:expectGitSelector = $false
        continue
      }
      { $_ -in @("-h", "--help") } {
        @"
Usage: install.ps1 [--stable] [--beta] [--nightly] [--git [main|deadbeef]] [legacy flags]

Defaults to the stable release channel.
--beta installs the current weekly beta candidate.
--nightly installs the current nightly build.
--git main or --git deadbeef selects a branch or ref directly.
Legacy flags such as --branch/--version remain supported.
"@ | Write-Host
        exit 0
      }
      default {
        if ($script:expectGitSelector -and -not $script:gitSelector -and -not $arg.StartsWith("-")) {
          $script:gitSelector = $arg
          $script:expectGitSelector = $false
          continue
        }
        if ($script:channel -in @("stable", "beta", "nightly")) {
          throw "$script:channel does not support a flag selector"
        }
        throw "unknown argument: $arg"
      }
    }
  }

  if (-not $script:branch -and -not $script:version -and $script:gitSelector) {
    if (Looks-Like-Git-Ref $script:gitSelector) {
      $script:version = $script:gitSelector
    } else {
      $script:branch = $script:gitSelector
    }
  }

  if ($script:branch -and $script:version) { throw "cannot combine --branch and --version" }
  if ($script:channel -eq "stable" -and $script:branch) { throw "stable does not support --branch" }
  if ($script:channel -eq "beta" -and ($script:branch -or $script:version)) { throw "beta does not support explicit selectors" }
  if ($script:channel -eq "nightly" -and ($script:branch -or $script:version)) { throw "nightly does not support explicit selectors" }
}

function Fetch-Manifest {
  $rawBase = ($repoUrl -replace "^https://github.com/", "https://raw.githubusercontent.com/") -replace "\.git$", ""
  $primaryUrl = "$rawBase/$bootstrapBranch/release-manifest.json"
  $fallbackUrl = "$rawBase/main/release-manifest.json"
  try {
    Fetch-File $primaryUrl $manifestPath
  } catch {
    Fetch-File $fallbackUrl $manifestPath
  }
}

function Get-Property($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  return $Object.PSObject.Properties[$Name].Value
}

function Resolve-Release {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $packageName = if ($env:RIN_NPM_PACKAGE) { $env:RIN_NPM_PACKAGE } elseif ($manifest.packageName) { [string]$manifest.packageName } else { "@rinchanai/rin" }
  $releaseRepoUrl = if ($manifest.repoUrl) { [string]$manifest.repoUrl } else { $repoUrl }
  $releaseRepoUrl = $releaseRepoUrl -replace "\.git$", ""
  $fileBase = ($packageName -split "/")[-1]
  $buildNpmTarballUrl = { param($releaseVersion) "https://registry.npmjs.org/$([System.Uri]::EscapeDataString($packageName))/-/$fileBase-$releaseVersion.tgz" }
  $buildRefArchiveUrl = { param($ref) "$releaseRepoUrl/archive/$(Url-Encode-Path $ref).tar.gz" }
  $buildBranchArchiveUrl = { param($name) "$releaseRepoUrl/archive/refs/heads/$(Url-Encode-Path $name).tar.gz" }

  if ($channel -eq "stable") {
    if ($branch) { throw "rin_stable_branch_not_supported" }
    $stable = $manifest.stable
    $resolvedVersion = if ($version) { $version } elseif ($stable.version) { [string]$stable.version } else { "0.0.0" }
    $entry = if ($version -and (Get-Property $stable "versions")) { Get-Property $stable.versions $version } else { $null }
    return [pscustomobject]@{
      PackageName = $packageName
      Channel = "stable"
      ArchiveUrl = if ($entry -and $entry.archiveUrl) { [string]$entry.archiveUrl } elseif ($stable.archiveUrl) { [string]$stable.archiveUrl } else { & $buildNpmTarballUrl $resolvedVersion }
      Version = $resolvedVersion
      Branch = "stable"
      Ref = if ($entry -and $entry.ref) { [string]$entry.ref } elseif ($stable.ref) { [string]$stable.ref } elseif ($version) { $version } else { $resolvedVersion }
      SourceLabel = if ($version) { "stable version $resolvedVersion" } else { "stable $resolvedVersion" }
    }
  }
  if ($channel -eq "beta") {
    $beta = $manifest.beta
    $resolvedRef = if ($beta.ref) { [string]$beta.ref } else { "main" }
    $resolvedVersion = if ($beta.version) { [string]$beta.version } else { "0.0.1-beta.0" }
    return [pscustomobject]@{
      PackageName = $packageName
      Channel = "beta"
      ArchiveUrl = if ($beta.archiveUrl) { [string]$beta.archiveUrl } else { & $buildRefArchiveUrl $resolvedRef }
      Version = $resolvedVersion
      Branch = "beta"
      Ref = $resolvedRef
      SourceLabel = "beta $resolvedVersion"
    }
  }
  if ($channel -eq "nightly") {
    $nightly = $manifest.nightly
    $train = $manifest.train
    $resolvedBranch = if ($nightly.branch) { [string]$nightly.branch } elseif ($train.nightlyBranch) { [string]$train.nightlyBranch } else { "main" }
    $resolvedRef = if ($nightly.ref) { [string]$nightly.ref } else { $resolvedBranch }
    $resolvedVersion = if ($nightly.version) { [string]$nightly.version } else { "0.0.1-nightly.0" }
    return [pscustomobject]@{
      PackageName = $packageName
      Channel = "nightly"
      ArchiveUrl = if ($nightly.archiveUrl) { [string]$nightly.archiveUrl } elseif ($nightly.ref) { & $buildRefArchiveUrl $resolvedRef } else { & $buildBranchArchiveUrl $resolvedBranch }
      Version = $resolvedVersion
      Branch = $resolvedBranch
      Ref = $resolvedRef
      SourceLabel = "nightly $resolvedVersion"
    }
  }

  $git = $manifest.git
  $resolvedBranch = if ($branch) { $branch } elseif ($git.defaultBranch) { [string]$git.defaultBranch } else { "main" }
  $resolvedRef = if ($version) { $version } else { $resolvedBranch }
  return [pscustomobject]@{
    PackageName = $packageName
    Channel = "git"
    ArchiveUrl = if ($version) { & $buildRefArchiveUrl $resolvedRef } else { & $buildBranchArchiveUrl $resolvedBranch }
    Version = $resolvedRef
    Branch = $resolvedBranch
    Ref = $resolvedRef
    SourceLabel = if ($version) { "git ref $resolvedRef" } else { "git branch $resolvedRef" }
  }
}

function Set-Release-Env($Release) {
  $env:RIN_RELEASE_CHANNEL = $Release.Channel
  $env:RIN_RELEASE_VERSION = $Release.Version
  $env:RIN_RELEASE_BRANCH = $Release.Branch
  $env:RIN_RELEASE_REF = $Release.Ref
  $env:RIN_RELEASE_SOURCE_LABEL = $Release.SourceLabel
  $env:RIN_RELEASE_ARCHIVE_URL = $Release.ArchiveUrl
  if ($Mode -eq "update") { $env:RIN_INSTALL_MODE = "update" }
}

try {
  $parsedArgs = Build-ParsedArgs
  Parse-Args $parsedArgs
  Say "Fetching release manifest"
  Fetch-Manifest
  $release = Resolve-Release
  Set-Release-Env $release

  if ($release.Channel -eq "stable") {
    Say $launchLabel
    npm exec --yes --package "$($release.PackageName)@$($release.Version)" -- rin-install
    exit $LASTEXITCODE
  }

  Say $fetchLabel
  Fetch-File $release.ArchiveUrl $archive
  New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
  Say $prepLabel
  tar -xzf $archive -C $srcDir --strip-components=1
  Push-Location $srcDir
  try {
    if (Test-Path -LiteralPath "package-lock.json") {
      npm ci --no-fund --no-audit
    } else {
      npm install --no-fund --no-audit
    }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Say $buildLabel
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Say $launchLabel
    node "dist/app/rin-install/main.js"
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
