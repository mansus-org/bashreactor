#!/usr/bin/env bash
# ---
# name: trap-term
# description: Saves progress when told to stop, and finishes at once when it finds that progress.
# outputs:
#   done:
#     type: string
# ---

if [ -f saved ]; then
  echo "trap-term: resuming from saved progress"
  echo resumed > "$OUTPUT_DONE"
  exit 0
fi

# The trap runs only once the foreground sleep has ended, which SIGTERM to the group takes care of.
trap 'echo progress > saved; exit 143' TERM
echo "trap-term: working"
sleep 60 &
wait
