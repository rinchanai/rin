param(
  [ValidateSet('install', 'update')]
  [string]$Mode = 'install',
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

switch ($Mode) {
  'install' {
    $Prefix = 'rin-install'
    $WorkPrefix = 'rin-install'
    $ManifestLabel = 'Fetching release manifest'
    $FetchLabel = 'Fetching installer source'
    $PrepLabel = 'Preparing installer source'
    $BuildLabel = 'Building installer'
    $LaunchLabel = 'Launching installer...'
    $NpmError = 'rin installer requires npm'
    $NodeEnv = @{}
  }
  'update' {
    $Prefix = 'rin-update'
    $WorkPrefix = 'rin-update'
    $ManifestLabel = 'Fetching release manifest'
    $FetchLabel = 'Fetching updater source'
    $PrepLabel = 'Preparing updater source'
    $BuildLabel = 'Building updater'
    $LaunchLabel = 'Launching updater...'
    $NpmError = 'rin updater requires npm'
    $NodeEnv = @{ RIN_INSTALL_MODE = 'update' }
  }
}

function Write-Step([string]$Label, [scriptblock]$Action) {
  Write-Host "[$Prefix] $Label"
  & $Action
  if (-not $?) {
    $code = if ($global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 1 }
    throw "${Prefix}_step_failed:${Label}:$code"
  }
}

function Test-LooksLikeGitRef([string]$Value) {
  if (-not $Value) { return $false }
  if ($Value -match '^(refs/|v[0-9])') { return $true }
  if ($Value.Contains('~') -or $Value.Contains('^') -or $Value.Contains(':')) { return $true }
  return $Value -match '^[0-9a-fA-F]{7,40}$'
}

function New-DefaultManifest([string]$RepoUrl, [string]$PackageName, [string]$BootstrapBranch) {
  return @{
    schemaVersion = 2
    packageName = $PackageName
    repoUrl = $RepoUrl
    bootstrapBranch = $BootstrapBranch
    train = @{
      series = '0.0'
      nightlyBranch = 'main'
    }
    stable = @{
      version = '0.0.0'
      archiveUrl = "$RepoUrl/archive/refs/heads/main.tar.gz"
      ref = 'main'
    }
    beta = @{
      version = '0.0.1-beta.0'
      archiveUrl = "$RepoUrl/archive/refs/heads/main.tar.gz"
      ref = 'main'
      promotionVersion = '0.0.1'
    }
    nightly = @{
      version = '0.0.1-nightly.0'
      archiveUrl = "$RepoUrl/archive/refs/heads/main.tar.gz"
      ref = 'main'
      branch = 'main'
    }
    git = @{
      defaultBranch = 'main'
      repoUrl = $RepoUrl
    }
  }
}

function Build-NpmTarballUrl([string]$Name, [string]$Version) {
  $encodedName = [uri]::EscapeDataString($(if ($Name) { $Name } else { '@rinchanai/rin' }))
  $fileBase = ($(if ($Name) { $Name } else { '@rinchanai/rin' }).Split('/')[-1])
  $resolvedVersion = if ($Version) { $Version } else { '0.0.0' }
  return "https://registry.npmjs.org/$encodedName/-/$fileBase-$resolvedVersion.tgz"
}

function Build-RefArchiveUrl([string]$RepoUrl, [string]$Ref) {
  $segments = ($(if ($Ref) { $Ref } else { 'main' }) -split '/').ForEach({ [uri]::EscapeDataString($_) })
  return ('{0}/archive/{1}.tar.gz' -f $RepoUrl, ($segments -join '/'))
}

function Build-BranchArchiveUrl([string]$RepoUrl, [string]$Branch) {
  $segments = ($(if ($Branch) { $Branch } else { 'main' }) -split '/').ForEach({ [uri]::EscapeDataString($_) })
  return ('{0}/archive/refs/heads/{1}.tar.gz' -f $RepoUrl, ($segments -join '/'))
}

function Resolve-Release($Manifest, [string]$RepoUrl, [string]$PackageName, [string]$Channel, [string]$Branch, [string]$Version) {
  if ($Branch -and $Version) {
    throw 'cannot combine --branch and --version'
  }

  $manifestRepoUrl = if ($Manifest.repoUrl) { [string]$Manifest.repoUrl } else { $RepoUrl }
  $manifestRepoUrl = $manifestRepoUrl -replace '\.git$', ''
  $manifestPackageName = if ($Manifest.packageName) { [string]$Manifest.packageName } else { $PackageName }

  switch ($Channel) {
    'stable' {
      if ($Branch) {
        throw 'stable does not support --branch'
      }
      $stable = $Manifest.stable
      $resolvedVersion = if ($Version) { $Version } elseif ($stable.version) { [string]$stable.version } else { '0.0.0' }
      $entry = $null
      if ($Version -and $stable.versions) {
        $entry = $stable.versions.$Version
      }
      return @{
        channel = 'stable'
        archiveUrl = if ($entry.archiveUrl) { [string]$entry.archiveUrl } elseif ($stable.archiveUrl) { [string]$stable.archiveUrl } else { Build-NpmTarballUrl $manifestPackageName $resolvedVersion }
        version = $resolvedVersion
        branch = 'stable'
        ref = if ($entry.ref) { [string]$entry.ref } elseif ($stable.ref) { [string]$stable.ref } elseif ($Version) { $Version } elseif ($stable.version) { [string]$stable.version } else { 'main' }
        sourceLabel = if ($Version) { "stable version $resolvedVersion" } else { "stable $resolvedVersion" }
      }
    }
    'beta' {
      if ($Branch -or $Version) {
        throw 'beta does not support explicit selectors'
      }
      $beta = $Manifest.beta
      $resolvedRef = if ($beta.ref) { [string]$beta.ref } else { 'main' }
      $resolvedVersion = if ($beta.version) { [string]$beta.version } else { '0.0.1-beta.0' }
      return @{
        channel = 'beta'
        archiveUrl = if ($beta.archiveUrl) { [string]$beta.archiveUrl } else { Build-RefArchiveUrl $manifestRepoUrl $resolvedRef }
        version = $resolvedVersion
        branch = 'beta'
        ref = $resolvedRef
        sourceLabel = "beta $resolvedVersion"
      }
    }
    'nightly' {
      if ($Branch -or $Version) {
        throw 'nightly does not support explicit selectors'
      }
      $nightly = $Manifest.nightly
      $train = $Manifest.train
      $resolvedBranch = if ($nightly.branch) { [string]$nightly.branch } elseif ($train.nightlyBranch) { [string]$train.nightlyBranch } else { 'main' }
      $resolvedRef = if ($nightly.ref) { [string]$nightly.ref } else { $resolvedBranch }
      $resolvedVersion = if ($nightly.version) { [string]$nightly.version } else { '0.0.1-nightly.0' }
      return @{
        channel = 'nightly'
        archiveUrl = if ($nightly.archiveUrl) { [string]$nightly.archiveUrl } elseif ($nightly.ref) { Build-RefArchiveUrl $manifestRepoUrl $resolvedRef } else { Build-BranchArchiveUrl $manifestRepoUrl $resolvedBranch }
        version = $resolvedVersion
        branch = $resolvedBranch
        ref = $resolvedRef
        sourceLabel = "nightly $resolvedVersion"
      }
    }
    default {
      $git = $Manifest.git
      $resolvedBranch = if ($Branch) { $Branch } elseif ($git.defaultBranch) { [string]$git.defaultBranch } else { 'main' }
      $resolvedRef = if ($Version) { $Version } else { $resolvedBranch }
      return @{
        channel = 'git'
        archiveUrl = if ($Version) { Build-RefArchiveUrl $manifestRepoUrl $resolvedRef } else { Build-BranchArchiveUrl $manifestRepoUrl $resolvedBranch }
        version = if ($Version) { $Version } else { $resolvedRef }
        branch = $resolvedBranch
        ref = $resolvedRef
        sourceLabel = if ($Version) { "git ref $resolvedRef" } else { "git branch $resolvedRef" }
      }
    }
  }
}

$repoUrl = if ($env:RIN_INSTALL_REPO_URL) { $env:RIN_INSTALL_REPO_URL.Trim() } else { 'https://github.com/rinchanai/rin' }
$repoUrl = $repoUrl -replace '\.git$', ''
$bootstrapBranch = if ($env:RIN_BOOTSTRAP_BRANCH) { $env:RIN_BOOTSTRAP_BRANCH.Trim() } else { 'stable-bootstrap' }
$packageName = if ($env:RIN_NPM_PACKAGE) { $env:RIN_NPM_PACKAGE.Trim() } else { '@rinchanai/rin' }
$cacheBase = if ($env:RIN_INSTALL_TMPDIR) {
  $env:RIN_INSTALL_TMPDIR.Trim()
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA 'rin-install'
} elseif ($env:TEMP) {
  Join-Path $env:TEMP 'rin-install'
} else {
  Join-Path (Join-Path $HOME 'AppData/Local/Temp') 'rin-install'
}

$channel = 'stable'
$branch = ''
$version = ''
$explicitChannel = ''
$expectGitSelector = $false
$gitSelector = ''

for ($index = 0; $index -lt $RemainingArgs.Length; $index += 1) {
  $arg = [string]$RemainingArgs[$index]
  switch ($arg) {
    '--stable' {
      if ($explicitChannel -and $explicitChannel -ne 'stable') {
        throw 'cannot combine conflicting release channel selectors'
      }
      $channel = 'stable'
      $explicitChannel = 'stable'
      $expectGitSelector = $false
    }
    '--beta' {
      if ($explicitChannel -and $explicitChannel -ne 'beta') {
        throw 'cannot combine conflicting release channel selectors'
      }
      $channel = 'beta'
      $explicitChannel = 'beta'
      $expectGitSelector = $false
    }
    '--nightly' {
      if ($explicitChannel -and $explicitChannel -ne 'nightly') {
        throw 'cannot combine conflicting release channel selectors'
      }
      $channel = 'nightly'
      $explicitChannel = 'nightly'
      $expectGitSelector = $false
    }
    '--git' {
      if ($explicitChannel -and $explicitChannel -ne 'git') {
        throw 'cannot combine conflicting release channel selectors'
      }
      $channel = 'git'
      $explicitChannel = 'git'
      $expectGitSelector = $true
    }
    '--branch' {
      $expectGitSelector = $false
      if ($index + 1 -ge $RemainingArgs.Length) {
        throw 'missing value for --branch'
      }
      $index += 1
      $branch = [string]$RemainingArgs[$index]
    }
    '--version' {
      $expectGitSelector = $false
      if ($index + 1 -ge $RemainingArgs.Length) {
        throw 'missing value for --version'
      }
      $index += 1
      $version = [string]$RemainingArgs[$index]
    }
    '-h' { throw 'usage' }
    '--help' { throw 'usage' }
    default {
      if ($expectGitSelector -and -not $gitSelector -and -not $arg.StartsWith('-')) {
        $gitSelector = $arg
        $expectGitSelector = $false
      } elseif ($channel -eq 'stable') {
        throw 'stable does not support a flag selector'
      } elseif ($channel -eq 'beta') {
        throw 'beta does not support a flag selector'
      } elseif ($channel -eq 'nightly') {
        throw 'nightly does not support a flag selector'
      } else {
        throw "unknown argument: $arg"
      }
    }
  }
}

if (-not $branch -and -not $version -and $gitSelector) {
  if (Test-LooksLikeGitRef $gitSelector) {
    $version = $gitSelector
  } else {
    $branch = $gitSelector
  }
}

if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  throw 'rin bootstrap requires tar'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'rin bootstrap requires node'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw $NpmError
}

