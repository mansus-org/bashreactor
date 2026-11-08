import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { HELLO_BLOCK, blockFile, startApi } from "./helpers.ts";

const server = startApi();
afterAll(() => server.cleanup());

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

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

  test("the library lists every name it holds, newest version and count included", async () => {
    const other = blockFile(
      "other-block",
      `name: other-block
description: Nothing at all.
inputs: {}
outputs:
  result:
    type: string`,
      `printf 'ok' > "$OUTPUT_RESULT"`,
    );
    expect((await server.call("POST", "/v1/blocks/other-block/versions", { body: { content: other.content } })).status).toBe(201);

    const listed = await body(await server.call("GET", "/v1/blocks"));
    const entries = listed.blocks as Record<string, unknown>[];
    const hello = entries.find((entry) => entry.name === "hello");
    expect(hello).toEqual({ name: "hello", latest: 2, versions: 2 });
    // In order by name, so two calls answer the same list and a client can page its own way through it.
    expect(entries.indexOf(hello!)).toBeLessThan(entries.findIndex((entry) => entry.name === "other-block"));
    // Names and counts, never the source: the bytes are one request per block, not a dump of the library.
    expect(JSON.stringify(listed)).not.toInclude("#!/usr/bin/env bash");
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

  // SPEC 2: the identity of a version is the SHA-256 of the file's exact bytes, and SPEC 2.2: the
  // body is opaque bytes. A file that is not valid UTF-8 used to be rewritten on the way in, so the
  // hash on the record was not the hash of the file that was uploaded. `content_b64` carries it whole.
  test("content_b64 stores a file that is not valid UTF-8, byte for byte", async () => {
    const bytes = Buffer.concat([
      Buffer.from(
        `#!/usr/bin/env bash\n# ---\n# name: binbody\n# description: Ends with bytes no terminal can show.\n# ---\n\necho hi\n: "`,
      ),
      Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3]),
      Buffer.from(`"\n`),
    ]);
    // A rewrite would be invisible unless it changed something: this is what the old path did to it.
    expect(sha256(bytes)).not.toBe(sha256(Buffer.from(new TextDecoder().decode(bytes))));

    const created = await server.call("POST", "/v1/blocks/binbody/versions", {
      body: { content_b64: bytes.toString("base64") },
    });
    expect(created.status).toBe(201);
    const record = await body(created);
    expect(record.sha256).toBe(sha256(bytes));
    expect(record.size).toBe(bytes.length);

    const content = await server.call("GET", "/v1/blocks/binbody/1/content");
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer()).equals(bytes)).toBe(true);
  });

  test("content and content_b64 are one file either way", async () => {
    const twin = blockFile("twin", `name: twin\ndescription: The same file, sent two ways.`, "echo twin");
    const asText = await body(await server.call("POST", "/v1/blocks/twin/versions", { body: { content: twin.content } }));
    const asBytes = await body(
      await server.call("POST", "/v1/blocks/twin/versions", {
        body: { content_b64: Buffer.from(twin.content, "utf8").toString("base64") },
      }),
    );
    // The same bytes are the same version (SPEC 3.4), whichever field they came in on.
    expect(asBytes).toMatchObject({ version: 1, sha256: asText.sha256 });
  });

  test("a body that cannot say which bytes to store is 422", async () => {
    const both = await server.call("POST", "/v1/blocks/x/versions", { body: { content: "a", content_b64: "YQ==" } });
    expect(both.status).toBe(422);
    expect(await body(both)).toMatchObject({ code: "unknown_input" });

    const junk = await server.call("POST", "/v1/blocks/x/versions", { body: { content_b64: "not base64!!" } });
    expect(junk.status).toBe(422);
    expect(await body(junk)).toMatchObject({ code: "type_mismatch", path: "content_b64" });
  });

  // SPEC 2.2: the header must be valid UTF-8 and the rest of the file is opaque, so a body of raw
  // bytes must not be allowed to hide a header that is not.
  test("a header that is not valid UTF-8 is refused, whatever the body is", async () => {
    const bytes = Buffer.concat([
      Buffer.from("#!/usr/bin/env bash\n# ---\n# name: bad"),
      Buffer.from([0xff, 0xfe]),
      Buffer.from("\n# ---\necho hi\n"),
    ]);
    const response = await server.call("POST", "/v1/blocks/badheader/versions", {
      body: { content_b64: bytes.toString("base64") },
    });
    expect(response.status).toBe(422);
    expect(await body(response)).toMatchObject({ code: "block_header_malformed" });
    expect((await server.call("GET", "/v1/blocks/badheader")).status).toBe(404);
  });
});
