// One run's page: every status gets its own word and sign, a refusal keeps the server's own words,
// the controls are built once and updated in place, and the line under the log says where the cursor
// really is. The stand-in DOM, the fake server and the fixtures are in runs.testkit.ts; the list has
// its own file because it is its own screen.

import { describe, expect, test } from "bun:test";
import {
  DONE,
  EVERY_STATUS,
  FAILED_RUN,
  FakeClock,
  FakeServer,
  HELD_RUN,
  LIVE,
  LIVE_RETRYING,
  MAX_DRAWN_LINES,
  POLL_MS,
  SIX_FAILED,
  STALE,
  TWICE_FAILED,
  T0,
  alarmOf,
  attemptButton,
  attemptButtons,
  buildAssets,
  buttonNamed,
  byteLength,
  CHUNKS,
  click,
  drawnLines,
  duration,
  fakeDocument,
  fileLink,
  filesServer,
  FILES_RUN,
  isoInstant,
  LOGFILE,
  metaLine,
  one,
  openRun,
  pair,
  panelLinks,
  panelTitle,
  render,
  renderList,
  REPORT,
  rowOf,
  ruleBody,
  runFixture,
  runStamp,
  savedFiles,
  serveLog,
  settle,
  shape,
  sheet,
  signOf,
  stampOf,
  statusLine,
  step,
  styled,
  summary,
  waitFor,
  when,
  word,
} from "./runs.testkit.ts";

describe("stamping a step", () => {
  test("a skipped step is stamped skipped, with the skipped sign", async () => {
    const view = await render(FAILED_RUN);
    const stamp = stampOf(view, "report");

    expect(word(stamp)).toBe("skipped");
    expect(word(stamp)).not.toBe("pending");
    expect(shape(stamp)).toBe(signOf("skipped"));
    expect(shape(stamp)).not.toBe(signOf("pending"));

    // The note is still the reason, which is the half that was never wrong.
    expect(rowOf(view, "report").querySelector(".steprow__note")?.textContent).toBe(
      "render failed, so this never started.",
    );
    // And the steps that were always stamped right still are.
    expect(word(stampOf(view, "fetch"))).toBe("succeeded");
    expect(word(stampOf(view, "render"))).toBe("failed");
  });

  test("every status the spec allows gets its own word and its own sign", async () => {
    const view = await render(EVERY_STATUS);

    const drawn = new Map<string, string>();
    // In this fixture the step id is its status, so one name does for both.
    for (const status of Object.keys(EVERY_STATUS.steps)) {
      const stamp = stampOf(view, status);
      expect(word(stamp)).toBe(status);
      expect(word(stamp)).not.toBe("");
      expect(shape(stamp)).not.toBe("");
      drawn.set(status, shape(stamp));
    }

    // Eight statuses, eight shapes: nothing is sharing pending's empty box any more.
    expect(drawn.size).toBe(Object.keys(EVERY_STATUS.steps).length);
    expect(new Set(drawn.values()).size).toBe(drawn.size);
    expect(drawn.get("pending")).toBe(signOf("pending"));
    for (const [status, shapeOf] of drawn) if (status !== "pending") expect(shapeOf).not.toBe(signOf("pending"));
  });

  test("the run's own status is stamped the same way", async () => {
    const view = await render(FAILED_RUN);
    const head = one(view.querySelector(".runhead__meta"), "run head");
    expect(word(one(head.querySelector(".stamp"), "head stamp"))).toBe("failed");
  });
});

describe("a log longer than one read", () => {
  const FINISHED = runFixture([step("render", "succeeded")], "succeeded");

  test("reads on until the server stops truncating, and ends on the last line", async () => {
    const lines = Array.from({ length: 600 }, (_, n) => `line ${n}`);
    const log = `${lines.join("\n")}\nEND\n`;
    const view = await render(FINISHED, () => serveLog(FINISHED, log, 1000), true);
    await settle();

    const drawn = view.querySelectorAll(".log__text");
    expect(drawn.at(-1)?.textContent).toBe("END");
    expect(drawn.length).toBe(601);
    expect(view.querySelector("[id=log-note]")?.hidden).toBe(true);
    expect(view.querySelector("[id=log-status]")?.textContent).toBe(`Read to byte ${new TextEncoder().encode(log).length}.`);
  });

  test("a line cut by a chunk boundary is whole once the rest arrives", async () => {
    const log = `${"x".repeat(2500)}\nEND\n`;
    const view = await render(FINISHED, () => serveLog(FINISHED, log, 1000), true);
    await settle();

    const drawn = view.querySelectorAll(".log__text");
    expect(drawn.map((node) => node.textContent.length)).toEqual([2500, 3]);
    expect(drawn.at(-1)?.textContent).toBe("END");
  });

  test("past the drawing cap it keeps the end and says how much it left out", async () => {
    const total = MAX_DRAWN_LINES + 700;
    const log = `${Array.from({ length: total }, (_, n) => `line ${n}`).join("\n")}\nEND\n`;
    const view = await render(FINISHED, () => serveLog(FINISHED, log, 4000), true);
    await settle();

    const drawn = view.querySelectorAll(".log__text");
    expect(drawn.length).toBe(MAX_DRAWN_LINES);
    expect(drawn.at(-1)?.textContent).toBe("END");
    const note = one(view.querySelector("[id=log-note]"), "cap note");
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain(`The first ${total + 1 - MAX_DRAWN_LINES} lines`);
    expect(note.textContent).toContain("are not drawn");
  });
});

