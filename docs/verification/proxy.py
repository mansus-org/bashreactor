#!/usr/bin/env python3
"""A deliberately flaky stand-in for the embeddings endpoint.

It forwards to the real local endpoint and answers the first FAIL_FIRST requests with 500, so an
embedding block has to hit its retry path and resume from its work directory for real.
"""
import json
import os
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

UPSTREAM = "http://127.0.0.1:8731/v1/embeddings"
COUNTER = "/tmp/br-flaky/count"
# Fail the requests numbered FAIL_AFTER+1 .. FAIL_FIRST, so an earlier batch can succeed and prove
# the block's cache works.
FAIL_AFTER = int(os.environ.get("FAIL_AFTER", "0"))
FAIL_FIRST = int(os.environ.get("FAIL_FIRST", "2"))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        with open(COUNTER, "a") as handle:
            handle.write("1\n")
        seen = sum(1 for _ in open(COUNTER))
        if FAIL_AFTER < seen <= FAIL_FIRST:
            print(f"proxy: request {seen} -> injected 500", flush=True)
            payload = b'{"error":{"message":"injected failure","type":"server_error"}}'
            self.send_response(500)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        request = urllib.request.Request(UPSTREAM, data=body, headers={"content-type": "application/json"})
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = response.read()
        print(f"proxy: request {seen} -> 200 ({len(payload)} bytes)", flush=True)
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    print(f"flaky endpoint on :8799, requests {FAIL_AFTER + 1}..{FAIL_FIRST} will 500", flush=True)
    HTTPServer(("127.0.0.1", 8799), Handler).serve_forever()
