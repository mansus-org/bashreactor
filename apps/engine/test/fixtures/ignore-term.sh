#!/usr/bin/env bash
# ---
# name: ignore-term
# description: Ignores SIGTERM, so only SIGKILL ends it.
# ---

trap '' TERM
echo "ignore-term: working"
while true; do sleep 1; done
