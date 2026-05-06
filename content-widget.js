/**
 * XBoost floating widget — content script.
 * The FAB lives on x.com / twitter.com pages; the panel hosts the same app
 * the (future) side panel would. We fetch sidepanel.html / sidepanel.css,
 * inject them into a Shadow DOM, then call window.mountXBoost(shadow).
 * One source of truth — no iframe, no duplication.
 */
(function () {
  "use strict";

  if (window.__xboostWidgetMounted) return;
  window.__xboostWidgetMounted = true;

  const LOGO_URL = chrome.runtime.getURL("icons/logo.png");
  const APP_HTML_URL = chrome.runtime.getURL("sidepanel.html");
  const APP_CSS_URL = chrome.runtime.getURL("sidepanel.css");

  const POS_KEY = "xboost_widget_pos_v1";
  const FAB_SIZE = 56;
  const EDGE_MARGIN = 12;
  const DRAG_THRESHOLD = 5;

  const FAB_STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .xb-widget {
      position: fixed;
      top: 20px;
      right: 20px;
      width: 56px;
      height: 56px;
      z-index: 2147483647;
      pointer-events: none;
    }
    .xb-widget * { pointer-events: auto; }

    .xb-fab {
      position: absolute;
      inset: 0;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: #fff;
      border: 1px solid rgba(0, 0, 0, 0.06);
      cursor: grab;
      padding: 0;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.10);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s;
      overflow: hidden;
      color: #000;
      touch-action: none;
      user-select: none;
    }
    .xb-fab:hover {
      transform: translateY(-2px) scale(1.05);
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.24), 0 2px 8px rgba(0, 0, 0, 0.12);
    }
    .xb-fab:active { transform: scale(0.95); }
    .xb-fab img {
      width: 38px;
      height: 38px;
      object-fit: contain;
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
      -webkit-user-drag: none;
    }
    .xb-widget.open .xb-fab img { transform: rotate(-8deg) scale(0.92); }
    .xb-widget.dragging { transition: none; }
    .xb-widget.dragging .xb-fab {
      cursor: grabbing;
      transform: scale(1.08);
      transition: transform 0.12s ease-out;
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.28), 0 4px 10px rgba(0, 0, 0, 0.14);
    }
    .xb-widget.dragging .xb-fab-pulse { display: none; }
    .xb-fab-pulse {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.18);
      animation: xb-pulse 2.4s ease-out infinite;
      z-index: -1;
      pointer-events: none;
    }
    .xb-widget.open .xb-fab-pulse { animation: none; opacity: 0; }
    @keyframes xb-pulse {
      0% { transform: scale(1); opacity: 0.5; }
      100% { transform: scale(1.6); opacity: 0; }
    }

    .xb-panel {
      position: absolute;
      top: 76px;
      right: 0;
      width: 400px;
      max-width: calc(100vw - 40px);
      height: min(640px, calc(100vh - 110px));
      background: #fafafa;
      border: 1px solid rgba(0, 0, 0, 0.06);
      border-radius: 16px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.20), 0 4px 12px rgba(0, 0, 0, 0.08);
      overflow: hidden;
      transform: translateY(-20px) scale(0.96);
      opacity: 0;
      transform-origin: top right;
      pointer-events: none;
      transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.22s;
      contain: layout style;
    }
    /* Panel direction varies by FAB quadrant (set by JS). */
    .xb-widget.pos-tl .xb-panel {
      top: 76px; bottom: auto; left: 0; right: auto;
      transform-origin: top left;
    }
    .xb-widget.pos-bl .xb-panel {
      top: auto; bottom: 76px; left: 0; right: auto;
      transform: translateY(20px) scale(0.96);
      transform-origin: bottom left;
    }
    .xb-widget.pos-br .xb-panel {
      top: auto; bottom: 76px; left: auto; right: 0;
      transform: translateY(20px) scale(0.96);
      transform-origin: bottom right;
    }
    .xb-widget.open .xb-panel {
      transform: translateY(0) scale(1);
      opacity: 1;
      pointer-events: auto;
    }

    /* The mounted panel app fills the panel. The panel CSS uses height:100vh
       on #app/#login-screen — that's the viewport, way bigger than our card.
       Override to fit exactly. */
    .xb-app-host {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #fafafa;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 14px;
      color: #0f1419;
      -webkit-font-smoothing: antialiased;
    }
    .xb-app-host #app,
    .xb-app-host #login-screen {
      height: 100% !important;
      width: 100%;
    }

    @media (max-width: 480px) {
      .xb-widget { top: 14px; right: 14px; }
      .xb-panel { width: calc(100vw - 28px); }
    }
  `;

  async function mount() {
    const host = document.createElement("div");
    host.id = "xboost-widget-host";
    host.style.cssText = [
      "all: initial",
      "position: fixed",
      "top: 0",
      "left: 0",
      "width: 0",
      "height: 0",
      "overflow: visible",
      "pointer-events: none",
      "z-index: 2147483647",
    ].join("; ") + ";";
    (document.body || document.documentElement).appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });

    const fabStyle = document.createElement("style");
    fabStyle.textContent = FAB_STYLES;
    shadow.appendChild(fabStyle);

    const widget = document.createElement("div");
    widget.className = "xb-widget";
    widget.id = "xb-widget";
    widget.innerHTML = `
      <div class="xb-panel" role="dialog" aria-label="XBoost">
        <div class="xb-app-host" id="xb-app-host"></div>
      </div>
      <button class="xb-fab" id="xb-fab" aria-label="Toggle XBoost">
        <span class="xb-fab-pulse"></span>
        <img src="${LOGO_URL}" alt="" />
      </button>
    `;
    shadow.appendChild(widget);

    const fab = shadow.getElementById("xb-fab");
    const appHost = shadow.getElementById("xb-app-host");

    function toggle() { widget.classList.toggle("open"); }
    function close() { widget.classList.remove("open"); }

    function clampPos({ x, y }) {
      return {
        x: Math.max(EDGE_MARGIN, Math.min(window.innerWidth - FAB_SIZE - EDGE_MARGIN, x)),
        y: Math.max(EDGE_MARGIN, Math.min(window.innerHeight - FAB_SIZE - EDGE_MARGIN, y)),
      };
    }

    function applyPos({ x, y }) {
      widget.style.top = y + "px";
      widget.style.left = x + "px";
      widget.style.right = "auto";
      widget.style.bottom = "auto";
      const cx = x + FAB_SIZE / 2;
      const cy = y + FAB_SIZE / 2;
      const onRight = cx >= window.innerWidth / 2;
      const onBottom = cy >= window.innerHeight / 2;
      widget.classList.remove("pos-tl", "pos-tr", "pos-bl", "pos-br");
      widget.classList.add(
        onBottom ? (onRight ? "pos-br" : "pos-bl") : (onRight ? "pos-tr" : "pos-tl")
      );
    }

    async function loadSavedPos() {
      try {
        const out = await chrome.storage.local.get(POS_KEY);
        return out[POS_KEY] || null;
      } catch { return null; }
    }
    async function savePos(pos) {
      try { await chrome.storage.local.set({ [POS_KEY]: pos }); } catch {}
    }

    // Drag state
    let dragging = false;
    let moved = false;
    let startPointerX = 0, startPointerY = 0;
    let startBoxX = 0, startBoxY = 0;

    fab.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      startPointerX = e.clientX;
      startPointerY = e.clientY;
      const rect = widget.getBoundingClientRect();
      startBoxX = rect.left;
      startBoxY = rect.top;
      try { fab.setPointerCapture(e.pointerId); } catch {}
    });

    fab.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startPointerX;
      const dy = e.clientY - startPointerY;
      if (!moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
        moved = true;
        widget.classList.add("dragging");
        close(); // close the panel while dragging
      }
      if (moved) applyPos(clampPos({ x: startBoxX + dx, y: startBoxY + dy }));
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      try { fab.releasePointerCapture(e.pointerId); } catch {}
      if (moved) {
        widget.classList.remove("dragging");
        const rect = widget.getBoundingClientRect();
        savePos({ x: rect.left, y: rect.top });
      }
    }
    fab.addEventListener("pointerup", endDrag);
    fab.addEventListener("pointercancel", endDrag);

    // Click toggles, but not if we just finished a drag.
    fab.addEventListener("click", (e) => {
      e.stopPropagation();
      if (moved) { moved = false; return; }
      toggle();
    });

    document.addEventListener("click", (e) => {
      if (e.target === host || host.contains(e.target)) return;
      close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && widget.classList.contains("open")) close();
    });

    // Re-clamp on resize so the FAB doesn't fall offscreen.
    window.addEventListener("resize", () => {
      const rect = widget.getBoundingClientRect();
      const clamped = clampPos({ x: rect.left, y: rect.top });
      if (clamped.x !== rect.left || clamped.y !== rect.top) {
        applyPos(clamped);
        savePos(clamped);
      } else {
        // still update quadrant class — viewport split changed
        applyPos(clamped);
      }
    });

    chrome.runtime?.onMessage?.addListener((message) => {
      if (message?.type === "TOGGLE_WIDGET") toggle();
    });

    // Restore saved position (or default to top-right).
    loadSavedPos().then((pos) => {
      if (pos) applyPos(clampPos(pos));
      else {
        // Compute default top-right position now so quadrant class is set.
        applyPos(clampPos({
          x: window.innerWidth - FAB_SIZE - 20,
          y: 20,
        }));
      }
    });

    // Load the panel HTML + CSS into our shadow DOM. sidepanel.js is loaded
    // as a sibling content script via manifest, so window.mountXBoost is
    // already defined when we get here.
    try {
      let [cssText, htmlText] = await Promise.all([
        fetch(APP_CSS_URL).then((r) => r.text()),
        fetch(APP_HTML_URL).then((r) => r.text()),
      ]);

      // Rewrite relative paths in the raw HTML BEFORE parsing — DOMParser
      // resolves relative paths against the X page's origin otherwise.
      htmlText = htmlText.replace(
        /(src|href)="(icons\/[^"]+)"/g,
        (_, attr, path) => `${attr}="${chrome.runtime.getURL(path)}"`
      );

      const appStyle = document.createElement("style");
      appStyle.textContent = cssText;
      shadow.insertBefore(appStyle, widget);

      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, "text/html");

      Array.from(doc.body.children).forEach((node) => {
        if (node.tagName === "SCRIPT") return;
        appHost.appendChild(node.cloneNode(true));
      });

      if (typeof window.mountXBoost === "function") {
        window.mountXBoost(shadow);
      } else {
        console.error("[XBoost] mountXBoost not exposed (sidepanel.js failed to load?)");
      }
    } catch (err) {
      console.error("[XBoost] Failed to mount widget app:", err);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
