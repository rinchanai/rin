#!/bin/sh
set -eu

REPO_URL=${RIN_INSTALL_REPO_URL:-https://github.com/THE-cattail/rin}
BRANCH=${RIN_INSTALL_BRANCH:-main}
TMPDIR_BASE=${TMPDIR:-/tmp}
WORKDIR=$(mktemp -d "$TMPDIR_BASE/rin-install.XXXXXX")
ARCHIVE="$WORKDIR/rin.tar.gz"
SRC_DIR="$WORKDIR/src"
LOGFILE="$WORKDIR/install.log"
LAUNCHER="$WORKDIR/launcher.mjs"
HAS_TTY=0

if tty -s 2>/dev/null; then
  exec 3>/dev/tty 4</dev/tty
  HAS_TTY=1
fi

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

say() {
  if [ "$HAS_TTY" -eq 1 ]; then
    printf '%s\n' "$1" >&3
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
    if [ "$HAS_TTY" -eq 1 ]; then
      printf '\r[rin-install] %s %s\033[K' "$frame" "$label" >&3
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
  if wait "$pid"; then
    status=0
  else
    status=$?
  fi
  if [ "$HAS_TTY" -eq 1 ]; then
    if [ "$status" -eq 0 ]; then
      printf '\r[rin-install] ✓ %s\033[K\n' "$label" >&3
    else
      printf '\r[rin-install] ✗ %s\033[K\n' "$label" >&3
    fi
  fi
  if [ "$status" -ne 0 ]; then
    say "[rin-install] command failed; recent log:"
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
  echo "rin installer requires curl or wget" >&2
  exit 1
}

ARCHIVE_URL="$REPO_URL/archive/refs/heads/$BRANCH.tar.gz"
: >"$LOGFILE"
run_step "Fetching installer from GitHub main" fetch "$ARCHIVE_URL" "$ARCHIVE"
mkdir -p "$SRC_DIR"
run_step "Preparing installer source" tar -xzf "$ARCHIVE" -C "$SRC_DIR" --strip-components=1

cd "$SRC_DIR"
if command -v npm >/dev/null 2>&1; then
  if [ -f package-lock.json ]; then
    run_step "Installing dependencies" npm ci --no-fund --no-audit --silent --loglevel=error
  else
    run_step "Installing dependencies" npm install --no-fund --no-audit --silent --loglevel=error
  fi
else
  echo "rin installer requires npm" >&2
  exit 1
fi

cat >"$LAUNCHER" <<'EOF'
import jiti from './src/node_modules/@mariozechner/jiti/lib/jiti.mjs'

const loader = jiti(import.meta.url, { interopDefault: true, moduleCache: true })
const mod = await loader.import('./src/src/core/rin-install/main.ts')
await mod.startInstaller()
EOF

say "[rin-install] Launching installer..."

if [ "$HAS_TTY" -eq 1 ]; then
  cd "$WORKDIR"
  exec node "$LAUNCHER" <&4 >&3 2>&1
fi

cd "$WORKDIR"
exec node "$LAUNCHER"
