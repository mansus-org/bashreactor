#!/usr/bin/env bash
# The server the demo runs against.
#
# One process serves the web UI at /app and the API at /v1, because that is what the container runs:
# apps/web/src/server.ts is apps/api/src/main.ts with the UI mounted in front of it. Starting the
# API alone would leave the browser half of the demo with nothing to open.
#
# The data directory is a throwaway one so a demo cannot touch ~/.bashreactor, and it survives the
# server so you can look at the run directory afterwards (SPEC 4.2). Export BASHREACTOR_HOME before
# this script to keep the runs somewhere of your own.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

export BASHREACTOR_HOME="${BASHREACTOR_HOME:-${TMPDIR:-/tmp}/bashreactor-demo}"
export BASHREACTOR_ADMIN_TOKEN="${BASHREACTOR_ADMIN_TOKEN:-br_demo_admin}"
export PORT="${PORT:-8080}"
# What /healthz reports. The image sets this to the git tag it was built as.
export BASHREACTOR_VERSION="${BASHREACTOR_VERSION:-demo}"

mkdir -p "$BASHREACTOR_HOME"

cat >&2 <<EOF
bashreactor demo server
  data dir  $BASHREACTOR_HOME
  web UI    http://127.0.0.1:$PORT/app
  API       http://127.0.0.1:$PORT/v1
  token     $BASHREACTOR_ADMIN_TOKEN

That token is for a server on your own machine and for nothing else. In another terminal:

  export BASHREACTOR_URL=http://127.0.0.1:$PORT
  export BASHREACTOR_TOKEN=$BASHREACTOR_ADMIN_TOKEN

Ctrl-C stops the server. The runs stay in the data directory.
EOF

exec bun "$root/apps/web/src/server.ts"
