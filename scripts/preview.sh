#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
MODE=${1:-fixture}
case "$MODE" in fixture) FLAG=-fixture ;; real) FLAG= ;; *) echo "usage: $0 [fixture|real]" >&2; exit 2 ;; esac
exec go run ./core/cmd/kafeitv $FLAG -port "${KAFEI_PORT:-0}" -instance-id preview
