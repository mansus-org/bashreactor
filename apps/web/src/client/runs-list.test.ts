// The runs list: a read of `GET /v1/runs` on the clock the test turns, rows patched in place so a
// rebuild cannot take the focus, and the row that says what the reading is doing. The stand-in DOM
// and the fake clock are in runs.testkit.ts; one run's page has its own file.

import { describe, expect, test } from "bun:test";
import {
  IDLE_POLL_MS,
  POLL_MS,
  fakeDocument,
  liveList,
  note,
  one,
  reply,
  renderList,
  ruleBody,
  showTab,
  summary,
  waitFor,
  word,
} from "./runs.testkit.ts";

describe("a list that keeps up", () => {
  test("reads again while a run on it is going", async () => {
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "running")]);
    expect(list.clock.waking).toBe(1);

    list.answer([summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
    await list.clock.advance(POLL_MS);

    expect(list.reads()).toBe(2);
    expect(word(one(list.view.querySelector(".stamp"), "the row's state"))).toBe("succeeded");
  });

  test("goes quiet the moment nothing on it is running, and keeps a slow watch", async () => {
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "running")]);
    list.answer([summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
    await list.clock.advance(POLL_MS);

    // One timer, and it is the slow one: nothing here is moving, but the list is still the front door.
    expect(list.clock.waking).toBe(1);
    const reads = list.reads();
    await list.clock.advance(POLL_MS * 10);
    expect(list.reads()).toBe(reads);
    await list.clock.advance(IDLE_POLL_MS);
    expect(list.reads()).toBe(reads + 1);
  });

  test("a run started somewhere else turns up while the list is quiet", async () => {
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
    expect(list.reads()).toBe(1);

    // Started from the CLI, or in another tab: nobody has touched this page.
    list.answer([summary("20261104T111500Z-1a2b3c4d", "running"), summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
    await list.clock.advance(IDLE_POLL_MS);

    expect(list.reads()).toBe(2);
    expect(list.view.querySelectorAll(".runrow").length).toBe(2);
    expect(word(one(list.view.querySelector(".stamp"), "the row's state"))).toBe("running");
    // And with something running, the fast loop is back on its own.
    await list.clock.advance(POLL_MS);
    expect(list.reads()).toBe(3);
  });

  test("one read that reorders, gains and loses in the same breath", async () => {
    const list = await liveList([
      summary("20261104T101500Z-3fa9c2d1", "running"),
      summary("20261104T091500Z-4b5c6d7e", "running"),
    ]);
    const before = list.view.querySelectorAll(".runrow");
    const kept = one(before[0] ?? null, "the older row");
    const gone = one(before[1] ?? null, "the row that is about to go");
    kept.focus();

    // The older of the two has been deleted, a newer one has arrived, and the survivor has moved up.
    list.answer([summary("20261104T111500Z-1a2b3c4d", "running"), summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
    await list.clock.advance(POLL_MS);

    const rows = list.view.querySelectorAll(".runrow");
    expect(rows.length).toBe(2);
    expect(rows[1]).toBe(kept);
    expect(fakeDocument.activeElement).toBe(kept);
    expect(rows[0]).not.toBe(kept);
    expect(rows[0]).not.toBe(gone);
  });

  test("an empty list fills, and empties again", async () => {
    const list = await liveList([]);
    expect(one(list.view.querySelector(".stage__empty"), "the empty message").hidden).toBe(false);
    expect(note(list.view).hidden).toBe(true);

    list.answer([summary("20261104T101500Z-3fa9c2d1", "running")]);
    await list.clock.advance(IDLE_POLL_MS);
    expect(list.view.querySelectorAll(".runrow").length).toBe(1);
    expect(one(list.view.querySelector(".stage__empty"), "the empty message").hidden).toBe(true);
    expect(note(list.view).hidden).toBe(true);

    list.answer([]);
    await list.clock.advance(POLL_MS);
    expect(list.view.querySelectorAll(".runrow").length).toBe(0);
    expect(one(list.view.querySelector(".stage__empty"), "the empty message").hidden).toBe(false);
    expect(note(list.view).hidden).toBe(true);
  });

  test("a row whose stored time cannot be read keeps the row and drops the time", async () => {
    const list = await liveList([summary("one", "succeeded"), { ...summary("two", "succeeded"), created_at: "not a time at all" }]);
    const view = list.view;

    // Echoing the string back would put a wrong time on the page dressed up as a right one.
    expect(view.textContent).not.toContain("not a time at all");
    const row = one(
      view.querySelectorAll(".runrow").find((r) => r.textContent.includes("two")) ?? null,
      "the row with the unreadable time",
    );
    expect(row.textContent).not.toContain("started");
    const good = one(
      view.querySelectorAll(".runrow").find((r) => r.textContent.includes("one")) ?? null,
      "the row with a real time",
    );
    expect(good.textContent).toContain("started");
  });

  test("a first read that fails does not leave the page saying it is loading", async () => {
    const list = await liveList([], true);
    expect(list.view.querySelector("[role=alert]")).not.toBeNull();
    // The box is the whole of the screen now: the line that said it was loading has to get out of it.
    expect(note(list.view).hidden).toBe(true);

    list.answer([summary("20261104T101500Z-3fa9c2d1", "running")]);
    await list.clock.advance(POLL_MS);
    expect(list.view.querySelectorAll(".runrow").length).toBe(1);
    expect(list.view.querySelector("[role=alert]")).toBeNull();
    expect(note(list.view).hidden).toBe(true);
  });

  test("a run that starts while you are looking turns up, and the row you were on is the same row", async () => {
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "running")]);
    const row = one(list.view.querySelector(".runrow"), "the row for the run already there");
    row.focus();

    // Newest first, so the old row has to move down a place.
    list.answer([summary("20261104T111500Z-1a2b3c4d", "running"), summary("20261104T101500Z-3fa9c2d1", "running")]);
    await list.clock.advance(POLL_MS);

    const rows = list.view.querySelectorAll(".runrow");
    expect(rows.length).toBe(2);
    expect(rows[1]).toBe(row);
    // The reason rows are patched rather than rebuilt: a rebuilt one takes the focus off you.
    expect(fakeDocument.activeElement).toBe(row);
  });

  test("says the reading is lost while the server is down, and stops saying it when it is not", async () => {
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "running")]);
    list.fail("the api is down");
    await list.clock.advance(POLL_MS);

    expect(note(list.view).hidden).toBe(false);
    expect(note(list.view).textContent).toContain("Lost the server");
    // The rows stay: a list that cannot read is not a list that is empty.
    expect(list.view.querySelectorAll(".runrow").length).toBe(1);
    // and it keeps trying, because the run may still be going.
    expect(list.clock.waking).toBe(1);

    list.answer([summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
    await list.clock.advance(POLL_MS);
    expect(note(list.view).hidden).toBe(true);
  });

  test("a tab nobody is looking at reads nothing, and reads the moment it is looked at again", async () => {
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "running")]);
    showTab(true);
    try {
      await list.clock.advance(POLL_MS * 5);
      expect(list.reads()).toBe(1);
      expect(list.clock.waking).toBe(0);

      list.answer([summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
      showTab(false);
      await waitFor("the row to say the run is over", () => list.view.textContent.includes("succeeded"));
      expect(word(one(list.view.querySelector(".stamp"), "the row's state"))).toBe("succeeded");
    } finally {
      showTab(false);
    }
  });

  test("a tab looked at again while a read is on its way does not start a second one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let out = 0;
    let peak = 0;
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "running")]);
    list.answer(() => {
      out += 1;
      peak = Math.max(peak, out);
      return gate.then(() => {
        out -= 1;
        return reply([summary("20261104T101500Z-3fa9c2d1", "running")]);
      });
    });

    // The tab goes away and comes back while that read is still in the air.
    await list.clock.advance(POLL_MS);
    showTab(true);
    showTab(false);
    release();
    await waitFor("the read to land", () => out === 0);

    expect(peak).toBe(1);
    // The read that landed is what re-armed the timer, so the list has not gone quiet on its own.
    expect(list.clock.waking).toBe(1);
  });
});

describe("a run in the list", () => {
  test("the row says its state once: the stamp, with no second sign beside it", async () => {
    const view = await renderList([summary("20261104T101500Z-3fa9c2d1", "failed")]);

    const row = one(view.querySelector(".runrow"), "a row in the run list");
    expect(row.querySelectorAll(".sign--large").length).toBe(0);
    expect(row.querySelectorAll(".stamp").length).toBe(1);
    expect(word(one(row.querySelector(".stamp"), "the row's stamp"))).toBe("failed");
  });

  test("the stylesheet leaves no column for a sign in front of the stamp", () => {
    expect(ruleBody(".runrow")).toMatch(/grid-template-columns:\s*minmax\(0, ?1fr\) auto/);
  });

  test("the line that reports the reading is a control, not a caption", () => {
    // Both live views read on their own now, so "loading" and "lost the server, still trying" are
    // things the page tells you rather than things you find out by reloading. They take the same
    // emphasis as the line under the log, and nothing else on those screens is bold at that size.
    expect(ruleBody(".runlist__note")).toMatch(/font-weight:\s*700/);
    expect(ruleBody(".runhead__stale")).toMatch(/font-weight:\s*700/);
  });
});

