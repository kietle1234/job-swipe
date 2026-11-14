#!/usr/bin/env python3
"""Local test webhook. Logs headers + body and replies with CORS enabled.

Optional control plane (used by the auto-retry e2e):
  GET  /health
  GET  /stats
  POST /control   JSON {failNext, failStatus, delayMs} — reset counters too
  POST /apply     (or any other path) — may fail the next N times, then 200
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone

PORT = int(os.environ.get("WEBHOOK_PORT", "8765"))
LOG_PATH = os.environ.get("WEBHOOK_LOG", os.path.join(os.path.dirname(__file__), "webhook-log.jsonl"))

os.makedirs(os.path.dirname(LOG_PATH) or ".", exist_ok=True)

state = {
    "failNext": 0,
    "failStatus": 503,
    "delayMs": 0,
    "posts": 0,
    "inFlight": 0,
    "maxInFlight": 0,
}
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self):
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS, GET")
        self.send_header(
            "Access-Control-Allow-Headers",
            self.headers.get("Access-Control-Request-Headers", "Content-Type, Authorization, X-Webhook-Key"),
        )
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")

    def _json(self, code, obj):
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/health"):
            self._json(200, {"ok": True})
            return
        if path.startswith("/stats"):
            with lock:
                snapshot = dict(state)
            self._json(200, snapshot)
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

        path = self.path.split("?", 1)[0]
        if path.startswith("/control"):
            with lock:
                if isinstance(body, dict):
                    if "failNext" in body:
                        state["failNext"] = int(body["failNext"])
                    if "failStatus" in body:
                        state["failStatus"] = int(body["failStatus"])
                    if "delayMs" in body:
                        state["delayMs"] = int(body["delayMs"])
                    # Reset concurrency counters so a new scenario starts clean.
                    state["posts"] = 0
                    state["inFlight"] = 0
                    state["maxInFlight"] = 0
                    snapshot = dict(state)
            self._json(200, {"ok": True, "state": snapshot})
            return

        with lock:
            state["inFlight"] += 1
            state["posts"] += 1
            if state["inFlight"] > state["maxInFlight"]:
                state["maxInFlight"] = state["inFlight"]
            delay_ms = state["delayMs"]
            fail_now = state["failNext"] > 0
            fail_status = state["failStatus"]
            if fail_now:
                state["failNext"] -= 1

        try:
            if delay_ms:
                time.sleep(delay_ms / 1000.0)

            record = {
                "receivedAt": datetime.now(timezone.utc).isoformat(),
                "path": self.path,
                "headers": {k: v for k, v in self.headers.items()},
                "body": body,
                "raw": raw.decode("utf-8", "replace"),
                "status": fail_status if fail_now else 200,
            }
            with open(LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record) + "\n")
            print("WEBHOOK_POST", json.dumps(record, indent=2), flush=True)

            if fail_now:
                self._json(fail_status, {"ok": False, "error": "injected failure"})
            else:
                self._json(200, {"ok": True})
        finally:
            with lock:
                state["inFlight"] = max(0, state["inFlight"] - 1)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"webhook listening on http://127.0.0.1:{PORT}  log={LOG_PATH}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
