// The one place that talks to /v1. Every call carries `Authorization: Bearer`, a failure is the
// SPEC 5 error object thrown as an ApiError, and a 401 sends the reader back to the gate with the
// server's own message. Ported in shape from the reference app's assets/api.js.

const URL_KEY = "bashreactor.url";
const TOKEN_KEY = "bashreactor.token";

/** What `GET /v1/whoami` answers. */
export interface Identity {
  name: string;
  scope: "read" | "write" | "admin";
  admin: boolean;
}

export interface BlockVersion {
  name: string;
  version: number;
  sha256: string;
  size: number;
  created_at: string;
}

export interface BlockList {
  name: string;
  latest: number;
  versions: BlockVersion[];
}

export interface PipelineVersionMeta {
  name: string;
  version: number;
  sha256: string;
  created_at: string;
}

export interface PipelineVersion extends PipelineVersionMeta {
  yaml: string;
  parsed: unknown;
}

/** One issue from `POST /v1/pipelines/validate`. It names a path, never a line. */
export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
  file?: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface RunSummary {
  id: string;
  pipeline: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  cancel_requested_at: string | null;
}

export interface Attempt {
  n: number;
  status: string;
  pid: number | null;
  pid_start: number | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  failure: { code: string; message: string } | null;
}

export interface RunStep {
  id: string;
  name: string;
  status: string;
  block: { uses: string; name: string; sha256: string };
  needs: string[];
  with: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  failure: { code: string; message: string } | null;
  attempts_used: number;
  next_attempt_at: string | null;
  attempts: Attempt[];
}

/**
 * Who holds a run's lock (SPEC 4.7). The API reads it when it reads the run; it is not a field of
 * `run.json`, because the lock outlives whatever the record last said: a run left `running` by an
 * engine that died and one being driven this second are the same words in the file.
 */
export interface RunClaim {
  /** The pid of the engine that wrote the lock. */
  pid: number;
  /** Whether that pid is still the process that wrote it. A stale claim blocks nothing. */
  live: boolean;
}

/** `run.json`, SPEC 4.9, plus the claim the API read beside it. */
export interface Run {
  schema: number;
  id: string;
  pipeline: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  cancel_requested_at: string | null;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  steps: Record<string, RunStep>;
  claim: RunClaim | null;
}

export interface LogChunk {
  run: string;
  step: string;
  attempt: number;
  offset: number;
  next_offset: number;
  truncated: boolean;
  text: string;
}

/** One file that may be downloaded, with its size, or why it is not a plain file. */
export interface RunFileEntry {
  path: string;
  size?: number;
  kind?: string;
  name?: string;
}

export interface RunFileAttempt {
  n: number;
  status: string;
  partial: boolean;
  log?: RunFileEntry;
  outputs?: RunFileEntry[];
  work?: RunFileEntry[];
}

/** What `GET /v1/runs/:id/files` answers (SPEC 4.10): the run's outputs, and each step's attempts. */
export interface RunFiles {
  run: string;
  status: string;
  partial: boolean;
  outputs: { name: string; path: string; size: number }[];
  steps: Record<string, { attempts: RunFileAttempt[] }>;
}

/** The SPEC 5 object, with the status that came back with it. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly path?: string;
  readonly file?: string;

  constructor(status: number, body: { code?: string; message?: string; path?: string; file?: string }) {
    super(body.message ?? `The server answered ${status} with no message.`);
    this.status = status;
    this.code = body.code ?? "internal_error";
    this.path = body.path;
    this.file = body.file;
  }
}

interface Session {
  base: string;
  token: string;
  identity: Identity | null;
  /** Set by the shell: a 401 belongs on the gate, with the server's message shown there. */
  onUnauthorized: (error: ApiError) => void;
}

export const session: Session = {
  base: localStorage.getItem(URL_KEY) ?? location.origin,
  token: localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY) ?? "",
  identity: null,
  onUnauthorized: () => {},
};

/** read keeps the token for this tab only; remember keeps it on this device. */
export function signIn(base: string, token: string, remember: boolean): void {
  session.base = base.replace(/\/+$/, "");
  session.token = token;
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(URL_KEY);
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  if (remember) localStorage.setItem(URL_KEY, session.base);
}

export function signOut(): void {
  session.token = "";
  session.identity = null;
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

/** A read-only token must not be offered a button that can only answer 403. */
export function canWrite(): boolean {
  const identity = session.identity;
  return identity !== null && (identity.admin || identity.scope === "write");
}

function url(path: string, query?: Record<string, string | number | null | undefined>): string {
  let href = `${session.base}/v1/${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) params.set(key, String(value));
    }
    const text = params.toString();
    if (text) href += `?${text}`;
  }
  return href;
}

async function send(
  method: string,
  path: string,
  options: { query?: Record<string, string | number | null | undefined>; body?: unknown; raw?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${session.token}`, accept: "application/json" };
  let body: string | undefined;
  if (options.raw !== undefined) {
    headers["content-type"] = "application/json";
    body = options.raw;
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(url(path, options.query), { method, headers, body, cache: "no-store" });
  } catch {
    throw new ApiError(0, {
      code: "api_unreachable",
      message: `${session.base} did not answer. Check the address, and that this server is running.`,
    });
  }
  // Any 401, on any call: it is the token that failed, not the endpoint, so the shell hears about it
  // whether the caller wanted its body parsed as JSON or not.
  if (response.status === 401) session.onUnauthorized(await errorOf(response));
  return response;
}

/**
 * Reads the SPEC 5 object off a response. It reads a clone, which is the whole point of it: reading
 * the body here used to leave nothing for the caller, whose own read then threw "answered with no
 * error object" — so the one message the person needed, the server's own reason, was the one thing
 * the screen could not show them.
 */
