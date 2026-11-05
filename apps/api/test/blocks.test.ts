import { afterAll, describe, expect, test } from "bun:test";
import { HELLO_BLOCK, blockFile, startApi } from "./helpers.ts";

const server = startApi();
afterAll(() => server.cleanup());

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("the block library", () => {
  test("creating a version stores it and answers with its metadata", async () => {
    const created = await server.call("POST", "/v1/blocks/hello/versions", { body: { content: HELLO_BLOCK.content } });
    expect(created.status).toBe(201);
    const record = await body(created);
    expect(record.name).toBe("hello");
    expect(record.version).toBe(1);
    expect(record.sha256).toBeString();
    expect(record.size).toBe(HELLO_BLOCK.content.length);
    expect(record.created_at).toStartWith("20");
  });

  test("the same bytes are the same version, and a change is the next one", async () => {
    const again = await server.call("POST", "/v1/blocks/hello/versions", { body: { content: HELLO_BLOCK.content } });
    expect(((await body(again)).version as number)).toBe(1);

    const changed = blockFile(
      "hello",
      `name: hello
description: Say hello, now with a shout.
inputs:
  name:
    type: string
    default: world
outputs:
  greeting:
    type: string
  bytes:
    type: integer`,
      `echo "HELLO $INPUT_NAME"\nprintf 'hello %s' "$INPUT_NAME" > "$OUTPUT_GREETING"\nwc -c < "$OUTPUT_GREETING" > "$OUTPUT_BYTES"`,
    );
    const next = await server.call("POST", "/v1/blocks/hello/versions", { body: { content: changed.content } });
    expect(next.status).toBe(201);
    expect(((await body(next)).version as number)).toBe(2);
  });

  test("listing a block gives every version and names the latest", async () => {
    const listed = await body(await server.call("GET", "/v1/blocks/hello"));
    expect(listed.name).toBe("hello");
    expect(listed.latest).toBe(2);
    expect((listed.versions as Record<string, unknown>[]).map((entry) => entry.version)).toEqual([1, 2]);
  });

  test("one version is readable by number, and by latest", async () => {
    const one = await body(await server.call("GET", "/v1/blocks/hello/1"));
    expect(one.version).toBe(1);
    const latest = await body(await server.call("GET", "/v1/blocks/hello/latest"));
    expect(latest.version).toBe(2);
  });

  test("the content route gives the exact bytes back", async () => {
    const third = blockFile(
      "hello",
      `name: hello
description: Third version.
inputs:
  name:
    type: string
    default: world
outputs:
  greeting:
    type: string`,
      `printf 'hello %s' "$INPUT_NAME" > "$OUTPUT_GREETING"`,
    );
    const created = await server.call("POST", "/v1/blocks/hello/versions", { body: { content: third.content } });
    expect(((await body(created)).version as number)).toBe(3);

    const response = await server.call("GET", "/v1/blocks/hello/3/content");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/plain");
    expect(await response.text()).toBe(third.content);
  });

  test("a block or version that is not there is 404", async () => {
    expect((await server.call("GET", "/v1/blocks/nope")).status).toBe(404);
    expect((await server.call("GET", "/v1/blocks/nope/latest")).status).toBe(404);
    expect((await server.call("GET", "/v1/blocks/hello/9")).status).toBe(404);
    expect((await server.call("GET", "/v1/blocks/hello/9/content")).status).toBe(404);
  });

  test("a block whose header is broken is 422 and is not stored", async () => {
    const broken = "#!/usr/bin/env bash\n# ---\n# name: [oops\n# ---\n\necho hi\n";
    const response = await server.call("POST", "/v1/blocks/oops/versions", { body: { content: broken } });
    expect(response.status).toBe(422);
    expect(await body(response)).toMatchObject({ code: "block_header_malformed" });
    expect((await server.call("GET", "/v1/blocks/oops")).status).toBe(404);
  });

  test("a block that does not declare the name it is filed under is 422", async () => {
    const mismatch = blockFile("other", `name: other\ndescription: Not the one.`, "echo hi");
    const response = await server.call("POST", "/v1/blocks/renamed/versions", { body: { content: mismatch.content } });
    expect(response.status).toBe(422);
    expect(await body(response)).toMatchObject({ code: "block_schema_invalid", path: "name" });
  });

  test("a name that breaks the spec's rule is 422 before the store is asked", async () => {
    const response = await server.call("POST", "/v1/blocks/Not_A_Name/versions", { body: { content: HELLO_BLOCK.content } });
    expect(response.status).toBe(422);
    expect(await body(response)).toMatchObject({ code: "block_schema_invalid", path: "name" });
  });

  test("content is required and must be a string", async () => {
    expect((await server.call("POST", "/v1/blocks/x/versions", { body: {} })).status).toBe(422);
    const wrong = await server.call("POST", "/v1/blocks/x/versions", { body: { content: 42 } });
    expect(wrong.status).toBe(422);
    expect(await body(wrong)).toMatchObject({ code: "type_mismatch", path: "content" });
  });
});
