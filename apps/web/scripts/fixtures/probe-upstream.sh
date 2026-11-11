#!/usr/bin/env bash
# ---
# name: probe-upstream
# description: Ask whether the upstream export is ready; it never is, so the step keeps waiting.
# ---

echo "probe-upstream: export not ready yet" >&2
exit 75
