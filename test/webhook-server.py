#!/usr/bin/env python3
"""Local test webhook. Logs headers + body and replies with CORS enabled."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import sys
from datetime import datetime, timezone

PORT = int(os.environ.get("WEBHOOK_PORT", "8765"))
LOG_PATH = os.environ.get("WEBHOOK_LOG", os.path.join(os.path.dirname(__file__), "webhook-log.jsonl"))

os.makedirs(os.path.dirname(LOG_PATH) or ".", exist_ok=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self):
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            self.headers.get("Access-Control-Request-Headers", "Content-Type, Authorization, X-Webhook-Key"),
        )
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8") or "null")
        except Exception as exc:
            body = {"_parse_error": str(exc), "_raw": raw.decode("utf-8", "replace")}

        record = {
            "receivedAt": datetime.now(timezone.utc).isoformat(),
            "path": self.path,
            "headers": {k: v for k, v in self.headers.items()},
            "body": body,
            "raw": raw.decode("utf-8", "replace"),
        }
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
        # Also print a compact view for the test runner
        print("WEBHOOK_POST", json.dumps(record, indent=2), flush=True)

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"webhook listening on http://127.0.0.1:{PORT}  log={LOG_PATH}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
