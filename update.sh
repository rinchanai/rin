#!/bin/sh
set -eu

REPO_URL=${RIN_INSTALL_REPO_URL:-https://github.com/THE-cattail/rin}
CACHE_BASE=${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}
TMPDIR_BASE=${RIN_INSTALL_TMPDIR:-$CACHE_BASE/rin-update}
mkdir -p "$TMPDIR_BASE"
WORKDIR=$(mktemp -d "$TMPDIR_BASE/rin-update.XXXXXX")
ARCHIVE="$WORKDIR/rin.tar.gz"
SRC_DIR="$WORKDIR/src"
LOGFILE="$WORKDIR/update.log"
TARGETS_FILE="$WORKDIR/targets.tsv"
TTY=/dev/tty
USE_TTY=0
if [ -t 1 ] && [ -r "$TTY" ] 2>/dev/null; then
  USE_TTY=1
fi

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

say() {
  if [ "$USE_TTY" -eq 1 ]; then
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
    if [ "$USE_TTY" -eq 1 ]; then
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
  if [ "$USE_TTY" -eq 1 ]; then
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

discover_targets() {
  node - "$TARGETS_FILE" <<'NODE'
const fs = require('fs')
const path = require('path')

const outPath = process.argv[2]
const rows = []
const seen = new Set()

function add(targetUser, installDir, ownerHome, source) {
  const t = String(targetUser || '').trim()
  const i = String(installDir || '').trim()
  const h = String(ownerHome || '').trim()
  const s = String(source || '').trim()
  if (!t || !i || !h) return
  const key = `${t}\t${i}\t${h}`
  if (seen.has(key)) return
  seen.add(key)
  rows.push([t, i, h, s].join('\t'))
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return null }
}

function scanHome(homeDir) {
  const userName = path.basename(homeDir)
  const manifestPath = path.join(homeDir, '.rin', 'config', 'installer.json')
  const manifest = readJson(manifestPath)
  if (manifest && typeof manifest === 'object') {
    add(manifest.targetUser || userName, manifest.installDir || path.join(homeDir, '.rin'), homeDir, 'manifest')
  }

  const systemdDir = path.join(homeDir, '.config', 'systemd', 'user')
  try {
    for (const entry of fs.readdirSync(systemdDir)) {
      if (!/^rin-daemon(?:-.+)?\.service$/.test(entry)) continue
      const filePath = path.join(systemdDir, entry)
      const text = fs.readFileSync(filePath, 'utf8')
      const match = text.match(/^Environment=RIN_DIR=(.+)$/m)
      add(userName, match ? match[1].trim() : path.join(homeDir, '.rin'), homeDir, 'systemd')
    }
  } catch {}

  const launchAgentsDir = path.join(homeDir, 'Library', 'LaunchAgents')
  try {
    for (const entry of fs.readdirSync(launchAgentsDir)) {
      if (!/^com\.rin\.daemon\..+\.plist$/.test(entry)) continue
      const filePath = path.join(launchAgentsDir, entry)
      const text = fs.readFileSync(filePath, 'utf8')
      const match = text.match(/<key>RIN_DIR<\/key>\s*<string>([^<]+)<\/string>/)
      add(userName, match ? match[1].trim() : path.join(homeDir, '.rin'), homeDir, 'launchd')
    }
  } catch {}
}

for (const root of ['/home', '/Users']) {
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      scanHome(path.join(root, entry.name))
    }
  } catch {}
}

fs.writeFileSync(outPath, rows.join('\n') + (rows.length ? '\n' : ''))
NODE
}

prompt_target() {
  if [ ! -s "$TARGETS_FILE" ]; then
    say "[rin-update] No installed Rin daemon targets were discovered."
    exit 1
  fi

  say "[rin-update] Select an installed Rin target to update:"
  n=0
  while IFS='	' read -r target_user install_dir owner_home source; do
    n=$((n + 1))
    if [ "$USE_TTY" -eq 1 ]; then
      printf '  %s) target=%s installDir=%s ownerHome=%s source=%s\n' "$n" "$target_user" "$install_dir" "$owner_home" "$source" >"$TTY"
    else
      printf '  %s) target=%s installDir=%s ownerHome=%s source=%s\n' "$n" "$target_user" "$install_dir" "$owner_home" "$source"
    fi
  done <"$TARGETS_FILE"

  while :; do
    if [ "$USE_TTY" -eq 1 ]; then
      printf 'Enter selection [1-%s]: ' "$n" >"$TTY"
      IFS= read -r choice <"$TTY" || exit 1
    else
      printf 'Enter selection [1-%s]: ' "$n"
      IFS= read -r choice || exit 1
    fi
    case "$choice" in
      ''|*[!0-9]*) continue ;;
      *) if [ "$choice" -ge 1 ] && [ "$choice" -le "$n" ]; then break; fi ;;
    esac
  done

  selected=$(sed -n "${choice}p" "$TARGETS_FILE")
  TARGET_USER=$(printf '%s' "$selected" | cut -f1)
  INSTALL_DIR=$(printf '%s' "$selected" | cut -f2)
  export TARGET_USER INSTALL_DIR
  say "[rin-update] Selected target=$TARGET_USER installDir=$INSTALL_DIR"
}

ARCHIVE_URL="$REPO_URL/archive/refs/heads/main.tar.gz"
: >"$LOGFILE"
run_step "Discovering installed Rin targets" discover_targets
prompt_target
run_step "Fetching latest Rin from GitHub main" fetch "$ARCHIVE_URL" "$ARCHIVE"
mkdir -p "$SRC_DIR"
run_step "Preparing update source" tar -xzf "$ARCHIVE" -C "$SRC_DIR" --strip-components=1

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

run_step "Building latest Rin" npm run build
say "[rin-update] Publishing update..."

if [ "$USE_TTY" -eq 1 ] && [ -r /dev/tty ]; then
  exec env TARGET_USER="$TARGET_USER" INSTALL_DIR="$INSTALL_DIR" node - <<'NODE' </dev/tty >/dev/tty 2>&1
import { finalizeInstallPlan, detectCurrentUser } from './dist/core/rin-install/main.js'

const targetUser = String(process.env.TARGET_USER || '').trim()
const installDir = String(process.env.INSTALL_DIR || '').trim()
if (!targetUser || !installDir) throw new Error('rin_update_missing_target')
const result = await finalizeInstallPlan({
  currentUser: detectCurrentUser(),
  targetUser,
  installDir,
  sourceRoot: process.cwd(),
})
console.log(`rin update complete: ${result.publishedRuntime.releaseRoot}`)
NODE
fi

exec env TARGET_USER="$TARGET_USER" INSTALL_DIR="$INSTALL_DIR" node - <<'NODE'
import { finalizeInstallPlan, detectCurrentUser } from './dist/core/rin-install/main.js'

const targetUser = String(process.env.TARGET_USER || '').trim()
const installDir = String(process.env.INSTALL_DIR || '').trim()
if (!targetUser || !installDir) throw new Error('rin_update_missing_target')
const result = await finalizeInstallPlan({
  currentUser: detectCurrentUser(),
  targetUser,
  installDir,
  sourceRoot: process.cwd(),
})
console.log(`rin update complete: ${result.publishedRuntime.releaseRoot}`)
NODE
