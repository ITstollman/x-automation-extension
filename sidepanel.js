/**
 * XBoost panel app — login screen, drawer nav, page swap.
 * Exposed as window.mountXBoost(rootOrShadow). The content script hands us
 * the shadow root; we wire up everything inside that scope so nothing leaks
 * to the host page.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "xboost_session_v1";
  const HISTORY_KEY = "xboost_history_v1";
  const HISTORY_MAX = 200;
  const BRAND_KEY = "xboost_brand_v1";
  const SETTINGS_KEY = "xboost_settings_v1";

  const DEFAULT_BRAND = {
    link: "",
    tagline: "",
    description: "",
    value: "",
    audience: "",
    tones: [],
    voiceNotes: "",
    replyLength: "medium",
    emojis: "sometimes",
    hashtags: "never",
    pov: "i",
    questions: "balanced",
    topicsInclude: "",
    topicsExclude: "",
    hardRules: "",
    examples: "",
    ctaLink: "",
    ctaBlurb: "",
  };

  function $(root, sel) { return root.querySelector(sel); }
  function $$(root, sel) { return Array.from(root.querySelectorAll(sel)); }

  async function readSession() {
    try {
      const out = await chrome.storage.local.get(STORAGE_KEY);
      return out[STORAGE_KEY] || null;
    } catch { return null; }
  }
  async function writeSession(value) {
    try { await chrome.storage.local.set({ [STORAGE_KEY]: value }); } catch {}
  }
  async function clearSession() {
    try { await chrome.storage.local.remove(STORAGE_KEY); } catch {}
  }

  // ─── History ─────────────────────────────────────────────────────────────

  async function readHistory() {
    try {
      const out = await chrome.storage.local.get(HISTORY_KEY);
      return Array.isArray(out[HISTORY_KEY]) ? out[HISTORY_KEY] : [];
    } catch { return []; }
  }

  async function logAction(action) {
    try {
      const history = await readHistory();
      history.unshift({ ...action, ts: Date.now() });
      if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
      await chrome.storage.local.set({ [HISTORY_KEY]: history });
    } catch (err) {
      console.error("[XBoost] logAction failed:", err);
    }
    // Best-effort mirror to backend so the dashboard's History page
    // reflects manual actions too (Hi-button sends, suggestion sends).
    // Non-blocking; ignores failures (no backend connected = silent skip).
    if (window.xboostBackend) {
      try {
        const cfg = await window.xboostBackend.getConfig();
        if (cfg.key && cfg.accountId) {
          await window.xboostBackend.recordHistory?.({
            accountId: cfg.accountId,
            ...action,
          });
        }
      } catch {}
    }
  }

  async function clearHistory() {
    try { await chrome.storage.local.remove(HISTORY_KEY); } catch {}
  }

  // Expose so reply-suggestions.js (sibling content script in the same
  // isolated world) can record actions too.
  window.xboostLogAction = logAction;

  function relativeTime(ts) {
    const diff = Date.now() - ts;
    const min = 60_000, hour = 3_600_000, day = 86_400_000;
    if (diff < 30_000) return "just now";
    if (diff < hour) return `${Math.floor(diff / min)}m ago`;
    if (diff < day) return `${Math.floor(diff / hour)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  const HISTORY_ICONS = {
    sent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>',
    suggestion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.937A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .963L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>',
    other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 2"/></svg>',
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function renderHistoryItem(action) {
    const li = document.createElement("li");
    li.className = "history-item";

    const iconClass = action.type === "sent" ? "is-sent"
      : action.type === "suggestion-used" ? "is-suggestion" : "";
    const iconSvg = action.type === "sent" ? HISTORY_ICONS.sent
      : action.type === "suggestion-used" ? HISTORY_ICONS.suggestion
      : HISTORY_ICONS.other;

    let line = "";
    let quote = "";
    if (action.type === "sent") {
      line = `Sent to <strong>${escapeHtml(action.target || "—")}</strong>`;
      quote = action.text ? `“${escapeHtml(action.text)}”` : "";
    } else if (action.type === "suggestion-used") {
      line = `Used suggestion in <strong>${escapeHtml(action.target || "—")}</strong>`;
      quote = action.text ? `“${escapeHtml(action.text)}”` : "";
    } else {
      line = escapeHtml(action.label || action.type || "Action");
      quote = action.text ? escapeHtml(action.text) : "";
    }

    li.innerHTML = `
      <span class="history-icon ${iconClass}">${iconSvg}</span>
      <div class="history-body">
        <div class="history-line">${line}</div>
        ${quote ? `<div class="history-quote">${quote}</div>` : ""}
        <div class="history-meta">${relativeTime(action.ts)}</div>
      </div>
    `;
    return li;
  }

  function renderHistorySkeletons(list, count = 5) {
    list.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const li = document.createElement("li");
      li.className = "history-item is-skel";
      // Mirror the real history-item layout (icon circle + 2-line body) so
      // the swap to data is visually quiet.
      li.innerHTML = `
        <span class="history-icon"><span class="skeleton skel-circle" style="width:14px;height:14px;"></span></span>
        <div class="history-body">
          <div class="skeleton skel-line skel-w-70" style="margin-bottom:6px;"></div>
          <div class="skeleton skel-line-sm skel-w-50" style="margin-bottom:6px;"></div>
          <div class="skeleton skel-line-sm skel-w-30"></div>
        </div>
      `;
      list.appendChild(li);
    }
  }

  async function renderHistory(root) {
    const list = $(root, "#history-list");
    const empty = $(root, "#history-empty");
    if (!list) return;
    empty?.classList.add("hidden");
    renderHistorySkeletons(list);
    const history = await readHistory();
    list.innerHTML = "";
    if (!history.length) {
      empty?.classList.remove("hidden");
      return;
    }
    empty?.classList.add("hidden");
    for (const action of history) list.appendChild(renderHistoryItem(action));
  }

  function wireHistory(root) {
    $(root, "#history-clear-btn")?.addEventListener("click", async () => {
      if (!confirm("Clear all history?")) return;
      await clearHistory();
      renderHistory(root);
    });

    // Live-refresh when history changes (e.g., reply-suggestions.js logs).
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[HISTORY_KEY]) return;
      const active = root.querySelector(".nav-item.active")?.getAttribute("data-page");
      if (active === "history") renderHistory(root);
    });
  }

  // Stub auth — real call goes to the backend. For the scaffold, accept any
  // non-empty key so you can click through to the app shell.
  async function authenticate(key) {
    await new Promise((r) => setTimeout(r, 300));
    if (!key || key.trim().length < 4) {
      throw new Error("Invalid access key. Check the key from your signup email.");
    }
    return { key: key.trim(), createdAt: Date.now() };
  }

  function showApp(root) {
    $(root, "#login-screen")?.classList.add("hidden");
    $(root, "#app")?.classList.remove("hidden");
  }
  function showLogin(root) {
    $(root, "#app")?.classList.add("hidden");
    $(root, "#login-screen")?.classList.remove("hidden");
  }

  function wireLogin(root) {
    const form = $(root, "#login-form");
    const input = $(root, "#login-key-input");
    const errEl = $(root, "#login-error");
    if (!form || !input) return;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl?.classList.add("hidden");
      const btn = $(root, "#login-submit-btn");
      btn?.setAttribute("disabled", "true");
      try {
        const session = await authenticate(input.value);
        await writeSession(session);
        input.value = "";
        showApp(root);
      } catch (err) {
        if (errEl) {
          errEl.textContent = err.message;
          errEl.classList.remove("hidden");
        }
      } finally {
        btn?.removeAttribute("disabled");
      }
    });
  }

  function wireDrawer(root) {
    const menuBtn = $(root, "#menu-btn");
    const closeBtn = $(root, "#drawer-close-btn");
    const drawer = $(root, "#drawer");
    const backdrop = $(root, "#drawer-backdrop");

    function open() {
      drawer?.classList.remove("hidden");
      backdrop?.classList.remove("hidden");
    }
    function close() {
      drawer?.classList.add("hidden");
      backdrop?.classList.add("hidden");
    }

    menuBtn?.addEventListener("click", open);
    closeBtn?.addEventListener("click", close);
    backdrop?.addEventListener("click", close);

    $$(root, ".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(root, ".nav-item").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const page = btn.getAttribute("data-page");
        $$(root, ".page").forEach((p) => {
          p.classList.toggle("hidden", p.getAttribute("data-page") !== page);
        });
        if (page === "history") renderHistory(root);
        close();
      });
    });
  }

  function wireAutoToggle(root) {
    const toggle = $(root, "#auto-toggle");
    if (!toggle) return;
    toggle.addEventListener("click", () => {
      const on = toggle.getAttribute("data-on") === "true";
      toggle.setAttribute("data-on", on ? "false" : "true");
      toggle.setAttribute("aria-pressed", on ? "false" : "true");
    });
  }

  function wireLogout(root) {
    $(root, "#logout-btn")?.addEventListener("click", async () => {
      await clearSession();
      showLogin(root);
    });
  }

  // Navigate inside X. Prefer SPA nav (click an existing nav anchor) so we
  // don't blow away the panel state. If no matching anchor is in the DOM,
  // fall back to a real navigation.
  function navigateInX(path) {
    const candidates = document.querySelectorAll('a[href]');
    for (const a of candidates) {
      const href = a.getAttribute('href');
      if (href === path || href === path + '/') {
        a.click();
        return true;
      }
    }
    location.href = new URL(path, location.origin).href;
    return false;
  }

  const ACTIONS = {
    "open-messages": () => navigateInX("/messages"),
  };

  function wireActions(root) {
    $$(root, ".action-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = btn.getAttribute("data-action");
        const fn = ACTIONS[name];
        if (!fn) return;
        btn.setAttribute("data-busy", "true");
        try { await fn(); }
        catch (err) { console.error(`[XBoost] action ${name} failed:`, err); }
        finally { btn.removeAttribute("data-busy"); }
      });
    });
  }

  // ─── Messages: top 5 conversations + send "hi" ──────────────────────────

  function isOnMessages() {
    const p = location.pathname;
    return p.startsWith("/messages") || p.startsWith("/i/chat");
  }

  // True for short relative timestamps X shows on inbox rows: "2h", "30m",
  // "5d", "Yesterday", "Just now", "Mon", "Apr 12", etc.
  function looksLikeTimestamp(s) {
    const t = s.trim();
    if (!t) return false;
    if (/^\d{1,3}\s*[smhdwy]$/i.test(t)) return true;
    if (/^(now|just now|yesterday)$/i.test(t)) return true;
    if (/^(mon|tue|wed|thu|fri|sat|sun)$/i.test(t)) return true;
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\d{0,2}$/i.test(t)) return true;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)) return true;
    return false;
  }

  function cleanAriaName(s) {
    if (!s) return "";
    // X often formats as "Conversation with John Doe" or
    // "Group conversation with Alice, Bob, Carol".
    return s
      .replace(/^Conversation with\s+/i, "")
      .replace(/^Group conversation with\s+/i, "")
      .replace(/^DM with\s+/i, "")
      .trim();
  }

  function isPlausibleName(s) {
    if (!s) return false;
    if (s.length > 120) return false;
    if (s.startsWith("@")) return false;
    if (looksLikeTimestamp(s)) return false;
    if (/^[·•・,\s]+$/.test(s)) return false;
    return true;
  }

  function extractConversationName(row) {
    // Strategy A — aria-description on the row. X formats it as
    // "Display Name, @handle, last message, time" (and similar for groups).
    // The first comma-separated chunk is the display / group name.
    const desc = row.getAttribute("aria-description");
    if (desc) {
      const first = desc.split(",")[0].trim();
      if (isPlausibleName(first)) return first;
    }

    // Strategy B — anchor aria-label.
    const link = row.querySelector('a[href^="/messages/"], a[href^="/i/chat/"]');
    if (link) {
      const aria = cleanAriaName(link.getAttribute("aria-label"));
      if (isPlausibleName(aria)) return aria;
    }

    // Strategy C — the bold div X uses for the display name in inbox rows.
    // Tailwind class "font-bold" is the most stable signal short of a
    // dedicated testid (which the row doesn't have).
    const boldDiv = row.querySelector('div.font-bold, div[class*="font-bold"]');
    if (boldDiv) {
      const txt = (boldDiv.textContent || "").replace(/\s+/g, " ").trim();
      if (isPlausibleName(txt)) return txt;
    }

    // Strategy D — avatar alt / aria-label, in case X ever sets a real name
    // (right now it's a generic "user avatar", which we'll reject below).
    const img = row.querySelector('img[alt]:not([alt=""])');
    if (img) {
      const alt = img.getAttribute("alt").trim();
      if (isPlausibleName(alt) && !/^user avatar$/i.test(alt) && !/^https?:\/\//.test(alt)) return alt;
    }
    const roleImg = row.querySelector('[role="img"][aria-label]');
    if (roleImg) {
      const al = roleImg.getAttribute("aria-label").trim();
      if (isPlausibleName(al)) return al;
    }

    // Strategy E — walk all text-bearing leaf nodes (spans + divs). Skip
    // handles, timestamps, punctuation, preview prefixes (`You:`, `Name:`),
    // and the bare token "You".
    const candidates = row.querySelectorAll("div, span");
    const debugTexts = [];
    for (const el of candidates) {
      // Only look at leaf-ish nodes — if a node has element children with
      // their own text, we'll prefer the children.
      const hasElementChildren = Array.from(el.children).some((c) => c.textContent && c.textContent.trim());
      if (hasElementChildren) continue;
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!txt) continue;
      debugTexts.push(txt);
      if (!isPlausibleName(txt)) continue;
      if (txt.endsWith(":") && txt.length < 30) continue;
      if (/^you$/i.test(txt)) continue;
      return txt;
    }

    LOG("extractConversationName found nothing — leaf texts:", debugTexts);
    return null;
  }

  // Dump every signal we use (or might use) for naming a conversation row,
  // so the user can paste it back when extraction misbehaves.
  function dumpRowStructure(row, idx) {
    const link = row.querySelector('a[href^="/messages/"], a[href^="/i/chat/"]');
    const imgs = Array.from(row.querySelectorAll("img[alt]")).map((i) => ({
      alt: i.getAttribute("alt"),
      src: (i.getAttribute("src") || "").slice(0, 80),
    }));
    const roleImgs = Array.from(row.querySelectorAll('[role="img"]')).map((e) => ({
      ariaLabel: e.getAttribute("aria-label"),
      tag: e.tagName,
    }));
    const spans = Array.from(row.querySelectorAll("span"))
      .map((s) => ({
        text: (s.textContent || "").replace(/\s+/g, " ").trim(),
        parentTag: s.parentElement?.tagName,
        parentTestid: s.parentElement?.getAttribute("data-testid") || null,
        dir: s.getAttribute("dir") || s.parentElement?.getAttribute("dir") || null,
      }))
      .filter((s) => s.text);
    const ariaNodes = Array.from(row.querySelectorAll("[aria-label]"))
      .slice(0, 10)
      .map((e) => ({ tag: e.tagName, testid: e.getAttribute("data-testid"), label: e.getAttribute("aria-label") }));

    console.groupCollapsed(`[XBoost] row #${idx + 1} structure dump`);
    console.log("testid:", row.getAttribute("data-testid"));
    console.log("href:", link?.getAttribute("href"));
    console.log("link aria-label:", link?.getAttribute("aria-label"));
    console.log("link title:", link?.getAttribute("title"));
    console.log("imgs[alt]:", imgs);
    console.log("[role=img] aria-labels:", roleImgs);
    console.log("all [aria-label] nodes (first 10):");
    console.table(ariaNodes);
    console.log("spans in DOM order:");
    console.table(spans);
    console.log("outerHTML (first 2000 chars):", row.outerHTML.slice(0, 2000));
    console.groupEnd();
  }

  function scrapeConversations(limit = 5) {
    // X exposes inbox rows under [data-testid="dm-conversation-item-<id>"]
    // on /i/chat/* and /messages/*. Use those directly — more reliable than
    // walking anchors, and the row contains everything we need.
    const rows = document.querySelectorAll('[data-testid^="dm-conversation-item-"]');
    LOG("scrapeConversations — testid rows found:", rows.length);

    const skipPaths = new Set([
      "/messages", "/messages/compose",
      "/i/chat", "/i/chat/compose",
    ]);
    const seen = new Set();
    const out = [];

    let idx = 0;
    for (const row of rows) {
      if (out.length >= limit) break;

      const link = row.querySelector('a[href^="/messages/"], a[href^="/i/chat/"]');
      if (!link) { LOG("row has no link, skipping"); continue; }
      const href = link.getAttribute("href");
      if (!href || skipPaths.has(href)) continue;
      if (href.endsWith("/info") || href.endsWith("/participants")) continue;
      if (seen.has(href)) continue;

      dumpRowStructure(row, idx);

      const name = extractConversationName(row)
        || href.replace(/^\/[^/]+\/[^/]+\//, "")
        || href;
      LOG(`row #${idx + 1} →`, { href, extractedName: name });

      seen.add(href);
      out.push({ href, name });
      idx++;
    }

    // Fallback for layouts where the testid is missing — walk anchors only.
    if (out.length === 0) {
      LOG("no testid rows; falling back to anchor scan");
      const anchors = document.querySelectorAll(
        'a[href^="/messages/"], a[href^="/i/chat/"]'
      );
      for (const a of anchors) {
        if (out.length >= limit) break;
        const href = a.getAttribute("href");
        if (!href || skipPaths.has(href)) continue;
        if (href.endsWith("/info") || href.endsWith("/participants")) continue;
        if (seen.has(href)) continue;
        const name = extractConversationName(a) || a.textContent.replace(/\s+/g, " ").trim().slice(0, 40) || href;
        seen.add(href);
        out.push({ href, name });
      }
    }

    LOG("scrapeConversations result:", out);
    return out;
  }

  const LOG = (...args) => console.log("[XBoost]", ...args);
  const WARN = (...args) => console.warn("[XBoost]", ...args);

  // Log every data-testid that *might* be the DM composer or send button so
  // we can see what X actually renders on this URL shape.
  function probeComposerDom(label) {
    const all = document.querySelectorAll("[data-testid]");
    const interesting = [];
    all.forEach((el) => {
      const id = el.getAttribute("data-testid");
      if (!id) return;
      if (/dm|compose|send|message|tweet/i.test(id)) {
        interesting.push({
          testid: id,
          tag: el.tagName,
          contenteditable: el.getAttribute("contenteditable"),
          ariaDisabled: el.getAttribute("aria-disabled"),
          visible: !!(el.offsetWidth || el.offsetHeight),
        });
      }
    });
    LOG(`probe(${label}) — relevant data-testid count: ${interesting.length}`);
    if (interesting.length) console.table(interesting);
    // Also count contenteditable nodes — sometimes the composer drops the
    // testid but is still the only contenteditable on the page.
    const ce = document.querySelectorAll('[contenteditable="true"]');
    LOG(`probe(${label}) — contenteditable[true] count: ${ce.length}`);
  }

  async function waitForAny(selectors, timeoutMs = 6000, label = "") {
    const start = Date.now();
    let attempts = 0;
    while (Date.now() - start < timeoutMs) {
      attempts++;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          LOG(`waitForAny(${label}) hit "${sel}" after ${attempts} attempts (${Date.now() - start}ms)`);
          return { el, selector: sel };
        }
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    LOG(`waitForAny(${label}) TIMEOUT after ${timeoutMs}ms; tried ${selectors.length} selectors`);
    return null;
  }

  // X uses different composer DOM on different routes. /i/chat/* uses a real
  // <textarea data-testid="dm-composer-textarea">; older /messages/* used a
  // Draft.js contenteditable with testid "dmComposerTextInput".
  const INPUT_SELECTORS = [
    '[data-testid="dm-composer-textarea"]',
    '[data-testid="dmComposerTextInput"]',
    '[data-testid="messageComposerTextInput"]',
    'textarea[aria-label*="message" i]',
    'div[role="textbox"][contenteditable="true"][aria-label*="message" i]',
    'div[role="textbox"][contenteditable="true"]',
  ];
  const SEND_SELECTORS = [
    '[data-testid="dm-composer-send-button"]',
    '[data-testid="dmComposerSendButton"]',
    '[data-testid="dm-composer-form"] button[type="submit"]',
    '[data-testid="dm-composer-form"] [role="button"][aria-label*="send" i]',
    '[data-testid="messageComposerSendButton"]',
    'button[aria-label*="send" i]',
  ];

  // Set the value of a React-controlled <textarea>/<input> in a way that
  // React notices. React monkey-patches the native value setter; calling the
  // *original* native setter and then firing an `input` event is the only
  // path that updates React's internal value tracker.
  function setReactValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function typeAndSend(text) {
    LOG("typeAndSend start, target text:", JSON.stringify(text));
    LOG("location:", location.pathname);
    probeComposerDom("before-input");

    const inputHit = await waitForAny(INPUT_SELECTORS, 6000, "input");
    if (!inputHit) {
      probeComposerDom("input-not-found");
      throw new Error("DM input not found");
    }
    const input = inputHit.el;
    const isTextarea = input.tagName === "TEXTAREA" || input.tagName === "INPUT";
    LOG("input element:", input, "tagName:", input.tagName, "isTextareaPath:", isTextarea, "contenteditable:", input.getAttribute("contenteditable"));

    input.focus();
    LOG("input focused, document.activeElement is input?", document.activeElement === input);

    if (isTextarea) {
      LOG("typing path: native value setter + input event");
      setReactValue(input, text);
      LOG("after setReactValue, input.value:", JSON.stringify(input.value));
    } else {
      // contenteditable path
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      LOG("typing path: execCommand insertText");
      const inserted = document.execCommand("insertText", false, text);
      LOG("execCommand returned:", inserted, "input.textContent:", JSON.stringify(input.textContent));
      if (!inserted || !input.textContent.includes(text)) {
        WARN("execCommand failed — dispatching InputEvent fallback");
        input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }));
        input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
        LOG("after fallback, input.textContent:", JSON.stringify(input.textContent));
      }
    }

    // Give React a tick to render the send button before re-probing.
    await new Promise((r) => setTimeout(r, 200));
    probeComposerDom("after-input");

    const sendHit = await waitForAny(SEND_SELECTORS, 4000, "send");
    if (sendHit) {
      const sendBtn = sendHit.el;
      LOG("send button:", sendBtn, "aria-disabled:", sendBtn.getAttribute("aria-disabled"), "disabled:", sendBtn.disabled);
      for (let i = 0; i < 30; i++) {
        const disabled = sendBtn.getAttribute("aria-disabled") === "true" || sendBtn.disabled;
        if (!disabled) break;
        if (i === 0) LOG("send button starts disabled, waiting…");
        await new Promise((r) => setTimeout(r, 60));
      }
      const stillDisabled = sendBtn.getAttribute("aria-disabled") === "true" || sendBtn.disabled;
      LOG("after wait, send button disabled?", stillDisabled);
      if (!stillDisabled) {
        LOG("clicking send button");
        sendBtn.click();
        LOG("send button clicked");
        return;
      }
      WARN("send button stayed disabled — falling through to form submit");
    } else {
      WARN("no send button found — falling through to form submit");
    }

    // Fallback 1: submit the form directly.
    const form = document.querySelector('[data-testid="dm-composer-form"]') || input.closest("form");
    if (form && typeof form.requestSubmit === "function") {
      LOG("calling form.requestSubmit()");
      try {
        form.requestSubmit();
        LOG("form.requestSubmit() returned");
        return;
      } catch (err) {
        WARN("form.requestSubmit() threw:", err);
      }
    } else {
      WARN("no form to submit on; form:", form);
    }

    // Fallback 2: Enter keydown on the input.
    LOG("dispatching Enter keydown on input as last resort");
    const enter = new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    });
    const accepted = input.dispatchEvent(enter);
    LOG("Enter dispatch accepted:", accepted);
    if (!accepted) return;

    throw new Error("Could not submit the message (no send button, form submit, or Enter worked)");
  }

  async function sendHiTo(conversation) {
    LOG("sendHiTo:", conversation);
    const link = document.querySelector(`a[href="${conversation.href}"]`);
    if (!link) {
      WARN("anchor for", conversation.href, "not in DOM, hard-navigating");
      location.href = conversation.href;
      throw new Error("Reloaded to reach conversation; click again.");
    }
    LOG("found anchor, clicking to SPA-navigate to", conversation.href);
    link.click();
    // Give X a beat to render the chat pane.
    await new Promise((r) => setTimeout(r, 400));
    LOG("post-nav location:", location.pathname);
    // Use the chip-suggestion send pipeline (the one that actually works).
    // Exposed by reply-suggestions.js as window.xboostSendDirectly.
    if (typeof window.xboostSendDirectly !== "function") {
      throw new Error("Send helper not available — refresh the X tab and try again.");
    }
    const ok = await window.xboostSendDirectly("hi");
    if (!ok) throw new Error("Send didn't go through.");
    logAction({
      type: "sent",
      target: conversation.name,
      text: "hi",
      href: conversation.href,
    });
  }

  function renderConversations(root, conversations) {
    const list = $(root, "#convos-list");
    if (!list) return;
    list.innerHTML = "";
    conversations.forEach((c, i) => {
      const li = document.createElement("li");
      li.className = "convo-item";
      const num = document.createElement("span");
      num.className = "convo-num";
      num.textContent = String(i + 1);
      const name = document.createElement("span");
      name.className = "convo-name";
      name.title = c.name;
      name.textContent = c.name;
      const btn = document.createElement("button");
      btn.className = "convo-hi";
      btn.type = "button";
      btn.textContent = "Hi";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        const prev = btn.textContent;
        btn.textContent = "…";
        try {
          await sendHiTo(c);
          btn.classList.add("is-ok");
          btn.textContent = "Sent";
        } catch (err) {
          btn.classList.add("is-err");
          btn.textContent = "Fail";
          setStatus(root, err.message);
        } finally {
          setTimeout(() => {
            btn.classList.remove("is-ok", "is-err");
            btn.textContent = prev;
            btn.disabled = false;
          }, 2000);
        }
      });
      li.appendChild(num);
      li.appendChild(name);
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function setStatus(root, text) {
    const el = $(root, "#convos-status");
    if (el) el.textContent = text || "";
  }

  function wireMessages(root) {
    const refreshBtn = $(root, "#convos-refresh-btn");
    const hiAllBtn = $(root, "#convos-hi-all-btn");
    let cached = [];

    function renderConvoSkeletons(count = 5) {
      const list = $(root, "#convos-list");
      if (!list) return;
      list.innerHTML = "";
      for (let i = 0; i < count; i++) {
        const li = document.createElement("li");
        li.className = "convo-item is-skel";
        li.innerHTML = `
          <span class="convo-num"><span class="skeleton skel-line-sm" style="width:12px;"></span></span>
          <span class="convo-name"><span class="skeleton skel-line skel-w-70"></span></span>
          <span class="skeleton" style="flex-shrink:0;width:54px;height:24px;border-radius:999px;"></span>
        `;
        list.appendChild(li);
      }
    }

    async function refresh() {
      if (!isOnMessages()) {
        setStatus(root, "Open Messages first to load conversations.");
        $(root, "#convos-list").innerHTML = "";
        hiAllBtn?.classList.add("hidden");
        return;
      }
      // Show skeletons while we wait for X to settle and the scrape to land.
      renderConvoSkeletons(5);
      setStatus(root, "Loading conversations…");
      hiAllBtn?.classList.add("hidden");
      // Give X a beat to render its list if we just navigated.
      const found = scrapeConversations(5);
      if (found.length === 0) {
        // One retry after a short wait — X often renders DMs lazily.
        await new Promise((r) => setTimeout(r, 600));
        cached = scrapeConversations(5);
      } else {
        cached = found;
      }
      renderConversations(root, cached);
      if (cached.length === 0) {
        setStatus(root, "No conversations found in the inbox.");
        hiAllBtn?.classList.add("hidden");
      } else {
        setStatus(root, `Found ${cached.length} conversation${cached.length > 1 ? "s" : ""}.`);
        hiAllBtn?.classList.remove("hidden");
      }
    }

    refreshBtn?.addEventListener("click", refresh);

    hiAllBtn?.addEventListener("click", async () => {
      if (!cached.length) return;
      hiAllBtn.disabled = true;
      let done = 0;
      for (const c of cached) {
        try {
          setStatus(root, `Sending "hi" to ${c.name}…`);
          await sendHiTo(c);
          done++;
          // Small breathing room between sends so X doesn't rate-limit us.
          await new Promise((r) => setTimeout(r, 900));
        } catch (err) {
          setStatus(root, `Stopped at "${c.name}": ${err.message}`);
          hiAllBtn.disabled = false;
          return;
        }
      }
      hiAllBtn.disabled = false;
      setStatus(root, `Done. Sent "hi" to ${done}/${cached.length}.`);
    });

    // Auto-refresh once on mount if we're already on /messages.
    if (isOnMessages()) setTimeout(refresh, 400);
  }

  // ─── Brand profile ───────────────────────────────────────────────────────

  async function readBrand() {
    try {
      const out = await chrome.storage.local.get(BRAND_KEY);
      return { ...DEFAULT_BRAND, ...(out[BRAND_KEY] || {}) };
    } catch { return { ...DEFAULT_BRAND }; }
  }

  async function writeBrand(data) {
    try { await chrome.storage.local.set({ [BRAND_KEY]: data }); }
    catch (err) { console.error("[XBoost] writeBrand failed:", err); throw err; }
  }

  function brandFieldMap(root) {
    return {
      link: $(root, "#brand-link"),
      tagline: $(root, "#brand-tagline"),
      description: $(root, "#brand-description"),
      value: $(root, "#brand-value"),
      audience: $(root, "#brand-audience"),
      voiceNotes: $(root, "#brand-voice-notes"),
      topicsInclude: $(root, "#brand-topics-include"),
      topicsExclude: $(root, "#brand-topics-exclude"),
      hardRules: $(root, "#brand-hard-rules"),
      examples: $(root, "#brand-examples"),
      ctaLink: $(root, "#brand-cta-link"),
      ctaBlurb: $(root, "#brand-cta-blurb"),
    };
  }

  function applyBrand(root, data) {
    const fields = brandFieldMap(root);
    for (const [key, el] of Object.entries(fields)) {
      if (el) el.value = data[key] ?? "";
    }
    // Tones (chips)
    const tones = new Set(data.tones || []);
    $$(root, "#brand-tones .brand-chip").forEach((chip) => {
      const v = chip.getAttribute("data-value");
      const on = tones.has(v);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    });
    // Radio groups
    ["replyLength", "emojis", "hashtags", "pov", "questions"].forEach((name) => {
      const value = data[name];
      $$(root, `input[name="${name}"]`).forEach((input) => {
        input.checked = input.value === value;
      });
    });
  }

  function collectBrand(root) {
    const fields = brandFieldMap(root);
    const data = { ...DEFAULT_BRAND };
    for (const [key, el] of Object.entries(fields)) {
      if (el) data[key] = el.value.trim();
    }
    data.tones = $$(root, "#brand-tones .brand-chip[aria-pressed='true']")
      .map((chip) => chip.getAttribute("data-value"));
    ["replyLength", "emojis", "hashtags", "pov", "questions"].forEach((name) => {
      const checked = $(root, `input[name="${name}"]:checked`);
      if (checked) data[name] = checked.value;
    });
    return data;
  }

  function flashBrandStatus(root, message, kind) {
    const el = $(root, "#brand-save-status");
    if (!el) return;
    el.textContent = message;
    el.className = "brand-save-status";
    if (kind === "ok") el.classList.add("is-ok");
    else if (kind === "err") el.classList.add("is-err");
    el.classList.remove("hidden");
    clearTimeout(flashBrandStatus._t);
    flashBrandStatus._t = setTimeout(() => {
      el.classList.add("hidden");
    }, 2500);
  }

  const BRAND_TONE_VOCAB = [
    "warm", "witty", "professional", "bold", "playful", "direct",
    "sharp", "formal", "curious", "confident", "friendly", "contrarian",
  ];

  // Calls Gemini (via the shared window.xboostCallGemini exposed by
  // reply-suggestions.js) to draft a brand profile from a URL. The model
  // grounds on whatever it knows of the hostname plus the user's
  // domain — if it doesn't recognize the brand, it infers from the name.
  async function generateBrandFromLink(url) {
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new Error("Paste a full URL starting with https://");
    }
    if (typeof window.xboostCallGemini !== "function") {
      throw new Error("AI not available. Open the side panel from an x.com tab so suggestions can load.");
    }

    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}

    const prompt = `You are a brand strategist drafting a starter brand profile for a small business or creator who's growing on X (Twitter).

The brand's website / handle: ${url}
Hostname: ${host}

Draft a concrete, specific profile. Use whatever you know about this brand from training; if you don't recognize it, infer from the name and domain what it most likely is and write something concrete a founder would actually agree with — not vague filler.

Return JSON with all of these fields:

IDENTITY
- tagline: one-line pitch (under 100 chars), in the brand's voice
- description: 2-3 sentences a stranger should walk away knowing
- value: 1-2 sentences on the unique wedge — what no one else does the same way
- audience: who they specifically serve ("indie SaaS founders" not "businesses")

VOICE
- tones: 3-5 tone words from this exact list: ${BRAND_TONE_VOCAB.join(", ")}
- voiceNotes: 1-2 sentences on phrases or words this brand likely uses or avoids

OPERATING RULES (each will land on its own line in a textarea)
- topicsInclude: 4-6 specific topics this brand would engage with on X. Each under 6 words. Examples: "indie SaaS launches", "Shopify theme dev", "early-stage GTM"
- topicsExclude: 3-5 topics they should stay out of. Each under 6 words. Examples: "politics", "crypto trading", "subtweet drama"
- hardRules: 3-5 short imperative rules they should never violate. Plain English, one rule per string. Examples: "Never call us AI-powered.", "Never promise specific revenue numbers.", "Never name competitors directly."

EXAMPLES
- examples: 3 short sample tweets (each under 240 chars) the brand could realistically post — concrete, in-voice, varied (one observation, one strong opinion, one helpful tip)

PROMOTE
- ctaLink: the URL this brand probably wants people to land on. Default to ${url} if there's no obvious signup/get-started page.
- ctaBlurb: a natural one-liner this brand could drop in a relevant conversation that mentions ctaLink. Should feel like a friend recommending, not an ad. Mention the URL or use "[link]" as placeholder.

Be specific, not generic. Avoid "innovative", "cutting-edge", "revolutionary", "game-changer", "synergy", "transform", "unlock", "empower".`;

    const schema = {
      type: "object",
      properties: {
        tagline: { type: "string" },
        description: { type: "string" },
        value: { type: "string" },
        audience: { type: "string" },
        tones: { type: "array", items: { type: "string" } },
        voiceNotes: { type: "string" },
        topicsInclude: { type: "array", items: { type: "string" } },
        topicsExclude: { type: "array", items: { type: "string" } },
        hardRules: { type: "array", items: { type: "string" } },
        examples: { type: "array", items: { type: "string" } },
        ctaLink: { type: "string" },
        ctaBlurb: { type: "string" },
      },
      required: [
        "tagline", "description", "value", "audience", "tones", "voiceNotes",
        "topicsInclude", "topicsExclude", "hardRules", "examples", "ctaBlurb",
      ],
    };

    const draft = await window.xboostCallGemini(prompt, schema, {
      temperature: 0.7,
      maxOutputTokens: 1800,
    });

    // Filter tones to known vocabulary so chip toggling still works.
    draft.tones = Array.isArray(draft.tones)
      ? draft.tones.map((t) => String(t).toLowerCase().trim()).filter((t) => BRAND_TONE_VOCAB.includes(t))
      : [];

    // Convert array responses into the multi-line strings the form expects.
    const toLines = (arr) => Array.isArray(arr)
      ? arr.map((s) => String(s).trim()).filter(Boolean).join("\n")
      : "";
    const toParagraphs = (arr) => Array.isArray(arr)
      ? arr.map((s) => String(s).trim()).filter(Boolean).join("\n\n")
      : "";

    draft.topicsInclude = toLines(draft.topicsInclude);
    draft.topicsExclude = toLines(draft.topicsExclude);
    draft.hardRules = toLines(draft.hardRules);
    draft.examples = toParagraphs(draft.examples);
    if (!draft.ctaLink) draft.ctaLink = url;

    return draft;
  }

  function wireBrand(root) {
    const generateBtn = $(root, "#brand-generate-btn");
    const linkInput = $(root, "#brand-link");
    const genStatus = $(root, "#brand-generate-status");
    const saveBtn = $(root, "#brand-save-btn");
    const resetBtn = $(root, "#brand-reset-btn");

    // Auto-save: any field change persists to chrome.storage.local after a
    // short debounce. So a refresh, side-panel re-mount, or extension reload
    // never loses anything; suggestions also pick up edits in real time.
    let autoSaveTimer = null;
    let autoSaveSuspended = false;
    async function autoSaveNow() {
      if (autoSaveSuspended) return;
      try {
        await writeBrand(collectBrand(root));
        flashBrandStatus(root, "Saved.", "ok");
      } catch (err) {
        flashBrandStatus(root, "Auto-save failed: " + (err.message || err), "err");
      }
    }
    function scheduleAutoSave() {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(autoSaveNow, 600);
    }

    // Toggle chips (also auto-save)
    $$(root, "#brand-tones .brand-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const on = chip.getAttribute("aria-pressed") === "true";
        chip.setAttribute("aria-pressed", on ? "false" : "true");
        scheduleAutoSave();
      });
    });

    // Auto-save on text input + radio change
    [
      "#brand-link", "#brand-tagline", "#brand-description", "#brand-value",
      "#brand-audience", "#brand-voice-notes", "#brand-topics-include",
      "#brand-topics-exclude", "#brand-hard-rules", "#brand-examples",
      "#brand-cta-link", "#brand-cta-blurb",
    ].forEach((sel) => {
      const el = $(root, sel);
      if (el) el.addEventListener("input", scheduleAutoSave);
    });
    $$(root, 'input[type="radio"]').forEach((radio) => {
      radio.addEventListener("change", scheduleAutoSave);
    });

    // Save
    saveBtn?.addEventListener("click", async () => {
      const data = collectBrand(root);
      saveBtn.disabled = true;
      try {
        await writeBrand(data);
        saveBtn.setAttribute("data-saved", "true");
        const prev = saveBtn.textContent;
        saveBtn.textContent = "Saved ✓";
        flashBrandStatus(root, "Brand profile saved.", "ok");
        setTimeout(() => {
          saveBtn.textContent = prev;
          saveBtn.removeAttribute("data-saved");
        }, 1800);
      } catch (err) {
        flashBrandStatus(root, "Couldn't save. " + (err.message || err), "err");
      } finally {
        saveBtn.disabled = false;
      }
    });

    // Reset
    resetBtn?.addEventListener("click", async () => {
      if (!confirm("Reset the entire brand profile? This can't be undone.")) return;
      try {
        await chrome.storage.local.remove(BRAND_KEY);
        autoSaveSuspended = true;
        try { applyBrand(root, { ...DEFAULT_BRAND }); }
        finally { setTimeout(() => { autoSaveSuspended = false; }, 50); }
        flashBrandStatus(root, "Brand profile reset.", "ok");
      } catch (err) {
        flashBrandStatus(root, "Couldn't reset. " + (err.message || err), "err");
      }
    });

    // Generate from link
    generateBtn?.addEventListener("click", async () => {
      const url = (linkInput?.value || "").trim();
      genStatus.textContent = "";
      genStatus.classList.remove("is-err");
      generateBtn.setAttribute("data-busy", "true");
      try {
        const draft = await generateBrandFromLink(url);
        // Merge into existing form values without overwriting non-empty fields.
        const current = collectBrand(root);
        const merged = { ...current, link: url };
        for (const [key, val] of Object.entries(draft)) {
          if (key === "tones") {
            // Add suggested tones, keep user picks too.
            merged.tones = Array.from(new Set([...(current.tones || []), ...val]));
          } else if (!current[key]) {
            merged[key] = val;
          }
        }
        autoSaveSuspended = true;
        try { applyBrand(root, merged); }
        finally { setTimeout(() => { autoSaveSuspended = false; }, 50); }
        // Auto-save so reply/DM suggestions pick up the brand right away,
        // and so manual edits afterward don't double-save back the original.
        await writeBrand(merged);
        genStatus.textContent = "Drafted and active. Edits below save automatically.";
        flashBrandStatus(root, "Brand profile generated and saved.", "ok");
      } catch (err) {
        genStatus.textContent = err.message || "Generate failed.";
        genStatus.classList.add("is-err");
      } finally {
        generateBtn.removeAttribute("data-busy");
      }
    });

    // Initial load: hydrate the form from storage, but suppress auto-save
    // while we're programmatically setting values so it doesn't echo.
    readBrand().then((data) => {
      autoSaveSuspended = true;
      try { applyBrand(root, data); }
      finally { setTimeout(() => { autoSaveSuspended = false; }, 50); }
    });
  }

  // ─── Settings ────────────────────────────────────────────────────────────

  async function readSettings() {
    try {
      const out = await chrome.storage.local.get(SETTINGS_KEY);
      return out[SETTINGS_KEY] || {};
    } catch { return {}; }
  }
  async function writeSettings(data) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: data });
  }

  function wireSettings(root) {
    const input = $(root, "#settings-gemini-key");
    const toggle = $(root, "#settings-gemini-toggle");
    const status = $(root, "#settings-gemini-status");
    if (!input) return;

    // Initial load
    readSettings().then((s) => {
      if (s.geminiApiKey) input.value = s.geminiApiKey;
    });

    // Show/hide toggle
    toggle?.addEventListener("click", () => {
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      toggle.textContent = isPassword ? "Hide" : "Show";
    });

    // Auto-save with debounce. Empty value clears the override (falls
    // back to the shared key in reply-suggestions.js).
    let saveTimer = null;
    input.addEventListener("input", () => {
      if (status) {
        status.textContent = "Saving…";
        status.setAttribute("data-state", "saving");
      }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          const current = await readSettings();
          const trimmed = input.value.trim();
          await writeSettings({ ...current, geminiApiKey: trimmed });
          if (status) {
            status.textContent = trimmed
              ? "Saved. Suggestions will use your key."
              : "Cleared. Falling back to the shared default key.";
            status.setAttribute("data-state", "ok");
          }
        } catch (err) {
          if (status) {
            status.textContent = "Couldn't save: " + (err.message || err);
            status.setAttribute("data-state", "err");
          }
        }
      }, 500);
    });

    wireBackendSettings(root);
  }

  function wireBackendSettings(root) {
    const urlInput = $(root, "#settings-backend-url");
    const keyInput = $(root, "#settings-backend-key");
    const toggleBtn = $(root, "#settings-backend-toggle");
    const status = $(root, "#settings-backend-status");
    const connectBtn = $(root, "#settings-backend-connect");
    const disconnectBtn = $(root, "#settings-backend-disconnect");
    if (!keyInput || !window.xboostBackend) return;

    function setStatus(text, state) {
      if (!status) return;
      status.textContent = text;
      status.setAttribute("data-state", state || "idle");
    }

    // Hydrate from current state.
    window.xboostBackend.getConfig().then((cfg) => {
      if (urlInput && cfg.apiUrl) urlInput.value = cfg.apiUrl;
      if (cfg.key) {
        keyInput.value = cfg.key;
        setStatus(cfg.handle ? `Connected as @${cfg.handle}` : `Connected (user ${cfg.userId || "?"})`, "ok");
      }
    });

    toggleBtn?.addEventListener("click", () => {
      const isPwd = keyInput.type === "password";
      keyInput.type = isPwd ? "text" : "password";
      toggleBtn.textContent = isPwd ? "Hide" : "Show";
    });

    connectBtn?.addEventListener("click", async () => {
      const key = keyInput.value.trim();
      const apiUrl = (urlInput?.value || "").trim();
      if (!key) return setStatus("Paste a key first.", "err");
      setStatus("Verifying…", "saving");
      connectBtn.disabled = true;
      try {
        const data = await window.xboostBackend.connect({ key, apiUrl: apiUrl || undefined });
        setStatus(`Connected — user ${data.userId}`, "ok");
      } catch (err) {
        setStatus(err.message || "Could not connect", "err");
      } finally {
        connectBtn.disabled = false;
      }
    });

    disconnectBtn?.addEventListener("click", async () => {
      await window.xboostBackend.disconnect();
      keyInput.value = "";
      setStatus("Disconnected.", "idle");
    });
  }

  async function mountXBoost(root) {
    if (!root) {
      console.error("[XBoost] mountXBoost called without a root");
      return;
    }
    wireLogin(root);
    wireDrawer(root);
    wireAutoToggle(root);
    wireLogout(root);
    wireActions(root);
    wireMessages(root);
    wireHistory(root);
    wireBrand(root);
    wireSettings(root);

    const session = await readSession();
    if (session) showApp(root);
    else showLogin(root);
  }

  window.mountXBoost = mountXBoost;
})();
