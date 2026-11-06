#!/usr/bin/env bash
# ---
# name: fetch-pages
# description: Download several web pages and keep the readable text of each, one URL failing on its own.
# inputs:
#   urls:
#     type: string
#     description: The pages to read, one URL per line. Blank lines and lines starting with # are ignored.
#   min_words:
#     type: integer
#     description: A page with fewer readable words than this is reported as failed, not kept.
#     default: 20
# outputs:
#   pages:
#     type: file
#     description: One JSON object per readable page with url, title and text.
#   statuses:
#     type: file
#     description: One JSON object per requested URL with url, status (ok or failed), reason, http and words.
#   ok_count:
#     type: integer
#     description: How many URLs were read.
#   failed_count:
#     type: integer
#     description: How many URLs failed for good.
# ---

# Only the standard library, so the same block runs on the Alpine image, where a native wheel may not
# exist for musl.
uv run --quiet --no-project --script - <<'PY'
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

MAX_BYTES = 10 * 1024 * 1024
VOID = {"br", "img", "hr", "meta", "link", "input", "source", "wbr", "col", "area", "base", "track", "embed", "param"}
# Elements whose text is page furniture or code, not prose.
SKIP_TAGS = {
    "script", "style", "noscript", "template", "svg", "math", "iframe", "canvas", "object",
    "nav", "header", "footer", "aside", "form", "button", "select", "dialog", "head",
}
# Class and id words that mark furniture on sites that use a div for it. Whole words only, so
# "article-header" does not match "header".
SKIP_WORDS = {
    "nav", "navbar", "navbox", "navigation", "menu", "sidebar", "cookie", "cookies", "breadcrumb",
    "breadcrumbs", "advert", "advertisement", "mw-editsection", "reflist", "toc", "hatnote", "noprint",
}
BLOCK_TAGS = {
    "p", "div", "section", "article", "main", "li", "ul", "ol", "dl", "dt", "dd", "br", "hr", "tr",
    "table", "blockquote", "pre", "figure", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "details", "summary",
}


