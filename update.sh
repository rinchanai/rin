#!/bin/sh
set -eu

REPO_URL=${RIN_INSTALL_REPO_URL:-https://github.com/rinchanai/rin}
BOOTSTRAP_BRANCH=${RIN_BOOTSTRAP_BRANCH:-stable-bootstrap}
CACHE_BASE=${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}
TMPDIR_BASE=${RIN_INSTALL_TMPDIR:-$CACHE_BASE/rin-install}
mkdir -p "$TMPDIR_BASE"
WORKDIR=$(mktemp -d "$TMPDIR_BASE/rin-update.XXXXXX")
ARCHIVE="$WORKDIR/rin.tar.gz"
SRC_DIR="$WORKDIR/src"
LOGFILE="$WORKDIR/update.log"
TTY=/dev/tty
MANIFEST_PATH="$WORKDIR/release-manifest.json"
CHANNEL=stable
BRANCH=
VERSION=

usage() {
  cat <<'EOF'
Usage: ./update.sh [--stable] [--beta|--git] [--branch <name>] [--version <value>]

Defaults to the stable release channel.
Beta and git builds must be selected explicitly.
EOF
}

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

say() {
  if [ -w "$TTY" ]; then
    printf '%s\n' "$1" >"$TTY"
  else
    printf '%s\n' "$1"
  fi
}

render_spinner() {
  label=$1
  pid=$2
  i=0
  while kill -0 "$pid" 2>/dev/null; do
    case $i in
      0) frame='⠋' ;;
      1) frame='⠙' ;;
      2) frame='⠹' ;;
      3) frame='⠸' ;;
      4) frame='⠼' ;;
      5) frame='⠴' ;;
      6) frame='⠦' ;;
      7) frame='⠧' ;;
      8) frame='⠇' ;;
      *) frame='⠏' ;;
    esac
    if [ -w "$TTY" ]; then
      printf '\r[rin-update] %s %s' "$frame" "$label" >"$TTY"
    fi
    i=$(( (i + 1) % 10 ))
    sleep 0.1
  done
}

run_step() {
  label=$1
  shift
  : >>"$LOGFILE"
  "$@" >>"$LOGFILE" 2>&1 &
  pid=$!
  render_spinner "$label" "$pid"
  set +e
  wait "$pid"
  status=$?
  set -e
  if [ -w "$TTY" ]; then
    if [ "$status" -eq 0 ]; then
      printf '\r[rin-update] ✓ %s\033[K\n' "$label" >"$TTY"
    else
      printf '\r[rin-update] ✗ %s\033[K\n' "$label" >"$TTY"
    fi
  fi
  if [ "$status" -ne 0 ]; then
    say "[rin-update] command failed; recent log:"
    tail -n 80 "$LOGFILE" >&2 || true
    exit "$status"
  fi
}

fetch() {
  URL=$1
  OUT=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$OUT"
    return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$OUT" "$URL"
    return 0
  fi
  echo "rin updater requires curl or wget" >&2
  exit 1
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stable)
        CHANNEL=stable
        ;;
      --beta)
        CHANNEL=beta
        ;;
      --git)
        CHANNEL=git
        ;;
      --branch)
        [ "$#" -ge 2 ] || { echo "missing value for --branch" >&2; exit 1; }
        BRANCH=$2
        shift
        ;;
      --version)
        [ "$#" -ge 2 ] || { echo "missing value for --version" >&2; exit 1; }
        VERSION=$2
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "unknown argument: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
    shift
  done

  if [ -n "$BRANCH" ] && [ -n "$VERSION" ]; then
    echo "cannot combine --branch and --version" >&2
    exit 1
  fi
  if [ "$CHANNEL" = stable ] && [ -n "$BRANCH" ]; then
    echo "stable does not support --branch" >&2
    exit 1
  fi
}

fetch_manifest() {
  RAW_BASE=$(printf '%s' "$REPO_URL" | sed -e 's#^https://github.com/#https://raw.githubusercontent.com/#' -e 's#\.git$##')
  PRIMARY_URL="$RAW_BASE/$BOOTSTRAP_BRANCH/release-manifest.json"
  FALLBACK_URL="$RAW_BASE/main/release-manifest.json"
  if ! fetch "$PRIMARY_URL" "$MANIFEST_PATH"; then
    fetch "$FALLBACK_URL" "$MANIFEST_PATH"
  fi
}

