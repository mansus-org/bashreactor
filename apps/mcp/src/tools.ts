// The tools, one table. Each one names the access its route needs, describes itself well enough for
// an agent to pick the right one, and calls the REST API and nothing else.
//
// A tool's text result is the API's JSON response body, unchanged, so what an agent reads here is
// what `curl` would have printed. The two exceptions are a block's content, which the API answers
// as bytes, and the run operations, which carry the HTTP status the API used because 201 and 202
// mean different things to the caller.

import type { ApiClient } from "./api.ts";
import type { Args, CheckedArgs } from "./args.ts";
import { inputSchema } from "./args.ts";
import { errorObject, type ErrorObject } from "./errors.ts";

/** What a caller needs to reach a tool. Same three words the API's routes use. */
export type Access = "read" | "write" | "admin";

/** SPEC 1.1's name for a block or a pipeline. */
const NAME_SHAPE = "^[a-z][a-z0-9-]{0,63}$";
/** SPEC 4.2's shape of a run id. */
const RUN_ID_SHAPE = "^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$";
/** What the API's `:version` takes: a version number, or the latest one. */
const VERSION_PATTERN = "^(?:[1-9][0-9]*|latest)$";

const NAME_ARG = `Block or pipeline name: ${NAME_SHAPE}.`;
const RUN_ID_ARG = `Run id, ${RUN_ID_SHAPE}, as start_run returned it.`;
const VERSION_ARG = 'Version number, or "latest" for the newest one. Defaults to latest.';

const WRITE_HINT = "Needs a write token. ";
const ADMIN_HINT = "Needs the admin token. ";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  access: Access;
  annotations: ToolAnnotations;
  args: Args;
  run(client: ApiClient, args: CheckedArgs): Promise<unknown>;
}

const read = { readOnlyHint: true, destructiveHint: false } satisfies ToolAnnotations;
const writeOp = { readOnlyHint: false, destructiveHint: false } satisfies ToolAnnotations;

/** A POST whose status carries nothing: the caller wants the body the API answered with. */
async function postValue(client: ApiClient, path: string, body: unknown): Promise<unknown> {
  return (await client.post(path, body)).value;
}