async function errorOf(response: Response): Promise<ApiError> {
  let body: { code?: string; message?: string; path?: string; file?: string } = {};
  try {
    const read: unknown = await response.clone().json();
    // `null`, `"not found"`, `[]`: JSON that parses but is not the SPEC 5 object. Handing one of
    // those to ApiError used to throw here, outside the caller's reach, so the one thing that was
    // certain — the token is refused — never got through to the place that clears it.
    if (read !== null && typeof read === "object" && !Array.isArray(read)) body = read as typeof body;
    else if (typeof read === "string" && read !== "") body = { message: read };
  } catch {
    body = { message: `The server answered ${response.status} with no error object.` };
  }
  return new ApiError(response.status, body);
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw await errorOf(response);
  return (await response.json()) as T;
}

export const api = {
  whoami: () => send("GET", "whoami").then(json<Identity>),
  health: () => fetch(`${session.base}/healthz`, { cache: "no-store" }).then((r) => r.json() as Promise<Health>),

  blocks: (name: string) => send("GET", `blocks/${encodeURIComponent(name)}`).then(json<BlockList>),
  blockContent: (name: string, version: number | "latest") =>
    send("GET", `blocks/${encodeURIComponent(name)}/${version}/content`).then(async (response) => {
      if (!response.ok) throw await errorOf(response);
      return { text: await response.text(), sha256: response.headers.get("x-block-sha256") ?? "" };
    }),
  addBlockVersion: (name: string, content: string) =>
    // The exact bytes of the file, in a JSON string: the API stores what it is given, so the string
    // has to be the file and nothing else.
    send("POST", `blocks/${encodeURIComponent(name)}/versions`, {
      raw: JSON.stringify({ content }),
    }).then(json<BlockVersion>),

  pipelines: (name: string) => send("GET", `pipelines/${encodeURIComponent(name)}`).then(json<PipelineList>),
  pipelineVersion: (name: string, version: number | "latest") =>
    send("GET", `pipelines/${encodeURIComponent(name)}/${version}`).then(json<PipelineVersion>),
  validate: (yaml: string) => send("POST", "pipelines/validate", { body: { yaml } }).then(json<ValidationReport>),
  savePipeline: (name: string, yaml: string) =>
    send("POST", `pipelines/${encodeURIComponent(name)}/versions`, { body: { yaml } }).then(json<PipelineVersion>),

  runs: () => send("GET", "runs").then(json<RunSummary[]>),
  run: (id: string) => send("GET", `runs/${encodeURIComponent(id)}`).then(json<Run>),
  startRun: (body: { pipeline?: string; version?: number; yaml?: string; inputs?: Record<string, unknown> }) =>
    send("POST", "runs", { body }).then(json<Run>),
  cancelRun: (id: string) => send("POST", `runs/${encodeURIComponent(id)}/cancel`).then(json<Run>),
  retryRun: (id: string) => send("POST", `runs/${encodeURIComponent(id)}/retry`).then(json<Run>),
  resumeRun: (id: string) => send("POST", `runs/${encodeURIComponent(id)}/resume`).then(json<Run>),
  log: (id: string, step: string, attempt: number, offset: number) =>
    send("GET", `runs/${encodeURIComponent(id)}/logs/${encodeURIComponent(step)}/${attempt}`, {
      query: { offset },
    }).then(json<LogChunk>),

  runFiles: (id: string, query: Record<string, string | number | undefined> = {}) =>
    send("GET", `runs/${encodeURIComponent(id)}/files`, { query }).then(json<RunFiles>),

  /** The address of one file of a run, as the API spells it. */
  runFileUrl: (id: string, path: string) => url(`runs/${encodeURIComponent(id)}/file`, { path }),
  /** The address of a run's archive, whole or one step's attempt. */
  runArchiveUrl: (id: string, query: { step?: string; attempt?: number } = {}) =>
    url(`runs/${encodeURIComponent(id)}/archive`, query),
  /** The address of the manifest itself, which is a file people want to keep. */
  runManifestUrl: (id: string) => url(`runs/${encodeURIComponent(id)}/files`),

  saveRunFile: (id: string, path: string) => save(api.runFileUrl(id, path)),
  saveRunArchive: (id: string, query: { step?: string; attempt?: number } = {}) =>
    save(api.runArchiveUrl(id, query)),
  saveRunManifest: (id: string) => save(url(`runs/${encodeURIComponent(id)}/files`)),
};

/**
 * Fetch a file with the token on the request and hand it to the browser as a download.
 *
 * A plain link cannot do this: the API authenticates with a bearer header (SPEC 4.1) and an `a href`
 * the browser follows on its own carries no headers, so the honest href and the working click are two
 * different things. The href is still the real address, so copying it out and running it through curl
 * is a thing a person can do; clicking it goes through here.
 */
async function save(href: string): Promise<void> {
  const response = await fetch(href, { headers: { authorization: `Bearer ${session.token}` }, cache: "no-store" });
  if (!response.ok) throw await errorOf(response);
  const name = downloadName(response.headers.get("content-disposition"), href);
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

/** The filename the server asked for, or the last part of the address when it did not name one. */
function downloadName(disposition: string | null, href: string): string {
  const quoted = /filename="([^"]*)"/.exec(disposition ?? "");
  if (quoted !== null) return quoted[1]!;
  const path = new URL(href).pathname;
  return path.slice(path.lastIndexOf("/") + 1) || "download";
}

export interface Health {
  status: string;
  version: string;
  problem?: string;
}

export interface PipelineList {
  name: string;
  latest: number;
  versions: PipelineVersionMeta[];
}
