#!/usr/bin/env bash
# ---
# name: slow
# description: Sleeps long enough that a test can cancel it mid-run.
# outputs:
#   done:
#     type: string
# ---

echo "slow: starting"
sleep 60
echo "slow: done" > "$OUTPUT_DONE"
