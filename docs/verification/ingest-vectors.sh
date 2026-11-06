#!/usr/bin/env bash
# ---
# name: ingest-vectors
# description: Write chunks and their vectors into one SQLite file that a later step can search.
# inputs:
#   chunks:
#     type: file
#     description: One JSON object per line, each with i, words and text.
#   vectors:
#     type: file
#     description: One JSON object per line, each with i and vec.
#   title:
#     type: string
#     description: The document these chunks came from.
#   model:
#     type: string
#     description: The model that made the vectors, recorded so a mismatch is visible.
# outputs:
#   db:
#     type: file
#     description: The SQLite database, with meta and chunks tables.
#   rows:
#     type: integer
#     description: How many chunk rows were written.
#   dim:
#     type: integer
#     description: The length of the stored vectors.
#   bytes:
#     type: integer
#     description: The size of the database file.
# ---

uv run --quiet --no-project --script - <<'PY'
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
import json
import os
import sqlite3
import struct

with open(os.environ["INPUT_CHUNKS"], encoding="utf-8") as handle:
    chunks = {row["i"]: row for row in map(json.loads, handle) if row.get("text", "").strip()}
with open(os.environ["INPUT_VECTORS"], encoding="utf-8") as handle:
    vectors = {row["i"]: row["vec"] for row in map(json.loads, handle)}

missing = sorted(set(chunks) - set(vectors))
if missing:
    print(f"ingest-vectors: no vector for chunks {missing}")
    raise SystemExit(78)

dim = len(next(iter(vectors.values())))
if any(len(vec) != dim for vec in vectors.values()):
    print("ingest-vectors: the vectors are not all the same length")
    raise SystemExit(78)

# Built in the work directory and moved into the outputs directory at the end, so a step that dies
# halfway leaves nothing that looks like an index (SPEC 2.5).
path = "index.sqlite"
if os.path.exists(path):
    os.remove(path)

conn = sqlite3.connect(path)
conn.executescript(
    """
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE chunks (
      i INTEGER PRIMARY KEY,
      words INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL
    );
    """
)
conn.executemany(
    "INSERT INTO meta (key, value) VALUES (?, ?)",
    [
        ("title", os.environ["INPUT_TITLE"]),
        ("model", os.environ["INPUT_MODEL"]),
        ("dim", str(dim)),
        ("encoding", "float32 little-endian"),
        ("similarity", "cosine"),
    ],
)
conn.executemany(
    "INSERT INTO chunks (i, words, text, embedding) VALUES (?, ?, ?, ?)",
    [
        (i, chunks[i]["words"], chunks[i]["text"], struct.pack(f"<{len(vec)}f", *vec))
        for i, vec in sorted(vectors.items())
    ],
)
conn.commit()
rows = conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
conn.execute("VACUUM")
conn.commit()
conn.close()

size = os.path.getsize(path)
os.replace(path, os.environ["OUTPUT_DB"])

for name, value in (
    (os.environ["OUTPUT_ROWS"], rows),
    (os.environ["OUTPUT_DIM"], dim),
    (os.environ["OUTPUT_BYTES"], size),
):
    with open(name, "w", encoding="utf-8") as out:
        out.write(str(value))

print(f"ingest-vectors: {rows} rows, {dim} dimensions, {size} bytes")
PY
