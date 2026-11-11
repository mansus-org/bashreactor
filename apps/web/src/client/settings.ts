// Settings: who this token is, where the server is, how much disk the runs have left, and — for the
// admin — the agent tokens that may sign in. Nothing here is stored twice: the token list is the
// answer from /v1/tokens, and the created secret lives only inside the dialog that showed it.

import { api, ApiError, session, signOut } from "./api.js";
import type { CreatedToken, DiskSpace, Health, Identity, TokenInfo } from "./api.js";
import { announce, el, errorBox, removeNode } from "./dom.js";
import type { Child } from "./dom.js";
import {
  alarm,
  button,
  confirmDialog,
  exactTime,
  formatBytes,
  meter,
  pageHeader,
  relativeTime,
  segmented,
  table,
  typeStamp,
} from "./ui.js";
import type { TableColumn } from "./ui.js";
import type { Route } from "./app.js";

type Read<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** A read that belongs to one section: its failure is that section's news, not the whole screen's. */
async function read<T>(promise: Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function problem(caught: unknown): { code: string; message: string; path?: string; file?: string } {
  if (caught instanceof ApiError) return caught;
  return { code: "internal_error", message: caught instanceof Error ? caught.message : String(caught) };
}

function section(title: string, body: Child[], action?: Child): HTMLElement {
  return el(
    "section",
    { class: "settings__section" },
    el(
      "div",
      { class: "settings__section-head" },
      el("h2", { class: "h2" }, title),
      action ?? null,
    ),
    el("div", { class: "settings__section-body" }, body),
  );
}

function fact(label: string, value: Child): HTMLElement {
  return el("div", { class: "settings__fact" }, el("dt", {}, label), el("dd", {}, value));
}

function tokenTime(iso: string): HTMLElement {
  const exact = exactTime(iso);
  const relative = relativeTime(iso);
  return el("time", { datetime: iso, title: exact === "" ? null : exact }, relative === "" ? "—" : relative);
}

function identitySection(identity: Identity): HTMLElement {
  return section("You", [
    el(
      "p",
      { class: "settings__identity" },
      el("span", { class: "settings__name" }, identity.name),
      typeStamp(identity.admin ? "admin" : identity.scope),
      button("Sign out", {
        onClick: () => {
          signOut();
          // The sidebar redraws the shell in place; a screen has no renderer of its own, and the gate
          // belongs at this address, so the reload is the same sign-out with the same route.
          location.reload();
        },
      }),
    ),
  ]);
}

function serverSection(health: Read<Health>): HTMLElement {
  const version = health.ok ? el("code", {}, health.value.version) : el("span", {}, "—");
  const body: Child[] = [
    el(
      "dl",
      { class: "settings__facts" },
      fact("Version", version),
      fact("API URL", el("code", {}, `${session.base}/v1`)),
      fact("MCP URL", el("code", {}, `${session.base}/mcp`)),
    ),
    el("p", { class: "settings__licence" }, el("a", { href: "/app/OFL.txt" }, "Fonts and their licence")),
  ];
  if (!health.ok) body.push(errorBox(problem(health.error)));
  return section("Server", body);
}

function diskSection(disk: Read<DiskSpace>): HTMLElement {
  if (!disk.ok) return section("Disk", [errorBox(problem(disk.error))]);
  const space = disk.value;
  const total = Math.max(0, space.total_bytes);
  const used = Math.max(0, space.used_bytes);
  const fraction = total === 0 ? 0 : used / total;
  const percent = Math.round(fraction * 100);
  const details = el(
    "div",
    { class: "settings__disk" },
    meter(fraction, `${percent}% used`),
    el(
      "p",
      { class: "settings__disk-line" },
      `Used ${formatBytes(used)} · Free ${formatBytes(space.free_bytes)} of ${formatBytes(total)} · runs ${formatBytes(space.runs_bytes)}`,
    ),
    el("p", { class: "settings__path" }, "Data path ", el("code", {}, space.path)),
  );
  if (!space.low) return section("Disk", [details]);
  return section("Disk", [
    alarm({
      status: "failed",
      lead: "Disk almost full",
      text: `${formatBytes(space.free_bytes)} free of ${formatBytes(total)}.`,
    }),
    details,
  ]);
}

function withoutSecret(token: CreatedToken): TokenInfo {
  return {
    id: token.id,
    name: token.name,
    scope: token.scope,
    created_at: token.created_at,
    last_used: token.last_used,
  };
}

// BASHR-62: candidate for ui.ts — ui.ts has the confirmation dialog but no general Dialog component.
/**
 * The new-token dialog. It has two faces — the form, then the one answer that carries the secret — and
 * closing either of them forgets the secret: it is never in a screen variable after the dialog is
 * gone, and the next dialog starts from an empty field.
 */
function openNewToken(options: { onCreated: (token: CreatedToken) => void }): void {
  let scope: "read" | "write" = "read";
  let secretBox: HTMLInputElement | null = null;
  let disposed = false;
  let busy = false;
  const dialog = el("dialog", { class: "dialog", "aria-labelledby": "settings-token-title" });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (secretBox !== null) secretBox.value = "";
    secretBox = null;
    if (dialog.open) dialog.close();
    removeNode(dialog);
  };
  dialog.addEventListener("close", dispose);
  // Escape is a close too, and it must not take the dialog away before the server's answer — which is
  // the only time the secret is shown — has had a chance to land.
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });

  const name = el("input", {
    id: "settings-token-name",
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
  });
  const error = el("div", { class: "settings__dialog-error" });
  const access = segmented("Access", ["read", "write"], scope, (value) => {
    scope = value === "write" ? "write" : "read";
  });
  const submit = button("Create token", { primary: true, onClick: () => void create() }) as HTMLButtonElement;
  const cancel = button("Cancel", {
    onClick: () => {
      if (!busy) dispose();
    },
  }) as HTMLButtonElement;

  async function copy(secret: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      announce("Token copied.");
    } catch {
      // A browser that refuses the clipboard still has a selectable box, and a person can copy that.
      secretBox?.focus();
      secretBox?.select();
    }
  }

  function show(created: CreatedToken): void {
    secretBox = el("input", {
      id: "settings-token-secret",
      type: "text",
      readonly: true,
      class: "settings__secret",
      value: created.token,
    });
    dialog.replaceChildren(
      el(
        "div",
        { class: "dialog__body" },
        el("h2", { class: "dialog__title", id: "settings-token-title" }, "Token created"),
        el(
          "div",
          { class: "field" },
          el("label", { class: "label", for: "settings-token-secret" }, "Token"),
          el("div", { class: "row" }, secretBox, button("Copy", { onClick: () => void copy(created.token) })),
        ),
        el("p", { class: "dialog__help" }, "This is the only time it is shown."),
        el(
          "div",
          { class: "dialog__actions" },
          button("Close", { onClick: dispose }),
        ),
      ),
    );
    secretBox.focus();
    secretBox.select();
  }

  async function create(): Promise<void> {
    error.replaceChildren();
    busy = true;
    submit.disabled = true;
    cancel.disabled = true;
    try {
      const created = await api.createToken(name.value.trim(), scope);
      options.onCreated(created);
      show(created);
      announce(`Token ${created.name} created.`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        busy = false;
        dispose();
        return;
      }
      error.replaceChildren(errorBox(problem(caught)));
    } finally {
      busy = false;
      submit.disabled = false;
      cancel.disabled = false;
    }
  }

  const form = el(
    "form",
    {
      class: "settings__dialog-form",
      onsubmit: (event) => {
        event.preventDefault();
        void create();
      },
    },
    el(
      "div",
      { class: "field" },
      el("label", { class: "label", for: "settings-token-name" }, "Name"),
      name,
    ),
    el(
      "div",
      { class: "field" },
      el("span", { class: "label" }, "Access"),
      access,
    ),
    error,
    el(
      "div",
      { class: "dialog__actions" },
      cancel,
      submit,
    ),
  );

  dialog.replaceChildren(
    el(
      "div",
      { class: "dialog__body" },
      el("h2", { class: "dialog__title", id: "settings-token-title" }, "New token"),
      form,
    ),
  );
  document.body.append(dialog);
  dialog.showModal();
  name.focus();
}

