/**
 * XBoost background service worker.
 * - Click the toolbar icon → toggle the floating widget on the active X tab.
 * - Cmd/Ctrl+Shift+E → reload the extension and refresh open X tabs.
 */

const X_HOST_PATTERN = /^https:\/\/(www\.)?(x|twitter)\.com\//;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url || !X_HOST_PATTERN.test(tab.url)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_WIDGET" });
  } catch (err) {
    console.warn("[XBoost] Could not toggle widget:", err.message);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "reload-extension") return;
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id)));
  chrome.runtime.reload();
});
