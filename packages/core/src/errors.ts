export type ErrorCode = "not_implemented" | "invalid_block" | "invalid_pipeline" | "invalid_config";

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

// One shape on purpose: the CLI, the API and the MCP server all print toBody(), so a code seen in one
// surface means the same thing in the others.
export class BashreactorError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "BashreactorError";
    this.code = code;
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

export class NotImplementedError extends BashreactorError {
  constructor(what: string) {
    super("not_implemented", `${what} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}
