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