resolve_release() {
  node - "$MANIFEST_PATH" <<'NODE'
const fs = require('node:fs');
const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const channel = String(process.env.RIN_RELEASE_CHANNEL || 'stable').trim() || 'stable';
const branch = String(process.env.RIN_RELEASE_BRANCH || '').trim();
const version = String(process.env.RIN_RELEASE_VERSION || '').trim();
const repoUrl = String(process.env.RIN_INSTALL_REPO_URL || manifest.repoUrl || 'https://github.com/rinchanai/rin').trim().replace(/\.git$/i, '');
const buildArchiveUrl = (ref) => `${repoUrl}/archive/${String(ref || 'main').split('/').map(encodeURIComponent).join('/')}.tar.gz`;
const shellEscape = (value) => `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
let resolved;
if (channel === 'stable') {
  if (branch) throw new Error('stable channel does not support --branch');
  const entry = (manifest.stable && manifest.stable.versions && manifest.stable.versions[version]) || {};
  const resolvedVersion = version || String(manifest.stable?.version || '0.0.0');
  resolved = {
    channel,
    archiveUrl: String(entry.archiveUrl || manifest.stable?.archiveUrl || buildArchiveUrl(version || 'main')),
    version: resolvedVersion,
    branch: 'stable',
    ref: version || String(manifest.stable?.version || 'main'),
    sourceLabel: version ? `stable version ${resolvedVersion}` : `stable ${resolvedVersion}`,
  };
} else if (channel === 'beta') {
  if (version) {
    const entry = (manifest.beta && manifest.beta.versions && manifest.beta.versions[version]) || {};
    const resolvedBranch = String(entry.branch || manifest.beta?.defaultBranch || 'release/next');
    resolved = {
      channel,
      archiveUrl: String(entry.archiveUrl || buildArchiveUrl(version)),
      version,
      branch: resolvedBranch,
      ref: version,
      sourceLabel: `beta version ${version}`,
    };
  } else {
    const resolvedBranch = branch || String(manifest.beta?.defaultBranch || 'release/next');
    const entry = (manifest.beta && manifest.beta.branches && manifest.beta.branches[resolvedBranch]) || {};
    resolved = {
      channel,
      archiveUrl: String(entry.archiveUrl || buildArchiveUrl(resolvedBranch)),
      version: String(entry.version || '0.0.0-beta.0'),
      branch: resolvedBranch,
      ref: resolvedBranch,
      sourceLabel: `beta branch ${resolvedBranch}`,
    };
  }
} else {
  const resolvedRef = version || branch || String(manifest.git?.defaultBranch || 'main');
  resolved = {
    channel,
    archiveUrl: buildArchiveUrl(resolvedRef),
    version: version || resolvedRef,
    branch: branch || String(manifest.git?.defaultBranch || 'main'),
    ref: resolvedRef,
    sourceLabel: version ? `git ref ${resolvedRef}` : `git branch ${resolvedRef}`,
  };
}
const shellVars = {
  CHANNEL: resolved.channel,
  ARCHIVE_URL: resolved.archiveUrl,
  VERSION: resolved.version,
  BRANCH: resolved.branch,
  REF: resolved.ref,
  SOURCE_LABEL: resolved.sourceLabel,
};
for (const [key, value] of Object.entries(shellVars)) {
  console.log(`${key}=${shellEscape(value)}`);
}
NODE
}

parse_args "$@"
: >"$LOGFILE"
run_step "Fetching release manifest" fetch_manifest

eval "$(RIN_RELEASE_CHANNEL=$CHANNEL RIN_RELEASE_BRANCH=$BRANCH RIN_RELEASE_VERSION=$VERSION RIN_INSTALL_REPO_URL=$REPO_URL resolve_release)"

run_step "Fetching ${SOURCE_LABEL}" fetch "$ARCHIVE_URL" "$ARCHIVE"
mkdir -p "$SRC_DIR"
run_step "Preparing updater source" tar -xzf "$ARCHIVE" -C "$SRC_DIR" --strip-components=1

cd "$SRC_DIR"
if command -v npm >/dev/null 2>&1; then
  if [ -f package-lock.json ]; then
    run_step "Installing dependencies" npm ci --no-fund --no-audit
  else
    run_step "Installing dependencies" npm install --no-fund --no-audit
  fi
else
  echo "rin updater requires npm" >&2
  exit 1
fi

run_step "Building updater" npm run build
say "[rin-update] Launching updater from $SOURCE_LABEL..."

if [ -r /dev/tty ]; then
  env \
    RIN_INSTALL_MODE=update \
    RIN_RELEASE_CHANNEL="$CHANNEL" \
    RIN_RELEASE_VERSION="$VERSION" \
    RIN_RELEASE_BRANCH="$BRANCH" \
    RIN_RELEASE_REF="$REF" \
    RIN_RELEASE_SOURCE_LABEL="$SOURCE_LABEL" \
    RIN_RELEASE_ARCHIVE_URL="$ARCHIVE_URL" \
    node dist/app/rin-install/main.js </dev/tty >/dev/tty 2>&1
  exit $?
fi

env \
  RIN_INSTALL_MODE=update \
  RIN_RELEASE_CHANNEL="$CHANNEL" \
  RIN_RELEASE_VERSION="$VERSION" \
  RIN_RELEASE_BRANCH="$BRANCH" \
  RIN_RELEASE_REF="$REF" \
  RIN_RELEASE_SOURCE_LABEL="$SOURCE_LABEL" \
  RIN_RELEASE_ARCHIVE_URL="$ARCHIVE_URL" \
  node dist/app/rin-install/main.js
