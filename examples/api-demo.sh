#!/usr/bin/env bash
# The same pipeline through the REST API with curl and jq: the machine-readable path.
#
# demo.sh did the writing (publishing the four blocks, storing the pipeline), because that is what a
# person with a checkout and a token uses. This one reads what that left in the library, starts a run
# of the stored pipeline with typed JSON inputs, polls it, and follows a log by byte offset. It is
# the shape an agent or a CI job takes.
#
# Needs a server (examples/serve.sh) and BASHREACTOR_URL plus BASHREACTOR_TOKEN pointing at it, and
# demo.sh having stored the pipeline.
set -euo pipefail

if [[ -z "${BASHREACTOR_URL:-}" || -z "${BASHREACTOR_TOKEN:-}" ]]; then
  echo "set BASHREACTOR_URL and BASHREACTOR_TOKEN first; examples/serve.sh prints both" >&2
  exit 2
fi

base=${BASHREACTOR_URL%/}
token=$BASHREACTOR_TOKEN
home=${BASHREACTOR_HOME:-${TMPDIR:-/tmp}/bashreactor-demo}

failures=0
step() { printf '\n== %s\n' "$1"; }
note() { printf '         %s\n' "$1"; }
check() {
  if [[ "$2" == "$3" ]]; then
    printf 'ok       %s\n' "$1"
  else
    printf 'MISMATCH %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}
get() { curl -sS -H "authorization: Bearer $token" "$base$1"; }
post() { curl -sS -X POST -H "authorization: Bearer $token" -H 'content-type: application/json' -d "$2" "$base$1"; }

step "0. /healthz, which needs no token"
curl -sS "$base/healthz"
echo
check "who the token is" "admin" "$(get /v1/whoami | jq -r .scope)"

step "1. what the CLI put in the library"
if [[ "$(get /v1/pipelines/word-report | jq -r .name)" == "null" ]]; then
  echo "pipeline word-report is not stored; run examples/demo.sh first" >&2
  exit 1
fi
get /v1/blocks/generate-corpus | jq '{name, latest, sha256: .versions[-1].sha256}'
check "one version of each block" "1" "$(get /v1/blocks/generate-corpus | jq '.versions | length')"
# The stored document is the one the CLI rewrote: `uses: ./generate-corpus.sh` became a library
# reference, because the API resolves a run against its own staging directory and not your disk.
check "the stored pipeline uses library references" "4" \
  "$(get /v1/pipelines/word-report/latest | jq -r .yaml | grep -c 'uses: [a-z-]*@[0-9]*$')"

step "2. start a run of the stored pipeline, with typed inputs"
# The body carries the run's inputs as JSON, so `lines` is the integer 300 and not the string "300"
# (SPEC 3.3 checks them with the literal rule). 201 comes back as soon as the run exists and the
# engine drives it in the background, so this call never lasts as long as the run does.
created=$(post /v1/runs '{"pipeline":"word-report","inputs":{"lines":300,"seed":11,"title":"Other"}}')
if [[ "$(jq -r '.code // "none"' <<<"$created")" != "none" ]]; then
  echo "POST /v1/runs refused: $created" >&2
  exit 1
fi
id=$(jq -r .id <<<"$created")
check "201, and a run that has not run yet" "running" "$(jq -r .status <<<"$created")"
check "every step starts pending" "pending" "$(jq -r '[.steps[].status] | unique | .[]' <<<"$created")"
note "run $id"

step "3. poll it"
# No websocket, no callback: GET /v1/runs/:id is the whole of it and the answer is run.json, so a
# client that dies and comes back loses nothing.
for _ in $(seq 1 600); do
  run=$(get "/v1/runs/$id")
  status=$(jq -r .status <<<"$run")
  note "$status  $(jq -r '[.steps | to_entries[] | "\(.key)=\(.value.status)"] | join(" ")' <<<"$run")"
  [[ "$status" != "running" ]] && break
  sleep 0.2
done
check "the run succeeded" "succeeded" "$status"

step "4. follow a log by byte offset"
# The cursor is a byte offset into that attempt's log file (SPEC 4.8): read from 0, keep
# next_offset, ask again, get only what is new. The CLI's --follow and the web UI use the same
# cursor, which is what makes following a run that has been going for six hours cheap.
first=$(get "/v1/runs/$id/logs/generate/1?offset=0")
note "offset 0: $(jq -r '.text | split("\n")[0]' <<<"$first")"
check "the first read says where to come back with" "98" "$(jq -r .next_offset <<<"$first")"
rest=$(get "/v1/runs/$id/logs/generate/1?offset=42")
check "reading from 42 returns the second line and nothing before it" \
  "attempt 1: stopping after 120 lines, asking for a retry" "$(jq -r '.text | rtrimstr("\n")' <<<"$rest")"
check "it echoes the offset you asked for" "42" "$(jq -r .offset <<<"$rest")"
check "and the same end of file" "98" "$(jq -r .next_offset <<<"$rest")"
check "attempt 2 is a separate log" "attempt 2: 120 of 300 lines already written" \
  "$(get "/v1/runs/$id/logs/generate/2?offset=0" | jq -r '.text | split("\n")[0]')"

step "5. the results, against docs/examples/README.md"
check "total_words" "1950" "$(jq -r '.outputs.total_words' <<<"$run")"
check "the template built the title" "Other: 300 lines" "$(jq -r '.steps.report.with.title' <<<"$run")"
check "generate spent two of its three attempts" "2" "$(jq -r '.steps.generate.attempts_used' <<<"$run")"
check "the run kept the inputs it was given" '{"lines":300,"seed":11,"title":"Other"}' \
  "$(jq -c '.inputs' <<<"$run")"
note "the report:"
sed 's/^/         | /' "$home/runs/$id/steps/report/attempts/1/outputs/report"

step "6. every run, newest first"
get /v1/runs | jq -r '.[:4][] | [.id, .pipeline, .status] | @tsv'

printf '\n'
if (( failures )); then
  printf '%d outcome(s) did not match docs/examples/README.md.\n' "$failures"
  exit 1
fi
printf 'the API path matched docs/examples/README.md\n'
