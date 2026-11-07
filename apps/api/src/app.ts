// The routes. One table, one dispatcher, one error path: a route names the access it needs and
// returns a value, and everything that can go wrong is thrown and turned into a response in
// `respond`. Nothing here computes anything the engine or the store does not already compute.

import { join } from "node:path";
import { BLOCK_NAME_RE, parseBlock, parsePipeline, splitBlockHeaderBytes, validateBlockSource } from "@bashreactor/core";
import { Engine, FsRunStore } from "@bashreactor/engine";
import type { RunRecord } from "@bashreactor/engine";
import { Store } from "@bashreactor/store";
import type { BlockVersion, PipelineRecord } from "@bashreactor/store";
import { optionalInputs, optionalInteger, optionalString, parseIntegerParam, readBody, requireString } from "./body.ts";
import type { Body } from "./body.ts";
import type { ApiConfig } from "./config.ts";
import { ApiError, errorToResponse, firstIssueAsError } from "./errors.ts";
import { authenticate, authorize } from "./auth.ts";
import type { Access, Identity } from "./auth.ts";
import { stagePipeline } from "./staging.ts";
import { TokenStore } from "./tokens.ts";
import { diskSpace } from "./disk.ts";
import type { DiskSpace } from "./disk.ts";
import { archiveBody, buildManifest, fileResponse } from "./run-files.ts";
import type { FileScope } from "./run-files.ts";

// Where the web UI is mounted, by apps/web/src/index.ts. `GET /` sends a person there.
const APP_PATH = "/app";

const MAX_LOG_TEXT_BYTES = 1 << 20;

export interface ApiDependencies {
  config: ApiConfig;
  /** Injected in tests; otherwise built from the config. */
  engine?: Engine;
  store?: Store;
  tokens?: TokenStore;
  /** How the filesystem under the data directory is measured; the real `statfs` unless injected. */
  disk?: (path: string) => DiskSpace | null;
  log?: (line: string) => void;
}

export interface Api {
  fetch(request: Request): Promise<Response>;
  engine: Engine;
  store: Store;
  tokens: TokenStore;
  close(): void;
}

interface Ctx {
  request: Request;
  url: URL;
  params: Record<string, string>;
  identity: Identity;
}

interface Route {
  method: string;
  segments: string[];
  access: Access;
  handler: (ctx: Ctx) => Response | Promise<Response>;
}

