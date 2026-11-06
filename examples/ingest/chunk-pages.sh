#!/usr/bin/env bash
# ---
# name: chunk-pages
# description: Split every page into overlapping word windows with a stable id each.
# inputs:
#   pages:
#     type: file
#     description: One JSON object per page with url and text.
#   chunk_words:
#     type: integer
#     description: How many words per chunk.
#     default: 120
#   overlap:
#     type: integer
#     description: How many of a chunk's last words start the next one.
#     default: 24
# outputs:
#   chunks:
#     type: file
#     description: One JSON object per chunk with id, url, index, words and text.
#   chunk_count:
#     type: integer
#     description: How many chunks were written.
# ---

uv run --quiet --no-project --script - <<'PY'
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
import json
import os

size = int(os.environ["INPUT_CHUNK_WORDS"])
overlap = int(os.environ["INPUT_OVERLAP"])
if size < 1 or overlap < 0 or overlap >= size:
    print(f"chunk-pages: need 0 <= overlap < chunk_words, got overlap {overlap} and chunk_words {size}")
    raise SystemExit(78)

step = size - overlap
total = 0
with open(os.environ["INPUT_PAGES"], encoding="utf-8") as pages, open(os.environ["OUTPUT_CHUNKS"], "w", encoding="utf-8") as out:
    for line in pages:
        if not line.strip():
            continue
        page = json.loads(line)
        words = page["text"].split()
        windows = [words[start : start + size] for start in range(0, len(words), step)]
        # A tail no longer than the overlap is already inside the window before it.
        if len(windows) > 1 and len(windows[-1]) <= overlap:
            windows.pop()
        for index, window in enumerate(windows):
            # The id is the url and the index, so a re-run of the same page gives the same ids and a
            # consumer can upsert on it.
            out.write(json.dumps({"id": f"{page['url']}#{index}", "url": page["url"], "index": index, "words": len(window), "text": " ".join(window)}) + "\n")
        total += len(windows)
        print(f"chunk-pages: {page['url']}: {len(words)} words into {len(windows)} chunks")

with open(os.environ["OUTPUT_CHUNK_COUNT"], "w", encoding="utf-8") as out:
    out.write(str(total))
PY
