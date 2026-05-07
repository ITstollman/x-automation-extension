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

  // Each handler receives the action's payload and returns
  //   { ok: true, result?: any } | { ok: false, error: string }
  const HANDLERS = {
    "send-dm": async (payload) => {
      // Phase 1 will lift sidepanel.js's typeAndSend here.
      return { ok: false, error: "send-dm not yet implemented (Phase 1)" };
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