class Page(HTMLParser):
    """Collect the visible text of a page, one block per line, and the text inside main/article apart."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, bool, bool]] = []
        self.skipping = 0
        self.mains = 0
        self.lines: list[str] = []
        self.main_lines: list[str] = []
        self.buffer: list[str] = []
        self.title: list[str] = []
        self.in_title = False

    def flush(self):
        text = " ".join("".join(self.buffer).split())
        self.buffer = []
        if text:
            self.lines.append(text)
            if self.mains:
                self.main_lines.append(text)

    def handle_starttag(self, tag, attrs):
        if tag in BLOCK_TAGS:
            self.flush()
        if tag == "title":
            self.in_title = True
        if tag in VOID:
            return
        attrs = dict(attrs)
        words = set(" ".join([attrs.get("class") or "", attrs.get("id") or ""]).lower().split())
        skip = (
            tag in SKIP_TAGS
            or bool(words & SKIP_WORDS)
            or attrs.get("role") in {"navigation", "banner", "contentinfo", "complementary"}
            or "hidden" in attrs
            or attrs.get("aria-hidden") == "true"
        )
        # A main or article inside furniture does not count as the page's body.
        counts = tag in {"main", "article"} and not skip and not self.skipping
        self.stack.append((tag, skip, counts))
        if skip:
            self.skipping += 1
        if counts:
            self.mains += 1

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag in BLOCK_TAGS:
            self.flush()
        # Pop back to the tag that closed, so one unclosed tag does not shift everything after it.
        if any(open_tag == tag for open_tag, _, _ in self.stack):
            while self.stack:
                open_tag, skip, counts = self.stack.pop()
                self.skipping -= skip
                self.mains -= counts
                if open_tag == tag:
                    break

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)
        elif not self.skipping:
            self.buffer.append(data)


def read_html(markup: str) -> tuple[str, str]:
    page = Page()
    page.feed(markup)
    page.close()
    page.flush()
    # A page that marks its article up gets only the article; one that does not gets everything visible.
    main_words = sum(len(line.split()) for line in page.main_lines)
    lines = page.main_lines if main_words >= 50 else page.lines
    return " ".join("".join(page.title).split()), "\n".join(lines)


class Failure(Exception):
    """A page that will not get better by being asked again."""


class Retry(Exception):
    """A failure the network may cure."""


def download(url: str) -> tuple[str, str]:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise Failure("not an http or https URL")
    request = urllib.request.Request(url, headers={"user-agent": "bashreactor-ingest/1.0", "accept": "text/html,text/plain,*/*;q=0.5"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read(MAX_BYTES + 1)
            content_type = response.headers.get_content_type()
            charset = response.headers.get_content_charset()
    except urllib.error.HTTPError as error:
        # 408 and 429 ask for patience, every other 4xx is the server's final word.
        if error.code in {408, 425, 429} or error.code >= 500:
            raise Retry(f"http {error.code}")
        raise Failure(f"http {error.code}") from error
    except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
        raise Retry(f"network: {getattr(error, 'reason', error)}")
    if len(body) > MAX_BYTES:
        raise Failure(f"larger than {MAX_BYTES} bytes")
    if charset is None:
        found = re.search(rb"<meta[^>]+charset=[\"']?([A-Za-z0-9_-]+)", body[:4096], re.I)
        charset = found.group(1).decode("ascii") if found else "utf-8"
    try:
        text = body.decode(charset, errors="replace")
    except LookupError:
        text = body.decode("utf-8", errors="replace")
    if content_type in {"text/html", "application/xhtml+xml"} or (
        content_type in {"application/octet-stream", ""} and re.match(r"\s*(<!doctype html|<html)", text[:200], re.I)
    ):
        return read_html(text)
    if content_type.startswith("text/") or content_type in {"application/json", "application/xml"}:
        return "", "\n".join(" ".join(line.split()) for line in text.splitlines() if line.strip())
    raise Failure(f"content type {content_type} is not text")


urls: list[str] = []
for line in os.environ["INPUT_URLS"].splitlines():
    line = line.strip()
    if line and not line.startswith("#") and line not in urls:
        urls.append(line)
if not urls:
    print("fetch-pages: no URLs given")
    raise SystemExit(78)
min_words = int(os.environ["INPUT_MIN_WORDS"])

# The work directory outlives a retry, so a page read in attempt 1 is not read again in attempt 2.
# Final failures are cached too: a 404 does not change between attempts.
os.makedirs("cache", exist_ok=True)
results: dict[str, dict] = {}
retry: list[str] = []
for url in urls:
    path = f"cache/{hashlib.sha256(url.encode()).hexdigest()[:24]}.json"
    if os.path.exists(path):
        with open(path, encoding="utf-8") as cached:
            results[url] = json.load(cached)
        print(f"attempt {os.environ['BR_ATTEMPT']}: {url}: from cache, {results[url]['status']}")
        continue
    try:
        title, text = download(url)
        words = len(text.split())
        if words < min_words:
            raise Failure(f"only {words} readable words, need {min_words}")
        result = {"url": url, "status": "ok", "reason": "", "http": 200, "title": title, "text": text, "words": words}
    except Failure as failure:
        reason = str(failure)
        http = int(reason.split()[1]) if reason.startswith("http ") else None
        result = {"url": url, "status": "failed", "reason": reason, "http": http, "title": "", "text": "", "words": 0}
    except Retry as problem:
        print(f"attempt {os.environ['BR_ATTEMPT']}: {url}: {problem}, will ask to be retried")
        retry.append(url)
        continue
    with open(path, "w", encoding="utf-8") as out:
        json.dump(result, out)
    results[url] = result
    print(f"attempt {os.environ['BR_ATTEMPT']}: {url}: {result['status']} {result['reason']} {result['words']} words".rstrip())

if retry:
    print(f"fetch-pages: {len(retry)} of {len(urls)} URLs hit a network problem; the others are kept for the next attempt")
    raise SystemExit(75)

ok = [results[url] for url in urls if results[url]["status"] == "ok"]
if not ok:
    # Nothing to embed, and every reason is in the log above.
    print("fetch-pages: no URL could be read")
    raise SystemExit(78)

with open(os.environ["OUTPUT_PAGES"], "w", encoding="utf-8") as out:
    for page in ok:
        out.write(json.dumps({"url": page["url"], "title": page["title"], "text": page["text"]}) + "\n")
with open(os.environ["OUTPUT_STATUSES"], "w", encoding="utf-8") as out:
    for url in urls:
        r = results[url]
        out.write(json.dumps({"url": url, "status": r["status"], "reason": r["reason"], "http": r["http"], "words": r["words"]}) + "\n")
with open(os.environ["OUTPUT_OK_COUNT"], "w", encoding="utf-8") as out:
    out.write(str(len(ok)))
with open(os.environ["OUTPUT_FAILED_COUNT"], "w", encoding="utf-8") as out:
    out.write(str(len(urls) - len(ok)))
print(f"fetch-pages: {len(ok)} read, {len(urls) - len(ok)} failed for good")
PY
