#!/usr/bin/env bash
# ---
# name: msg-kill
# description: Kills its own bash with SIGKILL, so the attempt ends on a signal.
# outputs:
#   done:
#     type: string
# ---

echo "msg-kill: goodbye"
kill -9 $$