/** Everything a caller may call, in the order a person would reach for it. */
export const TOOLS: readonly ToolDef[] = [
  {
    name: "whoami",
    title: "Who am I",
    description:
      "Report which token this session is calling with and what it may do: {name, scope, admin}, " +
      "where scope is read, write or admin. Read it when a write tool says the token lacks a scope.",
    access: "read",
    annotations: read,
    args: {},
    run: (client) => client.json("/v1/whoami"),
  },

  // --- the block library -----------------------------------------------------
  {
    name: "list_block_versions",
    title: "List a block's versions",
    description:
      `Every stored version of one block, oldest first: version, sha256, size, created_at. ${NAME_ARG} ` +
      "There is no route that lists every block name, so you have to know it. A block with no versions " +
      "is block_not_found.",
    access: "read",
    annotations: read,
    args: { name: { type: "string", required: true, description: NAME_ARG } },
    run: (client, args) => client.json(`/v1/blocks/${encodeURIComponent(String(args.name))}`),
  },
  {
    name: "get_block_version",
    title: "Read a block version",
    description:
      "One block version's metadata: name, version, sha256, size, created_at. This is not the block's " +
      "contract — its inputs and outputs are in its header, so call get_block_content.",
    access: "read",
    annotations: read,
    args: {
      name: { type: "string", required: true, description: NAME_ARG },
      version: { type: "string", description: VERSION_ARG, pattern: VERSION_PATTERN },
    },
    run: (client, args) => versionPath(client, "/v1/blocks/", String(args.name), args.version),
  },
  {
    name: "get_block_content",
    title: "Read a block's source",
    description:
      "A block's exact bytes as text, with its sha256. A block is one bash file whose declaration is a " +
      "YAML comment header at the very top: name, description, and inputs and outputs with their type, " +
      "description and default. That header is the block's whole contract — read it before writing a " +
      "step that uses the block, because `with` has to supply every input that has no default, with " +
      "the declared type. Inputs reach the script as $INPUT_<NAME> and outputs are written to files at " +
      "$OUTPUT_<NAME>; stdout and stderr are only the log.",
    access: "read",
    annotations: read,
    args: {
      name: { type: "string", required: true, description: NAME_ARG },
      version: { type: "string", description: VERSION_ARG, pattern: VERSION_PATTERN },
    },
    run: async (client, args) => {
      const version = String(args.version ?? "latest");
      const name = String(args.name);
      const result = await client.text(`/v1/blocks/${encodeURIComponent(name)}/${version}/content`);
      return {
        name,
        version,
        sha256: result.headers.get("x-block-sha256") ?? "",
        content: result.text,
      };
    },
  },

  // --- pipeline versions -----------------------------------------------------
  {
    name: "list_pipeline_versions",
    title: "List a pipeline's versions",
    description: `Every stored version of one pipeline, oldest first, metadata only. ${NAME_ARG}`,
    access: "read",
    annotations: read,
    args: { name: { type: "string", required: true, description: NAME_ARG } },
    run: (client, args) => client.json(`/v1/pipelines/${encodeURIComponent(String(args.name))}`),
  },
  {
    name: "get_pipeline_version",
    title: "Read a pipeline version",
    description:
      "One pipeline version with its YAML exactly as it was stored, plus its parsed form. Read the YAML " +
      "before you edit a pipeline, and validate the edited document before you store it.",
    access: "read",
    annotations: read,
    args: {
      name: { type: "string", required: true, description: NAME_ARG },
      version: { type: "string", description: VERSION_ARG, pattern: VERSION_PATTERN },
    },
    run: (client, args) => versionPath(client, "/v1/pipelines/", String(args.name), args.version),
  },
  {
    name: "validate_pipeline",
    title: "Validate a pipeline",
    description:
      "Check a pipeline document against its schema and against the header of every block it references, " +
      "and report every rule it breaks. It creates nothing and answers 200 even when the document is " +
      "wrong: read `valid` and then `issues`, each of which is {code, message, path}. Always validate " +
      "before store_pipeline_version or start_run, which refuse an invalid document with only its first " +
      "issue. Fix everything, not just the first line — one bad `uses` hides every type error under it.",
    access: "read",
    annotations: read,
    args: {
      yaml: { type: "string", required: true, description: "The whole pipeline document, as YAML." },
    },
    run: (client, args) => postValue(client, "/v1/pipelines/validate", { yaml: args.yaml }),
  },

  // --- runs ------------------------------------------------------------------
  {
    name: "list_runs",
    title: "List runs",
    description:
      "Every run, newest first, with id, pipeline, status, created_at, finished_at and " +
      "cancel_requested_at. A status is running, succeeded, failed or cancelled. Call get_run for one " +
      "run's steps.",
    access: "read",
    annotations: read,
    args: {},
    run: (client) => client.json("/v1/runs"),
  },
  {
    name: "get_run",
    title: "Read a run",
    description:
      "One run, the whole run.json: its inputs with defaults applied, its outputs once it succeeded, and " +
      "every step with its status, its bound `with`, its failure {code, message} and its attempts with " +
      "pids, exit codes, signals and log positions. This is how you follow a run: start_run answers " +
      "before any step has finished, so call this again until `status` is no longer running. A step is " +
      "pending, running, waiting_retry, succeeded, failed, skipped or cancelled.",
    access: "read",
    annotations: read,
    args: { id: { type: "string", required: true, description: RUN_ID_ARG } },
    run: (client, args) => client.json(`/v1/runs/${encodeURIComponent(String(args.id))}`),
  },
  {
    name: "get_run_log",
    title: "Read a step's log",
    description:
      "What one attempt of one step printed, read by byte offset. Start at offset 0, then pass back the " +
      "`next_offset` you were given so you only read what is new; that is how you follow a log that " +
      "runs for hours without reading it twice. The answer is {offset, next_offset, truncated, text}, " +
      "and truncated means the chunk hit the 1 MiB cap, so come back for the rest. stdout and stderr " +
      "are one stream, in the order they were written, and the engine adds nothing to them. A step's " +
      "whole log is its attempts in order: when attempt n is finished, ask for n+1.",
    access: "read",
    annotations: read,
    args: {
      id: { type: "string", required: true, description: RUN_ID_ARG },
      step: { type: "string", required: true, description: "The step id, a key of the run's `steps`." },
      attempt: { type: "integer", required: true, minimum: 1, description: "The attempt number, from the run's `attempts`." },
      offset: { type: "integer", minimum: 0, description: "Byte to start reading at. Defaults to 0." },
    },
    run: (client, args) =>
      client.json(`/v1/runs/${encodeURIComponent(String(args.id))}/logs/${encodeURIComponent(String(args.step))}/${String(args.attempt)}`, {
        query: { offset: Number(args.offset ?? 0) },
      }),
  },

  // --- writing ---------------------------------------------------------------
  {
    name: "store_block_version",
    title: "Store a block version",
    description:
      WRITE_HINT +
      "Store a block: `content` is the whole bash file, and its header must declare this same name. " +
      "The identity of a version is the sha256 of the bytes, so storing the same bytes again returns " +
      "the version that already exists rather than making a new one. An invalid header is refused with " +
      "block_header_malformed or block_schema_invalid and a path; a file whose first line is not " +
      "`#!/usr/bin/env bash` and whose second is not `# ---` is malformed. Pipelines refer to a block " +
      "as name@version, so a new version never changes a pipeline that named an older one.",
    access: "write",
    annotations: writeOp,
    args: {
      name: { type: "string", required: true, description: `${NAME_ARG} Must equal the name in the header.` },
      content: { type: "string", required: true, description: "The whole block file, exactly as it should be stored." },
    },
    run: (client, args) =>
      postValue(client, `/v1/blocks/${encodeURIComponent(String(args.name))}/versions`, { content: args.content }),
  },
  {
    name: "store_pipeline_version",
    title: "Store a pipeline version",
    description:
      WRITE_HINT +
      "Store a pipeline document. It is validated first, against the header of every block it " +
      "references: an invalid one is refused with its first issue as {code, message, path} and nothing " +
      "is stored, so run validate_pipeline first and fix every issue. The `name` in the file must equal " +
      "this `name`. Storing the same bytes again returns the version that already exists.",
    access: "write",
    annotations: writeOp,
    args: {
      name: { type: "string", required: true, description: `${NAME_ARG} Must equal the name in the document.` },
      yaml: { type: "string", required: true, description: "The whole pipeline document, as YAML." },
    },
    run: (client, args) =>
      postValue(client, `/v1/pipelines/${encodeURIComponent(String(args.name))}/versions`, { yaml: args.yaml }),
  },
  {
    name: "start_run",
    title: "Start a run",
    description:
      WRITE_HINT +
      "Start a run and come back at once: the answer is status 201 with the run as created, every step " +
      "still pending, because the engine drives it in the background and a block may run for hours. Do " +
      "not wait for outputs here — poll get_run with the id, and read logs with get_run_log. Give " +
      "either `pipeline` (the name of a stored pipeline, `version` optional and latest by default) or " +
      "`yaml` for a document you have not stored, never both. `inputs` must carry a value for every " +
      "pipeline input that has no default, each with its declared type; a file input is an absolute " +
      "path on the server's own filesystem. A pipeline that does not validate, or an input that does " +
      "not fit, is refused with the error object and creates no run. Never put a secret in an input: " +
      "inputs are recorded in run.json in clear text, and a step's secrets come from its `pass_env`.",
    access: "write",
    // A block can reach anything on the network the host can, which is exactly what the hint is for.
    annotations: { ...writeOp, openWorldHint: true },
    args: {
      pipeline: { type: "string", description: `Name of a stored pipeline to run. ${NAME_ARG}` },
      version: { type: "string", description: `Which version of that pipeline to run. ${VERSION_ARG}` },
      yaml: { type: "string", description: "A pipeline document to run without storing it. Use instead of pipeline." },
      inputs: {
        type: "object",
        freeKeys: true,
        description: "The run's inputs, as a JSON object of name to value. Omit when every input has a default.",
      },
    },
    run: async (client, args) => {
      const body: Record<string, unknown> = {};
      if (args.pipeline !== undefined) body.pipeline = args.pipeline;
      // The API reads `version` as an integer and takes the latest one when it is absent, so "latest"
      // is left out rather than sent as NaN.
      if (args.version !== undefined && args.version !== "latest") body.version = Number(args.version);
      if (args.yaml !== undefined) body.yaml = args.yaml;
      if (args.inputs !== undefined) body.inputs = args.inputs;
      const { status, value } = await client.post("/v1/runs", body);
      return { status, run: value };
    },
  },
  {
    name: "cancel_run",
    title: "Cancel a run",
    description:
      WRITE_HINT +
      "Ask for a cancel of a run that is running. Every pending and waiting_retry step becomes " +
      "cancelled and every running attempt is sent SIGTERM, then SIGKILL after its kill_grace; a block " +
      "may trap TERM to save progress. The answer is status 202 with the run as it stands, which is not " +
      "final yet — poll get_run. A run that already finished is run_not_active.",
    access: "write",
    annotations: { ...writeOp, destructiveHint: true },
    args: { id: { type: "string", required: true, description: RUN_ID_ARG } },
    run: async (client, args) => {
      const { status, value } = await client.post(`/v1/runs/${encodeURIComponent(String(args.id))}/cancel`, {});
      return { status, run: value };
    },
  },
  {
    name: "retry_run",
    title: "Retry a run",
    description:
      WRITE_HINT +
      "Manual retry of a run that failed or was cancelled: every failed, skipped and cancelled step " +
      "goes back to pending with its attempt budget reset, the steps that succeeded keep their results, " +
      "work directories are kept, and the same snapshots of the pipeline and blocks are used — so " +
      "fixing a block does not change a run already started. Only a failed or cancelled run: a running " +
      "or succeeded one is run_not_retryable. Answers 200 with the run if it settled inside the " +
      "request, 202 if it is still going; then poll get_run.",
    access: "write",
    annotations: writeOp,
    args: { id: { type: "string", required: true, description: RUN_ID_ARG } },
    run: async (client, args) => {
      const { status, value } = await client.post(`/v1/runs/${encodeURIComponent(String(args.id))}/retry`, {});
      return { status, run: value };
    },
  },
  {
    name: "resume_run",
    title: "Resume a run",
    description:
      WRITE_HINT +
      "Take up a run that is still marked running because the engine that drove it died: its " +
      "interrupted attempts are stopped and started again from the top, in the same work directories, " +
      "so a block that saves progress there does not start over. Only for a run whose status is " +
      "running — one that finished is run_not_active, and one another engine holds is run_claimed. " +
      "Answers 200 with the run if it settled inside the request, 202 if it is still going.",
    access: "write",
    annotations: writeOp,
    args: { id: { type: "string", required: true, description: RUN_ID_ARG } },
    run: async (client, args) => {
      const { status, value } = await client.post(`/v1/runs/${encodeURIComponent(String(args.id))}/resume`, {});
      return { status, run: value };
    },
  },

  // --- tokens ----------------------------------------------------------------
  {
    name: "list_agent_tokens",
    title: "List agent tokens",
    description:
      ADMIN_HINT +
      "Every agent token the API has issued — id, name, scope, created_at, last_used — without their " +
      "secrets, which are never stored in the clear.",
    access: "admin",
    annotations: read,
    args: {},
    run: (client) => client.json("/v1/tokens"),
  },
  {
    name: "create_agent_token",
    title: "Create an agent token",
    description:
      ADMIN_HINT +
      "Issue an agent token that is read or write. The secret appears in this answer once and nowhere " +
      "else, so hand it to a human there and do not repeat it or store it. Give it the least scope the " +
      "agent needs: a reader that only browses the library gets read.",
    access: "admin",
    annotations: { ...writeOp, openWorldHint: false },
    args: {
      name: { type: "string", required: true, description: "What the token is called, such as the agent's name." },
      scope: { type: "string", required: true, enum: ["read", "write"], description: "What the token may do." },
    },
    run: (client, args) => postValue(client, "/v1/tokens", { name: args.name, scope: args.scope }),
  },
  {
    name: "revoke_agent_token",
    title: "Revoke an agent token",
    description:
      ADMIN_HINT +
      "Revoke one agent token by its id, from list_agent_tokens. The next request made with it is " +
      "refused, with no restart. An id that is not there is token_not_found.",
    access: "admin",
    annotations: { ...writeOp, destructiveHint: true },
    args: { id: { type: "string", required: true, description: "The token's id, not its secret." } },
    run: (client, args) => client.delete(`/v1/tokens/${encodeURIComponent(String(args.id))}`),
  },
];

/** The tool named, or null. A client may ask for anything. */
export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/** Why a caller may not use a tool, in the API's own words, or null when it may. */
export function refusalFor(tool: ToolDef, identity: { name: string; scope: Access; admin: boolean }): ErrorObject | null {
  if (tool.access === "admin" && !identity.admin) {
    return errorObject(
      "forbidden",
      `token "${identity.name}" is not the admin token; the tool ${tool.name} needs the admin token`,
    );
  }
  if (tool.access === "write" && identity.scope === "read") {
    return errorObject(
      "forbidden",
      `token "${identity.name}" is read-only; the tool ${tool.name} needs a write token`,
    );
  }
  return null;
}

/** The `tools/list` entry for a tool, schema included. */
export function toolListing(tool: ToolDef) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchema(tool.args),
    annotations: tool.annotations,
  };
}

/** `/v1/<kind>/<name>/<version>`, with latest when no version was given. */
function versionPath(client: ApiClient, base: string, name: string, version: unknown): Promise<unknown> {
  return client.json(`${base}${encodeURIComponent(name)}/${encodeURIComponent(String(version ?? "latest"))}`);
}
