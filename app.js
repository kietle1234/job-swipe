/* Job Swipe — vanilla JS, no build step. */
(() => {
  "use strict";

  const STORAGE = {
    swiped: "jobswipe:swiped",
    settings: "jobswipe:settings",
    queue: "jobswipe:queue",
    filter: "jobswipe:filter",
  };
  const THRESHOLD = 100;
  const DEFAULT_AUTH_HEADER = "Authorization";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const els = {
    deck: $("#deck"),
    empty: $("#empty"),
    error: $("#error"),
    errorMsg: $("#error-msg"),
    progress: $("#progress"),
    undo: $("#undo-btn"),
    settingsBtn: $("#settings-btn"),
    settings: $("#settings"),
    backdrop: $("#backdrop"),
    settingsClose: $("#settings-close"),
    form: $("#settings-form"),
    webhookUrl: $("#webhook-url"),
    senderKey: $("#sender-key"),
    authHeader: $("#auth-header"),
    savedFlag: $("#saved-flag"),
    nope: $("#nope-btn"),
    like: $("#like-btn"),
    queueBar: $("#queue-bar"),
    queueLabel: $("#queue-label"),
    retryBtn: $("#retry-btn"),
    retryFromSettings: $("#retry-from-settings"),
    toast: $("#toast"),
  };

  /** @type {{id:string, company:string, title:string, pay:string, location:string, lane:string, highlights:string[], headsUp:string, url:string, ats:string, sample?:boolean}[]} */
  let allJobs = [];
  /** @type {{id:string, dir:"left"|"right", at:string, sent?:boolean}[]} */
  let swiped = loadJson(STORAGE.swiped, []);
  let filter = loadJson(STORAGE.filter, "All") || "All";
  let historyStack = []; // for undo: copies of swipe records
  let drag = null;
  let busy = false;
  let toastTimer = 0;
  let drainBusy = false;
  let authDenied = false;
  let retryTimer = 0;
  let failCount = 0;
  let backoffMs = [30_000, 60_000, 120_000, 300_000];

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getSettings() {
    const s = loadJson(STORAGE.settings, {}) || {};
    return {
      webhookUrl: String(s.webhookUrl || "").trim(),
      senderKey: String(s.senderKey || ""),
      authHeader: String(s.authHeader || DEFAULT_AUTH_HEADER).trim() || DEFAULT_AUTH_HEADER,
    };
  }
  function getQueue() {
    return loadJson(STORAGE.queue, []) || [];
  }
  function setQueue(q) {
    saveJson(STORAGE.queue, q);
    renderQueueBar();
  }

  function swipedIds() {
    return new Set(swiped.map((s) => s.id));
  }

  function visibleJobs() {
    const gone = swipedIds();
    return allJobs.filter((j) => {
      if (gone.has(j.id)) return false;
      if (filter && filter !== "All" && j.lane !== filter) return false;
      return true;
    });
  }

  function monogram(name) {
    const parts = String(name || "")
      .replace(/[^A-Za-z0-9 ]/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function isRemote(location) {
    return /remote/i.test(String(location || ""));
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function cardHtml(job) {
    const laneClass = job.lane === "Healthcare" ? "health" : "banking";
    const laneChip = job.lane === "Healthcare" ? "lane-health" : "lane-banking";
    const highlights = (job.highlights || [])
      .map((h) => `<li>${escapeHtml(h)}</li>`)
      .join("");
    const remote = isRemote(job.location)
      ? `<span class="chip remote">Remote</span>`
      : "";
    const sample = job.sample
      ? `<span class="chip sample">Sample</span>`
      : "";
    return `
      <div class="stamp stamp-like">LIKE</div>
      <div class="stamp stamp-nope">NOPE</div>
      <div class="card-scroll">
        <div class="card-head">
          <div class="mono ${laneClass}" aria-hidden="true">${escapeHtml(monogram(job.company))}</div>
          <div class="head-text">
            <p class="company">${escapeHtml(job.company)}</p>
            <h2 class="title">${escapeHtml(job.title)}</h2>
            <div class="badges">
              <span class="chip ${laneChip}">${escapeHtml(job.lane || "")}</span>
              ${remote}
              ${sample}
            </div>
          </div>
        </div>
        <p class="pay">${escapeHtml(job.pay || "")}</p>
        <p class="where">${escapeHtml(job.location || "")}</p>
        ${highlights ? `<p class="section-label">Highlights</p><ul class="highlights">${highlights}</ul>` : ""}
        ${job.headsUp ? `<div class="heads"><strong>Heads-up</strong>${escapeHtml(job.headsUp)}</div>` : ""}
      </div>
      <div class="posting">
        ${job.url ? `<a href="${escapeHtml(job.url)}" target="_blank" rel="noopener noreferrer">View posting</a>` : `<span></span>`}
        ${job.ats ? `<span class="ats">${escapeHtml(job.ats)}</span>` : ""}
      </div>
    `;
  }

  function renderDeck() {
    $$(".card", els.deck).forEach((c) => c.remove());
    const jobs = visibleJobs();
    const show = jobs.slice(0, 2);
    if (!show.length) {
      els.empty.hidden = allJobs.length === 0;
      setActionsEnabled(false);
    } else {
      els.empty.hidden = true;
      // render back card first, top card last (on top in DOM + z-index)
      show.reverse().forEach((job, i, arr) => {
        const isTop = i === arr.length - 1;
        const el = document.createElement("article");
        el.className = "card" + (isTop ? "" : " is-behind");
        el.dataset.id = job.id;
        el.setAttribute("role", "group");
        el.setAttribute("aria-label", `${job.title} at ${job.company}`);
        el.innerHTML = cardHtml(job);
        if (isTop) bindDrag(el, job);
        // z-index: top on top
        el.style.zIndex = String(isTop ? 2 : 1);
        els.deck.appendChild(el);
      });
      setActionsEnabled(true);
    }
    renderProgress();
    els.undo.disabled = swiped.length === 0;
  }

  function setActionsEnabled(on) {
    els.like.disabled = !on;
    els.nope.disabled = !on;
  }

  function renderProgress() {
    const remaining = visibleJobs().length;
    const liked = swiped.filter((s) => s.dir === "right").length;
    const skipped = swiped.filter((s) => s.dir === "left").length;
    const laneBit = filter === "All" ? "" : ` · ${filter}`;
    if (!allJobs.length) {
      els.progress.textContent = "Loading…";
      return;
    }
    els.progress.textContent = `${remaining} left · ${liked} liked · ${skipped} skipped${laneBit}`;
  }

  function renderQueueBar() {
    const n = getQueue().length;
    if (n === 0) {
      els.queueBar.hidden = true;
      els.queueBar.classList.remove("is-error");
      return;
    }
    els.queueBar.hidden = false;
    if (authDenied) {
      els.queueBar.classList.add("is-error");
      els.queueLabel.textContent =
        n === 1
          ? "Couldn't send — check the key in Settings"
          : `Couldn't send ${n} — check the key in Settings`;
    } else {
      els.queueBar.classList.remove("is-error");
      if (drainBusy) {
        els.queueLabel.textContent = n === 1 ? "Sending…" : `Sending ${n}…`;
      } else if (!getSettings().webhookUrl) {
        els.queueLabel.textContent =
          n === 1
            ? "Waiting to send — add a webhook in Settings"
            : `Waiting to send ${n} — add a webhook in Settings`;
      } else {
        els.queueLabel.textContent =
          n === 1
            ? "Waiting to send, retrying automatically"
            : `Waiting to send ${n}, retrying automatically`;
      }
    }
  }

  function topCard() {
    return $(".card:not(.is-behind)", els.deck);
  }

  function bindDrag(el, job) {
    const likeStamp = $(".stamp-like", el);
    const nopeStamp = $(".stamp-nope", el);

    const onPointerDown = (e) => {
      if (busy) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // Let links and the inner scroll area start a scroll; only drag from non-interactive parts,
      // but still allow a horizontal swipe anywhere except on links.
      if (e.target.closest("a, button")) return;
      const scroll = e.target.closest(".card-scroll");
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        dx: 0,
        dy: 0,
        decided: false, // became a swipe (not a scroll)
        job,
        el,
        likeStamp,
        nopeStamp,
        scroll,
        startScrollTop: scroll ? scroll.scrollTop : 0,
      };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    const onPointerMove = (e) => {
      if (!drag || drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        // If the gesture is clearly vertical, let the card scroll instead of swiping.
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
          drag = null;
          return;
        }
        drag.decided = true;
        el.classList.add("is-dragging");
      }
      drag.dx = dx;
      drag.dy = dy;
      const rot = dx / 14;
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
      const abs = Math.min(1, Math.abs(dx) / THRESHOLD);
      if (dx > 0) {
        likeStamp.style.opacity = String(abs);
        nopeStamp.style.opacity = "0";
      } else {
        nopeStamp.style.opacity = String(abs);
        likeStamp.style.opacity = "0";
      }
    };

    const onPointerUp = (e) => {
      if (!drag || drag.pointerId !== e.pointerId) return;
      const { dx, dy, decided } = drag;
      const jobRef = drag.job;
      drag = null;
      el.classList.remove("is-dragging");
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (!decided) {
        resetCardTransform(el);
        return;
      }
      if (dx > THRESHOLD) {
        flyOff(el, "right", dx, dy, jobRef);
      } else if (dx < -THRESHOLD) {
        flyOff(el, "left", dx, dy, jobRef);
      } else {
        snapBack(el);
      }
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
  }

  function resetCardTransform(el) {
    el.style.transform = "";
    const likeStamp = $(".stamp-like", el);
    const nopeStamp = $(".stamp-nope", el);
    if (likeStamp) likeStamp.style.opacity = "0";
    if (nopeStamp) nopeStamp.style.opacity = "0";
  }

  function snapBack(el) {
    el.style.transition = "transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)";
    el.style.transform = "translate(0, 0) rotate(0)";
    const likeStamp = $(".stamp-like", el);
    const nopeStamp = $(".stamp-nope", el);
    if (likeStamp) {
      likeStamp.style.transition = "opacity 0.2s ease";
      likeStamp.style.opacity = "0";
    }
    if (nopeStamp) {
      nopeStamp.style.transition = "opacity 0.2s ease";
      nopeStamp.style.opacity = "0";
    }
    const done = () => {
      el.style.transition = "";
      if (likeStamp) likeStamp.style.transition = "";
      if (nopeStamp) nopeStamp.style.transition = "";
      el.removeEventListener("transitionend", done);
    };
    el.addEventListener("transitionend", done);
  }

  function flyOff(el, dir, dx, dy, job) {
    if (busy) return;
    busy = true;
    const width = Math.max(window.innerWidth, 400);
    const endX = dir === "right" ? width * 1.15 : -width * 1.15;
    const rot = dir === "right" ? 22 : -22;
    const likeStamp = $(".stamp-like", el);
    const nopeStamp = $(".stamp-nope", el);
    if (dir === "right" && likeStamp) likeStamp.style.opacity = "1";
    if (dir === "left" && nopeStamp) nopeStamp.style.opacity = "1";
    el.style.transition = "transform 0.32s ease-in";
    el.style.transform = `translate(${endX}px, ${dy || 0}px) rotate(${rot}deg)`;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      el.removeEventListener("transitionend", finish);
      commitSwipe(job, dir);
      busy = false;
    };
    el.addEventListener("transitionend", finish);
    setTimeout(finish, 400);
  }

  function commitSwipe(job, dir) {
    const record = {
      id: job.id,
      dir,
      at: new Date().toISOString(),
      sent: false,
    };
    swiped.push(record);
    saveJson(STORAGE.swiped, swiped);
    historyStack.push(record);
    if (dir === "right") {
      sendApply(job, record);
    }
    renderDeck();
  }

  function buildHeaders(settings) {
    const headers = { "Content-Type": "application/json" };
    const key = settings.senderKey || "";
    const authName = settings.authHeader || DEFAULT_AUTH_HEADER;
    if (key) {
      const authValue =
        authName.toLowerCase() === "authorization" ? `Bearer ${key}` : `Bearer ${key}`;
      headers[authName] = authValue;
      headers["X-Webhook-Key"] = key;
    }
    return headers;
  }

  function payloadFor(job, swipedAt) {
    // Send the full job object plus action + timestamp.
    return {
      action: "apply",
      job: { ...job },
      swipedAt: swipedAt || new Date().toISOString(),
    };
  }

  function sendApply(job, record) {
    const payload = payloadFor(job, record && record.at);
    enqueue(payload);
    if (!getSettings().webhookUrl) {
      toast("No webhook set — queued");
    }
    requestDrain();
  }

  function postBodyFrom(payload) {
    return {
      action: payload && payload.action ? payload.action : "apply",
      job: payload && payload.job,
      swipedAt: payload && payload.swipedAt,
    };
  }

  function enqueue(payload) {
    const q = getQueue();
    // de-dupe by job id
    const id = payload && payload.job && payload.job.id;
    const next = id ? q.filter((p) => !(p.job && p.job.id === id)) : q.slice();
    next.push(payload);
    setQueue(next);
  }

  function clearRetryTimer() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = 0;
    }
  }

  function backoffDelay() {
    const idx = Math.max(0, Math.min(failCount - 1, backoffMs.length - 1));
    return backoffMs[idx] ?? 300_000;
  }

  function scheduleRetry() {
    clearRetryTimer();
    const wait = backoffDelay();
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      requestDrain({ immediate: true });
    }, wait);
    renderQueueBar();
  }

  function requestDrain(opts = {}) {
    const immediate = !!opts.immediate;
    if (drainBusy) {
      renderQueueBar();
      return;
    }
    const q = getQueue();
    if (!q.length) {
      failCount = 0;
      authDenied = false;
      clearRetryTimer();
      renderQueueBar();
      return;
    }
    if (!immediate && retryTimer) {
      renderQueueBar();
      return;
    }
    drainNext();
  }

  function sendNow() {
    const q = getQueue();
    if (!q.length) {
      toast("Nothing queued");
      return;
    }
    if (!getSettings().webhookUrl) {
      openSettings();
      toast("Add a webhook URL first");
      return;
    }
    authDenied = false;
    clearRetryTimer();
    requestDrain({ immediate: true });
  }

  function markSent(id) {
    if (!id) return;
    const rec = swiped.find((s) => s.id === id && s.dir === "right");
    if (rec) rec.sent = true;
    saveJson(STORAGE.swiped, swiped);
  }

  function stillQueued(payload) {
    const q = getQueue();
    const id = payload && payload.job && payload.job.id;
    if (id) return q.some((p) => p.job && p.job.id === id);
    return q.includes(payload) || (q[0] && q[0].swipedAt === payload.swipedAt);
  }

  function dropFromQueue(payload) {
    const id = payload && payload.job && payload.job.id;
    const q = getQueue();
    const next = id ? q.filter((p) => !(p.job && p.job.id === id)) : q.filter((p) => p !== payload);
    setQueue(next);
  }

  async function drainNext() {
    if (drainBusy) return;
    const settings = getSettings();
    const q = getQueue();
    if (!q.length) {
      failCount = 0;
      authDenied = false;
      clearRetryTimer();
      renderQueueBar();
      return;
    }
    if (!settings.webhookUrl) {
      renderQueueBar();
      return;
    }

    const payload = q[0];
    const body = postBodyFrom(payload);
    drainBusy = true;
    renderQueueBar();

    let status = 0;
    try {
      const res = await fetch(settings.webhookUrl, {
        method: "POST",
        headers: buildHeaders(settings),
        body: JSON.stringify(body),
      });
      status = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Undo may have dropped this like while the request was in flight.
      let applied = false;
      if (stillQueued(payload)) {
        markSent(body.job && body.job.id);
        dropFromQueue(payload);
        applied = true;
      }
      failCount = 0;
      authDenied = false;
      drainBusy = false;
      if (applied && !getQueue().length) toast("Sent to apply");
      requestDrain({ immediate: true });
    } catch (err) {
      drainBusy = false;
      console.warn("Apply POST failed:", err);
      // If the user already undid this like, don't hold later swipes on its backoff.
      if (!stillQueued(payload)) {
        if (!getQueue().length) {
          failCount = 0;
          authDenied = false;
          clearRetryTimer();
        }
        renderQueueBar();
        requestDrain({ immediate: true });
        return;
      }
      authDenied = status === 401 || status === 403;
      failCount += 1;
      if (authDenied) {
        clearRetryTimer();
        renderQueueBar();
      } else {
        scheduleRetry();
      }
    }
  }

  function undo() {
    if (!swiped.length || busy) return;
    const last = swiped.pop();
    saveJson(STORAGE.swiped, swiped);
    historyStack = historyStack.filter((h) => h !== last);
    // If that like is still sitting in the queue, drop it so we don't apply a skipped card later.
    if (last && last.dir === "right" && !last.sent) {
      const q = getQueue().filter((p) => !(p.job && p.job.id === last.id));
      setQueue(q);
      if (!q.length) {
        failCount = 0;
        authDenied = false;
        clearRetryTimer();
      }
    }
    renderDeck();
    if (last && last.dir === "right" && last.sent) {
      toast("Card restored — apply was already sent");
    } else {
      toast("Undo");
    }
  }

  function toast(msg) {
    els.toast.hidden = false;
    els.toast.textContent = msg;
    requestAnimationFrame(() => els.toast.classList.add("is-on"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("is-on");
      setTimeout(() => {
        if (!els.toast.classList.contains("is-on")) els.toast.hidden = true;
      }, 220);
    }, 2200);
  }

  function openSettings() {
    const s = getSettings();
    els.webhookUrl.value = s.webhookUrl;
    els.senderKey.value = s.senderKey;
    els.authHeader.value = s.authHeader;
    els.savedFlag.textContent = "";
    els.settings.hidden = false;
    els.backdrop.hidden = false;
    els.settings.classList.remove("is-closed");
    requestAnimationFrame(() => {
      els.settings.classList.add("is-on");
      els.backdrop.classList.add("is-on");
    });
    els.settingsBtn.setAttribute("aria-expanded", "true");
  }

  function closeSettings() {
    els.settings.classList.remove("is-on");
    els.backdrop.classList.remove("is-on");
    els.settingsBtn.setAttribute("aria-expanded", "false");
    setTimeout(() => {
      if (!els.settings.classList.contains("is-on")) {
        els.settings.classList.add("is-closed");
        els.settings.hidden = true;
        els.backdrop.hidden = true;
      }
    }, 280);
  }

  function saveSettings(ev) {
    ev.preventDefault();
    const webhookUrl = els.webhookUrl.value.trim();
    const senderKey = els.senderKey.value;
    const authHeader = els.authHeader.value.trim() || DEFAULT_AUTH_HEADER;
    saveJson(STORAGE.settings, { webhookUrl, senderKey, authHeader });
    els.savedFlag.textContent = "Saved on this device only.";
    toast("Settings saved");
    authDenied = false;
    clearRetryTimer();
    requestDrain({ immediate: true });
  }

  function setFilter(next) {
    filter = next;
    saveJson(STORAGE.filter, filter);
    $$(".lane").forEach((btn) => {
      const on = btn.dataset.lane === filter;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    renderDeck();
  }

  function triggerButton(dir) {
    if (busy) return;
    const el = topCard();
    const jobs = visibleJobs();
    if (!el || !jobs[0]) return;
    flyOff(el, dir, dir === "right" ? THRESHOLD : -THRESHOLD, 0, jobs[0]);
  }

  async function loadJobs() {
    try {
      const res = await fetch("jobs.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allJobs = Array.isArray(data) ? data : data.jobs || [];
      els.error.hidden = true;
      renderDeck();
    } catch (err) {
      els.error.hidden = false;
      els.empty.hidden = true;
      els.errorMsg.textContent = "Could not read jobs.json. If you're offline, try reopening once you've been online.";
      els.progress.textContent = "Unavailable";
      setActionsEnabled(false);
      console.warn(err);
    }
  }

  function onKey(e) {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) {
      if (e.key === "Escape") closeSettings();
      return;
    }
    if (e.key === "Escape" && els.settings.classList.contains("is-on")) {
      closeSettings();
      return;
    }
    if (els.settings.classList.contains("is-on")) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      triggerButton("right");
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      triggerButton("left");
    } else if (e.key === "u" || e.key === "U" || e.key === "Backspace") {
      e.preventDefault();
      undo();
    }
  }

  function bindUi() {
    els.like.addEventListener("click", () => triggerButton("right"));
    els.nope.addEventListener("click", () => triggerButton("left"));
    els.undo.addEventListener("click", undo);
    els.settingsBtn.addEventListener("click", openSettings);
    els.settingsClose.addEventListener("click", closeSettings);
    els.backdrop.addEventListener("click", closeSettings);
    els.form.addEventListener("submit", saveSettings);
    els.retryBtn.addEventListener("click", sendNow);
    els.retryFromSettings.addEventListener("click", sendNow);
    $$(".lane").forEach((btn) => {
      btn.addEventListener("click", () => setFilter(btn.dataset.lane));
    });
    document.addEventListener("keydown", onKey);
  }

  function registerSw() {
    if (!("serviceWorker" in navigator)) return;
    // Avoid registering during automated tests if ?nosw=1 is present.
    const params = new URLSearchParams(location.search);
    if (params.has("nosw")) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((err) => {
        console.warn("SW registration failed:", err);
      });
    });
  }

  function onOnlineOrVisible() {
    if (document.visibilityState && document.visibilityState !== "visible") return;
    if (!getQueue().length) return;
    if (authDenied) {
      renderQueueBar();
      return;
    }
    clearRetryTimer();
    requestDrain({ immediate: true });
  }

  // Expose a tiny test hook used by the headless check.
  window.JobSwipe = {
    getSettings,
    getQueue,
    visibleJobs: () => visibleJobs().slice(),
    swipeRight: () => triggerButton("right"),
    swipeLeft: () => triggerButton("left"),
    undo,
    ready: () => allJobs.length > 0,
    sendNow,
    isSending: () => drainBusy,
    setBackoffMs: (arr) => {
      if (Array.isArray(arr) && arr.length) backoffMs = arr.map(Number);
    },
  };

  bindUi();
  setFilter(filter);
  renderQueueBar();
  loadJobs();
  registerSw();
  window.addEventListener("online", onOnlineOrVisible);
  document.addEventListener("visibilitychange", onOnlineOrVisible);
  requestDrain({ immediate: true });
})();
