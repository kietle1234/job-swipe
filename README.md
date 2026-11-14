# Job Swipe

A static, mobile-first Tinder-style job deck. Right swipe posts the job to your apply listener. Built to live on GitHub Pages; no build step.

## Run locally

```bash
cd job-swipe
python3 -m http.server 8080 --bind 127.0.0.1
```

Open http://127.0.0.1:8080/ and add it to your phone’s home screen (Share → Add to Home Screen on iOS, or the install prompt on Android).

## Fill in real jobs

Edit `jobs.json`. Each listing uses:

`id`, `company`, `title`, `pay`, `location`, `lane` (`Banking` or `Healthcare`), `highlights[]`, `headsUp`, `url`, `ats`. Mark seed data with `"sample": true`.

## Settings (this device only)

Open the gear. Paste:

- **Webhook URL** — the apply listener
- **Sender key** — sent as `Authorization: Bearer <key>` and as `X-Webhook-Key: <key>`
- **Auth header name** — change this if your listener expects a different header than `Authorization`

Values are stored in `localStorage` only. They are never written to these files.

On a successful right swipe the app POSTs:

```json
{ "action": "apply", "job": { /* full job object */ }, "swipedAt": "2026-11-14T15:00:00.000Z" }
```

Failed posts (network, CORS, or a non-2xx) are queued in `localStorage` and sent one at a time. The app retries automatically with backoff (30s, 1m, 2m, then every 5m), and also when you reopen the page, come back online, or bring the tab to the front. A calm status bar shows “Sending…” or “Waiting to send, retrying automatically.” Use **Send now** to try immediately. A rejected key (401 or 403) shows an error and points you to Settings instead of auto-retrying.

Left swipes never hit the network. Undo brings the last card back and drops it from the queue if it was not yet sent.

## CORS

The browser will preflight this POST because of the JSON content type and custom headers. The listener must reply to `OPTIONS` and `POST` with:

- `Access-Control-Allow-Origin` matching the GitHub Pages origin (or `*`)
- `Access-Control-Allow-Headers: Content-Type, Authorization, X-Webhook-Key` (and any custom auth header name you set)
- `Access-Control-Allow-Methods: POST, OPTIONS`

Many webhook hosts do not send these headers, so the request will fail in the browser even if the server would have accepted a server-to-server call. If that happens, point the app at a small CORS-enabled proxy or function in front of the real listener. The queue will hold failed applies until that is in place.

## Tests

```bash
cd job-swipe
node test/e2e.mjs
```

Starts `python3 -m http.server`, a local webhook on port 8765, and a Playwright check at 390×844. Screenshots land in `screenshots/`.