export function createApi(deps: ApiDependencies): Api {
  const config = deps.config;
  const log = deps.log ?? ((line: string) => console.log(line));
  const store = deps.store ?? new Store(config.storeDir);
  const tokens = deps.tokens ?? new TokenStore(config.tokensPath, log);
  const engine =
    deps.engine ?? new Engine({ store: new FsRunStore(config.dataDir), env: process.env, path: config.enginePath });
  const disk = deps.disk ?? diskSpace;
  const stageDir = join(config.dataDir, "stage");

  const routes: Route[] = [];
  const route = (method: string, path: string, access: Access, handler: Route["handler"]) => {
    routes.push({ method, segments: path.split("/").filter((part) => part !== ""), access, handler });
  };

  // --- who you are ---------------------------------------------------------

  route("GET", "/v1/whoami", "read", ({ identity }) => json(200, identity));

  /**
   * The filesystem `$BASHREACTOR_HOME` sits on (SPEC 6). Until now the only way to find out the volume
   * was full was that a run failed: the first thing to notice an over-full volume is a block's log
   * append, hours into a pipeline, and it reports as a step failure, not as a server that has
   * nowhere to write. This is the same fact, said before the runs start dying.
   *
   * It is a read and not the readiness probe, on purpose: `/healthz` is readiness, and a full volume
   * is not something a restart fixes — pulling the pod out of rotation with a run mid-flight to
   * report something that was already true is worse than the problem. `path` is here because a mount
   * that is not where the server thinks it is is exactly the deployment bug this catches.
   */
  route("GET", "/v1/disk", "read", () => {
    const space = disk(config.dataDir);
    if (space === null) {
      // `runtime_missing` rather than a new code: the server cannot answer because something it needs
      // is not there, which is the same 503 the engine's missing `bash` is (SPEC 5).
      throw new ApiError("runtime_missing", `cannot read the filesystem under "${config.dataDir}"`);
    }
    return json(200, { path: config.dataDir, ...space });
  });

  // --- tokens (admin only) -------------------------------------------------

  route("GET", "/v1/tokens", "admin", () => json(200, tokens.list()));

  route("POST", "/v1/tokens", "admin", async ({ request }) => {
    const body = await readBody(request, ["name", "scope"]);
    const created = tokens.create(requireString(body, "name"), requireString(body, "scope"));
    return json(201, { ...created.info, token: created.token });
  });

  route("DELETE", "/v1/tokens/:id", "admin", ({ params }) => {
    tokens.revoke(params.id!);
    return json(200, { deleted: params.id });
  });

  // --- the block library ---------------------------------------------------

  route("GET", "/v1/blocks/:name", "read", ({ params }) => {
    const name = blockName(params.name!);
    const versions = store.listBlockVersions(name).map(blockRecord);
    if (versions.length === 0) throw new ApiError("block_not_found", `block "${name}" has no versions`);
    return json(200, { name, latest: versions[versions.length - 1]!.version, versions });
  });

  route("GET", "/v1/blocks/:name/:version", "read", ({ params }) =>
    json(200, blockRecord(blockVersion(store, params.name!, params.version!))),
  );

  route("GET", "/v1/blocks/:name/:version/content", "read", ({ params }) => {
    const version = blockVersion(store, params.name!, params.version!);
    const bytes = store.readBlockVersion(version.name, version.version);
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "x-block-sha256": version.sha256 },
    });
  });

  route("POST", "/v1/blocks/:name/versions", "write", async ({ request, params }) => {
    const name = blockName(params.name!);
    const body = await readBody(request, ["content", "content_b64"]);
    // SPEC 2: the identity of a version is the SHA-256 of the file's exact bytes, so the bytes have
    // to arrive whole. `content_b64` carries any file; `content` is text and can only carry what is
    // valid UTF-8, and a caller that sends it gets the bytes that text encodes to.
    const bytes = blockBytes(body);
    // SPEC 2.2: the header must be valid UTF-8 and the rest of the file is opaque bytes, so the
    // header is checked over the bytes themselves — a body that is not UTF-8 must not hide a header
    // that is not either, and must not stop a header that is from being read.
    const header = splitBlockHeaderBytes(bytes);
    if (!header.ok) {
      throw new ApiError("block_header_malformed", header.error, { path: "name", file: `${name}.sh` });
    }
    // Only the header is read from this, and it is already known to be valid UTF-8, so the lossy
    // decode of everything after it cannot change what the checks below see.
    const source = new TextDecoder("utf-8").decode(bytes);

    const issues = validateBlockSource(source);
    if (issues.length > 0) throw firstIssueAsError(issues, `${name}.sh`);
    const declared = parseBlock(source).name;
    if (declared !== name) {
      throw new ApiError("block_schema_invalid", `the header declares "${declared}", not "${name}"`, {
        path: "name",
        file: `${name}.sh`,
      });
    }
    return json(201, blockRecord(store.addBlockVersion(name, bytes)));
  });

  // --- pipeline versions ---------------------------------------------------

  route("GET", "/v1/pipelines/:name", "read", ({ params }) => {
    const name = pipelineName(params.name!);
    const versions = store.listPipelineVersions(name).map((record) => pipelineRecord(record, false));
    if (versions.length === 0) throw new ApiError("pipeline_not_found", `pipeline "${name}" has no versions`);
    return json(200, { name, latest: versions[versions.length - 1]!.version, versions });
  });

  route("GET", "/v1/pipelines/:name/:version", "read", ({ params }) =>
    json(200, pipelineRecord(pipelineVersion(store, params.name!, params.version!))),
  );

  route("POST", "/v1/pipelines/validate", "read", async ({ request }) => {
    const body = await readBody(request, ["yaml"]);
    const yaml = requireString(body, "yaml");
    const issues = stagedValidation(yaml);
    return json(200, { valid: issues.length === 0, issues });
  });

  route("POST", "/v1/pipelines/:name/versions", "write", async ({ request, params }) => {
    const name = pipelineName(params.name!);
    const body = await readBody(request, ["yaml"]);
    const yaml = requireString(body, "yaml");

    const issues = stagedValidation(yaml);
    if (issues.length > 0) throw firstIssueAsError(issues, `${name}.yaml`);
    const pipeline = parsePipeline(yaml);
    if (pipeline.name !== name) {
      throw new ApiError("pipeline_schema_invalid", `the file declares "${pipeline.name}", not "${name}"`, {
        path: "name",
        file: `${name}.yaml`,
      });
    }
    return json(201, pipelineRecord(store.savePipeline({ name, yaml, parsed: pipeline })));
  });

  // --- runs ----------------------------------------------------------------

  route("GET", "/v1/runs", "read", async ({ url }) => {
    // SPEC 4.2: a run id sorts by time, so the ids alone order the list. The page is chosen from them
    // and only the page is read; reading every run to throw all but a page away is what made this one
    // request cost the whole history.
    const limit = runPageLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    const ids = (await engine.listRuns())
      .filter((id) => RUN_ID_RE.test(id))
      .toSorted((a, b) => b.localeCompare(a))
      // Anything that is not a run id is just a cursor: it compares, and the page comes back from the
      // top or empty. A caller cannot break the listing with a bad one.
      .filter((id) => cursor === null || id.localeCompare(cursor) < 0);
    const page = ids.slice(0, limit);
    // A run whose record cannot be read is not listable, and one bad file must not take the whole
    // listing with it: it is logged and left out, and the cursor being positional means the walk moves
    // past it instead of stopping there for good.
    const records = await Promise.all(
      page.map((id) =>
        engine.getRun(id).catch((error: unknown) => {
          log(`run ${id} is not listable: ${error}`);
          return null;
        }),
      ),
    );
    const runs = records
      .filter((record): record is RunRecord => record !== null)
      .map((record) => ({
        id: record.id,
        pipeline: record.pipeline,
        status: record.status,
        created_at: record.created_at,
        finished_at: record.finished_at,
        cancel_requested_at: record.cancel_requested_at,
      }));
    // The next cursor is the last id of the page whether or not every run on it could be read, so a
    // run the server cannot parse moves the walk along instead of stalling it on itself.
    const headers = page.length < ids.length ? { "x-next-cursor": page[page.length - 1]! } : undefined;
    return json(200, runs, headers);
  });

  route("POST", "/v1/runs", "write", async ({ request }) => {
    const body = await readBody(request, ["pipeline", "version", "yaml", "inputs"]);
    const inputs = optionalInputs(body, "inputs");
    const yaml = pipelineYamlOf(body);
    const staged = stagePipeline({ baseDir: stageDir, yaml, resolveBlock: libraryBlock });
    try {
      // SPEC 4.3: a pipeline that does not validate creates no run, and the answer is its first
      // issue as a 422, whether the pipeline came from the store or from the request body.
      const issues = engine.validate(staged.path);
      if (issues.length > 0) throw firstIssueAsError(issues);
      const record = await engine.start(staged.path, inputs);
      driveInBackground(record.id);
      return json(201, record);
    } finally {
      staged.cleanup();
    }
  });

  route("GET", "/v1/runs/:id", "read", async ({ params }) => json(200, await requiredRun(params.id!)));

  route("POST", "/v1/runs/:id/cancel", "write", async ({ params }) => {
    const id = runId(params.id!);
    await engine.cancel(id);
    return json(202, await requiredRun(id));
  });

  route("POST", "/v1/runs/:id/retry", "write", ({ params }) => {
    const id = runId(params.id!);
    return accepted(engine.retry(id), () => acceptedRun(id));
  });

  route("POST", "/v1/runs/:id/resume", "write", async ({ params }) => {
    const id = runId(params.id!);
    // SPEC 4.7: resume is for a run whose status is still `running`. The engine's drive loop is
    // harmless on a finished run, so the route says so rather than pretending to restart it.
    const record = await requiredRun(id);
    if (record.status !== "running") {
      throw new ApiError("run_not_active", `run "${id}" is ${record.status}, not running`);
    }
    return accepted(engine.resume(id), () => acceptedRun(id));
  });

  /**
   * Remove a run and everything it wrote (SPEC 4.2, SPEC 6). This is the only way anything outside the
   * engine can take a run away, because the engine owns the directory: `runs/<id>/` holds the record,
   * every block's log and every file a block made, and a caller that reached for `rm -rf` would be
   * guessing at a layout it does not own.
   *
   * It is a write and not an admin call: the same authority that starts a run may remove one, and
   * reading what is in there before you go is what `GET .../files` is for. A run with a live claim
   * answers 409 `run_claimed`, the code SPEC 5 already gives for "an engine holds this"; cancel it
   * first. The body names what went, the shape `DELETE /v1/tokens/:id` already answers with.
   */
  route("DELETE", "/v1/runs/:id", "write", async ({ params }) => {
    const id = runId(params.id!);
    await engine.deleteRun(id);
    return json(200, { deleted: id });
  });

  route("GET", "/v1/runs/:id/logs/:step/:attempt", "read", async ({ params, url }) => {
    const id = runId(params.id!);
    const stepId = params.step!;
    const attempt = parseIntegerParam("attempt", params.attempt!, 1);
    const offset = parseIntegerParam("offset", url.searchParams.get("offset") ?? "0", 0);

    const record = await requiredRun(id);
    // `Object.hasOwn`, because a step id comes from the URL and `record.steps["__proto__"]` answers
    // with the prototype: an inherited object is not a step of this run.
    const step = Object.hasOwn(record.steps, stepId) ? record.steps[stepId] : undefined;
    if (step === undefined) {
      throw new ApiError("step_not_found", `run "${id}" has no step "${stepId}"`, { path: `steps.${stepId}` });
    }
    if (!step.attempts.some((entry) => entry.n === attempt)) {
      throw new ApiError("attempt_not_found", `step "${stepId}" of run "${id}" has no attempt ${attempt}`, {
        path: `steps.${stepId}.attempts`,
      });
    }

    // A running attempt is still writing, so a chunk that stops mid-character holds the half back and
    // the next poll reads it whole; a finished attempt's bytes are final (SPEC 4.8).
    const open = step.attempts.some((entry) => entry.n === attempt && entry.status === "running");
    const chunk = await engine.readLog(id, stepId, attempt, offset, MAX_LOG_TEXT_BYTES, {
      attemptOpen: open,
    });
    const text = new TextDecoder("utf-8").decode(chunk.data);
    return json(200, {
      run: id,
      step: stepId,
      attempt,
      offset,
      next_offset: chunk.nextOffset,
      truncated: chunk.more,
      text,
    });
  });

  // --- a run's files (BASHR-47) ---------------------------------------------
  //
  // Three read-only routes over one run's own directory. Everything that decides what a path may name
  // lives in run-files.ts; these handlers only say which access is needed and where the run directory is.

  route("GET", "/v1/runs/:id/files", "read", async ({ params, url }) => {
    const id = runId(params.id!);
    const record = await requiredRun(id);
    const step = url.searchParams.get("step") ?? undefined;
    const attempt = optionalAttempt(url);
    requireStepAndAttempt(record, id, step, attempt);
    return json(200, buildManifest(record, runDirOf(id), { step, attempt, scope: scopeOf(url) }));
  });

  route("GET", "/v1/runs/:id/file", "read", async ({ params, url }) => {
    const id = runId(params.id!);
    const record = await requiredRun(id);
    const path = url.searchParams.get("path");
    if (path === null) throw new ApiError("bad_request", "give the file with ?path=", { path: "path" });
    return fileResponse(record, runDirOf(id), path);
  });

  route("GET", "/v1/runs/:id/archive", "read", async ({ params, url }) => {
    const id = runId(params.id!);
    const record = await requiredRun(id);
    const step = url.searchParams.get("step") ?? undefined;
    const attempt = optionalAttempt(url);
    requireStepAndAttempt(record, id, step, attempt);

    const archive = archiveBody(record, runDirOf(id), { step, attempt });
    const headers: Record<string, string> = {
      "content-type": "application/gzip",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="${archive.filename}"`,
      "x-run-skipped": String(archive.skipped),
    };
    if (archive.partial) headers["x-run-partial"] = "true";
    return new Response(archive.body, { status: 200, headers });
  });

  // --- dispatch ------------------------------------------------------------

  async function dispatch(request: Request, who: { name: string }): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter((part) => part !== "");

    if (request.method === "GET" && url.pathname === "/") {
      // One process serves both, and the UI is mounted at /app: a person who types the host into a
      // browser wants the app, not an error object. 302 and not 301 so a mount that moves is fixable.
      return Response.redirect(new URL(`${APP_PATH}/`, url).href, 302);
    }

    if (url.pathname === "/healthz") {
      if (request.method !== "GET") {
        throw new ApiError("method_not_allowed", "the deploy probe is GET /healthz");
      }
      // Deliberately still exactly `{status, version}`, and deliberately not the place the volume's
      // free space is reported (SPEC 6): this is the readiness probe, and a full `$BASHREACTOR_HOME`
      // is not something a restart fixes — it would pull a pod out of rotation with a run mid-flight
      // to say something that was already true. The number is at `GET /v1/disk`.
      return json(200, { status: "ok", version: config.version });
    }

    const match = matchRoute(routes, request.method, parts);
    if (match === null) {
      // A path this API has, with a method it does not take, is 405; a path it does not have at all is
      // 404. Both used to be 501, which told a caller nothing about what to change.
      const allowed = methodsAt(routes, parts);
      if (allowed.length > 0) {
        throw new ApiError(
          "method_not_allowed",
          `${request.method} ${url.pathname} is not allowed here; it takes ${allowed.toSorted().join(", ")}`,
        );
      }
      throw new ApiError("not_found", `${request.method} ${url.pathname} is not a path this API has`);
    }

    const identity = authenticate(request, config, tokens);
    who.name = identity.name;
    authorize(identity, match.route.access);
    return await match.route.handler({ request, url, params: match.params, identity });
  }

  async function handle(request: Request): Promise<Response> {
    const started = Date.now();
    const who = { name: "-" };
    let response: Response;
    try {
      response = await dispatch(request, who);
    } catch (error) {
      response = respond(errorToResponse(error));
    }
    log(
      `${request.method} ${new URL(request.url).pathname} ${response.status} ${Date.now() - started}ms ${who.name}`,
    );
    return response;
  }

  // --- helpers -------------------------------------------------------------

  function libraryBlock(name: string, version: number): Uint8Array | null {
    try {
      return store.readBlockVersion(name, version);
    } catch {
      return null;
    }
  }

  function stagedValidation(yaml: string) {
    const staged = stagePipeline({ baseDir: stageDir, yaml, resolveBlock: libraryBlock });
    try {
      return engine.validate(staged.path);
    } finally {
      staged.cleanup();
    }
  }

  function pipelineYamlOf(body: Awaited<ReturnType<typeof readBody>>): string {
    const yaml = optionalString(body, "yaml");
    const name = optionalString(body, "pipeline");
    if (yaml !== undefined && name !== undefined) {
      throw new ApiError("unknown_input", "give either pipeline or yaml, not both");
    }
    if (yaml !== undefined) return yaml;
    if (name === undefined) throw new ApiError("missing_input", 'give "pipeline" or "yaml"', { path: "pipeline" });
    const version = optionalInteger(body, "version");
    return pipelineVersion(store, name, version === undefined ? "latest" : String(version)).yaml;
  }

  /** Where a run's own directory is. The engine's store owns that answer (SPEC 4.2). */
  function runDirOf(id: string): string {
    return engine.store.layout(id).runDir;
  }

  async function requiredRun(id: string): Promise<RunRecord> {
    const record = await engine.getRun(runId(id));
    if (record === null) throw new ApiError("run_not_found", `run "${id}" does not exist`);
    return record;
  }

  async function acceptedRun(id: string): Promise<Response> {
    const record = await engine.getRun(id);
    return json(202, record ?? { id });
  }

  /**
   * A run operation that may take hours. It gets `settleMs` to fail fast (a bad id, a live claim) or
   * finish (a short run), and the answer is then the run itself; otherwise the operation keeps
   * running in the background and the answer is 202 Accepted.
   */
  async function accepted(operation: Promise<RunRecord>, fallback: () => Promise<Response>): Promise<Response> {
    const settled = new Promise<{ record: RunRecord } | { error: unknown }>((resolve) => {
      operation.then(
        (record) => resolve({ record }),
        (error) => resolve({ error }),
      );
    });
    const timer = new Promise<"settled">((resolve) => setTimeout(() => resolve("settled"), config.settleMs));
    const winner = await Promise.race([settled, timer]);
    if (winner === "settled") return await fallback();
    if ("error" in winner) throw winner.error;
    return json(200, winner.record);
  }

  /** Starts a run driving in the background, where a failure is a log line, not a lost response. */
  function driveInBackground(id: string): void {
    engine.drive(id).catch((error: unknown) => {
      log(`run ${id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return {
    fetch: handle,
    engine,
    store,
    tokens,
    close: () => store.close(),
  };
}

// The store names its fields in camelCase and run.json in snake_case (SPEC 4.9); one API answers in
// one of them, and it is the one the spec fixes.
function blockRecord(record: BlockVersion) {
  return {
    name: record.name,
    version: record.version,
    sha256: record.sha256,
    size: record.size,
    created_at: record.createdAt,
  };
}

function pipelineRecord(record: PipelineRecord, withBody = true) {
  const meta = {
    name: record.name,
    version: record.version,
    sha256: record.sha256,
    created_at: record.createdAt,
  };
  return withBody ? { ...meta, yaml: record.yaml, parsed: record.parsed } : meta;
}

// SPEC 4.2 fixes what a run id looks like, and the engine joins one straight into a path. Checking
// the shape here is what keeps a URL from naming a directory outside the run directory.
const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;

function runId(value: string): string {
  if (!RUN_ID_RE.test(value)) throw new ApiError("run_not_found", `"${value}" is not a run id`);
  return value;
}

/** What a page of the run list holds when the caller does not say, and the most it will ever hold. */
const DEFAULT_RUN_PAGE = 100;
const MAX_RUN_PAGE = 500;

/**
 * `?limit=` for the run list. Absent, empty or 0 is the default, and more than the cap is clamped
 * rather than refused: asking for more than the server will give is not a malformed request.
 */
function runPageLimit(raw: string | null): number {
  if (raw === null || raw === "") return DEFAULT_RUN_PAGE;
  const requested = parseIntegerParam("limit", raw, 0);
  return requested === 0 ? DEFAULT_RUN_PAGE : Math.min(requested, MAX_RUN_PAGE);
}

/**
 * The block file's exact bytes, from whichever field the caller sent. `content_b64` is the one that
 * can carry a file that is not valid UTF-8; SPEC 2 makes those bytes the version's identity, so
 * nothing here is allowed to rewrite one of them on the way in.
 */
function blockBytes(body: Body): Uint8Array {
  const content = optionalString(body, "content");
  const encoded = optionalString(body, "content_b64");
  if (content !== undefined && encoded !== undefined) {
    throw new ApiError("unknown_input", 'give either "content" or "content_b64", not both', {
      path: "content_b64",
    });
  }
  if (encoded !== undefined) {
    if (!BASE64_RE.test(encoded)) {
      throw new ApiError("type_mismatch", '"content_b64" is not base64', { path: "content_b64" });
    }
    return new Uint8Array(Buffer.from(encoded, "base64"));
  }
  if (content !== undefined) return new TextEncoder().encode(content);
  throw new ApiError("missing_input", '"content" or "content_b64" is required', { path: "content" });
}

/** Canonical base64, padding and all: anything else is the caller's mistake, not a byte to guess at. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function blockName(value: string): string {
  if (!BLOCK_NAME_RE.test(value)) {
    throw new ApiError("block_schema_invalid", `"${value}" is not a block name`, { path: "name" });
  }
  return value;
}

function pipelineName(value: string): string {
  if (!BLOCK_NAME_RE.test(value)) {
    throw new ApiError("pipeline_schema_invalid", `"${value}" is not a pipeline name`, { path: "name" });
  }
  return value;
}

function blockVersion(store: Store, name: string, version: string) {
  const checked = blockName(name);
  if (version === "latest") {
    const latest = store.latestBlockVersion(checked);
    if (latest === null) throw new ApiError("block_not_found", `block "${checked}" has no versions`);
    return latest;
  }
  return store.getBlockVersion(checked, parseIntegerParam("version", version, 1));
}

function pipelineVersion(store: Store, name: string, version: string) {
  const checked = pipelineName(name);
  if (version === "latest") {
    const latest = store.latestPipeline(checked);
    if (latest === null) throw new ApiError("pipeline_not_found", `pipeline "${checked}" has no versions`);
    return latest;
  }
  return store.getPipeline(checked, parseIntegerParam("version", version, 1));
}

/** Whether this route's fixed segments are this path, ignoring the method. */
function pathMatches(route: Route, parts: readonly string[]): boolean {
  if (route.segments.length !== parts.length) return false;
  return route.segments.every((segment, index) => segment.startsWith(":") || segment === parts[index]);
}

/** Which methods this path takes, so a wrong one can be named instead of guessed at. */
function methodsAt(routes: readonly Route[], parts: readonly string[]): string[] {
  const found: string[] = [];
  for (const route of routes) {
    if (pathMatches(route, parts) && !found.includes(route.method)) found.push(route.method);
  }
  return found;
}

function matchRoute(
  routes: readonly Route[],
  method: string,
  parts: readonly string[],
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method || !pathMatches(route, parts)) continue;
    const params: Record<string, string> = {};
    for (const [index, segment] of route.segments.entries()) {
      if (segment.startsWith(":")) params[segment.slice(1)] = decodeSegment(parts[index]!);
    }
    return { route, params };
  }
  return null;
}

// A path segment that is not valid percent-encoded UTF-8 is the caller's mistake, and `decodeURIComponent`
// says so with a bare URIError, which used to arrive as a 500 carrying the engine's own text.
function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new ApiError("bad_request", `"${part}" is not a valid percent-encoded path segment`);
  }
}

