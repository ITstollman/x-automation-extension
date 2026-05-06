/**
 * XBoost panel app — login screen, drawer nav, page swap.
 * Exposed as window.mountXBoost(rootOrShadow). The content script hands us
 * the shadow root; we wire up everything inside that scope so nothing leaks
 * to the host page.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "xboost_session_v1";

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
    await typeAndSend("hi");
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

    async function refresh() {
      if (!isOnMessages()) {
        setStatus(root, "Open Messages first to load conversations.");
        $(root, "#convos-list").innerHTML = "";
        hiAllBtn?.classList.add("hidden");
        return;
      }
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

    const session = await readSession();
    if (session) showApp(root);
    else showLogin(root);
  }

  window.mountXBoost = mountXBoost;
})();
