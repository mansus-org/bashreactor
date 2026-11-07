#!/usr/bin/env bash
# ---
# name: exit-code
# description: Leaves with the code it is handed; on 0 it publishes its output first.
# inputs:
#   exit_code:
#     type: integer
#     default: 75
#     description: The status to leave with.
#   note:
#     type: string
#     default: ""
# outputs:
#   done:
#     type: string
# ---

echo "attempt ${BR_ATTEMPT}: leaving ${INPUT_EXIT_CODE} note=${INPUT_NOTE}"
if [ "$INPUT_EXIT_CODE" = "0" ]; then echo done > "$OUTPUT_DONE"; fi
exit "$INPUT_EXIT_CODE"
