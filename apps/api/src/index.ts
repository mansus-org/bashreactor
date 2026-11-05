import { BashreactorError, NotImplementedError } from "@bashreactor/core";

const DEFAULT_PORT = 8080;

export function createHandler(options: { version: string }): (request: Request) => Response {
  return (request) => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/healthz") {
      return Response.json({ status: "ok", version: options.version });
    }
    const body = new NotImplementedError(`${request.method} ${pathname}`).toBody();
    return Response.json(body, { status: 501 });
  };
}

export function resolvePort(env: Record<string, string | undefined>): number {
  const raw = env.PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new BashreactorError("runtime_missing", `PORT must be an integer from 0 to 65535, got "${raw}"`);
  }
  return port;
}

// The image sets BASHREACTOR_VERSION to the tag it was built as. An image built by hand leaves it empty,
// and then the manifest's version is the honest answer.
export function resolveVersion(env: Record<string, string | undefined>, fallback: string): string {
  return env.BASHREACTOR_VERSION || fallback;
}
