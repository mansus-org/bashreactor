#!/usr/bin/env bash
# ---
# name: search-vectors
# description: Embed a query and return the closest chunks from a SQLite index.
# inputs:
#   db:
#     type: file
#     description: The database that ingest-vectors wrote.
#   query:
#     type: string
#     description: The question to answer from the index.
#   endpoint:
#     type: string
#     description: The embeddings route to POST to.
#   model:
#     type: string
#     description: The model the index was built with.
#   top:
#     type: integer
#     description: How many chunks to return.
#     default: 3
# outputs:
#   results:
#     type: file
#     description: A JSON array of i, score and text, closest first.
#   hits:
#     type: integer
#     description: How many chunks were returned.
#   top_score:
#     type: number
#     description: The cosine similarity of the closest chunk.
#   top_text:
#     type: string
#     description: The closest chunk's text.
# ---

uv run --quiet --no-project --script - <<'PY'
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
import json
import math
import os
import sqlite3
import struct
import urllib.error
import urllib.request

db = os.environ["INPUT_DB"]
model = os.environ["INPUT_MODEL"]
top = int(os.environ["INPUT_TOP"])

conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
meta = dict(conn.execute("SELECT key, value FROM meta"))
stored = meta.get("model")
if stored != model:
    print(f"search-vectors: the index was built with {stored!r}, not {model!r}")
    raise SystemExit(78)

body = json.dumps({"model": model, "input": [os.environ["INPUT_QUERY"]]}).encode()
request = urllib.request.Request(
    os.environ["INPUT_ENDPOINT"], data=body, headers={"content-type": "application/json"}
)
try:
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.load(response)
except urllib.error.HTTPError as error:
    print(f"search-vectors: the endpoint answered {error.code}")
    raise SystemExit(75 if error.code == 429 or error.code >= 500 else 78)
except (urllib.error.URLError, TimeoutError) as error:
    print(f"search-vectors: the endpoint is unreachable ({error})")
    raise SystemExit(75)

query = payload["data"][0]["embedding"]


def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


ranked = []
for i, blob, text in conn.execute("SELECT i, embedding, text FROM chunks"):
    stored_vec = struct.unpack(f"<{len(blob) // 4}f", blob)
    if len(stored_vec) != len(query):
        print(f"search-vectors: row {i} has {len(stored_vec)} dimensions, query has {len(query)}")
        raise SystemExit(78)
    ranked.append({"i": i, "score": cosine(query, stored_vec), "text": text})
conn.close()

ranked.sort(key=lambda row: (-row["score"], row["i"]))
hits = ranked[:top]

with open(os.environ["OUTPUT_RESULTS"], "w", encoding="utf-8") as out:
    json.dump(hits, out)
with open(os.environ["OUTPUT_HITS"], "w", encoding="utf-8") as out:
    out.write(str(len(hits)))
with open(os.environ["OUTPUT_TOP_SCORE"], "w", encoding="utf-8") as out:
    out.write(f"{hits[0]['score']:.6f}" if hits else "0")
with open(os.environ["OUTPUT_TOP_TEXT"], "w", encoding="utf-8") as out:
    out.write(hits[0]["text"] if hits else "")

for row in hits:
    print(f"search-vectors: {row['score']:.4f}  chunk {row['i']}: {row['text'][:72]}...")
PY
