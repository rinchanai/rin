#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec env RIN_BOOTSTRAP_WRAPPER_MODE=update sh "$SCRIPT_DIR/install.sh" "$@"
