# Deploying bashreactor.mansus.org

What the image runs, what is already wired end to end, and what still needs somebody with cluster
access. The platform side — the ApplicationSet, Image Updater, cert-manager, the ingress class — is
documented in the orchestration repo (`bashreactor-orchestration/ARGOCD.md`); this file is only
about this repo's half: `Dockerfile`, `.k3s/values.yaml`, and the two things that were not wired.

## One process, one port

`Dockerfile` builds `apps/web/src/server.ts` and its `CMD` is `bun server.js`. That one process
answers, on port 8080:

| Path | What it is |
| --- | --- |
| `/` | 302 to `/app/` |
| `/app` | the web UI (BASHR-8) |
| `/v1` | the REST API (BASHR-5) |
| `/mcp` | the MCP endpoint (BASHR-6) |
| `/healthz` | readiness, and the only path that answers without a token |

The chart renders one container and one Service port, and the ingress routes `/` Prefix to it, so
all five are published by the same rule and `/mcp` needed no route of its own.

**Why the MCP endpoint is in this process** rather than a second container or a second process in the
pod: the platform chart (`charts/app` in `nemoNoboru/k3s-hetzner-gitops`) renders exactly one
container and one Service port, so a second container is a change to a repo this one does not own
and its port would have no Service port and no route either way; and a second process in one
container dies silently while the pod still reads Ready, because the readiness probe only ever asks
`/healthz`, which is the API's. Mounted in the API's process it is reachable through what already
exists, it spends the caller's bearer token on the API exactly as the CLI and the web UI do, and it
cannot be up while the API is down. `apps/mcp/src/main.ts` still exists and still runs the same
server on a port of its own for local use (`bashreactor-mcp`, or `bun apps/mcp/src/main.ts`).

## The admin token chain

`.k3s/values.yaml` → `BASHREACTOR_ADMIN_TOKEN_SHA256` from the `bashreactor-secrets` secret,
`optional: true` → `resolveConfig` in `apps/api/src/config.ts` → every `/v1` route. The sealed
value is in `.k3s/values.yaml` itself, encrypted for the `bashreactor` namespace, so the token
never appears in this repo and only its SHA-256 does.

Verified by running the entry the image runs (`bun apps/web/src/server.ts`, `BASHREACTOR_HOME` a
temp directory) with and without the variable:

Without it — the process still starts, and says so on stdout:

```
$ env -u BASHREACTOR_ADMIN_TOKEN -u BASHREACTOR_ADMIN_TOKEN_SHA256 \
    BASHREACTOR_HOME=/tmp/tok-a PORT=18091 bun apps/web/src/server.ts
bashreactor listening on :18091
bashreactor: /v1 is disabled, no admin token is set in the environment

$ curl -sS -w ' [%{http_code}]\n' http://127.0.0.1:18091/v1/whoami
{"code":"runtime_missing","message":"the API is disabled: set BASHREACTOR_ADMIN_TOKEN or BASHREACTOR_ADMIN_TOKEN_SHA256 on the server"} [503]
$ curl -sS -w ' [%{http_code}]\n' http://127.0.0.1:18091/healthz
{"status":"ok","version":"0.0.0"} [200]
```

With only the hash, which is all the chart ever sets:

```
$ env -u BASHREACTOR_ADMIN_TOKEN BASHREACTOR_ADMIN_TOKEN_SHA256=$(printf '%s' 'a-probe-token' | sha256sum | cut -d' ' -f1) \
    BASHREACTOR_HOME=/tmp/tok-b PORT=18092 bun apps/web/src/server.ts
bashreactor listening on :18092

$ curl -sS -w ' [%{http_code}]\n' http://127.0.0.1:18092/v1/whoami
{"code":"unauthenticated","message":"missing token: send the header Authorization: Bearer <token>"} [401]
$ curl -sS -H 'authorization: Bearer a-probe-token' -w ' [%{http_code}]\n' http://127.0.0.1:18092/v1/whoami
{"name":"admin","scope":"admin","admin":true} [200]
```

So the chain is not broken anywhere: a missing secret is the only thing that can turn `/v1` off, and
it degrades to a 503 that names the variable instead of a crash loop. On the live site
`https://bashreactor.mansus.org/v1/whoami` answers the 401 above, which means the secret is there
and Sealed Secrets has decrypted it.

