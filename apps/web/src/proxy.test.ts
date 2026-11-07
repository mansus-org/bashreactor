import { expect, test } from "bun:test";
import { withForwardedScheme } from "./proxy.ts";

function get(path = "/app", headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:8080${path}`, { headers });
}

test("the scheme the visitor used survives the hop to the pod", () => {
  const fixed = withForwardedScheme(get("/app", { "x-forwarded-proto": "https" }));
  expect(fixed.url).toBe("https://127.0.0.1:8080/app");
  expect(fixed.method).toBe("GET");
});

test("a chain of proxies is read from the client's own hop", () => {
  const fixed = withForwardedScheme(get("/", { "x-forwarded-proto": "https, http" }));
  expect(fixed.url).toBe("https://127.0.0.1:8080/");
});

test("nothing changes when no proxy said anything, or said something that is not a scheme", () => {
  const request = get("/");
  expect(withForwardedScheme(request)).toBe(request);
  const nonsense = get("/", { "x-forwarded-proto": "gopher" });
  expect(withForwardedScheme(nonsense)).toBe(nonsense);
});

test("a host a client claims is not believed, because it would be an open redirect", () => {
  const fixed = withForwardedScheme(get("/", { "x-forwarded-proto": "https", "x-forwarded-host": "evil.example" }));
  expect(fixed.url).toBe("https://127.0.0.1:8080/");
});

test("a request that carries a body is handed back untouched", () => {
  const post = new Request("http://127.0.0.1:8080/v1/runs", {
    method: "POST",
    headers: { "x-forwarded-proto": "https" },
    body: "{}",
  });
  expect(withForwardedScheme(post)).toBe(post);
});
