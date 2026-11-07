#!/usr/bin/env bash
# ---
# name: msg-half-written
# description: Writes one of its two declared outputs and forgets the other.
# outputs:
#   report:
#     type: file
#     description: The one it does write.
#   count:
#     type: integer
#     description: The one it does not.
# ---

echo "one line" > "$OUTPUT_REPORT"
echo "msg-half-written: forgot to write the count"
