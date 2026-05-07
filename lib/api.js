/**
 * XBoost extension ↔ backend client.
 *
 * Auth: long-lived "connection key" (xb_...) generated in the dashboard
 * and pasted into Settings → Connect to backend. Stored in
 * chrome.storage.local. Exposed via window.xboostBackend so other
 * content scripts (sidepanel.js, reply-suggestions.js, background.js)
 * can use it without re-implementing fetch boilerplate.
 */
(function () {
  "use strict";

  if (window.__xboostBackendMounted) return;
  window.__xboostBackendMounted = true;

  const STATE_KEY = "xboost_backend_v1";

  // Default points at local dev. User overrides in Settings.
  const DEFAULT_API_URL = "http://localhost:3500";

  async function readState() {
    try {
      const out = await chrome.storage.local.get(STATE_KEY);
      return out[STATE_KEY] || {};
    } catch {
      return {};
    }
  }

  async function writeState(patch) {
    const current = await readState();
    const next = { ...current, ...patch };
    try { await chrome.storage.local.set({ [STATE_KEY]: next }); } catch {}
    return next;
  }

  async function getConfig() {
    const s = await readState();
    return {
      apiUrl: (s.apiUrl || DEFAULT_API_URL).replace(/\/+$/, ""),
      key: s.key || null,
      userId: s.userId || null,
      accountId: s.accountId || null,
      handle: s.handle || null,
    };
  }

  async function fetchJson(path, init = {}) {
    const cfg = await getConfig();
    if (!cfg.key) throw new Error("Not connected to backend — paste a connection key in Settings");
    const res = await fetch(`${cfg.apiUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.key}`,
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

  // Try a key + (optional) custom apiUrl. On success, persist + return whoami.
  async function connect({ key, apiUrl }) {
    if (!key || !key.startsWith("xb_")) throw new Error("Key must start with xb_");
    const url = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
    const res = await fetch(`${url}/api/keys/whoami`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(`Could not verify key: ${msg}`);
    }
    const data = await res.json();
    await writeState({ key, apiUrl: url, userId: data.userId });
    return data;
  }

  async function disconnect() {
    await writeState({ key: null, userId: null, accountId: null, handle: null });
  }

  // High-level API
  const xboostBackend = {
    getConfig,
    connect,
    disconnect,
    isConnected: async () => Boolean((await getConfig()).key),

    whoami: () => fetchJson("/api/keys/whoami"),

    connectAccount: ({ handle, displayName, avatar }) =>
      fetchJson("/api/accounts/connect", {
        method: "POST",
        body: JSON.stringify({ handle, displayName, avatar }),
      }),
    listAccounts: () => fetchJson("/api/accounts"),
    heartbeat: (accountId) =>
      fetchJson(`/api/accounts/${encodeURIComponent(accountId)}/heartbeat`, { method: "POST" }),

    nextAction: (accountId) =>
      fetchJson(`/api/actions/next?accountId=${encodeURIComponent(accountId)}`),
    reportAction: (id, body) =>
      fetchJson(`/api/actions/${encodeURIComponent(id)}/report`, {
        method: "POST",
        body: JSON.stringify(body),
      }),

    // Persist active accountId locally so all components share the same
    // "this is the X account this browser session represents" pointer.
    setActiveAccount: (accountId, handle) =>
      writeState({ accountId, handle }),

    // Best-effort: mirror a manual extension-side action to backend
    // history so the dashboard sees it.
    recordHistory: (entry) =>
      fetchJson("/api/history", {
        method: "POST",
        body: JSON.stringify(entry),
      }),
  };

  window.xboostBackend = xboostBackend;
})();
