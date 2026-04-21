#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
LOCAL_BOOTSTRAP_SCRIPT="$SCRIPT_DIR/scripts/bootstrap-entrypoint.sh"
if [ -f "$LOCAL_BOOTSTRAP_SCRIPT" ]; then
  exec sh "$LOCAL_BOOTSTRAP_SCRIPT" update "$@"
fi

BOOTSTRAP_SCRIPT_URL=${RIN_BOOTSTRAP_SCRIPT_URL:-https://raw.githubusercontent.com/rinchanai/rin/main/scripts/bootstrap-entrypoint.sh}
CACHE_BASE=${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}
TMPDIR_BASE=${RIN_INSTALL_TMPDIR:-$CACHE_BASE/rin-install}
mkdir -p "$TMPDIR_BASE"
BOOTSTRAP_SCRIPT=$(mktemp "$TMPDIR_BASE/bootstrap-entrypoint.XXXXXX.sh")
cleanup() {
  rm -f "$BOOTSTRAP_SCRIPT"
}
trap cleanup EXIT INT TERM

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

fetch "$BOOTSTRAP_SCRIPT_URL" "$BOOTSTRAP_SCRIPT"
sh "$BOOTSTRAP_SCRIPT" update "$@"
