// The gap between "the process started" and "the socket is listening" is where a container dies
// quietly. Building the API touches the filesystem — the store makes its directory and opens SQLite,
// the engine makes its run root — and a data directory the uid cannot write throws there, before
// anything can answer a probe. A preview deployment gets one URL out of that, so a server whose API
// could not be built still listens and says what failed at `/healthz` instead of refusing the
// connection. SPEC 1.5.

import { createApi } from "./app.ts";
import type { Api } from "./app.ts";
import type { ApiConfig } from "./config.ts";

/** Bun's server type is generic over its websocket data, so it is taken from the call that makes it. */
type Bound = ReturnType<typeof bind>;

function bind(port: number, handle: (request: Request) => Response | Promise<Response>) {
  return Bun.serve({ port, fetch: handle });
}

export interface Startup {
  server: Bound;
  /** Null when the API could not be built, in which case only `/healthz` answers anything. */
  api: Api | null;
  /** Why `api` is null, already reduced to one line. Null when everything came up. */
  problem: string | null;
}

export interface StartupOptions {
  config: ApiConfig;
  log?: (line: string) => void;
  /** Replaced in tests. The real one is `createApi`, which is where the filesystem gets touched. */
  build?: (config: ApiConfig, log: (line: string) => void) => Api;
}

/** Binds the socket, with the API if it could be built and a degraded answer if it could not. */
export function startServer(options: StartupOptions): Startup {
  const log = options.log ?? ((line: string) => console.log(line));
  const build =
    options.build ?? ((config: ApiConfig, logger: (line: string) => void) => createApi({ config, log: logger }));

  let handle: (request: Request) => Response | Promise<Response>;
  let api: Api | null = null;
  let problem: string | null = null;
  try {
    const built = build(options.config, log);
    api = built;
    handle = (request) => built.fetch(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    problem = reason;
    log(`bashreactor: degraded, the API could not start: ${reason}`);
    handle = (request) => degraded(request, options.config.version, reason);
  }

  const server = bind(options.config.port, handle);
  log(`bashreactor listening on :${server.port}`);
  return { server, api, problem };
}

/**
 * `/healthz` stays 200 while degraded on purpose: the probe is the only way into a container that
 * will not come up, and a failing status hides the reason behind it. Everything else answers the
 * SPEC 5 error object at 503, which is what the error table already says a broken server owes.
 */
function degraded(request: Request, version: string, problem: string): Response {
  if (request.method === "GET" && new URL(request.url).pathname === "/healthz") {
    return Response.json({ status: "degraded", version, problem });
  }
  return Response.json(
    { code: "runtime_missing", message: `bashreactor could not start: ${problem}` },
    { status: 503 },
  );
}

export interface SignalOptions {
  log?: (line: string) => void;
  /** Replaced in tests. The real one ends the process. */
  exit?: (code: number) => void;
}

/**
 * SPEC 4.7, graceful shutdown, for both entry points. A container's PID 1 gets no default signal
 * handling, so without handlers every rollout would wait out the pod's whole termination grace
 * period and then SIGKILL the engine with blocks still running and `lock` files behind.
 *
 * The first SIGTERM or SIGINT stops the listener and the engine: no step starts, running attempts get
 * their `kill_grace`, their runs stay `running` for the next process. The second skips the grace and
 * kills them at once, which still leaves the run directories as the first would. The third gives up
 * and exits 1, so a hung store can never make the process unkillable by a terminal.
 */
export function stopOnSignals(startup: Startup, options: SignalOptions = {}): void {
  const log = options.log ?? ((line: string) => console.log(line));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let received = 0;

  const onSignal = (signal: NodeJS.Signals): void => {
    received += 1;
    if (received === 1) {
      log(`bashreactor: ${signal}, stopping; running blocks get their kill_grace`);
      void stop(startup).then(
        () => exit(0),
        (error: unknown) => {
          log(`bashreactor: shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
          exit(1);
        },
      );
    } else if (received === 2) {
      log(`bashreactor: ${signal} again, killing running blocks now`);
      void startup.api?.engine.shutdown();
      void startup.server.stop(true);
    } else {
      exit(1);
    }
  };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

async function stop(startup: Startup): Promise<void> {
  // The engine goes first so that a request still being served cannot start a step on the way out.
  const engine = startup.api?.engine.shutdown();
  await Promise.all([engine, startup.server.stop()]);
  startup.api?.close();
}
