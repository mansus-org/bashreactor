#!/usr/bin/env bash
# The worked example over the REST API with nothing but curl and jq, into an empty library.
#
# demo.sh is what a person with a checkout runs: bun, the CLI, a server on their own machine. This is
# what a CI job runs when the thing under test is the *image*: the server is a container, the runner
# installs nothing to talk to it, and every block runs inside that container — including count-words,
# which makes uv fetch a Python under uid 10001 on musl, the one thing in the image that no amount of
# `command -v` proves.
#
# Point it at a server with a token that can write, because publishing is a write and the API is
# disabled without an admin token at all (apps/api/src/auth.ts):
#
#   BASHREACTOR_URL=http://localhost:8080 BASHREACTOR_TOKEN=... examples/image-demo.sh
#
# It publishes the four blocks itself, so it wants a library that holds nothing but them. A container
# that has just started is exactly that; a shared server is not, and the version numbers it reads back
# would then be somebody else's.
set -euo pipefail

base="${BASHREACTOR_URL:-http://localhost:8080}"
token="${BASHREACTOR_TOKEN:?BASHREACTOR_TOKEN has to be a token that can write}"
blocks="$(cd "$(dirname "${BASH_SOURCE[0]}")/../docs/examples" && pwd)"
pipeline="$blocks/word-report.yaml"

# The numbers docs/examples/word-report.yaml documents. If one of these moves, the example moved and
# the spec moved with it: change both together, or the image job is telling you something.
TOTAL_WORDS=1300
REPORT_BYTES=163

failures=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf 'ok        %s\n' "$label"
  else
    printf 'MISMATCH  %s\n          expected: %s\n          actual:   %s\n' "$label" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

get() { curl -sS -H "authorization: Bearer $token" "$base$1"; }
post() { curl -sS -H "authorization: Bearer $token" -H 'content-type: application/json' -d "$2" "$base$1"; }

# A response is its own verdict: the API answers an error with a code, and 201 with the stored object.
# Checking here rather than at the assertion is what makes a refused publish say so where it happened.
accepted() {
  local label="$1" response="$2" code
  code="$(jq -r '.code // "ok"' <<<"$response")"
  if [[ "$code" == "ok" ]]; then
    printf 'ok        %s\n' "$label"
  else
    printf 'MISMATCH  %s\n          %s\n' "$label" "$response"
    failures=$((failures + 1))
  fi
}

echo "=== $base holds nothing yet ==="
check "the block library starts empty" "0" "$(get /v1/blocks | jq '(.items // []) | length')"

echo
echo "=== publishing the four blocks ==="
sed_args=()
for name in generate-corpus check-corpus count-words render-report; do
  response="$(post "/v1/blocks/$name/versions" "$(jq -Rs '{content: .}' "$blocks/$name.sh")")"
  accepted "publish $name" "$response"
  # The store gives back the version it wrote, which is 1 the first time and the same number every
  # time after: the same bytes are never stored twice.
  sed_args+=(-e "s|uses: \./$name\.sh|uses: $name@$(jq -r '.version' <<<"$response")|")
done

echo
echo "=== storing the pipeline ==="
# The API resolves `uses` against the library and not against this disk (SPEC 3.4), so the file's
# `./x.sh` paths have to become `x@n` before the server will take the document at all.
yaml="$(sed -E "${sed_args[@]}" "$pipeline")"
accepted "store word-report" "$(post /v1/pipelines/word-report/versions "$(jq -Rs '{yaml: .}' <<<"$yaml")")"

echo
echo "=== running it ==="
response="$(post /v1/runs '{"pipeline":"word-report"}')"
accepted "start the run" "$response"
run="$(jq -r '.id // ""' <<<"$response")"
if [[ -z "$run" ]]; then
  echo "the run never started, so there is nothing left to measure." >&2
  exit 1
fi

for _ in $(seq 1 120); do
  record="$(get "/v1/runs/$run")"
  status="$(jq -r '.status // "unreadable"' <<<"$record")"
  [[ "$status" == "running" ]] || break
  sleep 1
done
echo "run $run finished as $status after ${SECONDS}s on the clock"

# A run that did not succeed is worth reading, and there is no filesystem to read it from afterwards.
if [[ "$status" != "succeeded" ]]; then
  for step in $(jq -r '.steps | keys[]?' <<<"$record"); do
    attempt="$(jq -r --arg step "$step" '.steps[$step].attempts[-1].n // ""' <<<"$record")"
    # A step that never ran has no log to show, and asking for attempt "null" only muddies the output.
    [[ -n "$attempt" ]] || continue
    printf -- '--- %s, attempt %s: %s\n' "$step" "$attempt" \
      "$(jq -r --arg step "$step" '.steps[$step].status' <<<"$record")" >&2
    get "/v1/runs/$run/logs/$step/$attempt" | jq -r '.text // .' >&2
  done
fi

echo
echo "=== the numbers ==="
check "the pipeline succeeded" "succeeded" "$status"
check "generate used both attempts" "2" "$(jq -r '.steps.generate.attempts_used' <<<"$record")"
check "total_words" "$TOTAL_WORDS" "$(jq -r '.outputs.total_words' <<<"$record")"
# The line uv's Python printed, from inside the container: proof the interpreter was fetched and run
# there, which is the reason this job exists.
check "count-words said it ran" "count-words: $TOTAL_WORDS words, 12 distinct" \
  "$(get "/v1/runs/$run/logs/count/1" | jq -r '(.text // "") | split("\n")[0]')"
check "report_bytes" "$REPORT_BYTES" "$(jq -r '.steps.report.outputs.report_bytes' <<<"$record")"
check "the report is where the spec says" "steps/report/attempts/1/outputs/report" \
  "$(jq -r '.outputs.report' <<<"$record")"

report="$(mktemp)"
trap 'rm -f "$report"' EXIT
path="$(jq -r '.outputs.report // ""' <<<"$record")"
if [[ -n "$path" ]]; then
  curl -sS -G -H "authorization: Bearer $token" "$base/v1/runs/$run/file" \
    --data-urlencode "path=$path" -o "$report"
fi
check "the report the server served is $REPORT_BYTES bytes" "$REPORT_BYTES" "$(wc -c <"$report" | tr -d ' ')"

echo
echo "=== the report, as the server gave it back ==="
cat "$report"

if ((failures > 0)); then
  echo
  echo "$failures value(s) did not match what the worked example is supposed to produce."
  exit 1
fi
