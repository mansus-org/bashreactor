# Bashreactor

A resumable pipeline runner for bash: a YAML file says what runs, every step runs one bash file, and a
run is a directory that can be restarted. These are the words the spec, the API, the CLI, the MCP
server and the web UI all use. `docs/SPEC.md` is where each one is defined in full.

## Authoring

**Pipeline**:
A named YAML document that lists steps, the inputs it takes and the outputs it gives.
_Avoid_: Flow, workflow, DAG, job

**Pipeline version**:
One stored, numbered copy of a pipeline (v1, v2, …); storing a pipeline adds a version, never edits one.
_Avoid_: Revision, deployment

**Step**:
One entry under a pipeline's `steps:`, which runs one block with its inputs bound.
_Avoid_: Task, job, node

**Block**:
A named bash file whose header declares what goes in and what comes out.
_Avoid_: Task, script, action, Prefect's "block" (stored configuration)

**Block version**:
One stored, numbered copy of a block, identified by the SHA-256 of its exact bytes.

**Contract**:
The inputs and outputs a block declares in its header, or a pipeline declares at its top level.
_Avoid_: Signature, schema, interface

**Library**:
The stored blocks, and only blocks. Stored pipelines are "pipelines", not library entries.
_Avoid_: Registry, catalog, store (for this meaning)

**Library reference**:
A step's `uses: name@version`, which names one block version in the library.

## Running

**Run**:
One execution of a pipeline with its inputs, recorded as one directory.
_Avoid_: Flow run, job, execution, build

**Run id**:
The name of a run, its creation time and a random suffix (`20261104T101500Z-3fa9c2d1`), so ids sort by time.
_Avoid_: Run name, run number

**Status**:
Where a run, step or attempt stands, always one of the spec's words (`pending`, `running`, `waiting_retry`, `succeeded`, `failed`, `skipped`, `cancelled`, and `interrupted` for an attempt).
_Avoid_: Completed, crashed, scheduled, state names from other tools

**Attempt**:
One try at running a step, numbered from 1 for the life of the run and never reset.
_Avoid_: Try, retry (for the attempt itself), execution

**Snapshot**:
The exact bytes of the pipeline and blocks a run was started with, kept in the run directory; resume and retry read only these.

**Work directory**:
A step's working directory inside its run, kept across its attempts so a later attempt can carry on.

**Claim**:
An engine's hold on a running run; only the holder writes the run.
_Avoid_: Lock, lease

**Manual retry**:
Setting a failed or cancelled run's unfinished steps back to `pending`, from the same snapshot, while its succeeded steps stay.
_Avoid_: Rerun, restart

**Resume**:
An engine taking up a run that was left `running` when its previous engine stopped.
_Avoid_: Restart, recover

## Access

**Admin token**:
The one token configured on the server, which can do everything, including managing agent tokens.

**Agent token**:
A token the admin creates for a person or an agent, with read or write access.
_Avoid_: API key, secret
