// The log cursor, tested as the function it is: chunks in, lines and offsets out.
//
// The functions come from the text the server serves rather than from `./logs.ts`, and that is a
// bun fact rather than a style choice: bun caches modules by path and ignores the import attribute,
// and `src/raw.js` has already loaded that path as a string by the time this file runs, so importing
// it here hands back the string and no functions. The served module is what the browser runs, so it
// is the better thing to test anyway.

import { describe, expect, test } from "bun:test";
import { buildAssets } from "../assets.ts";
import type { LogChunk } from "./logs.ts";

const served = new TextDecoder().decode(buildAssets().files.get("assets/logs.js")!.data);
const { emptyLog, feedLog, logLines } = (await import(
  `data:text/javascript;base64,${Buffer.from(served).toString("base64")}`
)) as typeof import("./logs.ts");

const chunk = (offset: number, next: number, text: string, truncated = false): LogChunk => ({
  offset,
  next_offset: next,
  text,
  truncated,
});

describe("feedLog", () => {
  test("keeps whole lines and holds back the one that has not finished", () => {
    let log = feedLog(emptyLog, chunk(0, 12, "first line\nsecond li"));
    expect(logLines(log).map((line) => line.text)).toEqual(["first line", "second li"]);
    expect(log.offset).toBe(12);

    log = feedLog(log, chunk(12, 20, "ne\nthird\n"));
    expect(logLines(log).map((line) => line.text)).toEqual(["first line", "second line", "third"]);
    expect(log.partial).toBe("");
    expect(log.offset).toBe(20);
  });

  test("the offset it hands back is the one the next request sends", () => {
    let log = emptyLog;
    for (const text of ["a\nbb\n", "ccc\n", "dd"]) {
      const bytes = new TextEncoder().encode(text).length;
      log = feedLog(log, chunk(log.offset, log.offset + bytes, text));
    }
    expect(log.offset).toBe(11);
    expect(logLines(log).map((line) => line.offset)).toEqual([0, 2, 5, 9]);
  });

  test("counts bytes, not characters, so a block that prints an em dash moves the cursor by three", () => {
    const text = "one — two\nnext\n";
    const bytes = new TextEncoder().encode(text).length;
    const log = feedLog(emptyLog, chunk(0, bytes, text));
    expect(logLines(log).map((line) => line.offset)).toEqual([0, 12]);
    expect(log.offset).toBe(bytes);
  });

  test("a chunk that is not where we left off replaces the pane instead of appending to a stale one", () => {
    let log = feedLog(emptyLog, chunk(0, 4, "old\n"));
    log = feedLog(log, chunk(0, 4, "new\n"));
    expect(logLines(log).map((line) => line.text)).toEqual(["new"]);
  });

  test("says when the server cut its answer short", () => {
    const log = feedLog(emptyLog, chunk(0, 1_048_576, "a lot of text\n", true));
    expect(log.truncated).toBe(true);
    expect(feedLog(emptyLog, chunk(0, 4, "a\n")).truncated).toBe(false);
  });

  test("an empty chunk changes nothing but the cursor", () => {
    const log = feedLog(emptyLog, chunk(0, 0, ""));
    expect(logLines(log)).toEqual([]);
    expect(log.offset).toBe(0);
  });
});
