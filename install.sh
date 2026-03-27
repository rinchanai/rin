#!/bin/sh
set -eu

REPO_URL=${RIN_INSTALL_REPO_URL:-https://github.com/THE-cattail/rin}
BRANCH=${RIN_INSTALL_BRANCH:-main}
TMPDIR_BASE=${TMPDIR:-/tmp}
WORKDIR=$(mktemp -d "$TMPDIR_BASE/rin-install.XXXXXX")
ARCHIVE="$WORKDIR/rin.tar.gz"
SRC_DIR="$WORKDIR/src"

cleanup() {
  rm -rf "$WORKDIR"
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
  echo "rin installer requires curl or wget" >&2
  exit 1
}

ARCHIVE_URL="$REPO_URL/archive/refs/heads/$BRANCH.tar.gz"
echo "[rin-install] fetching installer from GitHub main..."
fetch "$ARCHIVE_URL" "$ARCHIVE"
mkdir -p "$SRC_DIR"
tar -xzf "$ARCHIVE" -C "$SRC_DIR" --strip-components=1

cd "$SRC_DIR"
if command -v npm >/dev/null 2>&1; then
  if [ -f package-lock.json ]; then
    npm ci --no-fund --no-audit
  else
    npm install --no-fund --no-audit
  fi
else
  echo "rin installer requires npm" >&2
  exit 1
fi

npm run build

if [ -r /dev/tty ]; then
  exec node dist/app/rin-install/main.js </dev/tty >/dev/tty 2>&1
fi

exec node dist/app/rin-install/main.js