describe("a status this UI has never seen", () => {
  test("falls back to pending rather than printing a word with no shape", async () => {
    const view = await render(runFixture([step("fetch", "approved", [])], "approved"));
    const stamp = stampOf(view, "fetch");

    // `stateStamp` prints the word it is given and `sign` has no art for a name it does not know, so
    // passing an unknown status through would pair a word with the wrong shape. `pending` claims
    // nothing about the outcome and is not final, so it cannot call a live run finished.
    expect(word(stamp)).toBe("pending");
    expect(shape(stamp)).toBe(signOf("pending"));
    const head = one(view.querySelector(".runhead__meta"), "run head");
    expect(word(one(head.querySelector(".stamp"), "head stamp"))).toBe("pending");
  });

  test("interrupted is a word the screen knows, even though the spec keeps it to attempts", async () => {
    const view = await render(runFixture([step("render", "interrupted")], "interrupted"));
    expect(word(stampOf(view, "render"))).toBe("interrupted");
    expect(shape(stampOf(view, "render"))).toBe(signOf("interrupted"));
  });
});
describe("the actions a run is offered", () => {
  test("a run an engine holds is offered cancel, and not resume", async () => {
    // SPEC 4.7 refuses resume while a claim is live, and the server driving a run is that engine: the
    // only answer to the click was `run_claimed`. Cancel is not held by the claim, because it just
    // leaves a request for whoever does hold it (SPEC 4.6).
    const view = await openRun(new FakeServer(HELD_RUN));

    expect(buttonNamed(view, "Resume").hidden).toBe(true);
    expect(buttonNamed(view, "Cancel run").hidden).toBe(false);
    expect(buttonNamed(view, "Retry").hidden).toBe(true);
  });

  test("a run whose engine went away is offered resume", async () => {
    // The claim is what an engine left behind, and the run is still `running` only because nothing was
    // there to say otherwise. This is the run Resume exists for, so the claim must not hide it.
    const view = await openRun(new FakeServer({ ...HELD_RUN, claim: STALE }));

    expect(buttonNamed(view, "Resume").hidden).toBe(false);
  });

  test("a run that succeeded is offered none of them", async () => {
    // SPEC 4.6: a manual retry sets failed, skipped and cancelled steps back to pending, and a run
    // that succeeded has none of those. The engine answers `run_not_retryable`, so the page does not
    // ask it.
    const view = await openRun(new FakeServer(DONE));

    expect(buttonNamed(view, "Cancel run").hidden).toBe(true);
    expect(buttonNamed(view, "Resume").hidden).toBe(true);
    expect(buttonNamed(view, "Retry").hidden).toBe(true);
  });

  test("a run that failed is offered retry", async () => {
    const view = await openRun(new FakeServer(FAILED_RUN));
    expect(buttonNamed(view, "Retry").hidden).toBe(false);
  });

  test("a run that was cancelled is offered retry", async () => {
    // SPEC 4.6 counts a cancelled run alongside a failed one, and nothing on the head would tell you.
    const view = await openRun(new FakeServer(runFixture([step("render", "cancelled")], "cancelled")));
    expect(buttonNamed(view, "Retry").hidden).toBe(false);
  });

  test("resume arrives on the poll that finds the engine gone", async () => {
    // A run is watched, not reopened, so a claim going stale has to be able to change the head while
    // you are looking at it.
    const server = new FakeServer(HELD_RUN);
    const view = await openRun(server);
    expect(buttonNamed(view, "Resume").hidden).toBe(true);

    server.run = { ...HELD_RUN, claim: STALE };
    const polls = server.polls;
    await waitFor("a poll", () => server.polls > polls);

    expect(buttonNamed(view, "Resume").hidden).toBe(false);
  });
});

// ---------- what a refused action does ----------

