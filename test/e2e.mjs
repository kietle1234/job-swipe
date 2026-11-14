import { chromium } from "playwright-core";
import { createWriteStream, mkdirSync, readFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(ROOT, "screenshots");
const LOG = path.join(__dirname, "webhook-log.jsonl");
const REPORT = path.join(__dirname, "e2e-report.json");
const APP_PORT = Number(process.env.APP_PORT || 8080);
const HOOK_PORT = Number(process.env.WEBHOOK_PORT || 8765);
const APP = `http://127.0.0.1:${APP_PORT}/?nosw=1`;
const HOOK = `http://127.0.0.1:${HOOK_PORT}/apply`;
const SENDER_KEY = "test-sender-key-123";
const AUTH_HEADER = "Authorization";

mkdirSync(SHOTS, { recursive: true });
if (existsSync(LOG)) unlinkSync(LOG);

const children = [];
function start(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  children.push(child);
  const label = opts.label || cmd;
  child.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${label} err] ${d}`));
  return child;
}

function stopAll() {
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch {}
  }
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {}
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function readLog() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const results = { ok: true, checks: [] };
function check(name, pass, detail) {
  results.checks.push({ name, pass: !!pass, detail: detail ?? null });
  const mark = pass ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? " — " + detail : ""}`);
  if (!pass) results.ok = false;
}

async function hookControl(body) {
  const res = await fetch(`http://127.0.0.1:${HOOK_PORT}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`control HTTP ${res.status}`);
  return res.json();
}

async function hookStats() {
  const res = await fetch(`http://127.0.0.1:${HOOK_PORT}/stats`);
  if (!res.ok) throw new Error(`stats HTTP ${res.status}`);
  return res.json();
}

async function swipeRightSettled(page) {
  const job = await page.evaluate(() => {
    const j = window.JobSwipe.visibleJobs()[0];
    window.JobSwipe.swipeRight();
    return j ? { id: j.id, title: j.title, company: j.company } : null;
  });
  await delay(450);
  return job;
}

async function queueBarState(page) {
  return page.evaluate(() => {
    const bar = document.getElementById("queue-bar");
    const label = document.getElementById("queue-label");
    const btn = document.getElementById("retry-btn");
    return {
      hidden: !bar || bar.hidden,
      text: label ? label.textContent : "",
      button: btn ? btn.textContent.trim() : "",
      error: !!(bar && bar.classList.contains("is-error")),
      queue: window.JobSwipe.getQueue().map((p) => p.job && p.job.id),
      sending: window.JobSwipe.isSending(),
    };
  });
}

async function waitUntil(fn, timeoutMs, label) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}


