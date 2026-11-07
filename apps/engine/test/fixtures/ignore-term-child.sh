#!/usr/bin/env bash
# ---
# name: ignore-term-child
# description: Ignores SIGTERM, and leaves a child behind that ignores it too.
# ---

trap '' TERM

# The `|| true` on every sleep matters, in the child as much as here: the SIGTERM sent to the group
# kills the sleep itself, and bash takes the death of a job killed by SIGTERM as its own cue to leave.
# Left alone, the block would look like it obeyed the TERM and the escalation would never be tested.
# The child sets its own trap and prints its own pid, so a test can watch a process that nothing but
# the SIGKILL after the grace can end.
bash -c 'trap "" TERM; echo "background pid $$"; while :; do sleep 1 || true; done' &
while :; do sleep 1 || true; done
