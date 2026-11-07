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

## What a human still has to do, in order

Everything below needs the cluster or Argo CD; none of it can be done from a worktree.

1. **Merge, and let the image roll.** `.github/workflows/deploy.yml` tags `sha-<newest>` and
   `latest`; Image Updater picks it up within two minutes. Check where it landed:

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

Already done, so nobody needs to redo it: the repo is picked up by the `mansus-apps` ApplicationSet,
the `bashreactor` Application exists and syncs, `bashreactor.mansus.org` resolves, cert-manager has
issued `bashreactor-tls`, and the 1 Gi `local-path` volume with `fsGroup: 10001` is mounted at
`/data` — which is what makes a run survive a rollout.
