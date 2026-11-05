// Per-agent tokens, in the shape `myself serve` uses: a random secret, stored only as its sha256,
// each with a name, a scope and a created-at. The clear text is handed back exactly once, at
// creation. The list lives in memory and is persisted after every change, so a revoke takes effect
// on the next request rather than on the next restart.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sha256Hex } from "./config.ts";
import { ApiError } from "./errors.ts";

export const TOKEN_PREFIX = "br_";
export const TOKEN_SCOPES = ["read", "write"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

// How often last_used may cost a write.
const LAST_USED_EVERY_MS = 60_000;

export interface TokenInfo {
  id: string;
  name: string;
  scope: TokenScope;
  created_at: string;
  last_used: string | null;
}

interface StoredToken extends TokenInfo {
  sha256: string;
}

export class TokenStore {
  readonly path: string;
  /** Why the file on disk was not read, if it could not be. The API still serves, with no agents. */
  readonly problem: string | null;
  #list: StoredToken[];

  constructor(path: string, warn: (line: string) => void = () => {}) {
    this.path = path;
    const loaded = readTokens(path);
    this.#list = loaded.tokens;
    this.problem = loaded.problem;
    if (this.problem !== null) warn(this.problem);
  }

  /** Every token, oldest first, never with its secret. */
  list(): TokenInfo[] {
    return this.#list.map(({ sha256: _sha256, ...info }) => info);
  }

  /** Adds a token and returns it with its clear text, which is not kept anywhere. */
  create(name: string, scope: string, now: Date = new Date()): { info: TokenInfo; token: string } {
    const trimmed = name.trim();
    if (trimmed === "") throw new ApiError("missing_input", "give the token a name, such as the agent's", { path: "name" });
    if (trimmed.length > 100) throw new ApiError("type_mismatch", "token name is longer than 100 characters", { path: "name" });
    if (!isScope(scope)) {
      throw new ApiError("type_mismatch", `scope must be one of ${TOKEN_SCOPES.join(" or ")}`, { path: "scope" });
    }

    const secret = TOKEN_PREFIX + randomBytes(32).toString("hex");
    const info: TokenInfo = {
      id: randomUUID(),
      name: trimmed,
      scope,
      created_at: now.toISOString(),
      last_used: null,
    };
    this.#save([...this.#list, { ...info, sha256: sha256Hex(secret) }]);
    return { info, token: secret };
  }

  /** Revokes a token. The next request with it fails, without a restart. */
  revoke(id: string): void {
    const next = this.#list.filter((token) => token.id !== id);
    if (next.length === this.#list.length) {
      throw new ApiError("token_not_found", `token "${id}" does not exist`);
    }
    this.#save(next);
  }

  /** The token that matches this secret, or null. Updates last_used at most once a minute. */
  check(secret: string, now: Date = new Date()): TokenInfo | null {
    const candidate = Buffer.from(sha256Hex(secret), "utf8");
    let found: StoredToken | null = null;
    for (const token of this.#list) {
      // Compare every entry, so the time taken does not say which one matched.
      if (timingSafeEqual(candidate, Buffer.from(token.sha256, "utf8"))) found = token;
    }
    if (found === null) return null;

    if (found.last_used === null || now.getTime() - Date.parse(found.last_used) >= LAST_USED_EVERY_MS) {
      found.last_used = now.toISOString();
      this.#save(this.#list);
    }
    const { sha256: _sha256, ...info } = found;
    return info;
  }

  #save(list: StoredToken[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ tokens: list }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
    this.#list = list;
  }
}

function readTokens(path: string): { tokens: StoredToken[]; problem: string | null } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { tokens: [], problem: null }; // no file yet is the normal first start
  }
  // A file that cannot be read is treated as no agents rather than taken down the server with: the
  // alternative is a corrupt tokens.json crash-looping a pod that still has to answer /healthz.
  let parsed: { tokens?: unknown };
  try {
    parsed = JSON.parse(raw) as { tokens?: unknown };
  } catch (error) {
    return { tokens: [], problem: `${path}: ${(error as Error).message}` };
  }
  if (!Array.isArray(parsed.tokens)) {
    return { tokens: [], problem: `${path}: expected an object with a "tokens" array` };
  }
  return { tokens: parsed.tokens.filter(isStoredToken), problem: null };
}

function isStoredToken(value: unknown): value is StoredToken {
  const token = value as Partial<StoredToken> | null;
  return (
    token !== null &&
    typeof token === "object" &&
    typeof token.id === "string" &&
    typeof token.name === "string" &&
    isScope(token.scope) &&
    typeof token.sha256 === "string"
  );
}

export function isScope(value: unknown): value is TokenScope {
  return value === "read" || value === "write";
}