New-Item -ItemType Directory -Force -Path $cacheBase | Out-Null
$workDir = Join-Path $cacheBase ("$WorkPrefix." + [guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $workDir 'rin.tar.gz'
$srcDir = Join-Path $workDir 'src'
$manifestPath = Join-Path $workDir 'release-manifest.json'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = if ($scriptDir) { Split-Path -Parent $scriptDir } else { '' }
$localManifestPath = if ($repoRoot) { Join-Path $repoRoot 'release-manifest.json' } else { '' }

try {
  New-Item -ItemType Directory -Force -Path $workDir | Out-Null

  Write-Step $ManifestLabel {
    $rawBase = ($repoUrl -replace '^https://github.com/', 'https://raw.githubusercontent.com/')
    $primaryUrl = "$rawBase/$bootstrapBranch/release-manifest.json"
    $fallbackUrl = "$rawBase/main/release-manifest.json"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $primaryUrl -OutFile $manifestPath
    } catch {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $fallbackUrl -OutFile $manifestPath
      } catch {
        if ($localManifestPath -and (Test-Path -LiteralPath $localManifestPath)) {
          Copy-Item -LiteralPath $localManifestPath -Destination $manifestPath -Force
        } else {
          throw 'failed to fetch release manifest'
        }
      }
    }
  }

  $manifest = New-DefaultManifest $repoUrl $packageName $bootstrapBranch
  try {
    $loadedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($loadedManifest) {
      $manifest = $loadedManifest
    }
  } catch {}
  $release = Resolve-Release $manifest $repoUrl $packageName $channel $branch $version

  Write-Step $FetchLabel {
    Invoke-WebRequest -UseBasicParsing -Uri $release.archiveUrl -OutFile $archivePath
  }

  New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
  Write-Step $PrepLabel {
    & tar -xzf $archivePath -C $srcDir --strip-components=1
  }

  Push-Location $srcDir
  try {
    if (Test-Path -LiteralPath (Join-Path $srcDir 'package-lock.json')) {
      Write-Step 'Installing dependencies' {
        & npm ci --no-fund --no-audit
      }
    } else {
      Write-Step 'Installing dependencies' {
        & npm install --no-fund --no-audit
      }
    }

    Write-Step $BuildLabel {
      & npm run build
    }

    Write-Host "[$Prefix] $LaunchLabel"
    $previousEnv = @{}
    foreach ($pair in @{
      RIN_RELEASE_CHANNEL = $release.channel
      RIN_RELEASE_VERSION = $release.version
      RIN_RELEASE_BRANCH = $release.branch
      RIN_RELEASE_REF = $release.ref
      RIN_RELEASE_SOURCE_LABEL = $release.sourceLabel
      RIN_RELEASE_ARCHIVE_URL = $release.archiveUrl
      RIN_INSTALL_MODE = $NodeEnv.RIN_INSTALL_MODE
    }.GetEnumerator()) {
      $name = [string]$pair.Key
      $previousEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
      if ($null -eq $pair.Value -or $pair.Value -eq '') {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
      } else {
        [Environment]::SetEnvironmentVariable($name, [string]$pair.Value, 'Process')
      }
    }
    try {
      & node 'dist/app/rin-install/main.js'
      exit $LASTEXITCODE
    } finally {
      foreach ($pair in $previousEnv.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable([string]$pair.Key, $pair.Value, 'Process')
      }
    }
  } finally {
    Pop-Location
  }
} finally {
  if ($workDir -and (Test-Path -LiteralPath $workDir)) {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
