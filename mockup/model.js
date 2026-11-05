// The document model: YAML text goes in, the steps, wires and problems come out, and every edit
// from the graph side is a change to the text. Nothing here stores a pipeline, so the graph and the
// YAML cannot drift apart. This is the one file that knows the pipeline schema and the block format.

window.BR = window.BR || {};

BR.model = (() => {
  const REF = /\$\{\{\s*(.+?)\s*\}\}/g;
  const TOP_KEYS = ["name", "description", "max_parallel", "inputs", "steps", "outputs"];
  const STEP_KEYS = ["name", "uses", "needs", "with", "timeout", "retry"];
  const RETRY_KEYS = ["max_attempts", "delay"];
  const DURATION = /^\d+(s|m|h|d)$/;

  function problem(code, line, message, step) {
    return { code, line, message, step: step || null };
  }

  const isMap = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

  function readRef(expr) {
    const output = expr.match(/^steps\.([\w-]+)\.outputs\.([\w-]+)$/);
    if (output) return { kind: "output", step: output[1], output: output[2] };
    const input = expr.match(/^inputs\.([\w-]+)$/);
    if (input) return { kind: "input", name: input[1] };
    return { kind: "invalid", text: expr };
  }

  function refsIn(value) {
    if (typeof value !== "string") return [];
    return [...value.matchAll(REF)].map((m) => readRef(m[1]));
  }

  // One value is a plain reference, a string with references in it, or a literal.
  function readSource(value, has) {
    if (!has) return { kind: "unset", value: null, refs: [] };
    const refs = refsIn(value);
    if (refs.length === 1 && typeof value === "string" && value.replace(REF, "").trim() === "") return { ...refs[0], value, refs };
    return { kind: refs.length ? "template" : "literal", value, refs };
  }

  const outputRef = (step, output) => `\${{ steps.${step}.outputs.${output} }}`;
  const inputRef = (name) => `\${{ inputs.${name} }}`;

  // ---------- block files ----------

  // The spec has no runtime field: a block is always a bash file, and uv or bun are what it hands
  // over to. So the stamp is read from the script itself.
  function detectRuntime(body) {
    const match = body.match(/^\s*(?:exec\s+)?(uv|bun)\s+run\b/m);
    return match ? match[1] : "bash";
  }

  function parseBlock(source) {
    const out = { name: null, description: "", runtime: "bash", inputs: [], outputs: [], problems: [] };
    const lines = source.split("\n");
    let open = lines[0] && lines[0].startsWith("#!") ? 1 : 0;
    if ((lines[open] || "").trim() !== "# ---") {
      out.problems.push(problem("block_header", open + 1, 'A block starts with front matter: a "# ---" line after the shebang.'));
      return out;
    }
    const start = open + 1;
    let close = start;
    while (close < lines.length && lines[close].trim() !== "# ---") close++;
    if (close >= lines.length) {
      out.problems.push(problem("block_header", start, 'The front matter needs a closing "# ---" line.'));
      return out;
    }
    const bad = lines.slice(start, close).findIndex((l) => !/^#( |$)/.test(l));
    if (bad !== -1) {
      out.problems.push(problem("block_header", start + bad + 1, "Every front matter line starts with a # and a space."));
      return out;
    }
    const parsed = BR.yaml.parse(lines.slice(start, close).map((l) => l.replace(/^# ?/, "")).join("\n"));
    if (!parsed.ok) {
      out.problems.push(problem("block_header", parsed.error.line + start, parsed.error.message));
      return out;
    }
    const front = isMap(parsed.value) ? parsed.value : {};
    out.name = front.name ? String(front.name) : null;
    out.description = front.description ? String(front.description) : "";
    out.runtime = detectRuntime(lines.slice(close + 1).join("\n"));
    if (!out.name) out.problems.push(problem("block_header", start + 1, 'The front matter needs a "name".'));
    const declared = (map, kind) =>
      Object.entries(isMap(map) ? map : {}).map(([name, raw]) => {
        const decl = isMap(raw) ? raw : {};
        if (!decl.type) {
          out.problems.push(problem("block_header", (parsed.locs[`${kind}.${name}`] || { start: 0 }).start + start, `${name} needs a "type".`));
        }
        const hasDefault = Object.prototype.hasOwnProperty.call(decl, "default");
        return { name, type: decl.type || "unknown", description: decl.description ? String(decl.description) : "", required: !hasDefault, default: hasDefault ? decl.default : null };
      });
    out.inputs = declared(front.inputs, "inputs");
    out.outputs = declared(front.outputs, "outputs");
    return out;
  }

  const latest = (block) => block.versions[block.versions.length - 1];

  function usesFor(name) {
    return `./${name}.sh`;
  }

  // ---------- pipeline analysis ----------

  function analyze(text, library) {
    const parsed = BR.yaml.parse(text);
    if (!parsed.ok) return { ok: false, error: parsed.error, problems: [problem(parsed.error.code, parsed.error.line, parsed.error.message)] };

    const { locs } = parsed;
    const root = isMap(parsed.value) ? parsed.value : {};
    const problems = [];
    const lineOf = (path, fallback = 1) => (locs[path] ? locs[path].start : fallback);

    if (!root.name) problems.push(problem("missing_name", 1, 'The pipeline needs a "name".'));
    for (const key of Object.keys(root)) {
      if (!TOP_KEYS.includes(key)) problems.push(problem("unknown_key", lineOf(key), `A pipeline has no "${key}" key.`));
    }
    if (root.max_parallel !== undefined && !(Number.isInteger(root.max_parallel) && root.max_parallel > 0)) {
      problems.push(problem("bad_max_parallel", lineOf("max_parallel"), '"max_parallel" is a whole number, 1 or more.'));
    }

    const inputs = isMap(root.inputs) ? root.inputs : {};
    if (root.steps !== undefined && root.steps !== null && !isMap(root.steps)) {
      problems.push(problem("bad_steps", lineOf("steps"), '"steps" is a map of step ids.'));
    }
    const rawSteps = isMap(root.steps) ? root.steps : {};

    const steps = Object.keys(rawSteps).map((id) => {
      const path = `steps.${id}`;
      const raw = isMap(rawSteps[id]) ? rawSteps[id] : {};
      const range = locs[path];
      const retry = isMap(raw.retry) ? raw.retry : null;
      const step = {
        id,
        raw,
        range,
        title: raw.name ? String(raw.name) : "",
        uses: raw.uses ? String(raw.uses) : null,
        blockName: null,
        version: null,
        contract: null,
        needs: [],
        deps: [],
        timeout: raw.timeout === undefined || raw.timeout === null ? null : String(raw.timeout),
        maxAttempts: retry && retry.max_attempts !== undefined ? retry.max_attempts : null,
        delay: retry && retry.delay !== undefined ? retry.delay : null,
        inputs: [],
        outputs: [],
      };

      for (const key of Object.keys(raw)) {
        if (!STEP_KEYS.includes(key)) problems.push(problem("unknown_key", lineOf(`${path}.${key}`, range.start), `Steps have no "${key}" key.`, id));
      }
      if (raw.retry !== undefined && raw.retry !== null) {
        if (!retry) problems.push(problem("bad_retry", lineOf(`${path}.retry`), '"retry" is a map with max_attempts and delay.', id));
        else {
          for (const key of Object.keys(retry)) {
            if (!RETRY_KEYS.includes(key)) problems.push(problem("unknown_key", lineOf(`${path}.retry.${key}`), `"retry" has no "${key}" key.`, id));
          }
          if (retry.max_attempts !== undefined && !(Number.isInteger(retry.max_attempts) && retry.max_attempts > 0)) {
            problems.push(problem("bad_retry", lineOf(`${path}.retry.max_attempts`), '"max_attempts" is a whole number, 1 or more.', id));
          }
          if (retry.delay !== undefined && !DURATION.test(String(retry.delay))) {
            problems.push(problem("bad_retry", lineOf(`${path}.retry.delay`), "Delays read like 1s, 30s or 5m.", id));
          }
        }
      }

      if (!raw.uses) {
        problems.push(problem("missing_uses", range.start, `Step ${id} needs "uses", the block file it runs.`, id));
      } else {
        const match = String(raw.uses).match(/^\.\/([\w-]+)\.sh$/);
        const line = lineOf(`${path}.uses`, range.start);
        if (!match) {
          problems.push(problem("bad_uses", line, "Write the block as a path next to the pipeline, like ./count-words.sh.", id));
        } else {
          step.blockName = match[1];
          const block = library.find((b) => b.name === step.blockName);
          if (!block) {
            problems.push(problem("unknown_block", line, `There is no block ${step.blockName} in the library.`, id));
          } else {
            const current = latest(block);
            step.version = current.version;
            step.contract = parseBlock(current.source);
          }
        }
      }

      if (raw.needs !== undefined && raw.needs !== null) {
        step.needs = (Array.isArray(raw.needs) ? raw.needs : [raw.needs]).map(String);
      }
      if (raw.timeout !== undefined && raw.timeout !== null && !DURATION.test(String(raw.timeout))) {
        problems.push(problem("bad_timeout", lineOf(`${path}.timeout`), "Timeouts read like 90s, 15m, 6h or 2d.", id));
      }
      return step;
    });

    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    const edges = [];

    const checkRefs = (refs, line, id) => {
      for (const ref of refs) {
        if (ref.kind === "invalid") problems.push(problem("bad_ref", line, `"${ref.text}" is not a reference this schema has.`, id));
        if (ref.kind === "input" && !inputs[ref.name]) problems.push(problem("bad_ref", line, `The pipeline has no input called ${ref.name}.`, id));
        if (ref.kind === "output") {
          const from = byId[ref.step];
          if (!from) problems.push(problem("bad_ref", line, `There is no step called ${ref.step}.`, id));
          else if (from.contract && !from.contract.outputs.some((o) => o.name === ref.output)) {
            problems.push(problem("bad_ref", line, `${from.uses} has no output called ${ref.output}.`, id));
          }
        }
      }
    };

    for (const step of steps) {
      const path = `steps.${step.id}`;
      for (const need of step.needs) {
        if (!byId[need]) problems.push(problem("unknown_need", lineOf(`${path}.needs`), `Step ${step.id} needs ${need}, which does not exist.`, step.id));
      }

      const given = isMap(step.raw.with) ? step.raw.with : {};
      const declared = step.contract ? step.contract.inputs : [];
      const fedBy = new Set();

      const describe = (name, decl) => {
        const has = Object.prototype.hasOwnProperty.call(given, name);
        const line = lineOf(`${path}.with.${name}`, step.range.start);
        const source = readSource(has ? given[name] : null, has);
        checkRefs(source.refs, line, step.id);
        for (const ref of source.refs) {
          const from = ref.kind === "output" ? byId[ref.step] : null;
          if (from && (!from.contract || from.contract.outputs.some((o) => o.name === ref.output))) {
            fedBy.add(ref.step);
            edges.push({ from: ref.step, out: ref.output, to: step.id, in: name, kind: "data" });
          }
        }
        if (!has && decl && decl.required) problems.push(problem("missing_input", step.range.start, `Step ${step.id} has to set input ${name}.`, step.id));
        if (has && !decl && step.contract) problems.push(problem("unknown_input", line, `${step.uses} has no input called ${name}.`, step.id));
        return { name, type: decl ? decl.type : "unknown", required: decl ? decl.required : false, default: decl ? decl.default : null, description: decl ? decl.description : "", source };
      };

      step.inputs = declared.map((d) => describe(d.name, d));
      // Keys the block does not declare still draw, so the wire stays visible next to its problem.
      for (const key of Object.keys(given)) {
        if (!declared.some((d) => d.name === key)) step.inputs.push(describe(key, null));
      }
      step.outputs = step.contract ? step.contract.outputs : [];

      // A reference is a dependency by itself. "needs" only adds order without data.
      step.deps = [...new Set([...fedBy, ...step.needs.filter((n) => byId[n])])];
      for (const need of step.deps) {
        if (!fedBy.has(need)) edges.push({ from: need, to: step.id, kind: "needs" });
      }
    }

    const outputs = Object.entries(isMap(root.outputs) ? root.outputs : {}).map(([name, value]) => {
      const refs = refsIn(value);
      checkRefs(refs, lineOf(`outputs.${name}`), null);
      return { name, value: value === null ? "" : String(value), refs };
    });

    // Kahn's algorithm: whatever it cannot place is in a cycle. Those steps still get a layer, in
    // document order, so a broken graph is drawn and not hidden.
    const order = [];
    const layerOf = {};
    const pending = new Map(steps.map((s) => [s.id, new Set(s.deps)]));
    while (pending.size) {
      const ready = [...pending].filter(([, deps]) => [...deps].every((d) => !pending.has(d))).map(([id]) => id);
      if (ready.length === 0) {
        const stuck = [...pending.keys()];
        problems.push(problem("cycle", lineOf(`steps.${stuck[0]}`), `These steps wait for each other: ${stuck.join(", ")}.`, stuck[0]));
        for (const id of stuck) {
          layerOf[id] = Math.max(0, ...byId[id].deps.filter((d) => layerOf[d] !== undefined).map((d) => layerOf[d] + 1));
          order.push(id);
          pending.delete(id);
        }
        break;
      }
      for (const id of ready) {
        layerOf[id] = Math.max(0, ...[...pending.get(id)].map((d) => layerOf[d] + 1));
        order.push(id);
        pending.delete(id);
      }
    }
    for (const step of steps) step.layer = layerOf[step.id];
    const layers = [];
    for (const id of order) (layers[layerOf[id]] = layers[layerOf[id]] || []).push(id);

    problems.sort((a, b) => a.line - b.line);
    return {
      ok: true,
      name: root.name ? String(root.name) : "",
      description: root.description ? String(root.description) : "",
      maxParallel: Number.isInteger(root.max_parallel) && root.max_parallel > 0 ? root.max_parallel : Infinity,
      inputs: Object.keys(inputs).map((name) => {
        const raw = isMap(inputs[name]) ? inputs[name] : {};
        const hasDefault = Object.prototype.hasOwnProperty.call(raw, "default");
        return { name, type: raw.type || "string", description: raw.description ? String(raw.description) : "", required: !hasDefault, default: hasDefault ? raw.default : null };
      }),
      outputs,
      steps,
      byId,
      order,
      layers: layers.filter(Boolean),
      edges,
      problems,
      locs,
    };
  }

  function stepAtLine(analysis, line) {
    if (!analysis.ok) return null;
    const hit = analysis.steps.find((s) => line >= s.range.start && line <= s.range.end);
    return hit ? hit.id : null;
  }

  // ---------- edits: text in, text out ----------

  function formatValue(value) {
    return Array.isArray(value) ? `[${value.join(", ")}]` : BR.yaml.formatScalar(value);
  }

  // Sets or deletes one key and leaves every other line byte for byte what the person typed, so a
  // graph edit never eats a comment. Each step re-parses, because each one moves the lines.
  function setPath(text, path, value) {
    const parsed = BR.yaml.parse(text);
    const key = path.join(".");
    const parentPath = path.slice(0, -1);
    const parentKey = parentPath.join(".");
    const lines = text.split("\n");
    const here = parsed.locs[key];

    if (value === undefined) {
      if (!here) return text;
      lines.splice(here.start - 1, here.end - here.start + 1);
      const next = lines.join("\n");
      // A key that lost its last child would read back as null, which is a different document.
      if (parentPath.length) {
        const after = BR.yaml.parse(next);
        const parentValue = parentPath.reduce((v, k) => (v ? v[k] : undefined), after.value);
        if (parentValue === null) return setPath(next, parentPath, undefined);
      }
      return next;
    }

    const leaf = path[path.length - 1];
    if (here) {
      const indent = lines[here.start - 1].match(/^ */)[0];
      lines.splice(here.start - 1, here.end - here.start + 1, `${indent}${leaf}: ${formatValue(value)}`);
      return lines.join("\n");
    }

    const parent = parentPath.length ? parsed.locs[parentKey] : null;
    if (parentPath.length && !parent) {
      const withParent = setPath(text, parentPath, null);
      return setPath(withParent, path, value);
    }
    if (!parentPath.length) {
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push("", value === null ? `${leaf}:` : `${leaf}: ${formatValue(value)}`, "");
      return lines.join("\n");
    }
    const indent = `${lines[parent.start - 1].match(/^ */)[0]}  `;
    lines.splice(parent.end, 0, value === null ? `${indent}${leaf}:` : `${indent}${leaf}: ${formatValue(value)}`);
    return lines.join("\n");
  }

  function editStep(text, id, key, value) {
    return setPath(text, ["steps", id, ...key.split(".")], value);
  }

  function addStep(text, analysis, id, step) {
    const lines = text.split("\n");
    const body = [`  ${id}:`];
    if (step.title) body.push(`    name: ${BR.yaml.formatScalar(step.title)}`);
    body.push(`    uses: ${step.uses}`);
    if (analysis.steps.length) {
      lines.splice(analysis.steps[analysis.steps.length - 1].range.end, 0, "", ...body);
    } else if (analysis.locs.steps) {
      lines.splice(analysis.locs.steps.start - 1, 1, "steps:", ...body);
    } else {
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push("", "steps:", ...body, "");
    }
    return lines.join("\n");
  }

  // Removing a step also takes it out of everything that used it. Otherwise one click would leave a
  // problem on every step downstream.
  function removeStep(text, analysis, id) {
    let next = text;
    for (const output of analysis.outputs) {
      if (output.refs.some((r) => r.kind === "output" && r.step === id)) next = setPath(next, ["outputs", output.name], undefined);
    }
    for (const step of analysis.steps) {
      if (step.id === id) continue;
      for (const input of step.inputs) {
        if (input.source.refs.some((r) => r.kind === "output" && r.step === id)) next = editStep(next, step.id, `with.${input.name}`, undefined);
      }
      if (step.needs.includes(id)) {
        const left = step.needs.filter((n) => n !== id);
        next = editStep(next, step.id, "needs", left.length ? left : undefined);
      }
    }
    const range = BR.yaml.parse(next).locs[`steps.${id}`];
    const lines = next.split("\n");
    const hasBlankBefore = range.start >= 2 && lines[range.start - 2].trim() === "";
    const from = hasBlankBefore ? range.start - 2 : range.start - 1;
    lines.splice(from, range.end - from);
    return lines.join("\n");
  }

  // ---------- what a step can read from ----------

  // Everything not downstream is a legal source. Downstream would make a cycle, so it is not offered.
  function sourcesFor(analysis, id) {
    const downstream = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const step of analysis.steps) {
        if (!downstream.has(step.id) && step.deps.some((d) => downstream.has(d))) {
          downstream.add(step.id);
          grew = true;
        }
      }
    }
    const out = analysis.inputs.map((input) => ({ value: inputRef(input.name), label: `Pipeline input ${input.name}` }));
    for (const step of analysis.steps) {
      if (downstream.has(step.id)) continue;
      for (const output of step.outputs) out.push({ value: outputRef(step.id, output.name), label: `${step.id}, output ${output.name}` });
    }
    return out;
  }

  // The steps that could not run before this one finishes, for the "needs" checkboxes.
  function wouldCycle(analysis, id, candidate) {
    const seen = new Set();
    const walk = (at) => {
      if (at === id) return true;
      if (seen.has(at)) return false;
      seen.add(at);
      return (analysis.byId[at] ? analysis.byId[at].deps : []).some(walk);
    };
    return walk(candidate);
  }

  return { analyze, parseBlock, refsIn, stepAtLine, editStep, addStep, removeStep, sourcesFor, wouldCycle, latest, usesFor };
})();
