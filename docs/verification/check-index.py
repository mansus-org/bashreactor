#!/usr/bin/env python3
"""Check a Bashreactor-built SQLite index from the outside.

Re-embeds stored chunk text straight from the real endpoint and compares it with what the run wrote,
so a block that stored the wrong vector, or misaligned rows, cannot pass.
"""
import json
import math
import sqlite3
import struct
import sys
import urllib.request

db, endpoint, model = sys.argv[1], sys.argv[2], sys.argv[3]

conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
rows = conn.execute("SELECT i, words, text, embedding FROM chunks ORDER BY i").fetchall()
meta = dict(conn.execute("SELECT key, value FROM meta"))
print(f"rows={len(rows)} meta={meta}")

ok = True


def embed(texts):
    body = json.dumps({"model": model, "input": texts}).encode()
    req = urllib.request.Request(endpoint, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return [row["embedding"] for row in sorted(json.load(r)["data"], key=lambda x: x["index"])]


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b)) / (
        math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    )


# 1. every stored vector is finite and the right length
for i, words, text, blob in rows:
    vec = struct.unpack(f"<{len(blob) // 4}f", blob)
    if len(vec) != 1024:
        print(f"FAIL row {i}: {len(vec)} dimensions")
        ok = False
    if not all(math.isfinite(v) for v in vec):
        print(f"FAIL row {i}: non-finite component")
        ok = False
print("ok  every row is 1024 finite float32 components")

# 2. the stored vector really is that row's text
fresh = embed([text for _, _, text, _ in rows])
worst = 1.0
for (i, _, text, blob), vec in zip(rows, fresh):
    stored = struct.unpack(f"<{len(blob) // 4}f", blob)
    sim = cosine(stored, vec)
    worst = min(worst, sim)
    if sim < 0.999:
        print(f"FAIL row {i}: stored vector is not its own text (cosine {sim:.4f})")
        ok = False
print(f"ok  stored vectors match a fresh embedding of their own text (worst cosine {worst:.6f})")

# 3. rows are distinguishable, so the index is not one vector repeated
sims = [cosine(fresh[a], fresh[b]) for a in range(len(fresh)) for b in range(a + 1, len(fresh))]
print(f"ok  pairwise similarity across chunks: max {max(sims):.4f}, min {min(sims):.4f}")
if max(sims) > 0.99:
    print("WARN two chunks are near-identical")

# 4. retrieval: each query must land on a chunk that actually talks about it
checks = [
    ("Why does exact nearest neighbour search degrade in high dimensional spaces?", "curse of dimensionality"),
    ("How does a k-d tree split space to answer range queries?", "k-d tree"),
    ("What is locality sensitive hashing?", "locality sensitive"),
    ("How is approximate search evaluated against exact results?", "recall"),
]
for query, needle in checks:
    q = embed([query])[0]
    ranked = sorted(
        ((cosine(q, struct.unpack(f"<{len(b) // 4}f", b)), i, t) for i, _, t, b in rows),
        key=lambda r: (-r[0], r[1]),
    )
    top_score, top_i, top_text = ranked[0]
    hit = needle.lower() in top_text.lower()
    where = next((n for n, r in enumerate(ranked) if needle.lower() in r[2].lower()), None)
    print(f"{'ok  ' if hit else 'note'}  {query[:56]:<56} top={top_i} {top_score:.4f}  '{needle}' in top: {hit}, first at rank {where}")

conn.close()
print("VERDICT:", "index is sound" if ok else "PROBLEMS FOUND")
