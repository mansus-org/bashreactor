// What the visitor's URL really was, once a proxy has had its say.
//
// The cluster ends TLS at Traefik and hands the request to the pod over plain http, so
// `request.url` inside the pod says `http://` and every redirect built from it — `/` to `/app/` in
// the API, `/app` to `/app/` here — tells the browser to go to port 80, which the platform's
// routers are not listening on (`router.entrypoints: websecure`). Following one lands on a bare
// 404, so the site reads as down from the URL in the README. The proxy says what the visitor used
// in `X-Forwarded-Proto`, and this is the one place that reads it, so nothing downstream has to
// know it is behind anything.
//
// Only the scheme is taken, never `X-Forwarded-Host`: the host already arrives correctly in the
// `Host` header, and honouring a header a client can set would turn two redirects into an open
// redirect the moment the process runs without a proxy in front of it.

/** The first value of a comma-separated forwarded header, which is the client's own. */
function firstValue(header: string | null): string | undefined {
  const value = header?.split(",")[0]?.trim();
  return value === "" ? undefined : value;
}

/**
 * The request with its original scheme put back, or the request itself when there is nothing to fix.
 *
 * GET and HEAD only: a redirect is the only thing that reads the URL, and rebuilding a request that
 * carries a body would mean streaming that body again for nothing.
 */
export function withForwardedScheme(request: Request): Request {
  if (request.method !== "GET" && request.method !== "HEAD") return request;

  const scheme = firstValue(request.headers.get("x-forwarded-proto"));
  if (scheme !== "http" && scheme !== "https") return request;

  const url = new URL(request.url);
  if (url.protocol === `${scheme}:`) return request;
  url.protocol = scheme;
  return new Request(url.href, request);
}
