#!/bin/sh
set -eu

exec sh "$(dirname "$0")/scripts/bootstrap-entrypoint.sh" install