## The volume, and what fills it

`/data` is a 1 Gi `local-path` volume and every run writes into it — the record, every block's log,
everything a block made. Nothing trims a run directory in place, so the volume used to stop filling only
when it was full, and a full volume does not announce itself: the first symptom is a step failing on a
log append hours into a pipeline, which reads as a broken block and not as a server with nowhere to
write. Two things answer it now, and neither of them is `/healthz`.

**Retention** is `BASHREACTOR_RETENTION`, a SPEC 1.3 duration, set to `"30d"` in `.k3s/values.yaml` and
therefore in the pod from the next Argo CD sync. A run that has reached a final status and has been
finished longer than the window is deleted, at startup and then hourly: a run that is `running`, one
with no `finished_at`, and one with a live claim are all kept, and one directory that will not go does
not stop the pass. A `failed` or `cancelled` run goes on the same window as a success even though it can
still be retried, so a retry is something done inside the window (SPEC 4.11). Unset, `off`, `none` and
`0` all mean the server never deletes a run by itself, which is the default — right on a laptop, not on
a 1 Gi volume. Whichever it is the entry says so, because "off" being silent is how a volume fills:

```console
$ env BASHREACTOR_HOME=$tmp PORT=18094 BASHREACTOR_RETENTION=30d BASHREACTOR_ADMIN_TOKEN_SHA256=$HASH bun apps/web/src/server.ts
bashreactor listening on :18094
bashreactor: retention: a run that finished over 30d ago is deleted, at startup and then every 1h
```

A window shorter than the hourly sweep is accepted and said out loud at startup, because the sweep
cannot honour it exactly: a run then goes somewhere between the window and the window plus an hour.

A value that does not parse is fatal, the way a bad `PORT` is — starting with retention that was asked
for and not understood is how a deployment deletes the wrong year:

```console
$ env BASHREACTOR_RETENTION='a week' bun apps/web/src/server.ts
BashreactorError: BASHREACTOR_RETENTION must be a duration like 7d or 12h, or "off", got "a week"
$ echo $?
1
```

**The number** is `GET /v1/disk`, for a probe or a cron to watch before the runs start dying: the
filesystem under `$BASHREACTOR_HOME`, and `low` once there is less than 64 MiB free. `bashreactor disk`
is the same call and exits 1 on `low`. Both were run against the entry the image runs, with the admin
token, on a dev box that had one finished run in it:

```console
$ curl -sS -H "authorization: Bearer $TOKEN" http://127.0.0.1:18094/v1/disk
{"path":"/tmp/bashr42-disk.BmOQ4j","total_bytes":1005921779712,"used_bytes":564133601280,"free_bytes":441788178432,"low":false,"runs_bytes":22452}
$ bashreactor disk
path   /tmp/bashr42-disk.BmOQ4j
free   411 GB of 937 GB
used   525 GB  (56%)
runs/  22 KB
low    no
```

Read those two kinds of number apart, because on the cluster they are not the same claim.
`total_bytes`, `used_bytes` and `free_bytes` are the *filesystem*'s, and `local-path` provisions a
directory under `/var/lib/rancher/k3s/storage` that enforces no size: the 1 Gi in `.k3s/values.yaml`
is a promise the node does not keep, so on the cluster those three are the node's whole disk and `low`
fires when the node is nearly full, not when the volume's 1 Gi is spent. `runs_bytes` is the one that
answers the question the 1 Gi was asked for — the bytes under `runs/`, counted by walking them, and
nothing else — so it is the one to compare with the size in the values file and the one worth alerting
on. It is `du -sb runs/` to the byte; the cost of the walk is one `stat` per file, on a route nobody
polls at speed.

The third thing is `DELETE /v1/runs/:id` — `bashreactor runs rm <id>` — which removes one finished run
whole, and answers `run_claimed` while an engine is still writing into it. Twice the same id, so the
second one is visible too:

```console
$ curl -sS -X DELETE -H "authorization: Bearer $TOKEN" -w ' [%{http_code}]\n' http://127.0.0.1:18094/v1/runs/20261108T003334Z-88177479
{"deleted":"20261108T003334Z-88177479"} [200]
$ curl -sS -X DELETE -H "authorization: Bearer $TOKEN" -w ' [%{http_code}]\n' http://127.0.0.1:18094/v1/runs/20261108T003334Z-88177479
{"code":"run_not_found","message":"run \"20261108T003334Z-88177479\" does not exist"} [404]
$
```

