#!/bin/sh
set -eu

REPO_URL=${RIN_INSTALL_REPO_URL:-https://github.com/THE-cattail/rin}
CACHE_BASE=${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}
TMPDIR_BASE=${RIN_INSTALL_TMPDIR:-$CACHE_BASE/rin-install}
mkdir -p "$TMPDIR_BASE"
WORKDIR=$(mktemp -d "$TMPDIR_BASE/rin-update.XXXXXX")
ARCHIVE="$WORKDIR/rin.tar.gz"
SRC_DIR="$WORKDIR/src"
LOGFILE="$WORKDIR/update.log"
TTY=/dev/tty

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

ARCHIVE_URL="$REPO_URL/archive/refs/heads/main.tar.gz"
: >"$LOGFILE"
run_step "Fetching updater from GitHub main" fetch "$ARCHIVE_URL" "$ARCHIVE"
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
say "[rin-update] Launching updater..."

if [ -r /dev/tty ]; then
  exec env RIN_INSTALL_MODE=update node dist/app/rin-install/main.js </dev/tty >/dev/tty 2>&1
fi

exec env RIN_INSTALL_MODE=update node dist/app/rin-install/main.js
