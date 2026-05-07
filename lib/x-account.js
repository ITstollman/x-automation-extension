/**
 * X account auto-registration. When a user is logged into X.com:
 * 1. Scrape their @handle from the DOM (left rail account switcher)
 * 2. If we're connected to backend AND haven't registered this handle yet,
 *    POST /api/accounts/connect to register
 * 3. Cache the resulting accountId in chrome.storage so other components
 *    (poller, history sync) can use it
 *
 * Runs once after the page settles. Re-runs if the handle changes (account
 * switch).
 */
(function () {
  "use strict";

  if (window.__xboostAccountMounted) return;
  window.__xboostAccountMounted = true;

  const LOG = (...args) => console.log("[XBoost account]", ...args);

  function scrapeHandle() {
    // X exposes the logged-in user via several paths. Most reliable:
    //   <a data-testid="AppTabBar_Profile_Link" href="/<handle>">
    const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (profileLink) {
      const href = profileLink.getAttribute("href") || "";
      const m = href.match(/^\/([^/?#]+)/);
      if (m) return m[1].toLowerCase();
    }
    // Fallback: side-nav user avatar with aria-label "Account menu"
    const avatar = document.querySelector('[data-testid^="UserAvatar-Container-"]');
    if (avatar) {
      const id = avatar.getAttribute("data-testid") || "";
      const m = id.match(/UserAvatar-Container-(.+)$/);
      if (m) return m[1].toLowerCase();
    }
    return null;
  }

  function scrapeDisplayName() {
    // The profile link's UserName testid contains display name + handle.
    const userName = document.querySelector('[data-testid="AppTabBar_Profile_Link"] [dir="ltr"] span');
    return (userName?.textContent || "").trim();
  }

  function scrapeAvatar() {
    const img = document.querySelector('a[data-testid="AppTabBar_Profile_Link"] img');
    return img?.getAttribute("src") || "";
  }

  let lastReportedHandle = null;

  async function registerIfNeeded() {
    if (!window.xboostBackend) return; // lib/api.js not loaded
    if (!(await window.xboostBackend.isConnected())) return; // user hasn't pasted a key yet

    const handle = scrapeHandle();
    if (!handle) return;
    if (handle === lastReportedHandle) return;

    LOG("registering @" + handle + " with backend");
    try {
      const res = await window.xboostBackend.connectAccount({
        handle,
        displayName: scrapeDisplayName(),
        avatar: scrapeAvatar(),
      });
      LOG("backend returned accountId:", res.accountId);
      await window.xboostBackend.setActiveAccount(res.accountId, handle);
      lastReportedHandle = handle;
    } catch (err) {
      console.error("[XBoost account] registration failed:", err.message);
    }
  }

  // First attempt after the X UI has likely rendered.
  setTimeout(registerIfNeeded, 1500);

  // Watch for handle changes (account switch). Throttle to one rAF.
  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      registerIfNeeded();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