try {
  start("python3", ["-m", "http.server", String(APP_PORT), "--bind", "127.0.0.1"], {
    cwd: ROOT,
    label: "app",
  });
  start("python3", [path.join(__dirname, "webhook-server.py")], {
    cwd: ROOT,
    env: { ...process.env, WEBHOOK_PORT: String(HOOK_PORT), WEBHOOK_LOG: LOG },
    label: "hook",
  });

  await waitFor(`http://127.0.0.1:${APP_PORT}/`);
  await waitFor(`http://127.0.0.1:${HOOK_PORT}/health`);

  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
  });
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => consoleLines.push(`pageerror: ${err.message}`));

  await page.goto(APP, { waitUntil: "networkidle" });
  await page.waitForSelector(".card .title", { timeout: 8000 });

  const title = await page.locator(".card:not(.is-behind) .title").innerText();
  const company = await page.locator(".card:not(.is-behind) .company").innerText();
  check("loads and renders a job card", Boolean(title && company), `${company} — ${title}`);

  const progress = await page.locator("#progress").innerText();
  check("shows progress count", /\d+\s+left/.test(progress), progress);

  await page.screenshot({ path: path.join(SHOTS, "card-view.png"), fullPage: false });
  check("card-view screenshot written", existsSync(path.join(SHOTS, "card-view.png")));

  // Settings screen
  await page.click("#settings-btn");
  await page.waitForSelector("#settings.is-on");
  await delay(320);
  await page.screenshot({ path: path.join(SHOTS, "settings.png"), fullPage: false });
  check("settings screenshot written", existsSync(path.join(SHOTS, "settings.png")));

  await page.fill("#webhook-url", HOOK);
  await page.fill("#sender-key", SENDER_KEY);
  await page.fill("#auth-header", AUTH_HEADER);
  await page.click("#settings-form button[type=submit]");
  await delay(200);
  await page.click("#settings-close");
  await delay(300);

  // Right swipe via the public hook (exercises the same path as the heart button).
  const before = readLog().length;
  await page.evaluate(() => window.JobSwipe.swipeRight());
  // Wait for the fly-off + fetch
  let posts = [];
  for (let i = 0; i < 25; i++) {
    posts = readLog();
    if (posts.length > before) break;
    await delay(100);
  }
  check("right swipe triggered a POST", posts.length > before, `log entries: ${posts.length}`);

  const last = posts.at(-1);
  if (last) {
    const headers = {};
    for (const [k, v] of Object.entries(last.headers || {})) {
      headers[k.toLowerCase()] = v;
    }
    results.post = { headers: last.headers, body: last.body };
    console.log("\n--- Captured POST ---");
    console.log("Headers:", JSON.stringify(last.headers, null, 2));
    console.log("Body:", JSON.stringify(last.body, null, 2));

    check("Content-Type is application/json", /application\/json/i.test(headers["content-type"] || ""), headers["content-type"]);
    check(
      "Authorization Bearer key",
      headers["authorization"] === `Bearer ${SENDER_KEY}`,
      headers["authorization"]
    );
    check("X-Webhook-Key is the sender key", headers["x-webhook-key"] === SENDER_KEY, headers["x-webhook-key"]);
    check('body.action === "apply"', last.body?.action === "apply");
    check("body.job is the full job object", Boolean(last.body?.job?.id && last.body?.job?.company && last.body?.job?.title && last.body?.job?.url && last.body?.job?.ats));
    check("body.swipedAt is an ISO timestamp", typeof last.body?.swipedAt === "string" && !Number.isNaN(Date.parse(last.body.swipedAt)), last.body?.swipedAt);
    check("posted job matches the visible card", last.body?.job?.title === title && last.body?.job?.company === company, last.body?.job?.title);
  }

  // Toast
  const toastText = await page.evaluate(async () => {
    const el = document.getElementById("toast");
    for (let i = 0; i < 20; i++) {
      if (el && el.classList.contains("is-on") && el.textContent) return el.textContent;
      await new Promise((r) => setTimeout(r, 50));
    }
    return el ? el.textContent : "";
  });
  check("success toast says Sent to apply", /Sent to apply/i.test(toastText), toastText);

  // Left swipe should not POST
  const mid = readLog().length;
  await page.evaluate(() => window.JobSwipe.swipeLeft());
  await delay(600);
  const afterLeft = readLog().length;
  check("left swipe does not POST", afterLeft === mid, `before=${mid} after=${afterLeft}`);

  // Card advanced
  const nextTitle = await page.locator(".card:not(.is-behind) .title").innerText();
  check("deck advanced to a new card", nextTitle && nextTitle !== title, nextTitle);


  // --- Auto-retry, serialized queue, and calm status bar ---
  const retryLogStart = readLog().length;
  await hookControl({ failNext: 2, failStatus: 503, delayMs: 120 });
  await page.evaluate(() => window.JobSwipe.setBackoffMs([1800, 80, 80, 80]));

  const jobA = await swipeRightSettled(page);
  check("retry scenario has a first job", Boolean(jobA && jobA.id), jobA && jobA.id);

  const waiting = await waitUntil(async () => {
    const ui = await queueBarState(page);
    return !ui.hidden && !ui.sending && /retrying automatically/i.test(ui.text) ? ui : null;
  }, 4000, "waiting status after a transient failure");

  check("bar is visible after a failed send", !waiting.hidden);
  check("bar is not an error tone after a transient failure", !waiting.error, waiting.text);
  check(
    "bar says waiting / retrying automatically",
    /Waiting to send, retrying automatically/i.test(waiting.text),
    waiting.text
  );
  check("manual action is Send now", /Send now/i.test(waiting.button), waiting.button);
  check("does not show the old Not sent copy", !/Not sent/i.test(waiting.text), waiting.text);

  const jobB = await swipeRightSettled(page);
  const jobC = await swipeRightSettled(page);
  check("queued two more likes", Boolean(jobB && jobC), `${jobB && jobB.id}, ${jobC && jobC.id}`);

  const counted = await queueBarState(page);
  check(
    "bar reflects three queued likes",
    /Waiting to send 3, retrying automatically|Sending 3…/.test(counted.text),
    counted.text
  );

  // Let automatic backoff drain the queue (first retry is 1.8s, then fast).
  await waitUntil(async () => {
    const ui = await queueBarState(page);
    return ui.hidden && ui.queue.length === 0 && !ui.sending;
  }, 8000, "queue to drain automatically");

  const retryPosts = readLog().slice(retryLogStart);
  const okPosts = retryPosts.filter((p) => p.status === 200);
  const failPosts = retryPosts.filter((p) => p.status === 503);
  const okIds = okPosts.map((p) => p.body?.job?.id);
  const expectedIds = [jobA.id, jobB.id, jobC.id];
  check("transient failures were recorded before success", failPosts.length === 2, String(failPosts.length));
  check(
    "successful posts drain in swipe order",
    JSON.stringify(okIds) === JSON.stringify(expectedIds),
    JSON.stringify(okIds)
  );
  check(
    "posted payloads stay in the original format",
    okPosts.every((p) => p.body?.action === "apply" && p.body?.job?.id && typeof p.body?.swipedAt === "string"),
  );
  const retryStats = await hookStats();
  check("never sent two applies at once", retryStats.maxInFlight === 1, JSON.stringify(retryStats));
  const afterDrain = await queueBarState(page);
  check("bar hides when the queue is empty", afterDrain.hidden);

  // Coming back online should retry immediately instead of waiting out a long backoff.
  const onlineLogStart = readLog().length;
  await hookControl({ failNext: 1, failStatus: 503, delayMs: 80 });
  await page.evaluate(() => window.JobSwipe.setBackoffMs([30000, 30000, 30000, 30000]));
  const jobOnline = await swipeRightSettled(page);
  await waitUntil(async () => {
    const ui = await queueBarState(page);
    return !ui.hidden && !ui.sending && /retrying automatically/i.test(ui.text) ? ui : null;
  }, 4000, "waiting status before online retry");
  const beforeOnline = readLog().slice(onlineLogStart).length;
  await hookControl({ failNext: 0, failStatus: 503, delayMs: 80 });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitUntil(async () => {
    const ui = await queueBarState(page);
    return ui.hidden && ui.queue.length === 0;
  }, 4000, "online event to flush the queue");
  const afterOnline = readLog().slice(onlineLogStart);
  const onlineOk = afterOnline.filter((p) => p.status === 200);
  check("online event retries without waiting the full backoff", onlineOk.length >= 1 && onlineOk[0].body?.job?.id === jobOnline.id, String(afterOnline.length));
  check("online retry happened after the failure (did not wait 30s)", afterOnline.length > beforeOnline, String(afterOnline.length));

  // Undo should drop a like that is still queued.
  await hookControl({ failNext: 20, failStatus: 503, delayMs: 40 });
  await page.evaluate(() => window.JobSwipe.setBackoffMs([20000, 20000, 20000, 20000]));
  const jobUndo = await swipeRightSettled(page);
  await waitUntil(async () => (await queueBarState(page)).queue.includes(jobUndo.id), 4000, "undone job to appear in the queue");
  await page.evaluate(() => window.JobSwipe.undo());
  await delay(200);
  const afterUndo = await queueBarState(page);
  check("undo drops a queued like", !afterUndo.queue.includes(jobUndo.id), JSON.stringify(afterUndo.queue));

  // A rejected key should use the error tone and not auto-retry.
  const authLogStart = readLog().length;
  await hookControl({ failNext: 5, failStatus: 401, delayMs: 40 });
  await page.evaluate(() => window.JobSwipe.setBackoffMs([200, 200, 200, 200]));
  const jobAuth = await swipeRightSettled(page);
  const authUi = await waitUntil(async () => {
    const ui = await queueBarState(page);
    return !ui.hidden && ui.error ? ui : null;
  }, 4000, "auth error status");
  check("401 uses the error tone", authUi.error);
  check(
    "401 points the user to Settings",
    /Couldn't send.*Settings/i.test(authUi.text),
    authUi.text
  );
  const postsAt401 = readLog().slice(authLogStart).length;
  await delay(700);
  const postsAfterWait = readLog().slice(authLogStart).length;
  check("401 does not auto-retry", postsAfterWait === postsAt401, `${postsAt401} -> ${postsAfterWait}`);

  await hookControl({ failNext: 0, failStatus: 503, delayMs: 40 });
  await page.evaluate(() => window.JobSwipe.sendNow());
  await waitUntil(async () => {
    const ui = await queueBarState(page);
    return ui.hidden && ui.queue.length === 0 && !ui.sending;
  }, 4000, "Send now to flush a recovered 401");
  const authOk = readLog().slice(authLogStart).filter((p) => p.status === 200);
  check("Send now delivers the job after the key is accepted", authOk.some((p) => p.body?.job?.id === jobAuth.id));
  const authDone = await queueBarState(page);
  check("error tone clears after a successful send", authDone.hidden && !authDone.error);

  results.console = consoleLines;
  await browser.close();
} catch (err) {
  results.ok = false;
  results.error = String(err && err.stack ? err.stack : err);
  console.error(err);
} finally {
  stopAll();
  writeFileSync(REPORT, JSON.stringify(results, null, 2));
  console.log("\nReport:", REPORT);
  if (!results.ok) process.exit(1);
}
