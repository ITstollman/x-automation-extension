/**
 * Action executor — content script that receives EXECUTE_ACTION messages
 * from background.js and runs the corresponding DOM interaction.
 *
 * Phase 0: protocol is wired, but the actual send-dm / post / engage
 * handlers are stubs that return a structured "not-implemented" error.
 * Phase 1+ replaces each stub with real DOM logic (we already have the
 * primitives in reply-suggestions.js's sendDirectly and sidepanel.js's
 * typeAndSend — they'll be lifted into this file).
 */
(function () {
  "use strict";

  if (window.__xboostExecutorMounted) return;
  window.__xboostExecutorMounted = true;

  const LOG = (...args) => console.log("[XBoost executor]", ...args);

  // ─── Shared DOM helpers (mirrors of patterns proven in reply-suggestions.js) ──

  function setReactValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    if (el._valueTracker?.setValue) el._valueTracker.setValue("");
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function waitFor(selectorOrFn, timeoutMs = 6000, label = "") {
    const test = typeof selectorOrFn === "function"
      ? selectorOrFn
      : () => document.querySelector(selectorOrFn);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = test();
      if (el) return el;
      await new Promise((r) => setTimeout(r, 80));
    }
    LOG(`waitFor(${label || selectorOrFn}) TIMEOUT after ${timeoutMs}ms`);
    return null;
  }

  async function waitForEnabledSendBtn(timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const btn = document.querySelector('[data-testid="dm-composer-send-button"]')
        || document.querySelector('[data-testid="dmComposerSendButton"]');
      if (btn) {
        const disabled = btn.disabled || btn.getAttribute("aria-disabled") === "true";
        if (!disabled) return btn;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    return null;
  }

  // Open the user's profile via SPA nav and click "Message". Returns once
  // the DM textarea is visible.
  async function openDmComposerForHandle(handle) {
    const profilePath = `/${handle}`;
    if (location.pathname.toLowerCase() !== profilePath.toLowerCase()) {
      // Try in-page anchor first; fallback to history navigation.
      const anchor = document.querySelector(`a[href="${profilePath}"]`);
      if (anchor) anchor.click();
      else {
        history.pushState({}, "", profilePath);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    }

    // Wait for the profile's "Message" button.
    const msgBtn = await waitFor('[data-testid="sendDMFromProfile"]', 8000, "sendDMFromProfile");
    if (!msgBtn) {
      // Some profiles don't allow DM (closed inbox or not following). The
      // testid simply won't render. Surface a clear error.
      throw new Error('No "Message" button on profile (DMs may be closed or you must follow first)');
    }
    msgBtn.click();

    // Wait for the DM composer to mount.
    const textarea = await waitFor('[data-testid="dm-composer-textarea"]', 8000, "composer-textarea");
    if (!textarea) throw new Error("DM composer didn't open after clicking Message");
    return textarea;
  }

  // Right-aligned bubble in the message list = sent by us; left-aligned =
  // received from them. Using the same heuristic reply-suggestions.js uses.
  function detectMessageSender(textEl, listEl) {
    if (!listEl) return "unknown";
    const bubble = textEl.closest('[data-testid^="message-"]') || textEl.parentElement;
    if (!bubble) return "unknown";
    const r = bubble.getBoundingClientRect();
    const lr = listEl.getBoundingClientRect();
    const distLeft = r.left - lr.left;
    const distRight = lr.right - r.right;
    return distRight < distLeft ? "me" : "them";
  }

  // Did the prospect ever reply in this conversation? Read the most recent
  // few message bubbles and check if any are from `them`.
  function prospectHasReplied() {
    const list = document.querySelector('[data-testid="dm-message-list"]');
    if (!list) return false;
    const messages = document.querySelectorAll('[data-testid^="message-text-"]');
    if (!messages.length) return false;
    // Walk from most recent backwards; if we see a `them` message, they replied.
    for (let i = messages.length - 1; i >= 0 && i >= messages.length - 12; i--) {
      if (detectMessageSender(messages[i], list) === "them") return true;
    }
    return false;
  }

  async function sendDmAction({ recipientHandle, text, skipIfReplied }) {
    if (!recipientHandle) throw new Error("recipientHandle is required");
    if (!text) throw new Error("text is required");

    LOG("send-dm to @" + recipientHandle, "len=" + text.length, "skipIfReplied=" + !!skipIfReplied);
    const textarea = await openDmComposerForHandle(recipientHandle);

    // Reply-detection gate: only relevant for follow-up steps where the
    // backend asks us to bail if the prospect has already responded.
    if (skipIfReplied) {
      // Brief pause for the message list to populate after composer mounts.
      await new Promise((r) => setTimeout(r, 600));
      if (prospectHasReplied()) {
        LOG("skipping — prospect already replied");
        return { skipped: true, reason: "replied" };
      }
    }

    textarea.focus();
    setReactValue(textarea, text);
    await new Promise((r) => requestAnimationFrame(r));

    const sendBtn = await waitForEnabledSendBtn(4000);
    if (!sendBtn) throw new Error("Send button never enabled");
    sendBtn.click();

    // Verify by waiting for the textarea to clear (X clears after send).
    const cleared = await waitFor(() => {
      const el = document.querySelector('[data-testid="dm-composer-textarea"]');
      return el && el.value === "" ? el : null;
    }, 5000, "textarea-clear");
    if (!cleared) throw new Error("Send didn't go through (textarea still has content)");

    return { sentTo: recipientHandle, text };
  }

  // ─── Auto Engage helpers ───────────────────────────────────────────────

  // Navigate the page to a URL via SPA when possible, hard nav otherwise.
  async function spaNav(href) {
    const a = document.querySelector(`a[href="${href}"]`);
    if (a) {
      a.click();
    } else {
      history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  // Click a real anchor that opens a tweet's detail page.
  async function openTweetByUrl(tweetUrl) {
    const path = new URL(tweetUrl, location.origin).pathname;
    if (location.pathname === path) return;
    await spaNav(path);
    await waitFor('article[data-testid="tweet"]', 8000, "tweet-article");
  }

  // Scrape the search results page for tweet articles. Returns up to N items.
  function scrapeTweets(maxN = 20) {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const out = [];
    for (const a of articles) {
      if (out.length >= maxN) break;
      // Tweet detail link is the timestamp <a> inside the article.
      const link = a.querySelector('a[href*="/status/"][role="link"], a[href*="/status/"] time')?.closest("a");
      const href = link?.getAttribute("href");
      if (!href) continue;
      const m = href.match(/\/status\/(\d+)/);
      if (!m) continue;
      const tweetId = m[1];

      // Author handle: "@username" link inside the tweet header.
      const authorLink = a.querySelector('[data-testid="User-Name"] a[href^="/"]');
      const authorHandle = authorLink?.getAttribute("href")?.replace(/^\//, "")?.split("/")[0] || null;

      const tweetText = a.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || "";

      // Engagement counts from button aria-labels (X uses "12 Likes" etc).
      const parseCount = (sel) => {
        const btn = a.querySelector(sel);
        const raw = btn?.getAttribute("aria-label") || "";
        const num = raw.match(/(\d[\d,\.]*[KkMm]?)/);
        if (!num) return 0;
        const s = num[1].replace(/,/g, "");
        const mult = /[Kk]$/.test(s) ? 1000 : /[Mm]$/.test(s) ? 1000000 : 1;
        return Math.round(parseFloat(s) * mult);
      };
      const likes = parseCount('[data-testid="like"]');
      const retweets = parseCount('[data-testid="retweet"]');

      // Age (rough): X shows relative time in the timestamp; we don't
      // parse it precisely, but exposing the title attribute lets the
      // server filter on max-age if it cares.
      const timeEl = a.querySelector("time");
      const tweetedAt = timeEl?.getAttribute("datetime") || null;
      const ageHours = tweetedAt
        ? (Date.now() - new Date(tweetedAt).getTime()) / 3600000
        : null;

      out.push({
        tweetId,
        tweetUrl: `https://x.com${href}`,
        authorHandle,
        tweetText,
        likes, retweets,
        tweetedAt, ageHours,
      });
    }
    return out;
  }

  async function searchAction({ query }) {
    if (!query) throw new Error("query is required");
    const url = `/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
    await spaNav(url);
    await waitFor('article[data-testid="tweet"]', 10000, "search-results");
    // Give the list a beat to populate.
    await new Promise((r) => setTimeout(r, 800));
    const tweets = scrapeTweets(20);
    LOG(`scraped ${tweets.length} tweets for "${query}"`);
    return { tweets };
  }

  // Find a tweet button by testid within the focused article. Tweet
  // detail page only has one [data-testid="tweet"], so this is fine.
  function findTweetButton(testid) {
    const article = document.querySelector('article[data-testid="tweet"]');
    if (!article) return null;
    return article.querySelector(`[data-testid="${testid}"]`);
  }

  function realClick(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, button: 0, clientX: cx, clientY: cy };
    el.dispatchEvent(new MouseEvent("mousedown", base));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.dispatchEvent(new MouseEvent("click", base));
  }

  async function likeAction({ tweetUrl }) {
    if (!tweetUrl) throw new Error("tweetUrl is required");
    await openTweetByUrl(tweetUrl);
    const btn = findTweetButton("like") || findTweetButton("unlike");
    if (!btn) throw new Error("Like button not found");
    if (btn.getAttribute("data-testid") === "unlike") return { alreadyLiked: true };
    realClick(btn);
    // Optimistic: X swaps testid from "like" to "unlike" on success.
    const flipped = await waitFor(() => findTweetButton("unlike"), 3000, "unlike-flip");
    if (!flipped) throw new Error("Like did not register");
    return { liked: true };
  }

  async function retweetAction({ tweetUrl }) {
    if (!tweetUrl) throw new Error("tweetUrl is required");
    await openTweetByUrl(tweetUrl);
    const btn = findTweetButton("retweet") || findTweetButton("unretweet");
    if (!btn) throw new Error("Retweet button not found");
    if (btn.getAttribute("data-testid") === "unretweet") return { alreadyRetweeted: true };
    realClick(btn);
    // X opens a popup menu — click "Repost".
    const confirm = await waitFor('[data-testid="retweetConfirm"]', 3000, "retweetConfirm");
    if (!confirm) throw new Error("Retweet confirm not shown");
    realClick(confirm);
    return { retweeted: true };
  }

  async function replyAction({ tweetUrl, text }) {
    if (!tweetUrl) throw new Error("tweetUrl is required");
    if (!text) throw new Error("text is required");
    await openTweetByUrl(tweetUrl);
    const replyBtn = findTweetButton("reply");
    if (!replyBtn) throw new Error("Reply button not found");
    realClick(replyBtn);

    const editor = await waitFor('[data-testid="tweetTextarea_0"]', 5000, "tweetTextarea_0");
    if (!editor) throw new Error("Reply editor didn't open");

    editor.focus();
    // Tweet composer is a contenteditable Draft.js editor — use insertText.
    const range = document.createRange();
    range.selectNodeContents(editor);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    document.execCommand("insertText", false, text);

    const sendBtn = await waitFor(() => {
      const b = document.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
      if (!b) return null;
      const disabled = b.disabled || b.getAttribute("aria-disabled") === "true";
      return disabled ? null : b;
    }, 4000, "tweetButton-enabled");
    if (!sendBtn) throw new Error("Reply send button never enabled");
    sendBtn.click();

    // Verify by waiting for the editor to clear/unmount.
    const cleared = await waitFor(() => {
      const e = document.querySelector('[data-testid="tweetTextarea_0"]');
      return !e || (e.textContent || "").trim() === "" ? true : null;
    }, 5000, "tweet-editor-clear");
    if (!cleared) throw new Error("Reply didn't go through");
    return { replied: true };
  }

  // Each handler receives the action's payload and returns
  //   { ok: true, result?: any } | { ok: false, error: string }
  const HANDLERS = {
    "send-dm": async (payload) => {
      try { return { ok: true, result: await sendDmAction(payload) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    "search": async (payload) => {
      try { return { ok: true, result: await searchAction(payload) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    "like": async (payload) => {
      try { return { ok: true, result: await likeAction(payload) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    "retweet": async (payload) => {
      try { return { ok: true, result: await retweetAction(payload) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    "reply": async (payload) => {
      try { return { ok: true, result: await replyAction(payload) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    "post": async (payload) => {
      return { ok: false, error: "post not yet implemented (Phase 4)" };
    },
    "follow": async (payload) => {
      return { ok: false, error: "follow not yet implemented" };
    },
    // Useful even at Phase 0: a no-op the backend can use to test the
    // poll → execute → report round trip.
    "ping": async (payload) => {
      LOG("ping received:", payload);
      return { ok: true, result: { echoed: payload, at: Date.now() } };
    },
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "EXECUTE_ACTION") return false;
    const action = message.action || {};
    const handler = HANDLERS[action.type];
    if (!handler) {
      sendResponse({ ok: false, error: `Unknown action type: ${action.type}` });
      return true;
    }
    LOG("executing", action.type, action.id);
    Promise.resolve(handler(action.payload || {}))
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true; // tell Chrome we'll send response asynchronously
  });
})();
