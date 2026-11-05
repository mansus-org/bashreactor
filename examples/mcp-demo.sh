#!/usr/bin/env bash
# The same run again through the MCP server, so you can see the tools an agent would call.
#
# The MCP server is a front for the REST API: same token, same scopes, same error object. It starts
# on its own port and keeps no state of its own, so this script brings it up, calls the read tools
# that cover the steps demo.sh and api-demo.sh already did, and takes it back down. It starts no run
# of its own on purpose: a fourth copy of the same run would prove nothing.
#
# Needs a server (examples/serve.sh) and BASHREACTOR_URL plus BASHREACTOR_TOKEN pointing at it.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [[ -z "${BASHREACTOR_URL:-}" || -z "${BASHREACTOR_TOKEN:-}" ]]; then
  echo "set BASHREACTOR_URL and BASHREACTOR_TOKEN first; examples/serve.sh prints both" >&2
  exit 2
fi

token=$BASHREACTOR_TOKEN
port=${BASHREACTOR_MCP_PORT:-8090}
url="http://127.0.0.1:$port/mcp"
log=$(mktemp)
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

export BASHREACTOR_MCP_PORT=$port
bun "$root/apps/mcp/src/main.ts" >"$log" 2>&1 &
mcp_pid=$!
trap 'kill "$mcp_pid" 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do
  grep -q 'listening on' "$log" && break
  sleep 0.1
done
note "$(cat "$log")"

call() { # call <tool> <arguments as JSON>
  curl -sS -X POST "$url" \
    -H "authorization: Bearer $token" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" |
    jq -r '.result.content[0].text'
}

step "0. the server is up, and what it fronts"
curl -sS "http://127.0.0.1:$port/healthz"
echo
check "whoami through a tool" "admin" "$(call whoami '{}' | jq -r .scope)"

step "1. the tools"
tools=$(curl -sS -X POST "$url" -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
note "$(jq -r '[.result.tools[].name] | join(" ")' <<<"$tools")"
check "one tool per route the API offers" "19" "$(jq -r '.result.tools | length' <<<"$tools")"

step "2. the library, and a block's contract"
check "list_block_versions" "1" "$(call list_block_versions '{"name":"generate-corpus"}' | jq '.versions | length')"
# get_block_content is the tool worth its name here: a block's contract is its header, and no other
# surface hands you the whole file this cheaply.
check "get_block_content returns the block itself" "# name: generate-corpus" \
  "$(call get_block_content '{"name":"generate-corpus","version":"latest"}' | jq -r .content | sed -n '3p')"
check "get_pipeline_version sees the stored pipeline" "word-report" \
  "$(call get_pipeline_version '{"name":"word-report","version":"latest"}' | jq -r .name)"

step "3. the runs the other two scripts started"
id=$(call list_runs '{}' | jq -r '.[0].id // "none"')
if [[ "$id" == "none" ]]; then
  echo "no runs yet; run examples/demo.sh first" >&2
  exit 1
fi
note "newest run $id"
lines=$(call get_run "{\"id\":\"$id\"}" | jq -r .inputs.lines)
check "get_run" "word-report" "$(call get_run "{\"id\":\"$id\"}" | jq -r .pipeline)"
check "get_run_log returns that attempt's own first line" "attempt 1: 0 of $lines lines already written" \
  "$(call get_run_log "{\"id\":\"$id\",\"step\":\"generate\",\"attempt\":1,\"offset\":0}" | jq -r '.text | split("\n")[0]')"
check "and says where to come back with" "yes" \
  "$([[ "$(call get_run_log "{\"id\":\"$id\",\"step\":\"generate\",\"attempt\":1,\"offset\":0}" | jq -r .next_offset)" -gt 0 ]] && echo yes)"

step "4. the tools this demo did not need"
note "write: store_block_version, store_pipeline_version, start_run, cancel_run, retry_run, resume_run"
note "admin: list_agent_tokens, create_agent_token, revoke_agent_token"
note "A read token is refused every write tool by name, in the API's own words, and the tool stays in"
note "tools/list so an agent can find out why it could not do something."

printf '\n'
if (( failures )); then
  printf '%d outcome(s) did not match.\n' "$failures"
  exit 1
fi
printf 'the MCP path matched the API path\n'
