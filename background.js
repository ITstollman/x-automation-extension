/**
 * Xlift background service worker.
 *
 * Responsibilities:
 *   1. Toolbar icon → toggle the floating widget on the active X tab.
 *   2. Cmd/Ctrl+Shift+X → reload extension and open X tabs.
 *   3. Action poll loop — every POLL_INTERVAL_MS, ask the backend for the
 *      next due action for the active account and forward to the content
 *      script for execution. Reports outcome back to the backend.
 *   4. Heartbeat — pings the backend every HEARTBEAT_INTERVAL_MS so the
 *      dashboard knows the extension is online.
 */

const X_HOST_PATTERN = /^https:\/\/(www\.)?(x|twitter)\.com\//;
const POLL_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const STATE_KEY = "xlift_backend_v1";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url || !X_HOST_PATTERN.test(tab.url)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_WIDGET" });
  } catch (err) {
    console.warn("[Xlift bg] Could not toggle widget:", err.message);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "reload-extension") return;
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id)));
  chrome.runtime.reload();
});

// ─── Backend client (mirror of lib/api.js but for the service worker) ───

async function readState() {
  const out = await chrome.storage.local.get(STATE_KEY);
  return out[STATE_KEY] || {};
}

async function backendFetch(path, init = {}) {
  const s = await readState();
  if (!s.key) return null;
  const url = (s.apiUrl || "http://localhost:3500").replace(/\/+$/, "");
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${s.key}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function getActiveXTab() {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  // Prefer the most recently focused active tab if available.
  return tabs.find((t) => t.active) || tabs[0] || null;
}

// ─── Action poll loop ───────────────────────────────────────────────────

async function pollOnce() {
  try {
    const s = await readState();
    if (!s.key || !s.accountId) return;

    const result = await backendFetch(`/api/actions/next?accountId=${encodeURIComponent(s.accountId)}`);
    if (!result || !result.action) return;

    const action = result.action;
    console.log("[Xlift bg] dispatching action", action.id, action.type);

    const tab = await getActiveXTab();
    if (!tab) {
      // No X tab open — report a non-failure "deferred" so the backend can
      // re-queue. For now, mark failed so it doesn't block the queue.
      await reportAction(action.id, { ok: false, error: "No X tab open in browser" });
      return;
    }

    // Forward to content script for execution. The content script handles
    // the actual DOM interaction (typing, clicking send, etc.).
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "EXECUTE_ACTION", action });
    } catch (err) {
      await reportAction(action.id, { ok: false, error: `Content script unreachable: ${err.message}` });
      return;
    }

    await reportAction(action.id, response || { ok: false, error: "No response from content script" });
  } catch (err) {
    console.error("[Xlift bg] poll error:", err.message);
  }
}

async function reportAction(id, body) {
  try {
    await backendFetch(`/api/actions/${encodeURIComponent(id)}/report`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[Xlift bg] report failed:", err.message);
  }
}

async function heartbeatOnce() {
  try {
    const s = await readState();
    if (!s.key || !s.accountId) return;
    await backendFetch(`/api/accounts/${encodeURIComponent(s.accountId)}/heartbeat`, { method: "POST" });
  } catch (err) {
    // Quiet — heartbeats fail if backend is down, don't spam logs.
  }
}

// MV3 service workers can't use long-running setInterval reliably. Use
// chrome.alarms for the poll/heartbeat cadence.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("xlift-poll", { periodInMinutes: POLL_INTERVAL_MS / 60_000 });
  chrome.alarms.create("xlift-heartbeat", { periodInMinutes: HEARTBEAT_INTERVAL_MS / 60_000 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("xlift-poll", { periodInMinutes: POLL_INTERVAL_MS / 60_000 });
  chrome.alarms.create("xlift-heartbeat", { periodInMinutes: HEARTBEAT_INTERVAL_MS / 60_000 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "xlift-poll") pollOnce();
  else if (alarm.name === "xlift-heartbeat") heartbeatOnce();
});
