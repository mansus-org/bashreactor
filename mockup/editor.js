// The pipeline editor. The one piece of state that matters is `text`, the YAML. Typing changes it
// directly; every control on the graph side computes a new text through model.js. Everything on
// screen is then drawn from analyzing that text, so there is no second copy to keep in step.

(() => {
  const { el } = BR;
  const view = document.getElementById("view");

  if (BR.demoState === "loading") {
    view.replaceChildren(el("h1", { class: "title" }, "Pipeline"), el("p", { class: "state", role: "status" }, "Loading word-report from the store."));
    return;
  }
  if (BR.demoState === "error") {
    view.replaceChildren(
      el("h1", { class: "title" }, "Pipeline"),
      BR.errorBox(
        { code: "pipeline_unavailable", message: "The store did not answer, so the document could not be opened. Your last saved version is safe. Try again, and if this keeps happening check the API with bashreactor status." },
        el("a", { class: "btn btn--ink", href: "pipeline.html" }, "Try again"),
      ),
    );
    return;
  }

  const library = BR.library();
  let text = BR.demoState === "empty" ? "name: new-pipeline\n\nsteps:\n" : BR.pipelineText();
  let analysis = null;
  let lastGood = null;
  let selected = null;
  let undoStack = [];
  let undoKey = null;
  let flashed = {};
  let flashTimer = null;

  // ---------- skeleton ----------

  const title = el("h1", { class: "title" });
  const lead = el("p", { class: "lead" });
  const runButton = el("button", { class: "btn btn--ink", type: "button", onclick: openStartDialog }, "Start a run");
  const runHint = el("p", { class: "help" });
  const stageNote = el("p", { class: "stale-note", role: "status", hidden: true });
  const stage = el("div", { class: "stage", id: "stage", role: "group", "aria-label": "Pipeline graph. Up and Down walk the steps, Right goes to a step this one feeds, Left to a step it waits for." });
  const undoButton = el("button", { class: "btn", type: "button", disabled: true, onclick: undo }, "Undo");
  const addButton = el("button", { class: "btn", type: "button", onclick: openAddDialog }, "Add step");
  const inspector = el("section", { class: "inspector", id: "inspector", "aria-labelledby": "inspector-title" });
  const statusStamp = el("a", { class: "stamp", href: "#problems" });

  const gutter = el("div", { class: "yaml__gutter", "aria-hidden": "true" });
  const paintInner = el("div", { class: "yaml__inner" });
  const paint = el("pre", { class: "yaml__paint", "aria-hidden": "true" }, paintInner);
  const textarea = el("textarea", {
    id: "doc",
    wrap: "off",
    spellcheck: "false",
    autocapitalize: "off",
    autocomplete: "off",
    "aria-describedby": "yaml-help",
  });
  const problemsList = el("ol", { class: "problems__list" });
  const problemsNote = el("p", { class: "help" });
  const startDialog = el("dialog", { class: "dialog", "aria-labelledby": "start-title" });
  const addDialog = el("dialog", { class: "dialog", "aria-labelledby": "add-title" });

  const graph = BR.graph.create(stage, { onSelect: (id) => select(id, "graph") });

  view.replaceChildren(
    el(
      "div",
      { class: "head" },
      el("div", { class: "head__text" }, title, lead),
      el("div", { class: "row" }, el("a", { class: "btn", href: "run.html" }, "Latest run"), runButton),
      runHint,
    ),
    el(
      "div",
      { class: "ed" },
      el(
        "div",
        { class: "ed__graph" },
        el(
          "section",
          { "aria-labelledby": "graph-title" },
          el("div", { class: "bar" }, el("h2", { class: "h2", id: "graph-title" }, "Graph"), el("div", { class: "row" }, undoButton, addButton)),
          stageNote,
          stage,
          el(
            "p",
            { class: "legend" },
            el("span", {}, el("span", { class: "sw sw--wired" }), "fed by a reference"),
            el("span", {}, el("span", { class: "sw sw--value" }), "set to a value"),
            el("span", {}, el("span", { class: "sw sw--data" }), "output feeds input"),
            el("span", {}, el("span", { class: "sw sw--needs" }), "order only, no data"),
          ),
        ),
        inspector,
      ),
      el(
        "section",
        { class: "ed__yaml", "aria-labelledby": "yaml-title" },
        el("div", { class: "bar" }, el("h2", { class: "h2", id: "yaml-title" }, "YAML"), statusStamp),
        el("label", { class: "sr", for: "doc" }, "Pipeline YAML"),
        el("p", { class: "sr", id: "yaml-help" }, "Edits redraw the graph. Moving the caret into a step selects it in the graph. Tab leaves this field."),
        el("div", { class: "yaml" }, gutter, el("div", { class: "yaml__code" }, paint, textarea)),
        el(
          "section",
          { class: "problems", id: "problems", "aria-labelledby": "problems-title", tabindex: "-1" },
          el("h3", { class: "h3", id: "problems-title" }, "Problems"),
          problemsNote,
          problemsList,
        ),
      ),
    ),
    startDialog,
    addDialog,
  );

  // ---------- text is the state ----------

  function setText(next, { source, select: nextSelect } = {}) {
    text = next;
    if (BR.demoState === "loaded") BR.store.set("doc", text);
    if (source !== "yaml") textarea.value = text;
    analysis = BR.model.analyze(text, library);
    if (analysis.ok) lastGood = analysis;

    if (analysis.ok) {
      if (nextSelect !== undefined) selected = nextSelect;
      if (selected && !analysis.byId[selected]) selected = null;
      if (!selected && analysis.order.length) selected = analysis.order[0];
    }
    render(source);
    scheduleFlash();
  }

  function render(source) {
    const shown = analysis.ok ? analysis : lastGood;
    const stale = !analysis.ok;

    if (shown) {
      title.textContent = shown.name || "Untitled pipeline";
      lead.textContent = shown.description;
      document.title = `${shown.name || "Untitled"}, Bashreactor mockup`;
    }

    stageNote.hidden = !stale;
    if (stale) stageNote.textContent = `Line ${analysis.error.line} does not parse. The graph shows the last version that did, as a ghost, until it does.`;
    if (shown) graph.update({ analysis: shown, selected, stale });

    const count = analysis.problems.length;
    statusStamp.replaceChildren(BR.sign(count ? "failed" : "succeeded"), stale ? "does not parse" : count ? `${count} ${count === 1 ? "problem" : "problems"}` : "valid");

    runButton.disabled = count > 0 || !analysis.ok || !analysis.steps.length;
    runHint.textContent = !analysis.ok || count ? `Fix ${count === 1 ? "the problem" : `the ${count} problems`} under the YAML to start a run.` : analysis.steps.length ? "" : "Add a step to start a run.";
    runHint.hidden = !runHint.textContent;

    renderYaml();
    renderProblems();
    if (source !== "inspector-text") renderInspector();
  }

  function scheduleFlash() {
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      if (!analysis.ok) return;
      const now = Object.fromEntries(analysis.steps.map((s) => [s.id, JSON.stringify(s.raw)]));
      const changed = Object.keys(now).filter((id) => flashed[id] !== undefined && flashed[id] !== now[id]);
      const added = Object.keys(now).filter((id) => flashed[id] === undefined && Object.keys(flashed).length);
      graph.flash([...changed, ...added]);
      flashed = now;
    }, 300);
  }

  // ---------- the YAML pane ----------

  function paintLine(raw) {
    const line = el("span", { class: "yaml__line" });
    const commentAt = raw.search(/(^|\s)#/);
    const code = commentAt === -1 ? raw : raw.slice(0, commentAt);
    const comment = commentAt === -1 ? "" : raw.slice(commentAt);
    const key = code.match(/^(\s*(?:-\s+)?)([\w.-]+)(:)(.*)$/);
    const rest = key ? key[4] : code;
    if (key) line.append(key[1], el("span", { class: "yaml__key" }, key[2]), key[3]);
    let at = 0;
    for (const match of rest.matchAll(/\$\{\{.*?\}\}/g)) {
      line.append(rest.slice(at, match.index), el("span", { class: "yaml__ref" }, match[0]));
      at = match.index + match[0].length;
    }
    line.append(rest.slice(at));
    if (comment) line.append(el("span", { class: "yaml__comment" }, comment));
    if (raw === "") line.append(" ");
    return line;
  }

  function renderYaml() {
    const lines = text.split("\n");
    const bad = new Set(analysis.problems.map((p) => p.line));
    const range = analysis.ok && selected && analysis.byId[selected] ? analysis.byId[selected].range : null;
    const hit = (n) => range && n >= range.start && n <= range.end;
    paintInner.replaceChildren(
      ...lines.map((raw, index) => {
        const line = paintLine(raw);
        if (hit(index + 1)) line.classList.add("is-hit");
        return line;
      }),
    );
    gutter.replaceChildren(
      ...lines.map((_, index) => el("span", { class: `yaml__num${hit(index + 1) ? " is-hit" : ""}${bad.has(index + 1) ? " is-bad" : ""}` }, String(index + 1))),
    );
    syncScroll();
  }

  function syncScroll() {
    paint.scrollTop = textarea.scrollTop;
    paint.scrollLeft = textarea.scrollLeft;
    gutter.scrollTop = textarea.scrollTop;
  }

  function lineHeight() {
    return parseFloat(getComputedStyle(textarea).lineHeight) || 24;
  }

  function scrollToLine(line) {
    textarea.scrollTop = Math.max(0, (line - 2) * lineHeight());
    syncScroll();
  }

  function caretLine() {
    return text.slice(0, textarea.selectionStart).split("\n").length;
  }

  function placeCaret(line) {
    const lines = text.split("\n");
    const offset = lines.slice(0, line - 1).reduce((total, l) => total + l.length + 1, 0);
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(offset, offset);
    scrollToLine(line);
    select(BR.model.stepAtLine(analysis, line) || selected, "yaml");
    textarea.scrollIntoView({ block: "nearest" });
  }

  function followCaret() {
    if (!analysis.ok) return;
    const id = BR.model.stepAtLine(analysis, caretLine());
    if (id && id !== selected) select(id, "yaml");
  }

  textarea.addEventListener("input", () => {
    setText(textarea.value, { source: "yaml" });
    followCaret();
  });
  textarea.addEventListener("scroll", syncScroll);
  textarea.addEventListener("keyup", followCaret);
  textarea.addEventListener("click", followCaret);
  // The inverted marking steps back on focus, which the pane's CSS does on its own.

  // ---------- selection ----------

  function select(id, from) {
    if (!analysis.ok || !id || !analysis.byId[id]) return;
    selected = id;
    graph.select(id);
    renderYaml();
    renderInspector();
    if (from === "graph") {
      scrollToLine(analysis.byId[id].range.start);
      BR.announce(`Step ${id} selected, YAML lines ${analysis.byId[id].range.start} to ${analysis.byId[id].range.end}.`);
    }
  }

  // ---------- the inspector: the graph side of editing ----------

  function edit(next, key, select_) {
    if (key !== undoKey || key === null) undoStack.push(text);
    undoKey = key;
    undoButton.disabled = false;
    setText(next, { source: key && key.startsWith("text:") ? "inspector-text" : "inspector", select: select_ });
    restoreFocus();
  }

  let focusAfter = null;
  function restoreFocus() {
    if (!focusAfter) return;
    const target = document.getElementById(focusAfter);
    focusAfter = null;
    if (target && target !== document.activeElement) target.focus();
  }

  function undo() {
    const previous = undoStack.pop();
    if (previous === undefined) return;
    undoKey = null;
    undoButton.disabled = undoStack.length === 0;
    setText(previous, { source: "graph" });
    BR.announce("Last graph edit undone.");
    if (undoButton.disabled) addButton.focus();
  }

  function coerce(raw) {
    return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }

  function textField({ id, label, value, type, onInput, help, placeholder, disabled }) {
    return el(
      "div",
      { class: "field" },
      el("label", { class: "label", for: id }, label),
      el("input", {
        id,
        type: type || "text",
        value: value === null || value === undefined ? "" : String(value),
        placeholder,
        disabled,
        spellcheck: "false",
        "aria-describedby": help ? `${id}-help` : null,
        oninput: (event) => onInput(event.target.value.trim()),
      }),
      help ? el("p", { class: "help", id: `${id}-help` }, help) : null,
    );
  }

  function inputRow(step, input) {
    const fieldId = `f-in-${input.name}`;
    const { source } = input;
    const isRef = source.kind === "input" || source.kind === "output";
    const typed = source.kind === "literal" || source.kind === "template";
    const options = BR.model.sourcesFor(analysis, step.id);
    const current = isRef ? source.value : typed ? "__typed" : "__unset";
    const known = !isRef || options.some((o) => o.value === source.value);
    const select_ = el(
      "select",
      {
        id: fieldId,
        "aria-label": `Where ${input.name} comes from`,
        onchange: (event) => {
          const choice = event.target.value;
          focusAfter = choice === "__typed" ? `${fieldId}-value` : fieldId;
          if (choice === "__unset") edit(BR.model.editStep(text, step.id, `with.${input.name}`, undefined), null);
          else if (choice === "__typed") edit(BR.model.editStep(text, step.id, `with.${input.name}`, typed ? source.value : input.default === null ? "" : input.default), null);
          else edit(BR.model.editStep(text, step.id, `with.${input.name}`, choice), null);
        },
      },
      el("option", { value: "__unset" }, input.default !== null ? `Block default (${input.default})` : "Not set"),
      el("option", { value: "__typed" }, "Typed value"),
      options.map((o) => el("option", { value: o.value }, o.label)),
      known ? null : el("option", { value: source.value }, source.value),
    );
    select_.value = current;
    return el(
      "div",
      { class: "wire-row" },
      el("div", { class: "wire-row__name" }, input.name, el("small", {}, `${input.type}${input.required ? ", required" : ""}`)),
      el("div", { class: typed ? "" : "wide" }, select_),
      typed
        ? el(
            "div",
            {},
            el("label", { class: "sr", for: `${fieldId}-value` }, `Value of ${input.name}`),
            el("input", {
              id: `${fieldId}-value`,
              type: "text",
              spellcheck: "false",
              value: source.value === null ? "" : String(source.value),
              oninput: (event) => edit(BR.model.editStep(text, step.id, `with.${input.name}`, coerce(event.target.value)), `text:${fieldId}`),
            }),
          )
        : null,
    );
  }

  function renderInspector() {
    if (!analysis.ok) {
      inspector.replaceChildren(
        el("h2", { class: "h2", id: "inspector-title" }, "Step"),
        el("p", { class: "help" }, `Fix line ${analysis.error.line} in the YAML to edit steps here again.`),
      );
      return;
    }
    const step = selected ? analysis.byId[selected] : null;
    if (!step) {
      inspector.replaceChildren(
        el("h2", { class: "h2", id: "inspector-title" }, "Step"),
        el("p", { class: "help" }, "Add a step and its block, timeout, retries and wiring can be edited here."),
      );
      return;
    }

    const active = document.activeElement && inspector.contains(document.activeElement) ? document.activeElement.id : null;
    const usesOptions = library.map((b) => BR.model.usesFor(b.name));
    const usesSelect = el(
      "select",
      {
        id: "f-uses",
        onchange: (event) => {
          focusAfter = "f-uses";
          edit(BR.model.editStep(text, step.id, "uses", event.target.value), null);
        },
      },
      usesOptions.map((uses) => el("option", { value: uses }, uses)),
      step.uses && !usesOptions.includes(step.uses) ? el("option", { value: step.uses }, step.uses) : null,
      step.uses ? null : el("option", { value: "" }, "Pick a block"),
    );
    usesSelect.value = step.uses || "";

    const others = analysis.steps.filter((s) => s.id !== step.id);
    const fedBy = new Set(analysis.edges.filter((e) => e.to === step.id && e.kind === "data").map((e) => e.from));

    inspector.replaceChildren(
      el(
        "div",
        { class: "bar" },
        el("h2", { class: "h2", id: "inspector-title" }, step.id),
        el(
          "div",
          { class: "row" },
          el("button", { class: "btn", type: "button", onclick: () => placeCaret(step.range.start) }, "Edit in YAML"),
          step.blockName && step.contract ? el("a", { class: "btn", href: `blocks.html#${step.blockName}` }, "Open block") : null,
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: () => {
                edit(BR.model.removeStep(text, analysis, step.id), null, null);
                BR.announce(`Step ${step.id} removed. Undo brings it back.`);
                addButton.focus();
              },
            },
            "Remove step",
          ),
        ),
      ),
      el(
        "div",
        { class: "inspector__body" },
        el(
          "div",
          { class: "grid2" },
          textField({
            id: "f-name",
            label: "Name",
            value: step.title,
            onInput: (value) => edit(BR.model.editStep(text, step.id, "name", value === "" ? undefined : value), "text:name"),
          }),
          el("div", { class: "field" }, el("label", { class: "label", for: "f-uses" }, "Block"), usesSelect),
          textField({
            id: "f-timeout",
            label: "Timeout",
            value: step.timeout,
            placeholder: "6h",
            onInput: (value) => edit(BR.model.editStep(text, step.id, "timeout", value === "" ? undefined : coerce(value)), "text:timeout"),
          }),
          textField({
            id: "f-attempts",
            label: "Max attempts",
            value: step.maxAttempts,
            type: "number",
            placeholder: "1",
            onInput: (value) => edit(BR.model.editStep(text, step.id, "retry.max_attempts", value === "" ? undefined : coerce(value)), "text:attempts"),
          }),
          textField({
            id: "f-delay",
            label: "Delay between attempts",
            value: step.delay,
            placeholder: "1s",
            onInput: (value) => edit(BR.model.editStep(text, step.id, "retry.delay", value === "" ? undefined : coerce(value)), "text:delay"),
          }),
        ),
        step.inputs.length
          ? el(
              "div",
              {},
              el("h3", { class: "h3" }, "Inputs"),
              step.inputs.map((input) => inputRow(step, input)),
            )
          : step.contract
            ? el("p", { class: "help" }, `${step.uses} declares no inputs.`)
            : null,
        others.length
          ? el(
              "fieldset",
              { class: "fieldset" },
              el("legend", { class: "h3" }, "Waits for"),
              el("p", { class: "help" }, "A reference to an output already waits for that step. Tick a step here to wait for it without reading anything from it."),
              el(
                "div",
                { class: "checks" },
                others.map((other) => {
                  const implied = fedBy.has(other.id);
                  const explicit = step.needs.includes(other.id);
                  const cycles = !explicit && !implied && BR.model.wouldCycle(analysis, step.id, other.id);
                  return el(
                    "label",
                    { class: "check" },
                    el("input", {
                      id: `f-need-${other.id}`,
                      type: "checkbox",
                      checked: explicit || implied,
                      disabled: implied || cycles,
                      onchange: (event) => {
                        focusAfter = `f-need-${other.id}`;
                        const next = event.target.checked ? [...step.needs, other.id] : step.needs.filter((n) => n !== other.id);
                        edit(BR.model.editStep(text, step.id, "needs", next.length ? next : undefined), null);
                      },
                    }),
                    el(
                      "span",
                      {},
                      other.id,
                      implied
                        ? el("span", { class: "help" }, "Already implied by a reference.")
                        : cycles
                          ? el("span", { class: "help" }, "Would make a cycle.")
                          : null,
                    ),
                  );
                }),
              ),
            )
          : null,
      ),
    );
    if (active) {
      const again = document.getElementById(active);
      if (again) again.focus();
    }
  }

  function renderProblems() {
    problemsNote.textContent = analysis.problems.length ? "" : "None. The document is valid.";
    problemsNote.hidden = analysis.problems.length > 0;
    problemsList.replaceChildren(
      ...analysis.problems.map((p) =>
        el(
          "li",
          {},
          el(
            "button",
            { class: "problem", type: "button", onclick: () => placeCaret(p.line) },
            el("span", { class: "problem__at" }, `Line ${p.line}`),
            el("span", { class: "problem__msg" }, p.message),
            el("span", { class: "problem__code" }, p.code),
          ),
        ),
      ),
    );
  }

  // ---------- dialogs ----------

  function openAddDialog() {
    const usesSelect = el("select", { id: "add-uses" }, library.map((b) => el("option", { value: b.name }, BR.model.usesFor(b.name))));
    const idInput = el("input", { id: "add-id", type: "text", spellcheck: "false", required: true, autocomplete: "off" });
    const error = el("p", { class: "form-error", role: "alert", hidden: true });
    const suggest = () => {
      const base = usesSelect.value;
      let candidate = base;
      for (let n = 2; analysis.ok && analysis.byId[candidate]; n++) candidate = `${base}-${n}`;
      idInput.value = candidate;
    };
    usesSelect.addEventListener("change", suggest);
    suggest();

    addDialog.replaceChildren(
      el(
        "form",
        {
          class: "dialog__body",
          method: "dialog",
          onsubmit: (event) => {
            event.preventDefault();
            const id = idInput.value.trim();
            if (!/^[a-z][\w-]*$/.test(id)) {
              error.hidden = false;
              error.textContent = "A step id starts with a lowercase letter and has only letters, numbers, - and _.";
              idInput.focus();
              return;
            }
            if (analysis.byId[id]) {
              error.hidden = false;
              error.textContent = `There is already a step called ${id}.`;
              idInput.focus();
              return;
            }
            const next = BR.model.addStep(text, analysis, id, { uses: BR.model.usesFor(usesSelect.value) });
            addDialog.close();
            edit(next, null, id);
            scrollToLine(analysis.byId[id].range.start);
            graph.focus(id);
            BR.announce(`Step ${id} added.`);
          },
        },
        el("h2", { class: "dialog__title", id: "add-title" }, "Add a step"),
        el("div", { class: "field" }, el("label", { class: "label", for: "add-uses" }, "Block"), usesSelect),
        el("div", { class: "field" }, el("label", { class: "label", for: "add-id" }, "Step id"), idInput),
        error,
        el("div", { class: "row" }, el("button", { class: "btn btn--ink", type: "submit" }, "Add step"), el("button", { class: "btn", type: "button", onclick: () => addDialog.close() }, "Cancel")),
      ),
    );
    addDialog.showModal();
  }

  function openStartDialog() {
    const error = el("p", { class: "form-error", role: "alert", hidden: true });
    const fields = analysis.inputs.map((input) =>
      el(
        "div",
        { class: "field" },
        el("label", { class: "label", for: `start-${input.name}` }, input.name),
        el("input", {
          id: `start-${input.name}`,
          type: input.type === "integer" ? "number" : "text",
          value: input.default === null ? "" : String(input.default),
          spellcheck: "false",
          "aria-describedby": input.description ? `start-${input.name}-help` : null,
        }),
        input.description ? el("p", { class: "help", id: `start-${input.name}-help` }, input.description) : null,
      ),
    );
    startDialog.replaceChildren(
      el(
        "form",
        {
          class: "dialog__body",
          onsubmit: (event) => {
            event.preventDefault();
            const inputs = {};
            for (const input of analysis.inputs) {
              const raw = document.getElementById(`start-${input.name}`).value.trim();
              if (raw === "" && input.required) {
                error.hidden = false;
                error.textContent = `${input.name} has no default, so this run needs a value for it.`;
                document.getElementById(`start-${input.name}`).focus();
                return;
              }
              inputs[input.name] = raw === "" ? input.default : coerce(raw);
            }
            BR.store.set("start", { doc: text, inputs });
            location.href = "run.html?start=1";
          },
        },
        el("h2", { class: "dialog__title", id: "start-title" }, `Start ${analysis.name}`),
        fields.length ? fields : el("p", {}, "This pipeline takes no inputs."),
        error,
        el("div", { class: "row" }, el("button", { class: "btn btn--ink", type: "submit" }, "Start the run"), el("button", { class: "btn", type: "button", onclick: () => startDialog.close() }, "Cancel")),
      ),
    );
    startDialog.showModal();
  }

  // ---------- start ----------

  textarea.value = text;
  const fromHash = decodeURIComponent(location.hash).match(/^#step=(.+)$/);
  setText(text, { source: "init", select: fromHash ? fromHash[1] : undefined });
  if (fromHash && selected) scrollToLine(analysis.byId[selected].range.start);
  flashed = analysis.ok ? Object.fromEntries(analysis.steps.map((s) => [s.id, JSON.stringify(s.raw)])) : {};
})();
