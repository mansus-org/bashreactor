// The Start dialog: a pipeline's declared inputs become controls that send each value in the type it
// declares, and the page that opened it says how to name the run on the wire and where to go once it
// starts. The editor is the first caller; a pipeline page can be another without knowing its
// internals.

import { api, ApiError } from "./api.js";
import type { Run } from "./api.js";
import { el, errorBox } from "./dom.js";
import type { Json } from "./yaml.js";

export type Reading = { ok: true; value: Json | undefined } | { ok: false; message: string };

// SPEC 1.2, text form. A value is sent in the type its input declares, and the text only has to be
// something that type can be read from: how it looks decides nothing.
export const INTEGER = /^-?(0|[1-9][0-9]*)$/;
const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

/** What a number or json field's text means, or the sentence that says why it means nothing. */
export function parseTyped(type: string, name: string, text: string): Reading {
  const raw = text.trim();
  if (type === "integer") {
    return INTEGER.test(raw) && Number.isSafeInteger(Number(raw))
      ? { ok: true, value: Number(raw) }
      : { ok: false, message: `${name} is an integer: type a whole number such as 42.` };
  }
  if (type === "number") {
    return NUMBER.test(raw) && Number.isFinite(Number(raw))
      ? { ok: true, value: Number(raw) }
      : { ok: false, message: `${name} is a number: type a figure such as 3.5.` };
  }
  if (type === "json") {
    try {
      return { ok: true, value: JSON.parse(raw) as Json };
    } catch (error) {
      return { ok: false, message: `${name} is JSON, and this is not: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true, value: text };
}

/** The empty value of a type, for a typed field that has no default to start from. */
export function blankOf(type: string): Json {
  return type === "integer" || type === "number" ? 0 : type === "boolean" ? false : type === "json" ? null : "";
}

/**
 * Whether `editStep` writes this value into the YAML faithfully. It prints an object as
 * `[object Object]` and does not quote a comma inside a list item, so only a scalar, or a list of
 * plain ones, goes through it.
 */
export function writable(value: Json): boolean {
  if (Array.isArray(value)) {
    return value.every((item) => item === null || typeof item === "number" || typeof item === "boolean" || (typeof item === "string" && /^[\w .-]*$/.test(item)));
  }
  return value === null || typeof value !== "object";
}

const HINTS: Record<string, string> = {
  integer: "A whole number.",
  number: "A number.",
  json: "JSON. It is sent as JSON, so text that is not JSON is not sent.",
  file: "An absolute path to a file on the server this runs on. The engine copies it into the run.",
};

/**
 * One field of the Start dialog. It remembers what it was drawn with, and `read` answers `undefined`
 * for a field that still holds that, so a default nobody touched is not sent and runs as declared.
 */
function startField(input: StartRunInput): { node: HTMLElement; control: HTMLElement; read: () => Reading } {
  // Not `start-<name>`: an input called `title` would take the id of the dialog's own heading.
  const id = `start-in-${input.name}`;
  const helpText = [input.description, HINTS[input.type] ?? ""].filter((part) => part !== "").join(" ");
  const help = helpText !== "" ? el("p", { class: "help", id: `${id}-help` }, helpText) : null;
  const describedBy = help !== null ? `${id}-help` : null;
  const needsValue: Reading = { ok: false, message: `${input.name} has no default, so this run needs a value for it.` };
  const untouched: Reading = { ok: true, value: undefined };

  if (input.type === "boolean") {
    const declared = input.default === true;
    const box = el("input", { id, type: "checkbox", "aria-describedby": describedBy });
    box.checked = declared;
    return {
      node: el("div", { class: "field" }, el("label", { class: "check" }, box, el("span", {}, input.name)), help),
      control: box,
      // A checkbox always has an answer, so one with no default has to send it.
      read: () => (!input.required && box.checked === declared ? untouched : { ok: true, value: box.checked }),
    };
  }

  const initial = input.type === "json" ? (input.required ? "" : JSON.stringify(input.default, null, 2)) : input.default === null ? "" : String(input.default);
  const control: HTMLInputElement | HTMLTextAreaElement =
    input.type === "json"
      ? el("textarea", { id, class: "code", rows: 6, spellcheck: "false", autocomplete: "off", "aria-describedby": describedBy })
      : el("input", {
          id,
          type: "text",
          inputmode: input.type === "integer" ? "numeric" : input.type === "number" ? "decimal" : null,
          placeholder: input.type === "file" ? "/absolute/path/on/the/server" : null,
          spellcheck: "false",
          autocomplete: "off",
          "aria-describedby": describedBy,
        });
  control.value = initial;
  return {
    node: el("div", { class: "field" }, el("label", { class: "label", for: id }, input.name), control, help),
    control,
    read: () => {
      const raw = control.value;
      const text = input.type === "string" || input.type === "file" ? raw : raw.trim();
      if (text === "" && input.required) return needsValue;
      if (raw === initial) return untouched;
      if (input.type === "file") {
        return raw.startsWith("/") ? { ok: true, value: raw } : { ok: false, message: `${input.name} is a file: give the absolute path to it on the server, starting with /.` };
      }
      return parseTyped(input.type, input.name, raw);
    },
  };
}

export interface StartRunInput {
  name: string;
  type: string;
  default: Json;
  description: string;
  required: boolean;
}

export interface StartRunOptions {
  /** The pipeline's name, as the dialog's heading says it. */
  name: string;
  inputs: readonly StartRunInput[];
  /** The one line under the fields, saying what this Start will actually run. */
  help: string;
  /** The POST body: a stored pipeline by name and version, or the YAML as it stands. */
  body: (inputs: Record<string, unknown>) => { pipeline?: string; version?: number; yaml?: string; inputs?: Record<string, unknown> };
  /** What to do once the server has started the run. */
  started: (run: Run) => void;
  /** The page's own starting state, told again with false when the request fails. */
  sending?: (sending: boolean) => void;
}

/**
 * Fill `dialog` with the Start form and open it. Every value is read at submit time, so a default
 * nobody touched is not sent and runs as declared. A refusal from the API stays in the dialog, in
 * the server's own words, because that is where the person is looking.
 */
export function openStartRun(dialog: HTMLDialogElement, options: StartRunOptions): void {
  const error = el("p", { class: "form-error", role: "alert", hidden: true });
  const fields = options.inputs.map((input) => ({ input, ...startField(input) }));

  async function start(inputs: Record<string, unknown>): Promise<void> {
    dialog.close();
    options.sending?.(true);
    try {
      const run = await api.startRun(options.body(inputs));
      options.started(run);
    } catch (caught) {
      options.sending?.(false);
      dialog.replaceChildren(
        errorBox(
          caught instanceof ApiError ? caught : { code: "internal_error", message: String(caught) },
          el("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Close"),
        ),
      );
      dialog.showModal();
    }
  }

  dialog.replaceChildren(
    el(
      "form",
      {
        class: "dialog__body",
        onsubmit: (event) => {
          event.preventDefault();
          error.hidden = true;
          const inputs: Record<string, unknown> = {};
          for (const field of fields) {
            const reading = field.read();
            if (!reading.ok) {
              error.hidden = false;
              error.textContent = reading.message;
              field.control.focus();
              return;
            }
            if (reading.value !== undefined) inputs[field.input.name] = reading.value;
          }
          void start(inputs);
        },
      },
      el("h2", { class: "dialog__title", id: "start-title" }, `Start ${options.name}`),
      fields.length > 0 ? fields.map((field) => field.node) : el("p", {}, "This pipeline takes no inputs."),
      el("p", { class: "help" }, options.help),
      error,
      el(
        "div",
        { class: "row" },
        el("button", { class: "btn btn--ink", type: "submit" }, "Start the run"),
        el("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
      ),
    ),
  );
  dialog.showModal();
}