describe("an action the server refuses", () => {
  test("a refused resume stays on the page, in the server's own words, through a poll", async () => {
    // The page offers Resume for a run nobody holds (LIVE has no claim), and the run can be claimed
    // between that read and this click. SPEC 4.7 then says so, and the box has to outlast the poll.
    const server = new FakeServer(LIVE);
    server.refuse("resume", "run_claimed", "Another engine holds this run.");
    const view = await openRun(server);

    const resume = buttonNamed(view, "Resume");
    expect(resume.hidden).toBe(false);
    click(resume);
    await waitFor("the refusal to be drawn", () => !alarmOf(view).hidden);

    const alarm = alarmOf(view);
    expect(alarm.textContent).toContain("Resume refused");
    expect(alarm.textContent).toContain("run_claimed");
    expect(alarm.textContent).toContain("Another engine holds this run.");

    // The bug was here: the next poll rendered the head, and the head hid the box in the same tick.
    const polls = server.polls;
    await waitFor("another poll", () => server.polls > polls);
    expect(alarm.hidden).toBe(false);
    expect(alarm.textContent).toContain("run_claimed");
  });

  test("dismiss takes the refusal away", async () => {
    const server = new FakeServer(LIVE);
    server.refuse("resume", "run_claimed", "Another engine holds this run.");
    const view = await openRun(server);
    const resume = buttonNamed(view, "Resume");
    expect(resume.hidden).toBe(false);
    click(resume);
    await waitFor("the refusal to be drawn", () => !alarmOf(view).hidden);

    click(one(alarmOf(view).querySelector('[data-action="dismiss"]'), "the Dismiss button"));
    expect(alarmOf(view).hidden).toBe(true);
  });

  test("an action that works clears the refusal that came before it", async () => {
    const server = new FakeServer(LIVE);
    server.refuse("resume", "run_claimed", "Another engine holds this run.");
    const view = await openRun(server);
    const resume = buttonNamed(view, "Resume");
    expect(resume.hidden).toBe(false);
    click(resume);
    await waitFor("the refusal to be drawn", () => !alarmOf(view).hidden);

    server.allow("resume");
    click(resume);
    await waitFor("the alarm to clear", () => alarmOf(view).hidden);
    expect(alarmOf(view).textContent).toBe("");
  });

  test("retry refused because the run finished under us stays said", async () => {
    // The page offered Retry on a run that had failed, and the run reached its end between that read
    // and this click. SPEC 4.6 then answers `run_not_retryable`, and the box is the whole point.
    const server = new FakeServer(FAILED_RUN);
    server.refuse("retry", "run_not_retryable", "A run that succeeded is not retried.", 400);
    const view = await openRun(server);

    const retry = buttonNamed(view, "Retry");
    expect(retry.hidden).toBe(false);
    // The alarm is already open on the run's own failure, so what has to change is what is in it.
    click(retry);
    await waitFor("the refusal to be drawn", () => alarmOf(view).textContent.includes("Retry refused"));

    expect(alarmOf(view).textContent).toContain("run_not_retryable");
    // Nothing is polled for a finished run, so nothing is waiting to hide the reason again.
    await settle();
    expect(alarmOf(view).hidden).toBe(false);
    expect(alarmOf(view).textContent).toContain("Retry refused");
  });
});

// ---------- what a poll does to the controls ----------

describe("the controls of a live run", () => {
  test("the jump box keeps what you typed and Cancel keeps focus across a poll", async () => {
    const server = new FakeServer(LIVE);
    const view = await openRun(server);
    const box = one(view.querySelector('[id="run-jump"]'), "the run jump box");
    const cancel = buttonNamed(view, "Cancel run");
    box.value = "20261104T120000Z-deadbeef";
    cancel.focus();
    expect(fakeDocument.activeElement).toBe(cancel);

    const polls = server.polls;
    await waitFor("a poll", () => server.polls > polls);

    expect(view.querySelector('[id="run-jump"]')).toBe(box);
    expect(one(view.querySelector('[id="run-jump"]'), "the run jump box").value).toBe("20261104T120000Z-deadbeef");
    expect(buttonNamed(view, "Cancel run")).toBe(cancel);
    expect(fakeDocument.activeElement).toBe(cancel);
  });

  test("the attempt picker is the same two buttons every poll", async () => {
    const server = new FakeServer(LIVE_RETRYING);
    const view = await openRun(server);
    const first = attemptButton(view, 0);
    const second = attemptButton(view, 1);
    expect(attemptButtons(view).map((node) => node.textContent)).toEqual(["1", "2"]);
    expect(second.getAttribute("aria-pressed")).toBe("true");
    first.focus();

    const polls = server.polls;
    await waitFor("a poll", () => server.polls > polls);

    expect(attemptButtons(view).map((node) => node.textContent)).toEqual(["1", "2"]);
    expect(attemptButton(view, 0)).toBe(first);
    expect(attemptButton(view, 1)).toBe(second);
    expect(fakeDocument.activeElement).toBe(first);
  });

  test("picking another attempt reads that attempt's bytes, and says which is pressed", async () => {
    const server = new FakeServer(TWICE_FAILED);
    server.logs = { "render/1": "the first try\n", "render/2": "the second try\n" };
    const view = await openRun(server);
    await waitFor("the newest attempt", () => drawnLines(view).join() === "the second try");
    expect(attemptButton(view, 1).getAttribute("aria-pressed")).toBe("true");

    click(attemptButton(view, 0));
    await waitFor("attempt 1's log", () => drawnLines(view).join() === "the first try");

    expect(attemptButton(view, 0).getAttribute("aria-pressed")).toBe("true");
    expect(attemptButton(view, 1).getAttribute("aria-pressed")).toBe("false");
    expect(statusLine(view)).toBe(`Read to byte ${byteLength("the first try\n")}.`);
  });
});

