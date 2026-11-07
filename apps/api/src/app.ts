// The routes. One table, one dispatcher, one error path: a route names the access it needs and
// returns a value, and everything that can go wrong is thrown and turned into a response in
// `respond`. Nothing here computes anything the engine or the store does not already compute.

import { join } from "node:path";
import { BLOCK_NAME_RE, parseBlock, parsePipeline, validateBlockSource } from "@bashreactor/core";
import { Engine, FsRunStore } from "@bashreactor/engine";
import type { RunRecord } from "@bashreactor/engine";
import { Store } from "@bashreactor/store";
import type { BlockVersion, PipelineRecord } from "@bashreactor/store";
import { optionalInputs, optionalInteger, optionalString, parseIntegerParam, readBody, requireString } from "./body.ts";
import type { ApiConfig } from "./config.ts";
import { ApiError, errorToResponse, firstIssueAsError } from "./errors.ts";
import { authenticate, authorize } from "./auth.ts";
import type { Access, Identity } from "./auth.ts";
import { stagePipeline } from "./staging.ts";
import { TokenStore } from "./tokens.ts";

// Where the web UI is mounted, by apps/web/src/index.ts. `GET /` sends a person there.
const APP_PATH = "/app";

const MAX_LOG_TEXT_BYTES = 1 << 20;

export interface ApiDependencies {
  config: ApiConfig;
  /** Injected in tests; otherwise built from the config. */
  engine?: Engine;
  store?: Store;
  tokens?: TokenStore;
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
  const stageDir = join(config.dataDir, "stage");

  const routes: Route[] = [];
  const route = (method: string, path: string, access: Access, handler: Route["handler"]) => {
    routes.push({ method, segments: path.split("/").filter((part) => part !== ""), access, handler });
  };

  // --- who you are ---------------------------------------------------------

  route("GET", "/v1/whoami", "read", ({ identity }) => json(200, identity));

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
    const body = await readBody(request, ["content"]);
    const content = requireString(body, "content");

    const issues = validateBlockSource(content);
    if (issues.length > 0) throw firstIssueAsError(issues, `${name}.sh`);
    const declared = parseBlock(content).name;
    if (declared !== name) {
      throw new ApiError("block_schema_invalid", `the header declares "${declared}", not "${name}"`, {
        path: "name",
        file: `${name}.sh`,
      });
    }
    return json(201, blockRecord(store.addBlockVersion(name, content)));
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

  route("GET", "/v1/runs", "read", async () => {
    const ids = await engine.listRuns();
    const records = await Promise.all(ids.map((id) => engine.getRun(id)));
    const runs = records
      .filter((record): record is RunRecord => record !== null)
      .toSorted((a, b) => b.id.localeCompare(a.id))
      .map((record) => ({
        id: record.id,
        pipeline: record.pipeline,
        status: record.status,
        created_at: record.created_at,
        finished_at: record.finished_at,
        cancel_requested_at: record.cancel_requested_at,
      }));
    return json(200, runs);
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

function json(status: number, value: unknown): Response {
  return Response.json(value, { status });
}

function respond(error: { status: number; body: unknown }): Response {
  const headers: Record<string, string> = {};
  if (error.status === 401) headers["www-authenticate"] = 'Bearer realm="bashreactor"';
  return Response.json(error.body, { status: error.status, headers });
}
