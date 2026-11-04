#!/usr/bin/env bash
# ---
# name: generate-corpus
# description: Write a reproducible text corpus, one line of words per line of output.
# inputs:
#   lines:
#     type: integer
#     description: How many lines to write.
#     default: 200
#   seed:
#     type: integer
#     description: The same seed and line count always produce the same bytes.
#     default: 7
#   interrupt_at:
#     type: integer
#     description: On attempt 1, stop after this many lines and ask to be retried. 0 never stops.
#     default: 0
# outputs:
#   corpus:
#     type: file
#     description: The corpus text.
#   line_count:
#     type: integer
#     description: How many lines the corpus has.
# ---

words=(amber birch cedar delta ember fjord grove heron inlet juniper kestrel larch)

# Each line depends only on the seed and its own number, so the result is byte-identical no matter
# how many attempts it took to write.
write_line() {
  local state=$(( (INPUT_SEED * 31 + $1) & 0x7fffffff ))
  local count=$(( 4 + state % 6 ))
  local line="" i
  for (( i = 0; i < count; i++ )); do
    state=$(( (state * 1103515245 + 12345) & 0x7fffffff ))
    line+="${words[(state >> 16) % ${#words[@]}]} "
  done
  printf '%s\n' "${line% }" >> corpus.partial
}

# The work directory survives retries and engine restarts, so a later attempt carries on from here
# instead of starting over.
touch corpus.partial
written=$(wc -l < corpus.partial)
echo "attempt $BR_ATTEMPT: $written of $INPUT_LINES lines already written"

for (( n = written + 1; n <= INPUT_LINES; n++ )); do
  if (( BR_ATTEMPT == 1 && INPUT_INTERRUPT_AT > 0 && n > INPUT_INTERRUPT_AT )); then
    echo "attempt $BR_ATTEMPT: stopping after $INPUT_INTERRUPT_AT lines, asking for a retry"
    exit 75
  fi
  write_line "$n"
done

wc -l < corpus.partial > "$OUTPUT_LINE_COUNT"
# The work directory and the outputs directory share a filesystem, so this move is cheap and the
# engine never sees a half-written artifact.
mv corpus.partial "$OUTPUT_CORPUS"
echo "attempt $BR_ATTEMPT: corpus finished"
