#!/usr/bin/env bash
# ---
# name: chunk-text
# description: Split text into overlapping word windows, one JSON object per line.
# inputs:
#   article:
#     type: file
#     description: The text to split.
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
#     description: One JSON object per line with i, words and text.
#   chunk_count:
#     type: integer
#     description: How many chunks were written.
#   longest_chunk:
#     type: integer
#     description: The largest chunk, in words.
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
if overlap >= size:
    print(f"chunk-text: overlap {overlap} must be smaller than the chunk size {size}")
    raise SystemExit(78)

with open(os.environ["INPUT_ARTICLE"], encoding="utf-8") as article:
    words = article.read().split()

step = size - overlap
chunks = [words[start : start + size] for start in range(0, len(words), step)]
# A tail shorter than the overlap is noise on its own, so it rides along with the chunk before it.
if len(chunks) > 1 and len(chunks[-1]) <= overlap:
    chunks.pop()

with open(os.environ["OUTPUT_CHUNKS"], "w", encoding="utf-8") as out:
    for i, chunk in enumerate(chunks):
        out.write(json.dumps({"i": i, "words": len(chunk), "text": " ".join(chunk)}) + "\n")

with open(os.environ["OUTPUT_CHUNK_COUNT"], "w", encoding="utf-8") as out:
    out.write(str(len(chunks)))
with open(os.environ["OUTPUT_LONGEST_CHUNK"], "w", encoding="utf-8") as out:
    out.write(str(max((len(c) for c in chunks), default=0)))

print(f"chunk-text: {len(words)} words into {len(chunks)} chunks of {size} with {overlap} overlap")
PY
