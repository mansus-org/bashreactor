#!/usr/bin/env bash
# The scripted path through Bashreactor: store the blocks and the pipeline, run them, follow the
# logs, read the results, and check every number against docs/examples/README.md.
#
# This is what a person types, plus the two polling loops a script needs and a person typing the next
# command by hand does not. It fails loudly: an outcome that differs from the spec's worked example is
# a bug in this repo and is printed as MISMATCH, never smoothed over.
#
# Needs a server (examples/serve.sh) and BASHREACTOR_URL plus BASHREACTOR_TOKEN pointing at it.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pipeline="$root/docs/examples/word-report.yaml"
home="${BASHREACTOR_HOME:-${TMPDIR:-/tmp}/bashreactor-demo}"

if [[ -z "${BASHREACTOR_URL:-}" || -z "${BASHREACTOR_TOKEN:-}" ]]; then
  echo "set BASHREACTOR_URL and BASHREACTOR_TOKEN first; examples/serve.sh prints both" >&2
  exit 2
fi

cli() { bun "$root/apps/cli/src/bin.ts" "$@"; }

failures=0
step() { printf '\n== %s\n' "$1"; }
note() { printf '         %s\n' "$1"; }
check() { # check <what> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    printf 'ok       %s\n' "$1"
  else
    printf 'MISMATCH %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}
run_status() { cli runs get "$1" --json | jq -r .status; }
field() { cli runs get "$1" --json | jq -r "$2"; }

# wait_for_run is what `runs start --wait` does for you. wait_for_attempt is here because the demo
# follows a log while the run is still going, and the log route answers attempt_not_found until the
# engine has created that attempt. A person is slower than the engine, so only a script hits it.
wait_for_attempt() {
  local id=$1 step_id=$2 n=0
  for _ in $(seq 1 600); do
    n=$(cli runs get "$id" --json | jq -r --arg s "$step_id" '.steps[$s].attempts | length')
    [[ "$n" != "0" ]] && return 0
    sleep 0.1
  done
  echo "step $step_id of run $id never started" >&2
  return 1
}
wait_for_run() {
  local id=$1 status=running
  for _ in $(seq 1 1200); do
    status=$(run_status "$id")
    [[ "$status" != "running" ]] && return 0
    sleep 0.1
  done
  echo "run $id is still $status after two minutes" >&2
  return 1
}

# Copied from docs/examples/README.md, which is the authority. The engine's own tests read the same
# four blocks and assert the same numbers, so a mismatch here is a real regression.
readonly CORPUS_SHA=645ce2d768db71791d28a66e9e5b0f29e8c8799365cbf3f4da0580fa7c041393
readonly COUNTS_SHA=970c6e40e987cbce61f63b5397349f7892a1a29af5fcc12d60d13834f26a6b7b
readonly REPORT_SHA=f64f7bba5dd7e3982fd38008b6cab150f2e438e753f1eca60607be7fa1125075

step "0. is it up, and who am I"
cli health
cli whoami

step "1. store the four blocks and the pipeline"
# `pipelines validate` publishes every `uses: ./x.sh` beside the file into the library and checks
# the rewritten document; `pipelines add` stores that same document as a pipeline version. The API
# has no route that takes a directory of blocks, so this is the one surface that can do it from a
# checkout (apps/cli/README.md, "A pipeline file on your disk").
cli pipelines validate "$pipeline"
cli pipelines add word-report "$pipeline"
cli pipelines ls word-report

step "2. run it with the defaults, and follow the log while it runs"
start=$(cli runs start "$pipeline")
printf '%s\n' "$start"
id=$(printf '%s\n' "$start" | awk 'NR == 1 { print $2 }')
note "run id $id"
wait_for_attempt "$id" generate
cli runs logs "$id" generate --follow

step "3. wait for it, then read the whole run"
wait_for_run "$id"
cli runs get "$id"

step "4. exit 75, and the resume from the work directory (SPEC 2.8, 4.1)"
check "generate attempt 1 exit code" "75" "$(field "$id" '.steps.generate.attempts[0].exit_code')"
check "generate attempt 1 failure code" "retry_requested" "$(field "$id" '.steps.generate.attempts[0].failure.code')"
check "generate attempt 2 status" "succeeded" "$(field "$id" '.steps.generate.attempts[1].status')"
check "generate spent two of its three attempts" "2" "$(field "$id" '.steps.generate.attempts_used')"
check "attempt 1 log" "attempt 1: 0 of 200 lines already written
attempt 1: stopping after 120 lines, asking for a retry" "$(cli runs logs "$id" generate --attempt 1 2>/dev/null)"
check "attempt 2 log, carrying on where attempt 1 stopped" "attempt 2: 120 of 200 lines already written
attempt 2: corpus finished" "$(cli runs logs "$id" generate --attempt 2 2>/dev/null)"
# SPEC 2.5: a failed attempt's outputs are kept for debugging and never published. Attempt 1 kept
# its partial corpus in the work directory, not in its outputs directory, which is what let attempt 2
# carry on instead of starting over.
check "attempt 1 published nothing" "0" "$(find "$home/runs/$id/steps/generate/attempts/1/outputs" -type f | wc -l | tr -d ' ')"
check "the work directory survived the retry" "yes" "$(test -d "$home/runs/$id/steps/generate/work" && echo yes)"

step "5. the results, against docs/examples/README.md"
check "run status" "succeeded" "$(run_status "$id")"
check "total_words" "1300" "$(field "$id" '.outputs.total_words')"
check "report output path" "steps/report/attempts/1/outputs/report" "$(field "$id" '.outputs.report')"
check "generate line_count" "200" "$(field "$id" '.steps.generate.outputs.line_count')"
check "report_bytes" "163" "$(field "$id" '.steps.report.outputs.report_bytes')"
check "top_words" '[{"word":"amber","count":114},{"word":"larch","count":114},{"word":"fjord","count":113},{"word":"delta","count":110},{"word":"cedar","count":109}]' "$(field "$id" '.steps.count.outputs.top_words | tojson')"
check "count log" "count-words: 1300 words, 12 distinct" "$(cli runs logs "$id" count 2>/dev/null | head -1)"
check "report log" "render-report: 163 bytes" "$(cli runs logs "$id" report 2>/dev/null | head -1)"
check "sha256 of corpus" "$CORPUS_SHA" "$(sha256sum "$home/runs/$id/steps/generate/attempts/2/outputs/corpus" | cut -d' ' -f1)"
check "sha256 of counts" "$COUNTS_SHA" "$(sha256sum "$home/runs/$id/steps/count/attempts/1/outputs/counts" | cut -d' ' -f1)"
check "sha256 of report" "$REPORT_SHA" "$(sha256sum "$home/runs/$id/steps/report/attempts/1/outputs/report" | cut -d' ' -f1)"
check "a published file is read-only" "444" "$(stat -c %a "$home/runs/$id/steps/report/attempts/1/outputs/report")"
printf '         the report, byte for byte:\n'
sed 's/^/         | /' "$home/runs/$id/steps/report/attempts/1/outputs/report"

step "6. the gate: exit 78 never spends the retry budget, and unrelated work carries on"
# lines=50 is below check's min_lines, so check exits 78 (block_fatal). Its retry says
# max_attempts: 2 and must not use any of it. report needs check, so it is skipped; count does not
# need it, so it finishes. Three hard cases in one run.
rc=0
out=$(cli runs start "$pipeline" --input lines=50 --wait) || rc=$?
printf '%s\n' "$out"
short=$(printf '%s\n' "$out" | awk 'NR == 1 { print $2 }')
note "run id $short"
check "waiting for a failed run exits 1" "1" "$rc"
check "run status" "failed" "$(run_status "$short")"
check "a failed run has no outputs" "null" "$(field "$short" '.outputs | tojson')"
check "generate succeeded, and never reached interrupt_at" "succeeded/1" "$(field "$short" '.steps.generate | "\(.status)/\(.attempts_used)"')"
check "check is block_fatal after one attempt of two" "failed/1/block_fatal" "$(field "$short" '.steps.check | "\(.status)/\(.attempts_used)/\(.failure.code)"')"
check "count carried on" "succeeded/1" "$(field "$short" '.steps.count | "\(.status)/\(.attempts_used)"')"
check "report was skipped, with no attempts and no with" "skipped/0/null" "$(field "$short" '.steps.report | "\(.status)/\(.attempts_used)/\(.with | tostring)"')"
check "count still published its outputs" "object" "$(field "$short" '.steps.count.outputs | type')"
check "check log" "check-corpus: 50 lines, need at least 100" "$(cli runs logs "$short" check --attempt 1 2>/dev/null)"

step "7. a run is a directory you can read (SPEC 4.2)"
find "$home/runs/$id" -maxdepth 3 -mindepth 1 | sed "s|$home/runs/$id|.|" | sort | sed 's/^/         /'

printf '\n'
if (( failures )); then
  printf '%d outcome(s) did not match docs/examples/README.md. That is a bug, not something to work around.\n' "$failures"
  exit 1
fi
printf 'every outcome matched docs/examples/README.md\n'
