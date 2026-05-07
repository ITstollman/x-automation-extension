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

  async function sendDmAction({ recipientHandle, text }) {
    if (!recipientHandle) throw new Error("recipientHandle is required");
    if (!text) throw new Error("text is required");

    LOG("send-dm to @" + recipientHandle, "len=" + text.length);
    const textarea = await openDmComposerForHandle(recipientHandle);

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

  // Each handler receives the action's payload and returns
  //   { ok: true, result?: any } | { ok: false, error: string }
  const HANDLERS = {
    "send-dm": async (payload) => {
      try {
        const result = await sendDmAction(payload);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    "post": async (payload) => {
      return { ok: false, error: "post not yet implemented (Phase 4)" };
    },
    "like": async (payload) => {
      return { ok: false, error: "like not yet implemented (Phase 3)" };
    },
    "retweet": async (payload) => {
      return { ok: false, error: "retweet not yet implemented (Phase 3)" };
    },
    "comment": async (payload) => {
      return { ok: false, error: "comment not yet implemented (Phase 3)" };
    },
    "follow": async (payload) => {
      return { ok: false, error: "follow not yet implemented (Phase 3)" };
    },
    "search": async (payload) => {
      return { ok: false, error: "search not yet implemented (Phase 3)" };
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
