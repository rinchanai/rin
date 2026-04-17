#!/bin/sh
set -eu

MODE=${1:-install}
case "$MODE" in
  install)
    PREFIX=rin-install
    WORK_PREFIX=rin-install
    LOG_NAME=install.log
    FETCH_LABEL='Fetching installer from GitHub main'
    PREP_LABEL='Preparing installer source'
    BUILD_LABEL='Building installer'
    LAUNCH_LABEL='Launching installer...'
    FETCH_ERROR='rin installer requires curl or wget'
    NPM_ERROR='rin installer requires npm'
    NODE_ENV_PREFIX=
    ;;
  update)
    PREFIX=rin-update
    WORK_PREFIX=rin-update
    LOG_NAME=update.log
    FETCH_LABEL='Fetching updater from GitHub main'
    PREP_LABEL='Preparing updater source'
    BUILD_LABEL='Building updater'
    LAUNCH_LABEL='Launching updater...'
    FETCH_ERROR='rin updater requires curl or wget'
    NPM_ERROR='rin updater requires npm'
    NODE_ENV_PREFIX='RIN_INSTALL_MODE=update '
    ;;
  *)
    echo "unknown Rin bootstrap mode: $MODE" >&2
    exit 64
    ;;
 esac

REPO_URL=${RIN_INSTALL_REPO_URL:-https://github.com/rinchanai/rin}
CACHE_BASE=${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}
TMPDIR_BASE=${RIN_INSTALL_TMPDIR:-$CACHE_BASE/rin-install}
mkdir -p "$TMPDIR_BASE"
WORKDIR=$(mktemp -d "$TMPDIR_BASE/$WORK_PREFIX.XXXXXX")
ARCHIVE="$WORKDIR/rin.tar.gz"
SRC_DIR="$WORKDIR/src"
LOGFILE="$WORKDIR/$LOG_NAME"
TTY=/dev/tty

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

has_tty() {
  [ -t 0 ] && [ -t 1 ] && [ -r "$TTY" ] 2>/dev/null && [ -w "$TTY" ] 2>/dev/null
}

say() {
  if has_tty; then
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
    if has_tty; then
      printf '\r[%s] %s %s' "$PREFIX" "$frame" "$label" >"$TTY"
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
  if has_tty; then
    if [ "$status" -eq 0 ]; then
      printf '\r[%s] ✓ %s\033[K\n' "$PREFIX" "$label" >"$TTY"
    else
      printf '\r[%s] ✗ %s\033[K\n' "$PREFIX" "$label" >"$TTY"
    fi
  fi
  if [ "$status" -ne 0 ]; then
    say "[$PREFIX] command failed; recent log:"
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
  echo "$FETCH_ERROR" >&2
  exit 1
}

ARCHIVE_URL="$REPO_URL/archive/refs/heads/main.tar.gz"
: >"$LOGFILE"
run_step "$FETCH_LABEL" fetch "$ARCHIVE_URL" "$ARCHIVE"
mkdir -p "$SRC_DIR"
run_step "$PREP_LABEL" tar -xzf "$ARCHIVE" -C "$SRC_DIR" --strip-components=1

cd "$SRC_DIR"
if command -v npm >/dev/null 2>&1; then
  if [ -f package-lock.json ]; then
    run_step "Installing dependencies" npm ci --no-fund --no-audit
  else
    run_step "Installing dependencies" npm install --no-fund --no-audit
  fi
else
  echo "$NPM_ERROR" >&2
  exit 1
fi

run_step "$BUILD_LABEL" npm run build
say "[$PREFIX] $LAUNCH_LABEL"

if has_tty; then
  sh -lc "${NODE_ENV_PREFIX}node dist/app/rin-install/main.js" </dev/tty >/dev/tty 2>&1
  exit $?
fi

sh -lc "${NODE_ENV_PREFIX}node dist/app/rin-install/main.js"
