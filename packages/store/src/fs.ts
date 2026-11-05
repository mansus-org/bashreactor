// File helpers for the store's on-disk files. Immutable files (blocks, artifacts) are written
// atomically via a same-directory temp file and rename; logs are append-only via O_APPEND.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function atomicWriteFile(path: string, bytes: Uint8Array): void {
  ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may already be gone; nothing to clean up.
    }
    throw err;
  }
  fsyncDir(dirname(path));
}

export function appendFile(path: string, bytes: Uint8Array): number {
  ensureDir(dirname(path));
  const fd = openSync(path, "a", 0o644);
  try {
    writeAll(fd, bytes);
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

export function readFileAll(path: string): Uint8Array {
  return readFileFrom(path, 0).bytes;
}

export function fileSizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function readFileFrom(path: string, offset: number): { bytes: Uint8Array; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.min(Math.max(offset, 0), size);
    const length = size - start;
    const bytes = new Uint8Array(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, bytes, got, length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return { bytes: bytes.subarray(0, got), size };
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
  }
}

function fsyncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
