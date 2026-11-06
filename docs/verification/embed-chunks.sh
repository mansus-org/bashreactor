#!/usr/bin/env bash
# ---
# name: embed-chunks
# description: Embed every chunk through an OpenAI-compatible endpoint, resuming from cached vectors.
# inputs:
#   chunks:
#     type: file
#     description: One JSON object per line, each with i and text.
#   endpoint:
#     type: string
#     description: The embeddings route to POST to.
#   model:
#     type: string
#     description: The model to ask for.
#   batch:
#     type: integer
#     description: How many chunks per request.
#     default: 8
# outputs:
#   vectors:
#     type: file
#     description: One JSON object per line, each with i and vec.
#   count:
#     type: integer
#     description: How many chunks were embedded.
#   dim:
#     type: integer
#     description: The length of one vector.
# ---

uv run --quiet --no-project --script - <<'PY'
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
import json
import os
import sys
import urllib.error
import urllib.request

endpoint = os.environ["INPUT_ENDPOINT"]
model = os.environ["INPUT_MODEL"]
batch = int(os.environ["INPUT_BATCH"])

with open(os.environ["INPUT_CHUNKS"], encoding="utf-8") as handle:
    chunks = [json.loads(line) for line in handle if line.strip()]

# The work directory is kept across attempts and engine restarts, so an embedding already paid for is
# never paid for twice (SPEC 4.1). That matters here: an embedding run is the expensive step.
cache = "cache"
os.makedirs(cache, exist_ok=True)


def embed(texts):
    body = json.dumps({"model": model, "input": texts}).encode()
    request = urllib.request.Request(
        endpoint, data=body, headers={"content-type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 429 or error.code >= 500:
            print(f"embed-chunks: the endpoint answered {error.code}, asking to be retried")
            raise SystemExit(75)
        print(f"embed-chunks: the endpoint answered {error.code}, which a retry cannot fix")
        raise SystemExit(78)
    except (urllib.error.URLError, TimeoutError) as error:
        print(f"embed-chunks: the endpoint is unreachable ({error}), asking to be retried")
        raise SystemExit(75)
    rows = sorted(payload["data"], key=lambda row: row.get("index", 0))
    return [row["embedding"] for row in rows]


todo = [chunk for chunk in chunks if not os.path.exists(f"{cache}/{chunk['i']:05d}.json")]
print(f"embed-chunks: {len(chunks)} chunks, {len(todo)} not yet embedded, model {model}")

for start in range(0, len(todo), batch):
    group = todo[start : start + batch]
    vectors = embed([chunk["text"] for chunk in group])
    if len(vectors) != len(group):
        print(f"embed-chunks: asked for {len(group)} vectors, got {len(vectors)}")
        raise SystemExit(75)
    for chunk, vector in zip(group, vectors):
        # Written per chunk, so an interrupt in the middle of a batch still keeps what it earned.
        with open(f"{cache}/{chunk['i']:05d}.json", "w", encoding="utf-8") as out:
            json.dump(vector, out)
    done = min(start + batch, len(todo))
    print(f"embed-chunks: embedded {done} of {len(todo)}")

dim = 0
with open(os.environ["OUTPUT_VECTORS"], "w", encoding="utf-8") as out:
    for chunk in chunks:
        with open(f"{cache}/{chunk['i']:05d}.json", encoding="utf-8") as cached:
            vector = json.load(cached)
        dim = len(vector)
        out.write(json.dumps({"i": chunk["i"], "vec": vector}) + "\n")

with open(os.environ["OUTPUT_COUNT"], "w", encoding="utf-8") as out:
    out.write(str(len(chunks)))
with open(os.environ["OUTPUT_DIM"], "w", encoding="utf-8") as out:
    out.write(str(dim))

print(f"embed-chunks: {len(chunks)} vectors of {dim} dimensions")
PY
