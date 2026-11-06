#!/usr/bin/env python3
"""The embeddings endpoint, slowed down, so a run can be interrupted in the middle of real work."""
import json
import os
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

UPSTREAM = "http://127.0.0.1:8731/v1/embeddings"
DELAY = float(os.environ.get("DELAY", "1"))
LOG = os.environ.get("SLOW_LOG", "/tmp/br-flaky/slow.log")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        time.sleep(DELAY)
        request = urllib.request.Request(UPSTREAM, data=body, headers={"content-type": "application/json"})
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = response.read()
        with open(LOG, "a") as handle:
            handle.write(f"{time.strftime('%H:%M:%S')} {len(payload)} bytes\n")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    print(f"slow endpoint on :8800, {DELAY}s per request", flush=True)
    HTTPServer(("127.0.0.1", 8800), Handler).serve_forever()