// The three file routes take their narrowing in the query string, where a wrong value is the same
// kind of mistake as a wrong offset on the log route.
function optionalAttempt(url: URL): number | undefined {
  const raw = url.searchParams.get("attempt");
  return raw === null ? undefined : parseIntegerParam("attempt", raw, 1);
}

const FILE_SCOPES: readonly string[] = ["outputs", "work", "logs", "all"];

function scopeOf(url: URL): FileScope {
  const raw = url.searchParams.get("scope") ?? "all";
  if (!FILE_SCOPES.includes(raw)) {
    throw new ApiError("type_mismatch", `scope must be one of ${FILE_SCOPES.join(", ")}, got "${raw}"`, {
      path: "scope",
    });
  }
  return raw as FileScope;
}

/** A `step_not_found` / `attempt_not_found` for a query that names neither, exactly as the log route. */
function requireStepAndAttempt(
  record: RunRecord,
  id: string,
  step: string | undefined,
  attempt: number | undefined,
): void {
  if (step === undefined) return;
  const found = Object.hasOwn(record.steps, step) ? record.steps[step] : undefined;
  if (found === undefined) {
    throw new ApiError("step_not_found", `run "${id}" has no step "${step}"`, { path: `steps.${step}` });
  }
  if (attempt !== undefined && !found.attempts.some((entry) => entry.n === attempt)) {
    throw new ApiError("attempt_not_found", `step "${step}" of run "${id}" has no attempt ${attempt}`, {
      path: `steps.${step}.attempts`,
    });
  }
}

function json(status: number, value: unknown, headers?: Record<string, string>): Response {
  return Response.json(value, { status, headers });
}

function respond(error: { status: number; body: unknown }): Response {
  const headers: Record<string, string> = {};
  if (error.status === 401) headers["www-authenticate"] = 'Bearer realm="bashreactor"';
  return Response.json(error.body, { status: error.status, headers });
}
