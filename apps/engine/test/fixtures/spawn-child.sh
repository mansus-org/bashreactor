#!/usr/bin/env bash
# ---
# name: spawn-child
# description: Leaves a background child behind, so a timeout must kill the whole process group.
# outputs:
#   done:
#     type: string
# ---

sleep 300 &
echo "spawn-child: background pid $!"
sleep 300
echo "spawn-child: done" > "$OUTPUT_DONE"
