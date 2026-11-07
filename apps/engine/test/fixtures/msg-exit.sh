#!/usr/bin/env bash
# ---
# name: msg-exit
# description: Leaves with whatever code it is told to, so a failure message can be read for it.
# inputs:
#   code:
#     type: integer
#     description: The exit code to leave with.
# ---

echo "msg-exit: leaving with $INPUT_CODE" >&2
exit "$INPUT_CODE"