`/healthz` deliberately says nothing about any of this. It is the readiness probe, and a full volume is
not something a restart fixes: failing it would take the pod out of rotation with a run mid-flight to
report something that was already true.

## What a human still has to do, in order

The four things this task was opened for, and where each stands:

| Step | Status | How you can tell |
| --- | --- | --- |
| Argo CD Application | **done** | the `mansus-apps` generator picked the repo up; `/healthz` answers `sha-<sha>` |
| Router for the host | **done** | Traefik routes `/` Prefix to the Service; the site answers over HTTPS |
| TLS | **done** | cert-manager issued `bashreactor-tls`; the name check passes |
| The secret | **done, and it is not the last thing** | the sealed hash is applied and decrypts: live `/v1/whoami` answers 401, not 503 |

What is left is smaller than that list, and it is still nothing a worktree can do. Everything below
needs the cluster or Argo CD.

1. **Merge, and let the image roll.** Once `ci` has passed on the merge commit,
   `.github/workflows/deploy.yml` tags `sha-<newest>` and `latest`; Image Updater picks it up within
   two minutes. A merge whose `ci` fails is not deployed. Check where it landed:

   ```
   curl -sS https://bashreactor.mansus.org/healthz
   ```

   The `version` must be the merge commit's short sha. If it is an older sha ten minutes after the
   build went green, the pod is not the new image: look at the Application's sync status, then at
   whether the `argocd/ghcr-pull` credential can read the `bashreactor` package (ARGOCD.md step 2).

2. **Check the two paths this branch changes.** Both fail on the image that runs today:

   ```
   curl -sS -o /dev/null -w '%{redirect_url}\n' https://bashreactor.mansus.org/app
   # must be https://bashreactor.mansus.org/app/ — it is http:// today, which is why the site
   # looked unreachable: the redirect dropped the scheme the visitor came in on.
   curl -sS -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
        -H "authorization: Bearer <admin token>" -w '\n[%{http_code}]\n' \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
        https://bashreactor.mansus.org/mcp
   # today: 404 not_found, because nothing ran the MCP server. After this: 200 with
   # {"result":{"serverInfo":{"name":"bashreactor", ...}}}.
   ```

3. **Hand out tokens, not the admin token.** The admin token's plaintext is in nobody's repo — only
   its hash is sealed — so whoever holds it is the only one who can mint. Make a scoped one per
   agent and give that to the agent:

   ```
   curl -sS -X POST -H "authorization: Bearer <admin token>" -H 'content-type: application/json' \
        -d '{"name":"claude","scope":"read"}' https://bashreactor.mansus.org/v1/tokens
   ```

   The answer carries the token once, in `token`; `bashreactor tokens ls` and `DELETE
   /v1/tokens/:id` revoke it. Until someone does this, the only credential that reaches `/v1` and
   `/mcp` is the admin one, which can delete runs and mint tokens.

4. **Decide what previews are for.** Previews run in another namespace and cannot decrypt the
   production secret, so `bashreactor-pr-<n>.mansus.org` comes up with `/v1` answering the 503
   above and the UI only. That is deliberate — a preview that could run blocks would need someone
   else's volume and someone else's tokens. If a preview is supposed to be able to run things, it
   needs its own secret in its own namespace, and that is a decision, not an oversight.

5. **Rotate the admin token if it has ever been pasted somewhere public.** Re-seal the new hash for
   the `bashreactor` namespace with the cluster's Sealed Secrets key, replace
   `sealedSecrets[0].encryptedData.BASHREACTOR_ADMIN_TOKEN_SHA256` in `.k3s/values.yaml`, and let
   Argo CD sync. Nothing else has to be touched; the old token stops working at the rollout.
   The token itself is in the owner's Vaultwarden, item "bashreactor admin token".

Already done, so nobody needs to redo it: the repo is picked up by the `mansus-apps` ApplicationSet,
the `bashreactor` Application exists and syncs, `bashreactor.mansus.org` resolves, cert-manager has
issued `bashreactor-tls`, and the 1 Gi `local-path` volume with `fsGroup: 10001` is mounted at
`/data` — which is what makes a run survive a rollout.
