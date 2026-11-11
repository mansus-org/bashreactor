// Fills a running server with a small library and runs in every status a screen has to draw: the
// worked example succeeding and failing, a step that needed a second attempt, a run still working,
// one cancelled half way, and one whose step waits ten minutes for a retry. The screens are judged
// against this, so it has to look like a server somebody uses, not like one test fixture.
//
//   BASHREACTOR_URL=http://127.0.0.1:8080 BASHREACTOR_TOKEN=br_demo_admin bun apps/web/scripts/seed.ts

import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const fixtures = join(import.meta.dir, "fixtures");

export interface Seeded {
  succeeded: string;
  failed: string;
  retried: string;
  running: string;
  cancelled: string;
  waiting: string;
}

export async function seed(url: string, token: string): Promise<Seeded> {
  const cli = async (...args: string[]): Promise<void> => {
    const child = Bun.spawn(["bun", join(root, "apps/cli/src/bin.ts"), ...args], {
      env: { ...process.env, BASHREACTOR_URL: url, BASHREACTOR_TOKEN: token },
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await child.exited) !== 0) {
      throw new Error(`bashreactor ${args.join(" ")}: ${await new Response(child.stderr).text()}`);
    }
  };
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    return text === "" ? null : JSON.parse(text);
  };
  const start = async (pipeline: string, inputs: Record<string, unknown> = {}): Promise<string> =>
    (await call("POST", "/v1/runs", { pipeline, inputs })).id;
  const settle = async (id: string, seconds = 120): Promise<void> => {
    for (let i = 0; i < seconds * 10; i++) {
      if ((await call("GET", `/v1/runs/${id}`)).status !== "running") return;
      await Bun.sleep(100);
    }
    throw new Error(`run ${id} is still running after ${seconds} s`);
  };
  const reached = async (id: string, step: string, status: string): Promise<void> => {
    for (let i = 0; i < 600; i++) {
      if ((await call("GET", `/v1/runs/${id}`)).steps[step]?.status === status) return;
      await Bun.sleep(100);
    }
    throw new Error(`step ${step} of run ${id} never became ${status}`);
  };

  // `pipelines add` publishes every `./x.sh` next to the file into the library first, the way a
  // person with a checkout stores a pipeline.
  await cli("pipelines", "add", "word-report", join(root, "docs/examples/word-report.yaml"));
  for (const name of ["nightly-sync", "daily-export", "upstream-wait"]) {
    await cli("pipelines", "add", name, join(fixtures, `${name}.yaml`));
  }

  const succeeded = await start("word-report");
  await settle(succeeded);
  const failed = await start("word-report", { lines: 50 });
  await settle(failed);
  const retried = await start("daily-export");
  await settle(retried);
  const second = await start("word-report", { seed: 11, title: "Weekly words" });
  await settle(second);
  const synced = await start("nightly-sync", { seconds: 6 });
  await settle(synced);

  const cancelled = await start("nightly-sync", { seconds: 600 });
  await reached(cancelled, "transform", "running");
  await call("POST", `/v1/runs/${cancelled}/cancel`);
  await settle(cancelled);

  const waiting = await start("upstream-wait");
  await reached(waiting, "probe", "waiting_retry");
  const running = await start("nightly-sync", { seconds: 900 });
  await reached(running, "transform", "running");

  return { succeeded, failed, retried, running, cancelled, waiting };
}

if (import.meta.main) {
  const url = process.env.BASHREACTOR_URL;
  const token = process.env.BASHREACTOR_TOKEN;
  if (url === undefined || token === undefined) {
    console.error("set BASHREACTOR_URL and BASHREACTOR_TOKEN first; examples/serve.sh prints both");
    process.exit(2);
  }
  console.log(JSON.stringify(await seed(url.replace(/\/$/, ""), token), null, 2));
}