// ---------- the line that says where the log is ----------

describe("the line under the log", () => {
  test("it moves with the cursor while a long log is still being read", async () => {
    const server = new FakeServer(DONE);
    server.logs = { render: "one line\nthen another\nlast one\n" };
    server.chunkBytes = 10;
    server.logDelayMs = 150;
    const view = await openRun(server);

    // The old line was written once, before any of the log had arrived, and never again.
    await waitFor("the first chunk", () => drawnLines(view).length > 0);
    expect(statusLine(view)).toBe("Read to byte 10; more of the log is waiting.");

    await waitFor("the whole log", () => statusLine(view) === `Read to byte ${byteLength("one line\nthen another\nlast one\n")}.`);
  });

  test("switching steps starts the line again rather than going on from the step you left", async () => {
    const server = new FakeServer(DONE);
    server.logs = { fetch: "fetched three bytes\n", render: "rendered\n" };
    server.logDelayMs = 200;
    const view = await openRun(server);
    await waitFor("render's log", () => statusLine(view) === `Read to byte ${byteLength("rendered\n")}.`);

    click(rowOf(view, "fetch"));
    // The pane belongs to fetch now and its bytes are still on the way; the line must not still be
    // reporting where render left the cursor.
    expect(statusLine(view)).toBe("Read to byte 0.");

    await waitFor("fetch's log", () => statusLine(view) === `Read to byte ${byteLength("fetched three bytes\n")}.`);
    expect(drawnLines(view)).toEqual(["fetched three bytes"]);
  });
});

// ---------- when the server goes away ----------

describe("a server that stops answering", () => {
  test("the page says it lost the server, and stops saying it when the server comes back", async () => {
    const server = new FakeServer(LIVE);
    server.logs = { render: "hello\n" };
    const view = await openRun(server);
    await waitFor("the first log read", () => statusLine(view) === "Reading from byte 6.");

    server.stop();
    await waitFor("the page to notice", () => statusLine(view).includes("Lost the server, still trying."));
    expect(statusLine(view)).toContain("api_unreachable");
    // The last good poll stays on screen, which is why the line has to carry the bad news.
    expect(one(view.querySelector('[id="panel-title"]'), "the panel title").textContent).toBe("render");

    server.live();
    await waitFor("a good poll", () => !statusLine(view).includes("Lost the server"));
    expect(statusLine(view)).toBe("Reading from byte 6.");
  });
});

// ---------- what the alarm says ----------

