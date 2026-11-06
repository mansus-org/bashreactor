#!/usr/bin/env bash
# ---
# name: fetch-article
# description: Download one HTML article and keep its body text.
# inputs:
#   url:
#     type: string
#     description: The article to download.
#   min_bytes:
#     type: integer
#     description: Refuse an article whose extracted text is shorter than this.
#     default: 2000
# outputs:
#   article:
#     type: file
#     description: The body text, one paragraph per line.
#   title:
#     type: string
#     description: The title of the article, without the site's suffix.
#   bytes:
#     type: integer
#     description: How many bytes of text were kept.
# ---

raw=article.html

# The work directory survives a retry and an engine restart, so a download that got this far is not
# thrown away (SPEC 2.6, 4.1).
if [[ -s "$raw" ]]; then
  echo "attempt $BR_ATTEMPT: reusing $(wc -c < "$raw") bytes already in the work directory"
else
  # The status code goes to its own variable so a 404 is never mistaken for a dead network.
  status=$(curl --silent --show-error --location --max-time 90 \
    --user-agent 'bashreactor-ingest-example/1.0' \
    --output "$raw.part" --write-out '%{http_code}' "$INPUT_URL") || status=000
  case "$status" in
    2*)
      mv "$raw.part" "$raw"
      echo "attempt $BR_ATTEMPT: fetched $status, $(wc -c < "$raw") bytes"
      ;;
    4*)
      # Another attempt would read the same 404, so say so with the code that stops the run now.
      echo "attempt $BR_ATTEMPT: $INPUT_URL answered $status, which a retry cannot fix"
      exit 78
      ;;
    *)
      echo "attempt $BR_ATTEMPT: the download failed with status $status, asking to be retried"
      exit 75
      ;;
  esac
fi

uv run --quiet --no-project --script - <<'PY'
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
import json
import os
from html.parser import HTMLParser

VOID = {"br", "img", "hr", "meta", "link", "input", "source", "wbr", "col", "area", "base"}
# Anything whose text is not prose: markup noise, sidebars, tables, footnote markers.
SKIP = {"script", "style", "sup", "sub", "table", "figure", "math", "anno", "figcaption"}


class Article(HTMLParser):
    """Keep the text of the paragraphs in the article body, and nothing else."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.body_at: int | None = None
        self.paragraphs: list[str] = []
        self.buffer: list[str] = []
        self.title: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append(tag)
        if tag == "div" and dict(attrs).get("id") == "mw-content-text":
            self.body_at = len(self.stack)

    def handle_endtag(self, tag):
        if tag == "p" and self.buffer:
            self.flush()
        # Pop back to the tag that closed, so one unclosed tag does not shift everything after it.
        if tag in self.stack:
            while self.stack and self.stack.pop() != tag:
                pass
        if self.body_at is not None and len(self.stack) < self.body_at:
            self.body_at = None

    def handle_data(self, data):
        in_body = self.body_at is not None and len(self.stack) >= self.body_at
        if in_body and "p" in self.stack:
            if not any(tag in SKIP for tag in self.stack):
                self.buffer.append(data)
        elif not in_body and "title" in self.stack:
            self.title.append(data)

    def flush(self):
        text = " ".join("".join(self.buffer).split())
        self.buffer = []
        if len(text) > 40:
            self.paragraphs.append(text)


with open("article.html", encoding="utf-8") as page:
    parser = Article()
    for line in page:
        parser.feed(line)
parser.close()

title = " ".join("".join(parser.title).split())
if title.endswith(" - Wikipedia"):
    title = title[: -len(" - Wikipedia")]

text = "\n".join(parser.paragraphs)
kept = len(text.encode("utf-8"))
if kept < int(os.environ["INPUT_MIN_BYTES"]):
    print(f"fetch-article: only {kept} bytes of text, need at least {os.environ['INPUT_MIN_BYTES']}")
    raise SystemExit(78)

with open(os.environ["OUTPUT_ARTICLE"], "w", encoding="utf-8") as out:
    out.write(text)
with open(os.environ["OUTPUT_TITLE"], "w", encoding="utf-8") as out:
    out.write(title)
with open(os.environ["OUTPUT_BYTES"], "w", encoding="utf-8") as out:
    out.write(str(kept))

print(f"fetch-article: {title}: {len(parser.paragraphs)} paragraphs, {kept} bytes")
PY
