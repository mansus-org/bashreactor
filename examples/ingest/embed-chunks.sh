#!/usr/bin/env bash
# ---
# name: embed-chunks
# description: Embed every chunk through an OpenAI-compatible route and write the file a consumer reads.
# inputs:
#   chunks:
#     type: file
#     description: One JSON object per chunk with id, url, index and text.
#   statuses:
#     type: file
#     description: One JSON object per requested URL, from fetch-pages. Goes into the manifest.
#   endpoint:
#     type: string
#     description: The embeddings route to POST to.
#   model:
#     type: string
#     description: The model to ask for.
#   batch:
#     type: integer
#     description: How many chunks per request.
#     default: 16
# outputs:
#   embeddings:
#     type: file
#     description: One JSON object per chunk with id, url, index, text, model, dim and embedding.
#   manifest:
#     type: file
#     description: One JSON object with the model, dim, counts and the status of every requested URL.
#   dim:
#     type: integer
#     description: The length of one vector.
#   embedded:
#     type: integer
#     description: How many chunks are in embeddings.
# ---

# The key comes from the engine's environment through pass_env and goes nowhere but the
# Authorization header: not into a log line, not into a file, not into an error message.
if [[ -z "${EMBEDDINGS_API_KEY+x}" ]]; then
  echo "embed-chunks: EMBEDDINGS_API_KEY is not set. Set it (empty if the endpoint needs no key) in the environment of the server that runs this pipeline."
  exit 78
fi

uv run --quiet --no-project --script - <<'PY'
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request

endpoint = os.environ["INPUT_ENDPOINT"]
model = os.environ["INPUT_MODEL"]
batch = int(os.environ["INPUT_BATCH"])
key = os.environ["EMBEDDINGS_API_KEY"]
if batch < 1:
    print(f"embed-chunks: batch must be at least 1, got {batch}")
    raise SystemExit(78)

# Userinfo and query strings can carry credentials, so the log names the route without them.
shown = urllib.parse.urlsplit(endpoint)
route = f"{shown.scheme}://{shown.hostname}{shown.path}"

with open(os.environ["INPUT_CHUNKS"], encoding="utf-8") as handle:
    chunks = [json.loads(line) for line in handle if line.strip()]
if not chunks:
    print("embed-chunks: no chunks to embed")
    raise SystemExit(78)

# The work directory is kept across attempts and engine restarts, so an embedding already paid for is
# never paid for twice (SPEC 4.1). The model is part of the name: another model's vector is not a hit.
os.makedirs("cache", exist_ok=True)


def cache_path(chunk):
    digest = hashlib.sha256(f"{model}\0{chunk['id']}\0{chunk['text']}".encode()).hexdigest()[:32]
    return f"cache/{digest}.json"


def embed(texts):
    headers = {"content-type": "application/json"}
    if key:
        headers["authorization"] = f"Bearer {key}"
    request = urllib.request.Request(endpoint, data=json.dumps({"model": model, "input": texts}).encode(), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        # The body is not printed: some gateways echo the request, headers included.
        if error.code in {408, 425, 429} or error.code >= 500:
            print(f"embed-chunks: {route} answered {error.code}, asking to be retried")
            raise SystemExit(75)
        print(f"embed-chunks: {route} answered {error.code}, which a retry cannot fix (check the key, the model name and the route)")
        raise SystemExit(78)
    except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError) as error:
        print(f"embed-chunks: {route} failed ({type(error).__name__}), asking to be retried")
        raise SystemExit(75)
    try:
        rows = sorted(payload["data"], key=lambda row: row.get("index", 0))
        return [row["embedding"] for row in rows]
    except (KeyError, TypeError):
        print(f"embed-chunks: {route} answered without a data list of embeddings")
        raise SystemExit(78)


todo = [chunk for chunk in chunks if not os.path.exists(cache_path(chunk))]
print(f"embed-chunks: {len(chunks)} chunks, {len(todo)} not yet embedded, model {model}, route {route}")

for start in range(0, len(todo), batch):
    group = todo[start : start + batch]
    vectors = embed([chunk["text"] for chunk in group])
    if len(vectors) != len(group):
        print(f"embed-chunks: asked for {len(group)} vectors, got {len(vectors)}")
        raise SystemExit(75)
    for chunk, vector in zip(group, vectors):
        # Written per chunk, so an interrupt in the middle of a batch still keeps what it earned.
        with open(cache_path(chunk) + ".part", "w", encoding="utf-8") as out:
            json.dump(vector, out)
        os.replace(cache_path(chunk) + ".part", cache_path(chunk))
    print(f"embed-chunks: embedded {min(start + batch, len(todo))} of {len(todo)}")

dim = 0
per_url: dict[str, int] = {}
with open(os.environ["OUTPUT_EMBEDDINGS"], "w", encoding="utf-8") as out:
    for chunk in chunks:
        with open(cache_path(chunk), encoding="utf-8") as cached:
            vector = json.load(cached)
        if dim and len(vector) != dim:
            print(f"embed-chunks: vector sizes differ ({dim} and {len(vector)})")
            raise SystemExit(78)
        dim = len(vector)
        per_url[chunk["url"]] = per_url.get(chunk["url"], 0) + 1
        out.write(json.dumps({
            "id": chunk["id"], "url": chunk["url"], "index": chunk["index"], "text": chunk["text"],
            "model": model, "dim": dim, "embedding": vector,
        }) + "\n")

with open(os.environ["INPUT_STATUSES"], encoding="utf-8") as handle:
    statuses = [json.loads(line) for line in handle if line.strip()]
manifest = {
    "format": 1,
    "model": model,
    "dim": dim,
    "chunks": len(chunks),
    "urls_ok": sum(1 for s in statuses if s["status"] == "ok"),
    "urls_failed": sum(1 for s in statuses if s["status"] != "ok"),
    "urls": [{**s, "chunks": per_url.get(s["url"], 0)} for s in statuses],
}
with open(os.environ["OUTPUT_MANIFEST"], "w", encoding="utf-8") as out:
    json.dump(manifest, out, indent=2)
    out.write("\n")
with open(os.environ["OUTPUT_DIM"], "w", encoding="utf-8") as out:
    out.write(str(dim))
with open(os.environ["OUTPUT_EMBEDDED"], "w", encoding="utf-8") as out:
    out.write(str(len(chunks)))
print(f"embed-chunks: {len(chunks)} embeddings of {dim} dimensions")
PY
