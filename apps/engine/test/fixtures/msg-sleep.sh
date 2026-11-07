#!/usr/bin/env bash
# ---
# name: msg-sleep
# description: Outlives any timeout this test would bother setting.
# outputs:
#   done:
#     type: string
# ---

echo "msg-sleep: going to sleep"
sleep 120
echo done > "$OUTPUT_DONE"
