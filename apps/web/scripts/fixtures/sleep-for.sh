#!/usr/bin/env bash
# ---
# name: sleep-for
# description: Work for a number of seconds, one log line a second.
# inputs:
#   seconds:
#     type: integer
#     description: How long to work.
#     default: 5
#   label:
#     type: string
#     description: What each log line starts with.
#     default: work
# ---

for (( i = 1; i <= INPUT_SECONDS; i++ )); do
  echo "$INPUT_LABEL: $i of $INPUT_SECONDS"
  sleep 1
done
