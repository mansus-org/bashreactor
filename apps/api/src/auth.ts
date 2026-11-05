// Who may call what, in the shape `myself serve` uses: one admin token from the environment plus
// per-agent tokens that are read or write. Every /v1 route names the access it needs and nothing
// else decides it.

import { timingSafeEqual } from "node:crypto";
import type { ApiConfig } from "./config.ts";
import { sha256Hex } from "./config.ts";
import { ApiError } from "./errors.ts";
import type { TokenInfo, TokenStore } from "./tokens.ts";

export type Access = "read" | "write" | "admin";

export interface Identity {
  name: string;
  scope: "read" | "write" | "admin";
  admin: boolean;
}

const ADMIN: Identity = { name: "admin", scope: "admin", admin: true };

/** The caller of a request, or an ApiError with status 401 or 503. */
export function authenticate(request: Request, config: ApiConfig, tokens: TokenStore): Identity {
  if (config.adminHash === null) {
    throw new ApiError(
      "runtime_missing",
      "the API is disabled: set BASHREACTOR_ADMIN_TOKEN or BASHREACTOR_ADMIN_TOKEN_SHA256 on the server",
      { status: 503 },
    );
  }
  const header = request.headers.get("authorization") ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (secret === "") {
    throw new ApiError("unauthenticated", "missing token: send the header Authorization: Bearer <token>");
  }

  if (matches(secret, config.adminHash)) return ADMIN;

  const info: TokenInfo | null = tokens.check(secret);
  if (info === null) throw new ApiError("unauthenticated", "invalid or revoked token");
  return { name: info.name, scope: info.scope, admin: false };
}

export function authorize(identity: Identity, need: Access): void {
  if (need === "admin" && !identity.admin) {
    throw new ApiError("forbidden", "this endpoint needs the admin token");
  }
  if (need === "write" && identity.scope === "read") {
    throw new ApiError("forbidden", `token "${identity.name}" is read-only; this endpoint needs a write token`);
  }
}

function matches(secret: string, hash: string): boolean {
  const candidate = Buffer.from(sha256Hex(secret), "utf8");
  const expected = Buffer.from(hash, "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
