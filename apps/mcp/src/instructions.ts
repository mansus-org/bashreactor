// The instructions string of the `initialize` result: the one text an agent reads before it picks a
// tool, so it has to carry the four things that are not obvious from a tool's name — that a block's
// contract is its header, that validation is free and storing is not, that a run is asynchronous,
// and that a log is read by offset. Written to be read once and then acted on correctly.

export const INSTRUCTIONS = `Bashreactor runs pipelines of bash blocks. A block is one bash file: it reads its inputs from $INPUT_<NAME>, writes each output to the file at $OUTPUT_<NAME>, and treats stdout and stderr as its log only. A pipeline names steps, each with \`uses: name@version\`, and binds the block's inputs under \`with:\`. Every tool here calls the same REST API the CLI and the web app call, with the token you connected with: nothing is cached, nothing is remembered between calls.

Read before you write.
- A block's contract is its header: the YAML in the comment block at the very top of the file, declaring name, description, and inputs and outputs with their type, description and default. get_block_content shows it; get_block_version is metadata only. The six types are string, integer, number, boolean, json and file. An input with no default must be given in \`with\`, with its declared type.
- Read a stored pipeline's YAML with get_pipeline_version before you change it, and store it under its own name.

Validate, then store.
- validate_pipeline creates nothing and answers even when the document is wrong: read \`valid\`, then \`issues\`, each {code, message, path}. Fix every issue at once — one unresolvable \`uses\` hides every type error under it.
- store_pipeline_version and start_run refuse an invalid document with only its first issue, so validating first is cheaper than guessing.
- A step names a block as name@version and a version never changes, so storing a new block version cannot disturb a pipeline that named an older one.

A run is asynchronous.
- start_run answers 201 with the run as created and every step pending, because the engine drives it in the background and a block may run for six hours. Do not expect outputs in that answer: poll get_run until \`status\` is no longer "running", and read logs while it goes.
- cancel_run is for a run that is running, retry_run for one that failed or was cancelled, resume_run for one left "running" by an engine that died. Each answers before the run is final, so poll get_run after it too.

Read a log by offset.
- get_run_log(id, step, attempt, offset) returns {offset, next_offset, truncated, text}. Start at 0, then pass back the next_offset you were given to read only what is new; that is how you follow hours of output without reading it twice. \`truncated\` means the chunk hit the size cap and there is more at next_offset. A step's log is its attempts in order, so move to the next attempt number once one has finished.

Errors are one object everywhere.
- A failing tool returns {code, message, path, file} — the same object the REST API and the CLI print. Act on \`code\`: type_mismatch, missing_input and unknown_input name the field in \`path\`; block_not_found says that block or version is not stored; run_not_found, run_not_active, run_not_retryable and run_claimed say the run is elsewhere in its life. Do not repeat a call that failed with a definition error — fix the document and send it again.
- A tool that needs more than your token grants says which scope it lacked. whoami shows what your token is.`;
