// The live run. A small simulator plays each step's fixture log on a timer and moves steps through
// the spec's statuses (pending, running, waiting_retry, succeeded, failed, skipped, cancelled) by the
// rules the pipeline declares: dependencies, max_parallel, retries. The screen only ever reads the
// run's state, the way it would read run.json and the attempt logs from the API.

(() => {
  const { el } = BR;
  const data = window.BashreactorData;
  const view = document.getElementById("view");
  const LINE_MS = 700;

  if (BR.demoState === "loading") {
    view.replaceChildren(el("h1", { class: "title" }, "Runs"), el("p", { class: "state", role: "status" }, "Loading run 42 and its logs."));
    return;
  }
  if (BR.demoState === "empty") {
    view.replaceChildren(
      el("h1", { class: "title" }, "Runs"),
      el(
        "div",
        { class: "stage__empty" },
        BR.sign("queued", "sign sign--large"),
        el("p", {}, "word-report has not run yet. Start a run from the editor and it shows up here while it works."),
        el("a", { class: "btn btn--ink", href: "pipeline.html" }, "Open the editor"),
      ),
    );
    return;
  }

  const library = BR.library();

  // ---------- the run model ----------

  function blockScript(name, kind) {
    const table = kind === "failed" ? data.failures : data.logs;
    return table[name] && table[name].length
      ? table[name]
      : [
          [0, "sys", "attempt 1 of {max_attempts} started in /var/lib/bashreactor/runs/{run}/{step}", 1],
          [1, "out", `${name} has no fake log in data.js, so this run says only this.`],
          [1, "sys", "exit 0"],
        ];
  }

  function runId(now) {
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    let hex = "00000000";
    try {
      hex = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    }
    return `${stamp}-${hex}`;
  }

  function freshRun(doc, inputs) {
    const analysis = BR.model.analyze(doc, library);
    const steps = {};
    for (const id of analysis.order) {
      const parsed = analysis.byId[id];
      const block = library.find((b) => b.name === parsed.blockName);
      steps[id] = {
        name: parsed.title,
        status: "pending",
        block: { uses: parsed.uses, name: parsed.blockName, sha256: block ? window.BR.sha256Hex(window.BR.model.latest(block).source) : null },
        needs: parsed.deps,
        with: null,
        outputs: null,
        failure: null,
        attempts_used: 0,
        next_attempt_at: null,
        attempts: [],
      };
    }
    return {
      schema: 1,
      id: runId(new Date()),
      pipeline: analysis.name,
      status: "running",
      created_at: new Date().toISOString(),
      finished_at: null,
      cancel_requested_at: null,
      inputs,
      outputs: null,
      steps,
    };
  }

  function makeRun(runJson, doc) {
    const analysis = BR.model.analyze(doc, library);
    const run = {
      id: runJson.id,
      inputs: runJson.inputs,
      pipeline: runJson.pipeline,
      maxParallel: analysis.maxParallel,
      startedAt: Date.parse(runJson.created_at),
      finishedAt: runJson.finished_at ? Date.parse(runJson.finished_at) : null,
      cancelRequestedAt: runJson.cancel_requested_at,
      outputs: runJson.outputs,
      order: analysis.order,
      connected: true,
      steps: {},
    };
    for (const id of analysis.order) {
      const parsed = analysis.byId[id];
      const s = runJson.steps && runJson.steps[id] ? runJson.steps[id] : null;
      const step = {
        id,
        title: s && s.name ? s.name : parsed.title,
        uses: parsed.uses,
        blockName: parsed.blockName,
        version: parsed.version,
        deps: s && Array.isArray(s.needs) ? s.needs : parsed.deps,
        maxAttempts: parsed.maxAttempts || 1,
        vars: {},
        state: s ? s.status : "pending",
        attempts: s ? s.attempts : [],
        attemptsUsed: s ? s.attempts_used : 0,
        outputs: s ? s.outputs : null,
        failure: s ? s.failure : null,
        nextAttemptAt: s && s.next_attempt_at ? Date.parse(s.next_attempt_at) : null,
        attempt: 0,
        seconds: 0,
        runningSince: null,
        reason: null,
        error: null,
        lines: [],
        script: [],
        cursor: 0,
      };

      // Bound values come from run.json; a fresh run has not bound them yet, so the simulator fills
      // the literals and input references the engine would bind on first start.
      if (s && s.with) {
        Object.assign(step.vars, s.with);
      } else {
        for (const input of parsed.inputs) {
          const raw = input.source.value;
          if (input.source.kind === "input") step.vars[input.name] = run.inputs[input.source.name];
          else if (input.source.kind === "literal") step.vars[input.name] = raw;
        }
      }
      step.vars.run = run.id;
      step.vars.step = id;
      step.vars.max_attempts = step.maxAttempts;
      if (step.vars.lines === undefined) step.vars.lines = run.inputs.lines;

      const attempts = step.attempts;
      if (attempts.length) {
        step.attempt = attempts[attempts.length - 1].n;
        const first = Date.parse(attempts[0].started_at);
        const last = attempts[attempts.length - 1];
        if (step.state === "running") {
          step.runningSince = Date.parse(last.started_at);
          step.seconds = (Date.now() - first) / 1000;
        } else if (last.finished_at) {
          step.seconds = (Date.parse(last.finished_at) - first) / 1000;
        }
      }

      if (step.state === "failed" && step.failure) {
        const word = step.attemptsUsed === 1 ? "attempt" : "attempts";
        step.error = `${step.failure.message}. All ${step.attemptsUsed} ${word} are used, and the work directory is kept.`;
      }

      const script = blockScript(parsed.blockName || id, step.state === "failed" ? "failed" : "ok");
      step.script = script;
      if (step.state === "succeeded" || step.state === "failed") {
        script.forEach((line) => pushLine(step, line, line[0]));
        step.cursor = script.length;
      } else if (step.state === "running") {
        const elapsed = stepSeconds(step);
        const shown = script.filter((line) => line[0] <= elapsed).length;
        script.slice(0, shown).forEach((line) => pushLine(step, line, line[0]));
        step.cursor = shown;
      }
      run.steps[id] = step;
    }
    for (const id of run.order) {
      const step = run.steps[id];
      if (step.state === "skipped") {
        const bad = step.deps.find((d) => ["failed", "cancelled"].includes(run.steps[d] && run.steps[d].state));
        step.reason = bad ? `${bad} ${run.steps[bad].state}` : "A dependency did not succeed";
      }
    }
    return run;
  }

  function fill(text, step) {
    return text.replace(/\{(\w+)\}/g, (whole, key) => (step.vars[key] === undefined ? whole : step.vars[key]));
  }

  function pushLine(step, line, at) {
    step.lines.push({ at, stream: line[1], text: fill(line[2], step) });
    if (line[3]) step.attempt = line[3];
  }

  function runState(run) {
    const states = run.order.map((id) => run.steps[id].state);
    if (states.includes("running") || states.includes("pending") || states.includes("waiting_retry")) return "running";
    if (states.includes("failed")) return "failed";
    if (states.includes("cancelled")) return "cancelled";
    return "succeeded";
  }

  function outputsOf(step) {
    return Object.entries(step.outputs || {}).map(([name, value]) => ({
      name,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));
  }

  function stepSeconds(step) {
    return step.state === "running" && step.runningSince ? (Date.now() - step.runningSince) / 1000 : step.seconds;
  }

  function waitingFor(run, step) {
    if (step.state === "waiting_retry") {
      if (step.nextAttemptAt) return `Retries in ${BR.duration(Math.max(0, (step.nextAttemptAt - Date.now()) / 1000))}.`;
      return "Waiting to retry.";
    }
    const open = step.deps.filter((d) => run.steps[d].state !== "succeeded");
    if (open.length) return `Waits for ${open.join(", ")}.`;
    return "Waits for a free slot.";
  }

  function tick(run) {
    if (!run.connected || runState(run) !== "running") return;
    for (const id of run.order) {
      const step = run.steps[id];
      if (step.state !== "running") continue;
      const line = step.script[step.cursor++];
      if (line) {
        pushLine(step, line, stepSeconds(step));
        onLine(run, step);
      }
      if (step.cursor >= step.script.length) {
        step.seconds = stepSeconds(step);
        step.state = "succeeded";
        const known = succeededRun && succeededRun.steps[id];
        if (known && known.outputs) step.outputs = known.outputs;
        onState(run, step);
      }
    }
    let running = run.order.filter((id) => run.steps[id].state === "running").length;
    for (const id of run.order) {
      const step = run.steps[id];
      if (step.state !== "pending") continue;
      const blocked = step.deps.find((d) => ["failed", "cancelled"].includes(run.steps[d].state));
      if (blocked) {
        step.state = "skipped";
        step.reason = `${blocked} ${run.steps[blocked].state}`;
        onState(run, step);
      } else if (running < run.maxParallel && step.deps.every((d) => run.steps[d].state === "succeeded")) {
        step.state = "running";
        step.attempt = 1;
        step.script = blockScript(step.blockName || id, "ok");
        step.cursor = 0;
        step.lines = [];
        step.runningSince = Date.now();
        running++;
        onState(run, step);
      }
    }
    if (runState(run) !== "running" && !run.finishedAt) {
      run.finishedAt = Date.now();
      onFinished(run);
    }
  }

  function cancel(run) {
    for (const id of run.order) {
      const step = run.steps[id];
      if (step.state === "running") {
        step.seconds = stepSeconds(step);
        step.lines.push({ at: step.seconds, stream: "sys", text: "cancelled: sent SIGTERM, the work directory is kept" });
        step.state = "cancelled";
        step.reason = "You cancelled the run";
        onLine(run, step);
        onState(run, step);
      } else if (step.state === "pending" || step.state === "waiting_retry") {
        step.state = "cancelled";
        step.reason = "You cancelled the run";
        onState(run, step);
      }
    }
    run.finishedAt = Date.now();
    onFinished(run);
  }

  function retry(run) {
    for (const id of run.order) {
      const step = run.steps[id];
      if (step.state === "failed" || step.state === "cancelled" || step.state === "skipped") {
        step.state = "pending";
        step.reason = null;
        step.error = null;
        step.attempt = 0;
        step.seconds = 0;
        step.lines = [];
        step.cursor = 0;
        step.outputs = null;
        step.failure = null;
        onState(run, step);
      }
    }
    run.finishedAt = null;
    run.cancelRequestedAt = null;
  }

  // ---------- which runs exist ----------

  const fixtureDoc = data.pipeline;
  const succeededRun = data.runs.find((r) => r.status === "succeeded");
  const runs = data.runs.map((runJson) => makeRun(runJson, fixtureDoc));
  const params = new URLSearchParams(location.search);
  let current = runs[0];

  if (params.get("start")) {
    const start = BR.store.get("start");
    const doc = start ? start.doc : fixtureDoc;
    const run = makeRun(freshRun(doc, start ? start.inputs : data.runs[0].inputs), doc);
    runs.unshift(run);
    current = run;
  }
  const wanted = location.hash.match(/^#([0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})$/);
  if (wanted) current = runs.find((r) => r.id === wanted[1]) || current;

  // ---------- the screen ----------

  let selected = null;
  let follow = true;
  let paused = false;
  let held = 0;
  let shownCount = 0;
  let programmaticScroll = false;
  let streamLost = BR.demoState === "error";

  const title = el("h1", { class: "title" });
  const bigSign = el("div", { class: "runhead__sign" });
  const meta = el("div", { class: "runhead__meta" });
  const cancelButton = el("button", { class: "btn", type: "button", onclick: () => cancelDialog.showModal() }, "Cancel run");
  const runSelect = el("select", {
    id: "run-select",
    onchange: (event) => {
      location.hash = `#${event.target.value}`;
    },
  });
  const params_ = el("dl", { class: "params", "aria-label": "Inputs of this run" });
  const alarm = el("section", { class: "alarm", "aria-labelledby": "alarm-title", hidden: true });
  const stepList = el("div", { class: "steps", role: "tablist", "aria-orientation": "vertical", "aria-label": "Steps of this run" });
  const panelTitle = el("h2", { class: "h2", id: "panel-title" });
  const panelMeta = el("p", { class: "logpanel__meta" });
  const panelOutputs = el("dl", { class: "outputs" });
  const followButton = el("button", { class: "btn", type: "button", "aria-pressed": "true", onclick: toggleFollow }, "Follow");
  const pauseButton = el("button", { class: "btn", type: "button", onclick: togglePause }, "Pause");
  const logStatus = el("p", { class: "logpanel__status", id: "log-status" });
  const logLines = el("ol", { class: "log__lines" });
  // role=log would read every line aloud; state changes are announced on their own instead.
  const logBox = el("div", { class: "log", tabindex: "0", "aria-label": "Log output. Arrow keys scroll it.", "aria-live": "off", "aria-describedby": "log-status" }, logLines);
  const connectionBox = el("div", {});
  const panel = el(
    "section",
    { class: "logpanel", id: "log-panel", role: "tabpanel", "aria-labelledby": "panel-title" },
    el("div", { class: "bar" }, panelTitle, el("div", { class: "logpanel__tools" }, logStatus, followButton, pauseButton)),
    panelMeta,
    panelOutputs,
    connectionBox,
    logBox,
  );
  const cancelDialog = el(
    "dialog",
    { class: "dialog", "aria-labelledby": "cancel-title" },
    el(
      "div",
      { class: "dialog__body" },
      el("h2", { class: "dialog__title", id: "cancel-title" }, "Cancel this run?"),
      el("p", {}, "The running step gets SIGTERM and every pending step is cancelled. The work directories stay, so a retry carries on from them."),
      el(
        "div",
        { class: "row" },
        el(
          "button",
          {
            class: "btn btn--ink",
            type: "button",
            onclick: () => {
              cancelDialog.close();
              cancel(current);
            },
          },
          "Cancel the run",
        ),
        el("button", { class: "btn", type: "button", onclick: () => cancelDialog.close() }, "Keep it running"),
      ),
    ),
  );

  view.replaceChildren(
    el(
      "div",
      { class: "runhead" },
      bigSign,
      el("div", { class: "runhead__text" }, title, meta),
      el(
        "div",
        { class: "runhead__tools" },
        el("div", { class: "field" }, el("label", { class: "label", for: "run-select" }, "Run"), runSelect),
        cancelButton,
      ),
    ),
    params_,
    alarm,
    el("div", { class: "run" }, el("section", { "aria-label": "Steps" }, stepList), panel),
    cancelDialog,
  );

  const rows = {};

  function pickStep(run) {
    const live = run.order.find((id) => run.steps[id].state === "running");
    const failed = run.order.find((id) => run.steps[id].state === "failed");
    return live || failed || [...run.order].reverse().find((id) => run.steps[id].lines.length) || run.order[0];
  }

  function loadRun(run) {
    current = run;
    follow = true;
    paused = false;
    held = 0;
    selected = pickStep(run);
    stepList.replaceChildren();
    for (const key of Object.keys(rows)) delete rows[key];
    for (const id of run.order) {
      const row = {
        stamp: el("span", { class: "steprow__stamp" }),
        time: el("span", { class: "steprow__time" }),
        note: el("span", { class: "steprow__note" }),
      };
      row.button = el(
        "button",
        {
          class: "steprow",
          type: "button",
          role: "tab",
          id: `tab-${id}`,
          "aria-controls": "log-panel",
          onclick: () => choose(id, true),
          onkeydown: tabKeys,
        },
        el("span", { class: "steprow__id" }, id),
        row.time,
        row.stamp,
        row.note,
      );
      rows[id] = row;
      stepList.append(row.button);
    }
    renderRunSelect();
    renderHead();
    renderSteps();
    renderPanel();
    renderLog(true);
  }

  function tabKeys(event) {
    const order = current.order;
    const index = order.indexOf(selected);
    let next = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = order[(index + 1) % order.length];
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = order[(index - 1 + order.length) % order.length];
    if (event.key === "Home") next = order[0];
    if (event.key === "End") next = order[order.length - 1];
    if (!next) return;
    event.preventDefault();
    choose(next, true);
    rows[next].button.focus();
  }

  // Picking a step that is not running means you came to read it, so the view stops chasing the run.
  function choose(id, byHand) {
    selected = id;
    if (byHand && current.steps[id].state !== "running" && follow) {
      follow = false;
    }
    held = 0;
    renderSteps();
    renderPanel();
    renderLog(true);
  }

  function toggleFollow() {
    follow = !follow;
    if (follow) {
      const live = current.order.find((id) => current.steps[id].state === "running");
      if (live && live !== selected) {
        choose(live, false);
        follow = true;
      }
      scrollToEnd();
    }
    renderPanel();
  }

  function togglePause() {
    paused = !paused;
    if (!paused) {
      held = 0;
      renderLog(false);
    }
    renderPanel();
  }

  function renderRunSelect() {
    runSelect.replaceChildren(...runs.map((r) => el("option", { value: r.id }, `Run ${r.id}, ${runState(r)}`)));
    runSelect.value = current.id;
  }

  function renderHead() {
    const run = current;
    const state = runState(run);
    title.textContent = `Run ${run.id}`;
    document.title = `Run ${run.id}, Bashreactor mockup`;
    bigSign.replaceChildren(BR.sign(state, "sign sign--large"));
    const elapsed = ((run.finishedAt || Date.now()) - run.startedAt) / 1000;
    meta.replaceChildren(
      BR.stateStamp(state),
      el("a", { href: "pipeline.html" }, run.pipeline),
      el("span", {}, `started ${BR.duration((Date.now() - run.startedAt) / 1000)} ago`),
      el("span", {}, run.finishedAt ? `took ${BR.duration(elapsed)}` : `running for ${BR.duration(elapsed)}`),
    );
    cancelButton.hidden = state !== "running";
    params_.replaceChildren(...Object.entries(run.inputs).map(([key, value]) => el("div", {}, el("dt", {}, key), el("dd", {}, String(value)))));

    const failed = run.order.find((id) => run.steps[id].state === "failed");
    const interrupted = state === "cancelled" && !failed;
    alarm.hidden = !(failed || interrupted);
    if (failed) {
      const step = run.steps[failed];
      alarm.replaceChildren(
        el("h2", { class: "h2", id: "alarm-title" }, `${failed} failed`),
        el("p", {}, step.error || "The step exited with an error."),
        el(
          "div",
          { class: "row" },
          el("button", { class: "btn btn--ink", type: "button", onclick: retryNow }, `Retry from ${failed}`),
          el("button", { class: "btn", type: "button", onclick: () => { choose(failed, true); rows[failed].button.focus(); } }, "Read its log"),
        ),
      );
    } else if (interrupted) {
      alarm.replaceChildren(
        el("h2", { class: "h2", id: "alarm-title" }, "Cancelled"),
        el("p", {}, "Nothing else will run. The work directories are kept, so a retry carries on from them."),
        el("div", { class: "row" }, el("button", { class: "btn btn--ink", type: "button", onclick: retryNow }, "Retry what did not finish")),
      );
    }
  }

  function retryNow() {
    retry(current);
    follow = true;
    renderHead();
    renderSteps();
    renderRunSelect();
    rows[current.order[0]].button.focus();
    BR.announce(`Run ${current.id} retried.`);
  }

  function renderSteps() {
    const run = current;
    for (const id of run.order) {
      const step = run.steps[id];
      const row = rows[id];
      const isSelected = id === selected;
      row.button.setAttribute("aria-selected", String(isSelected));
      row.button.tabIndex = isSelected ? 0 : -1;
      row.stamp.replaceChildren(BR.stateStamp(step.state));
      row.time.textContent = step.attempt > 0 ? BR.duration(stepSeconds(step)) : "";
      let note = step.title;
      if (step.state === "pending" || step.state === "waiting_retry") note = waitingFor(run, step);
      if (step.state === "running" || step.state === "failed") note = `Attempt ${step.attempt} of ${step.maxAttempts}`;
      if (step.state === "cancelled") note = step.reason ? `${step.reason}.` : "Cancelled.";
      if (step.state === "skipped") note = step.reason ? `${step.reason}.` : "Skipped.";
      if (step.state === "succeeded" && step.attempt > 1) note = `Took ${step.attempt} attempts`;
      row.note.textContent = note;
    }
  }

  function renderPanel() {
    const run = current;
    const step = run.steps[selected];
    panelTitle.textContent = step.id;
    panel.setAttribute("aria-labelledby", "panel-title");
    panelMeta.replaceChildren(
      step.title ? `${step.title}. ` : "",
      "Runs ",
      step.blockName ? el("a", { href: `blocks.html#${step.blockName}` }, `${step.blockName} v${step.version}`) : step.uses || "no block",
      ".",
    );
    const outputs = step.state === "succeeded" ? outputsOf(step) : [];
    panelOutputs.hidden = outputs.length === 0;
    panelOutputs.replaceChildren(...outputs.map((o) => el("div", {}, el("dt", {}, o.name), el("dd", { tabindex: "0" }, o.value))));

    const isLive = step.state === "running";
    followButton.setAttribute("aria-pressed", String(follow));
    pauseButton.textContent = paused ? "Resume" : "Pause";
    pauseButton.disabled = !isLive;
    if (streamLost && isLive) logStatus.textContent = "Disconnected.";
    else if (paused && isLive) logStatus.textContent = held ? `Paused, ${held} ${held === 1 ? "line" : "lines"} held back.` : "Paused.";
    else if (isLive) logStatus.textContent = "Streaming.";
    else if (step.state === "pending") logStatus.textContent = "Not started.";
    else if (step.state === "waiting_retry") logStatus.textContent = "Waiting to retry.";
    else if (step.state === "skipped") logStatus.textContent = "Skipped.";
    else logStatus.textContent = "Finished.";

    connectionBox.replaceChildren(
      ...(streamLost && isLive
        ? [
            BR.errorBox(
              { code: "stream_lost", message: `The log stream dropped after line ${step.lines.length}. The step may still be running: lines already here are safe, and reconnecting fetches what you missed.` },
              el("button", { class: "btn btn--ink", type: "button", onclick: reconnect }, "Reconnect"),
            ),
          ]
        : []),
    );
  }

  function reconnect() {
    streamLost = false;
    current.connected = true;
    renderPanel();
    BR.announce("Log stream reconnected.");
    followButton.focus();
  }

  function lineNode(line) {
    return el(
      "li",
      { class: `log__line log__line--${line.stream}` },
      el("span", { class: "log__time" }, BR.clock(line.at)),
      el("span", { class: "log__stream" }, line.stream),
      el("span", { class: "log__text" }, line.text),
    );
  }

  function renderLog(reset) {
    const step = current.steps[selected];
    if (reset) {
      logLines.replaceChildren();
      shownCount = 0;
    }
    if (!step.lines.length) {
      const message =
        step.state === "pending"
          ? `${step.id} has not started. ${waitingFor(current, step)}`
          : step.state === "cancelled"
            ? `${step.id} was cancelled before it printed anything.`
            : step.state === "skipped"
              ? `${step.id} was skipped. ${step.reason || "A dependency did not succeed."}`
              : step.state === "waiting_retry"
                ? `${step.id} is waiting to retry. ${waitingFor(current, step)}`
                : "Waiting for the first line.";
      logLines.replaceChildren(el("li", { class: "log__empty" }, message));
      shownCount = 0;
      return;
    }
    if (shownCount === 0) logLines.replaceChildren();
    const fresh = step.lines.slice(shownCount);
    logLines.append(...fresh.map(lineNode));
    shownCount = step.lines.length;
    if (follow) scrollToEnd();
    else if (reset) logBox.scrollTop = 0;
  }

  function scrollToEnd() {
    programmaticScroll = true;
    logBox.scrollTop = logBox.scrollHeight;
    requestAnimationFrame(() => { programmaticScroll = false; });
  }

  // Scrolling up to read means you left the live edge; Follow says so rather than yanking you back.
  logBox.addEventListener("scroll", () => {
    if (programmaticScroll || !follow) return;
    if (logBox.scrollTop + logBox.clientHeight < logBox.scrollHeight - 8) {
      follow = false;
      renderPanel();
    }
  });

  // ---------- simulator events ----------

  function onLine(run, step) {
    if (run !== current || step.id !== selected) return;
    if (paused) {
      held++;
      renderPanel();
    } else {
      renderLog(false);
    }
  }

  function onState(run, step) {
    if (run !== current) return;
    renderHead();
    renderSteps();
    renderRunSelect();
    BR.flash(rows[step.id].button);
    BR.announce(`${step.id} ${step.state}.`);
    if (step.state === "running" && follow) {
      const live = run.order.find((id) => run.steps[id].state === "running");
      const onLive = run.steps[selected].state === "running";
      if (!onLive && live) {
        paused = false;
        held = 0;
        choose(live, false);
        return;
      }
    }
    if (step.id === selected) {
      renderPanel();
      renderLog(step.state === "running");
    }
  }

  function onFinished(run) {
    if (run !== current) return;
    paused = false;
    renderHead();
    renderSteps();
    renderRunSelect();
    renderPanel();
    renderLog(false);
    BR.flash(bigSign);
    BR.announce(`Run ${run.id} ${runState(run)}.`);
  }

  window.addEventListener("hashchange", () => {
    const id = location.hash.match(/^#([0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})$/);
    const run = id && runs.find((r) => r.id === id[1]);
    if (run) loadRun(run);
  });

  // The error demo plays a few lines first, so the stream drops visibly mid-run.
  if (streamLost) current.connected = false;

  loadRun(current);

  setInterval(() => runs.forEach(tick), LINE_MS);
  setInterval(() => {
    if (runState(current) === "running") {
      renderHead();
      renderSteps();
    }
  }, 1000);
})();
