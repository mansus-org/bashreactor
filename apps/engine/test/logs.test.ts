// Reading an attempt's log (SPEC 4.8): the cursor is what makes hours of output cheap to watch, so
// a read must touch only its window on disk and must never cut a character in half.

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { FsRunStore } from "../src/run-store.ts";
import { newRunId } from "../src/run.ts";

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-logs-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytesOf = (value: string) => new TextEncoder().encode(value);
const MIB = 1 << 20;
const STEP = "build";
const LOG = `steps/${STEP}/attempts/1/log`;

describe("reading a log", () => {
  test("a read asks the disk for its window and nothing more", async () => {
    const store = new FsRunStore(newRoot());
    const runId = newRunId();
    const log = Buffer.concat([Buffer.from("x".repeat(3 * MIB)), Buffer.from("\nthe last line\n")]);
    await store.writeFile(runId, LOG, new Uint8Array(log));
    const path = store.layout(runId).attemptLogPath(STEP, 1);
    expect(statSync(path).size).toBe(log.length);
    expect(log.length).toBeGreaterThan(MIB);

    const asked: { offset: number; length: number }[] = [];
    const readWhole: string[] = [];
    const spy = new Proxy(store, {
      get(self, prop) {
        const value = Reflect.get(self, prop);
        if (prop === "readFileRange") {
          return (id: string, rel: string, offset: number, length: number) => {
            asked.push({ offset, length });
            return self.readFileRange(id, rel, offset, length);
          };
        }
        if (prop === "readFile") {
          return (id: string, rel: string) => {
            readWhole.push(rel);
            return self.readFile(id, rel);
          };
        }
        return typeof value === "function" ? value.bind(self) : value;
      },
    });
    const engine = new Engine({ store: spy });

    const WINDOW = 64 * 1024;
    const pieces: Buffer[] = [];
    let at = 0;
    for (;;) {
      const before = asked.length;
      const chunk = await engine.readLog(runId, STEP, 1, at, WINDOW);
      // At most two positional reads per chunk: the window, and the few bytes that finish a character.
      expect(asked.length - before).toBeLessThanOrEqual(2);
      for (const read of asked.slice(before)) expect(read.length).toBeLessThanOrEqual(WINDOW + 3);
      expect(chunk.nextOffset).toBe(at + chunk.data.length);
      pieces.push(Buffer.from(chunk.data));
      at = chunk.nextOffset;
      if (!chunk.more) break;
      expect(pieces.length).toBeLessThan(200);
    }

    expect(Buffer.concat(pieces).equals(log)).toBe(true);
    expect(text(pieces.at(-1)!)).toInclude("the last line");
    expect(readWhole).toEqual([]);
    const requested = asked.reduce((total, read) => total + read.length, 0);
    // One window per poll, plus the last short one: reading the file whole on every read would be
    // windows times the log, not the log once.
    expect(requested).toBeLessThan(log.length + WINDOW + 3 * asked.length);
    // Reading it to the end again from the cursor finds nothing new, and costs nothing.
    const tail = await engine.readLog(runId, STEP, 1, at, WINDOW);
    expect(tail).toEqual({ data: new Uint8Array(), nextOffset: at, more: false });
  }, 60_000);

  test("next_offset never lands inside a character", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const runId = newRunId();
    const words = "héllo wörld — 👍 café\n";
    await store.writeFile(runId, LOG, bytesOf(words));

    // One byte at a time: every chunk has to reach past the window to finish the character it cut.
    let at = 0;
    let seen = "";
    for (let polls = 0; polls < 100; polls++) {
      const chunk = await engine.readLog(runId, STEP, 1, at, 1);
      expect(chunk.data.length).toBeGreaterThan(0);
      // A fatal decoder throws on anything but whole sequences, so this is the boundary test.
      const piece = new TextDecoder("utf-8", { fatal: true }).decode(chunk.data);
      expect(piece).not.toInclude("\ufffd");
      seen += piece;
      at = chunk.nextOffset;
      if (!chunk.more) break;
    }
    expect(seen).toBe(words);

    const split = bytesOf("héllo").indexOf(0xc3); // the first byte of "é"
    const chunk = await engine.readLog(runId, STEP, 1, split, 1);
    expect(text(chunk.data)).toBe("é");
    expect(chunk.nextOffset).toBe(split + 2);
  });

  test("a character a running attempt has only half written waits for the rest", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const runId = newRunId();
    const path = store.layout(runId).attemptLogPath(STEP, 1);
    // The block wrote "h", then one byte of "é" and stopped there: the poll lands mid-character.
    await store.writeFile(runId, LOG, Uint8Array.from([0x68, 0xc3]));

    const half = await engine.readLog(runId, STEP, 1, 0, 1 << 20, { attemptOpen: true });
    expect(text(half.data)).toBe("h");
    expect(half.nextOffset).toBe(1);
    expect(half.more).toBe(false);

    // The attempt finishes the character and the line; the reader picks it up whole.
    appendFileSync(path, Uint8Array.from([0xa9, 0x6c, 0x6c, 0x6f, 0x0a]));
    const rest = await engine.readLog(runId, STEP, 1, half.nextOffset, 1 << 20, { attemptOpen: true });
    expect(text(rest.data)).toBe("éllo\n");
    expect(rest.nextOffset).toBe(7);
    expect(text(readFileSync(path))).toBe("héllo\n");

    // And the held-back byte is not lost: once the attempt is over it is the block's own byte.
    const flushed = await engine.readLog(runId, STEP, 1, 1, 1 << 20);
    expect(Array.from(flushed.data)).toEqual([0xc3, 0xa9, 0x6c, 0x6c, 0x6f, 0x0a]);
  });

  test("bytes that are not UTF-8 come through byte for byte", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const runId = newRunId();
    // 0xff is no one's lead byte, 0x80 is a continuation with nothing before it, and 0xe2 0x82 0x28
    // is a three-byte sequence whose last byte is not a continuation. All of it is the block's own.
    const garbage = Uint8Array.from([0x68, 0xff, 0xfe, 0x80, 0xe2, 0x82, 0x28, 0xf0, 0x28, 0x8c, 0xbc]);
    await store.writeFile(runId, LOG, garbage);

    const chunk = await engine.readLog(runId, STEP, 1, 0, 1 << 20, { attemptOpen: true });
    expect(Array.from(chunk.data)).toEqual(Array.from(garbage));
    expect(chunk.nextOffset).toBe(garbage.length);
    expect(chunk.more).toBe(false);

    // A truncated sequence at the end of a finished attempt is invalid bytes on purpose, too.
    const other = newRunId();
    await store.writeFile(other, LOG, Uint8Array.from([0x68, 0xc3]));
    const done = await engine.readLog(other, STEP, 1, 0, 1 << 20);
    expect(Array.from(done.data)).toEqual([0x68, 0xc3]);
    expect(done.nextOffset).toBe(2);
  });
});


