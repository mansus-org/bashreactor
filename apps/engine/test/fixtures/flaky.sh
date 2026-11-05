#!/usr/bin/env bash
# ---
# name: flaky
# description: Fails once with exit 75, then succeeds on a later attempt using its work directory.
# outputs:
#   result:
#     type: string
#     description: The word "done".
# ---

if [ -f marker ]; then
  echo done > "$OUTPUT_RESULT"
  echo "second attempt: finished"
else
  touch marker
  echo "first attempt: asking for a retry"
  exit 75
fi