function tokenColumns(revoke: (token: TokenInfo) => void): TableColumn<TokenInfo>[] {
  return [
    { header: "Name", cell: (token) => token.name },
    { header: "Access", cell: (token) => typeStamp(token.scope) },
    { header: "Created", cell: (token) => tokenTime(token.created_at) },
    {
      header: "Last used",
      cell: (token) => (token.last_used === null ? "never" : tokenTime(token.last_used)),
    },
    {
      header: "",
      label: "Actions",
      align: "right",
      cell: (token) =>
        button("Revoke", {
          ariaLabel: `Revoke ${token.name}`,
          onClick: () => revoke(token),
        }),
    },
  ];
}

async function revokeToken(token: TokenInfo, done: () => void, failed: (error: unknown) => void): Promise<void> {
  const confirmed = await confirmDialog({
    title: `Revoke ${token.name}?`,
    text: "Anything signing in with this token stops working.",
    confirmLabel: "Revoke",
  });
  if (!confirmed) return;
  try {
    await api.revokeToken(token.id);
    done();
    announce(`Token ${token.name} revoked.`);
  } catch (caught) {
    failed(caught);
  }
}

export async function renderSettings(view: HTMLElement, _route: Route, signal: AbortSignal): Promise<void> {
  const identity = session.identity;
  if (identity === null) {
    view.replaceChildren(
      errorBox({ code: "unauthenticated", message: "There is no token to show settings for." }),
    );
    return;
  }

  const admin = identity.admin;
  const [health, disk, tokenRead] = await Promise.all([
    read(api.health()),
    read(api.disk()),
    admin ? read(api.tokens()) : Promise.resolve(null),
  ]);
  if (signal.aborted) return;

  let tokens: TokenInfo[] = tokenRead !== null && tokenRead.ok ? tokenRead.value : [];
  const tokenError = el("div");
  const tokenTable = el("div", { class: "settings__tokens" });

  function paintTokens(): void {
    const columns = tokenColumns((token) =>
      void revokeToken(
        token,
        () => {
          tokens = tokens.filter((entry) => entry.id !== token.id);
          tokenError.replaceChildren();
          paintTokens();
        },
        (caught) => tokenError.replaceChildren(errorBox(problem(caught))),
      ),
    );
    tokenTable.replaceChildren(table(columns, tokens, { empty: "No agent tokens yet." }));
  }

  const tokenAction = button("New token", {
    onClick: () =>
      openNewToken({
        onCreated: (created) => {
          tokens = [...tokens, withoutSecret(created)];
          tokenError.replaceChildren();
          paintTokens();
        },
      }),
  });

  const tokenBody: Child[] = [tokenError];
  if (tokenRead !== null && !tokenRead.ok) {
    tokenError.append(errorBox(problem(tokenRead.error)));
  } else {
    paintTokens();
    tokenBody.push(tokenTable);
  }

  const header = pageHeader({ title: "Settings" });
  view.replaceChildren(
    el(
      "div",
      { class: "settings" },
      header,
      identitySection(identity),
      serverSection(health),
      diskSection(disk),
      admin ? section("Tokens", tokenBody, tokenAction) : null,
    ),
  );
}