describe("the alarm over the steps", () => {
  test("it names every step that failed, each one a way to its log", async () => {
    const server = new FakeServer(SIX_FAILED);
    const view = await openRun(server);
    const alarm = alarmOf(view);

    expect(alarm.hidden).toBe(false);
    expect(one(alarm.querySelector(".h2"), "the alarm's title").textContent).toBe("6 steps failed");
    expect(alarm.querySelectorAll("[data-log-step]").map((node) => node.textContent)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(alarm.textContent).toContain("exit_nonzero: the script exited 1");
  });

  test("the retry button is labelled with what a retry does, which is more than the failed steps", async () => {
    const server = new FakeServer(SIX_FAILED);
    const view = await openRun(server);
    const alarm = alarmOf(view);

    // SPEC 4.6: retry sets every failed, skipped and cancelled step back to pending.
    expect(one(alarm.querySelector('[data-action="retry-all"]'), "the retry button").textContent).toBe("Retry 7 steps");
    expect(alarm.textContent).toContain("Retry sets 6 failed steps, 1 skipped step back to pending");
  });

  test("one failed step is named, not counted", async () => {
    const server = new FakeServer(FAILED_RUN);
    const view = await openRun(server);
    const alarm = alarmOf(view);

    expect(one(alarm.querySelector(".h2"), "the alarm's title").textContent).toBe("render failed");
    expect(alarm.querySelectorAll("[data-log-step]").map((node) => node.textContent)).toEqual(["render"]);
    expect(one(alarm.querySelector('[data-action="retry-all"]'), "the retry button").textContent).toBe("Retry 2 steps");
  });

  test("the alarm is not rebuilt under you while the run polls", async () => {
    const limping = runFixture([step("render", "failed"), step("report", "running", ["render"])], "running");
    const server = new FakeServer(limping);
    const view = await openRun(server);
    const retry = one(alarmOf(view).querySelector('[data-action="retry-all"]'), "the retry button");
    retry.focus();

    const polls = server.polls;
    await waitFor("a poll", () => server.polls > polls);

    expect(one(alarmOf(view).querySelector('[data-action="retry-all"]'), "the retry button")).toBe(retry);
    expect(fakeDocument.activeElement).toBe(retry);
  });

  test("a failed step's name in the alarm points the pane at its log and puts the focus on its row", async () => {
    const server = new FakeServer(SIX_FAILED);
    const view = await openRun(server);
    expect(one(view.querySelector('[id="panel-title"]'), "the panel title").textContent).toBe("a");

    click(one(alarmOf(view).querySelector('[data-log-step="c"]'), "the link to c's log"));
    await waitFor("the pane to move to c", () => one(view.querySelector('[id="panel-title"]'), "the panel title").textContent === "c");

    expect(rowOf(view, "c").getAttribute("aria-selected")).toBe("true");
    expect(fakeDocument.activeElement).toBe(rowOf(view, "c"));
  });
});

// ---------- following a log that cannot grow ----------

describe("following a log", () => {
  test("a finished run does not offer to follow or pause a log that cannot grow", async () => {
    const server = new FakeServer(DONE);
    server.logs = { render: "rendered\n" };
    const view = await openRun(server);
    await waitFor("the log", () => drawnLines(view).length > 0);

    expect(buttonNamed(view, "Follow").disabled).toBe(true);
    expect(buttonNamed(view, "Pause").disabled).toBe(true);
  });

  test("a live run offers both", async () => {
    const server = new FakeServer(LIVE);
    server.logs = { render: "hello\n" };
    const view = await openRun(server);
    await waitFor("the log", () => drawnLines(view).length > 0);

    expect(buttonNamed(view, "Follow").disabled).toBe(false);
    expect(buttonNamed(view, "Pause").disabled).toBe(false);
  });

  test("a pause made while the run was live can still be undone after it finishes", async () => {
    const server = new FakeServer(LIVE);
    server.logs = { render: "hello\n" };
    const view = await openRun(server);
    await waitFor("the log", () => drawnLines(view).length > 0);
    click(buttonNamed(view, "Pause"));
    expect(statusLine(view)).toContain("Paused.");

    server.run = DONE;
    await waitFor("the run to finish", () => runStamp(view) === "succeeded");
    expect(buttonNamed(view, "Follow").disabled).toBe(true);
    expect(buttonNamed(view, "Resume reading").disabled).toBe(false);

    click(buttonNamed(view, "Resume reading"));
    await waitFor("the reading to start again", () => !statusLine(view).startsWith("Paused."));
    expect(statusLine(view)).toBe("Read to byte 6.");
  });

  test("a step that has never started has nothing to pause", async () => {
    const server = new FakeServer(runFixture([step("build", "pending")], "running"));
    const view = await openRun(server);

    expect(statusLine(view)).toBe("Not started.");
    expect(buttonNamed(view, "Pause").disabled).toBe(true);
    expect(buttonNamed(view, "Follow").disabled).toBe(false);
  });
});

// ---------- a live view keeps up with the run ----------
//
// Both screens are a read of run.json on a timer, and the whole of finding 45 was that the timer was
// never there: the list was painted once and left, so a run that started, finished or was retried
// while you were looking only turned up after a reload. What is pinned here is the loop and not the
// wait. Each test hands the screen a clock it turns itself and counts the reads the screen asked for,
// so "it polled, and then it stopped" is a number rather than a nap, and "running for 4 m 07 s" is
// measured against a now the test chose rather than whatever the machine running the suite believes.

/**
 * The Runs list, on a clock the test turns. `answer` and `fail` say what the next read will say and
 * `reads` counts them, so a test can watch the screen ask rather than wait to see whether it did.
 */
describe("a run screen that keeps up", () => {
  test("stops asking once the run is finished, and leaves no timer behind", async () => {
    const server = new FakeServer(runFixture([step("build", "running")], "running"));
    const clock = new FakeClock();
    const view = await openRun(server, clock);
    expect(clock.waking).toBe(1);

    server.run = runFixture([step("build", "succeeded")], "succeeded");
    await clock.advance(POLL_MS);

    expect(runStamp(view)).toBe("succeeded");
    expect(clock.waking).toBe(0);
    const polls = server.polls;
    await clock.advance(POLL_MS * 10);
    expect(server.polls).toBe(polls);
  });

  test("follow stays on a step that failed an attempt and is due another one", async () => {
    const server = new FakeServer(runFixture([step("build", "running"), step("report", "pending", ["build"])], "running"));
    const clock = new FakeClock();
    const view = await openRun(server, clock);
    expect(panelTitle(view)).toBe("build");

    // The attempt failed and the retry timer has it now. The run is still going, and so is this step:
    // the next attempt is its log continuing, not another step's starting.
    server.run = runFixture([step("build", "waiting_retry"), step("report", "running", ["build"])], "running");
    await clock.advance(POLL_MS);

    expect(panelTitle(view)).toBe("build");
    expect(word(one(rowOf(view, "build").querySelector(".stamp"), "the row's state"))).toBe("waiting_retry");
    expect(rowOf(view, "build").textContent).toContain("On screen");
  });

  test("a retry that is already due is not counted backwards", async () => {
    const clock = new FakeClock();
    // The fixture is written around T0, and its retry is due at T1: 41 seconds on.
    clock.set(T0);
    const server = new FakeServer(runFixture([step("build", "waiting_retry"), step("report", "pending", ["build"])], "running"));
    const view = await openRun(server, clock);
    expect(rowOf(view, "build").textContent).toContain("Another attempt in 41 s");

    // The engine's clock and the browser's are two clocks, and the browser can wake after the due time.
    // Counting up from there would read as a countdown that went wrong.
    await clock.advance(42_000);
    expect(rowOf(view, "build").textContent).toContain("Another attempt is due now.");
  });

  test("a retry with less than a second left still counts in a number above zero", async () => {
    const clock = new FakeClock();
    clock.set(T0);
    const server = new FakeServer(runFixture([step("build", "waiting_retry"), step("report", "pending", ["build"])], "running"));
    const view = await openRun(server, clock);

    // Four tenths of a second left rounds to "1 s": "in 0 s" with time still to go reads as a timer
    // that stopped, which is the same lie as a countdown going backwards.
    await clock.advance(40_600);
    expect(rowOf(view, "build").textContent).toContain("Another attempt in 1 s");
    expect(rowOf(view, "build").textContent).not.toContain("in 0 s");
  });

  test("a retry with no readable time to wait for says it is waiting, not how long", async () => {
    const clock = new FakeClock();
    clock.set(T0);
    const run = runFixture([step("build", "waiting_retry"), step("report", "pending", ["build"])], "running");
    run.steps.build!.next_attempt_at = "not a time at all";
    const view = await openRun(new FakeServer(run), clock);

    // "Another attempt in ." is the sentence with the number missing, which is the same bug wearing a hat.
    expect(rowOf(view, "build").textContent).toContain("Waiting to retry.");
    expect(rowOf(view, "build").textContent).not.toContain("Another attempt in .");
  });

  test("a stored time this build cannot read says nothing rather than NaN", async () => {
    const broken = runFixture([step("build", "running")], "running");
    broken.created_at = "not a time at all";
    const server = new FakeServer(broken);
    const view = await openRun(server, new FakeClock());

    expect(view.textContent).not.toContain("NaN");
    expect(metaLine(view, "started").textContent).toBe("started");
  });

  test("says the poll is lost, and stops saying it when the server answers again", async () => {
    const server = new FakeServer(LIVE);
    const clock = new FakeClock();
    const view = await openRun(server, clock);

    server.refusePoll();
    await clock.advance(POLL_MS);
    expect(metaLine(view, "lost the server").textContent).toBe("lost the server, still trying");
    expect(metaLine(view, "lost the server").getAttribute("title")).toContain("the api is down");
    // The state on screen stays the last good one, because that is the last thing known about it.
    expect(runStamp(view)).toBe("running");

    server.answerPollAgain();
    await clock.advance(POLL_MS);
    expect(metaLine(view, "lost the server").hidden).toBe(true);
  });

  test("follow moves the pane to the step that is running now", async () => {
    const server = new FakeServer(runFixture([step("fetch", "running")], "running"));
    const clock = new FakeClock();
    const view = await openRun(server, clock);
    expect(panelTitle(view)).toBe("fetch");

    // `render` starts and `fetch` finishes on the same poll, which is the case the old rule missed:
    // there was no new attempt to notice, so the pane sat on a finished log while the run went on.
    server.run = runFixture([step("fetch", "succeeded"), step("render", "running", ["fetch"])], "running");
    await clock.advance(POLL_MS);

    expect(panelTitle(view)).toBe("render");
  });

  test("follow off pins the pane to the step it was left on", async () => {
    const server = new FakeServer(runFixture([step("fetch", "running")], "running"));
    const clock = new FakeClock();
    const view = await openRun(server, clock);
    click(buttonNamed(view, "Follow"));
    expect(buttonNamed(view, "Follow").getAttribute("aria-pressed")).toBe("false");

    server.run = runFixture([step("fetch", "succeeded"), step("render", "running", ["fetch"])], "running");
    await clock.advance(POLL_MS);

    // Somebody chose this step and turned following off to keep it: the run moving on is not their
    // business. Only the pane moving is, and only when they asked for it.
    expect(panelTitle(view)).toBe("fetch");
  });

  test("the time it has been going is counted from the run's own clock, not the machine's", async () => {
    const server = new FakeServer(LIVE);
    const clock = new FakeClock();
    clock.set("2026-11-04T10:19:07Z"); // 4 m 07 s after the run was created
    const view = await openRun(server, clock);

    expect(metaLine(view, "running for").textContent).toBe("running for 4 m 07 s");
  });

  test("a run that has finished says how long it took, and stops counting", async () => {
    const server = new FakeServer(DONE);
    const clock = new FakeClock();
    clock.set("2026-11-04T13:00:00Z"); // hours after it was over
    const view = await openRun(server, clock);

    expect(metaLine(view, "took").textContent).toBe(`took ${duration(41)}`);
    expect(clock.waking).toBe(0);
  });
});

describe("one clock on the screen", () => {
  test("a time is the reader's own clock, and does not name a zone", () => {
    const stamp = when("2026-11-04T10:15:00Z");
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Read back as the reader's own local time it is the same instant: nothing is printed in a zone
    // the reader did not choose, which is what made three screens disagree by hours.
    expect(Date.parse(stamp)).toBe(Date.parse("2026-11-04T10:15:00Z"));
  });

  test("the exact instant is on the page for anyone who wants it", async () => {
    const server = new FakeServer(LIVE);
    const view = await openRun(server);

    expect(metaLine(view, "started").getAttribute("title")).toBe(LIVE.created_at);
    expect(metaLine(view, "started").textContent).toBe(`started ${when(LIVE.created_at)}`);
  });

  test("the printed time is the same instant the server sent", () => {
    // Computed from the reader's own local getters, so it holds in any zone the test machine runs in:
    // this is the one place that says out loud what `when` promises.
    const local = new Date(Date.UTC(2026, 10, 4, 10, 15, 0));
    expect(when("2026-11-04T10:15:00Z")).toBe(
      `${local.getFullYear()}-${pair(local.getMonth() + 1)}-${pair(local.getDate())} ${pair(local.getHours())}:${pair(local.getMinutes())}:${pair(local.getSeconds())}`,
    );
  });

  test("a time that is not there is nothing, not a date invented", () => {
    expect(when(null)).toBe("");
    expect(isoInstant(null)).toBe("");
  });
});
describe("a run's name", () => {
  test("the display word is Run and the id is set under it in the code face", async () => {
    const view = await render(runFixture([step("build", "succeeded")], "succeeded"));

    const title = one(view.querySelector(".title"), "the run's heading");
    expect(title.textContent.startsWith("Run ")).toBe(true);

    const id = one(title.querySelector(".title__id"), "the run id inside the heading");
    expect(id.textContent).toBe("20261104T101500Z-3fa9c2d1");
    // The code face is what makes an id read as a string, and it comes from the class, not a font
    // the heading happens to inherit.
    expect(id.classList.contains("mono")).toBe(true);
  });

  test("the id is smaller than the smallest the display heading ever gets", () => {
    const idSize = Number(/font-size:\s*([\d.]+)rem/.exec(ruleBody(".title__id"))?.[1]);
    const displayFloor = Number(/font-size:\s*clamp\(\s*([\d.]+)rem/.exec(ruleBody(".title"))?.[1]);
    expect(idSize).toBeGreaterThan(0);
    expect(idSize).toBeLessThan(displayFloor);
  });

  test("the id still breaks at its own hyphen rather than in the middle of a group of digits", () => {
    expect(ruleBody(".title__id")).toMatch(/overflow-wrap:\s*break-word/);
  });
});

describe("text longer than the box it is in", () => {
  test("a description that is one long word breaks inside its own box", () => {
    // A pipeline's `description:` is whatever the file says it is. Without this the page scrolled
    // sideways: 2635 px of page in a 1440 px window.
    expect(ruleBody(".lead")).toMatch(/overflow-wrap:\s*(anywhere|break-word)/);
  });

  test("the graph gives a port name the whole width of its step", () => {
    // Two columns of port names inside a step whose width the graph sets from the room its columns
    // leave behind is how `total_words` came out as `total_wor/ds` at 1440 px. One column, and the
    // mark on each side is what still says which way the name runs.
    expect(sheet).not.toMatch(/\.node__ports\s*\{[^}]*grid-template-columns/);
    expect(ruleBody(".stage--flow .port--out")).toContain("text-align: right");
  });
});

describe("the app's own content security policy", () => {
  test("no module the browser runs puts a style attribute on an element", () => {
    // The CSP the server sends is `style-src 'self'`: an inline style is dropped, so the control it
    // was styling sits out of line and the console fills up once per poll.
    const offenders: string[] = [];
    for (const [name, asset] of buildAssets().files) {
      if (!name.startsWith("assets/") || !name.endsWith(".js")) continue;
      if (/\bstyle:\s*["']/.test(new TextDecoder().decode(asset.data))) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  test("neither run screen leaves a style attribute on the page", async () => {
    const view = await render(runFixture([step("build", "succeeded")], "succeeded"));
    expect(styled(view)).toEqual([]);
    expect(styled(await renderList([summary("20261104T101500Z-3fa9c2d1", "failed")]))).toEqual([]);
  });

  test("a label beside its buttons is a class, and the class zeroes the margin", () => {
    expect(ruleBody(".label--inline")).toMatch(/margin:\s*0/);
  });
});
describe("the files of a run", () => {
  test("the attempt on screen links to each of its files, at that run's own address", async () => {
    const view = await openRun(filesServer());

    expect(panelLinks(view)).toEqual([
      REPORT,
      CHUNKS,
      LOGFILE,
      "Everything in ingest as one archive",
    ]);
    for (const path of [REPORT, CHUNKS, LOGFILE]) {
      expect(fileLink(view, path).getAttribute("href")).toBe(
        `http://runs.test/v1/runs/${FILES_RUN.id}/file?path=${encodeURIComponent(path)}`,
      );
    }
  });

  test("the archive links say which run, which step and which attempt", async () => {
    const view = await openRun(filesServer());

    expect(fileLink(view, "Everything in ingest as one archive").getAttribute("href")).toBe(
      `http://runs.test/v1/runs/${FILES_RUN.id}/archive?step=ingest&attempt=1`,
    );
    expect(fileLink(view, "Download the run").getAttribute("href")).toBe(
      `http://runs.test/v1/runs/${FILES_RUN.id}/archive`,
    );
    expect(fileLink(view, "Download the manifest").getAttribute("href")).toBe(
      `http://runs.test/v1/runs/${FILES_RUN.id}/files`,
    );
  });

  test("a size is said, so nobody clicks blind into a gigabyte", async () => {
    const view = await openRun(filesServer());

    expect(fileLink(view, CHUNKS).textContent).toBe(`${CHUNKS} 1.5 kB`);
    expect(fileLink(view, REPORT).textContent).toBe(`${REPORT} 24 B`);
  });

  test("clicking a file link asks the API for it and does not navigate", async () => {
    const server = filesServer();
    const view = await openRun(server);
    savedFiles.length = 0;

    let navigated = false;
    fileLink(view, REPORT).dispatchEvent("click", { preventDefault: () => void (navigated = true) });
    await waitFor("the file to be handed to the browser", () => savedFiles.length > 0);

    expect(navigated).toBe(true);
    expect(savedFiles).toEqual([{ name: "report.html", url: "blob:13" }]);
    expect(server.asked).toContain(`GET /v1/runs/${FILES_RUN.id}/file`);
  });

  test("clicking the archive link downloads that step's attempt", async () => {
    const server = filesServer();
    const view = await openRun(server);
    savedFiles.length = 0;

    click(fileLink(view, "Everything in ingest as one archive"));
    await waitFor("the archive to be handed to the browser", () => savedFiles.length > 0);

    expect(savedFiles).toEqual([{ name: `${FILES_RUN.id}-ingest-attempt1.tar.gz`, url: "blob:12" }]);
  });

  test("a run whose files cannot be listed still shows the run", async () => {
    const server = new FakeServer(FILES_RUN);
    const view = await openRun(server);

    expect(word(one(view.querySelector(".steprow .stamp"), "the step's stamp"))).toBe("succeeded");
    expect(panelLinks(view)).toEqual([]);
    expect(one(view.querySelector('[id="panel-title"]'), "the panel title").textContent).toBe("ingest");
  });
});
