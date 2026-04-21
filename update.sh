#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
LOCAL_BOOTSTRAP_SCRIPT="$SCRIPT_DIR/scripts/bootstrap-entrypoint.sh"
if [ -f "$LOCAL_BOOTSTRAP_SCRIPT" ]; then
  exec sh "$LOCAL_BOOTSTRAP_SCRIPT" update "$@"
fi

REPO_URL=${RIN_INSTALL_REPO_URL:-https://github.com/rinchanai/rin}
BOOTSTRAP_BRANCH=${RIN_BOOTSTRAP_BRANCH:-stable-bootstrap}
RAW_BASE=$(printf '%s' "$REPO_URL" | sed -e 's#^https://github.com/#https://raw.githubusercontent.com/#' -e 's#\.git$##')
BOOTSTRAP_SCRIPT_URL=${RIN_BOOTSTRAP_SCRIPT_URL:-$RAW_BASE/$BOOTSTRAP_BRANCH/scripts/bootstrap-entrypoint.sh}
BOOTSTRAP_SCRIPT_FALLBACK_URL=${RIN_BOOTSTRAP_SCRIPT_FALLBACK_URL:-$RAW_BASE/main/scripts/bootstrap-entrypoint.sh}
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

fetch_with_fallback() {
  PRIMARY_URL=$1
  FALLBACK_URL=$2
  OUT=$3
  if fetch "$PRIMARY_URL" "$OUT"; then
    return 0
  fi
  if [ -n "$FALLBACK_URL" ] && [ "$FALLBACK_URL" != "$PRIMARY_URL" ]; then
    fetch "$FALLBACK_URL" "$OUT"
    return 0
  fi
  return 1
}

fetch_with_fallback "$BOOTSTRAP_SCRIPT_URL" "$BOOTSTRAP_SCRIPT_FALLBACK_URL" "$BOOTSTRAP_SCRIPT"
sh "$BOOTSTRAP_SCRIPT" update "$@"
