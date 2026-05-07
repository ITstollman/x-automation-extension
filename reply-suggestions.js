/**
 * XBoost reply suggestions — inject a chip bar above X's DM composer.
 * Click a chip to populate the textarea (user can still edit before sending).
 *
 * AI swap-point: getSuggestions(context) is the only thing to replace when
 * you wire a real backend. It returns Promise<string[]>; everything else
 * (DOM injection, React-aware value setting, SPA-nav handling) stays.
 */
(function () {
  "use strict";

  const LOG = (...args) => console.log("[XBoost suggestions]", ...args);

  LOG("script loaded at", location.pathname);

  if (window.__xboostSuggestionsMounted) {
    LOG("already mounted, bailing");
    return;
  }
  window.__xboostSuggestionsMounted = true;

  // One-shot stylesheet for skeleton shimmer. Lives in the host page so
  // chip-bar children (which render directly in the X DOM, not in our
  // shadow root) can use the .xb-skel class.
  if (!document.getElementById('xb-skel-styles')) {
    const styleTag = document.createElement('style');
    styleTag.id = 'xb-skel-styles';
    styleTag.textContent = `
      .xb-skel {
        background: linear-gradient(
          90deg,
          rgba(127,127,127,0.10) 0%,
          rgba(127,127,127,0.24) 50%,
          rgba(127,127,127,0.10) 100%
        );
        background-size: 200% 100%;
        animation: xbSkelShimmer 1.4s ease-in-out infinite;
        border-radius: 6px;
      }
      @keyframes xbSkelShimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .xb-skel { animation: none; }
      }
    `;
    document.head.appendChild(styleTag);
  }

  // DM composer
  const TEXTAREA_SEL = '[data-testid="dm-composer-textarea"]';
  const CONTAINER_SEL = '[data-testid="dm-composer-container"]';
  const FORM_SEL = '[data-testid="dm-composer-form"]';
  const MESSAGE_TEXT_SEL = '[data-testid^="message-text-"]';
  // Tweet reply composer
  const TWEET_INPUT_SEL = '[data-testid="tweetTextarea_0"]';
  const TWEET_SEND_SEL = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
  const TWEET_ARTICLE_SEL = 'article[data-testid="tweet"]';
  const TWEET_TEXT_SEL = '[data-testid="tweetText"]';
  const TWEET_USER_SEL = '[data-testid="User-Name"]';
  const BAR_CLASS = "xb-suggestions";

  // ⚠️ DEV ONLY — this key is the shared fallback. Each user can override
  // it via Settings → AI provider in the side panel; their key is read
  // per-call from chrome.storage.local. Move this file to a backend proxy
  // before public release.
  const GEMINI_API_KEY = "AIzaSyAjSsdmm3f8kiFmXWMHWMBBXe8cdBTcONo";
  const GEMINI_MODEL = "gemini-2.5-flash";
  const BRAND_KEY = "xboost_brand_v1";
  const SETTINGS_KEY = "xboost_settings_v1";

  async function getGeminiUrl() {
    let userKey = "";
    try {
      const out = await chrome.storage.local.get(SETTINGS_KEY);
      userKey = (out[SETTINGS_KEY]?.geminiApiKey || "").trim();
    } catch {}
    const key = userKey || GEMINI_API_KEY;
    return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  }

  // Expose so sidepanel.js (sibling content script in the same isolated
  // world) can reuse the same Gemini wiring for Brand → Generate without
  // duplicating the key.
  async function callGemini(prompt, responseSchema, options = {}) {
    const res = await fetch(await getGeminiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxOutputTokens ?? 1200,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseSchema,
        },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts.map((p) => p?.text || "").filter(Boolean).join("");
    if (!text) {
      throw new Error(`Gemini returned no text (finishReason=${candidate?.finishReason || "none"})`);
    }
    return JSON.parse(text);
  }
  window.xboostCallGemini = callGemini;

  // ─── Brand profile helpers ───────────────────────────────────────────────

  async function readBrand() {
    try {
      const out = await chrome.storage.local.get(BRAND_KEY);
      return out[BRAND_KEY] || null;
    } catch { return null; }
  }

  function brandHasContent(b) {
    if (!b) return false;
    return Boolean(
      b.tagline || b.description || b.value || b.audience ||
      (Array.isArray(b.tones) && b.tones.length) ||
      b.voiceNotes || b.hardRules || b.examples
    );
  }

  // Render a compact "About me" block for the AI so it knows whose voice
  // to mimic. Skipped entirely if the user hasn't filled anything in.
  // mode: "dm" → conservative CTA mention (only when invited); "tweet" →
  // actively steer public replies toward the product when there's an opening.
  function renderBrandContext(b, mode) {
    if (!brandHasContent(b)) return "";
    const lines = ["About me (the user drafting these replies):"];
    if (b.tagline) lines.push(`- Identity: ${b.tagline}`);
    if (b.description) lines.push(`- About: ${b.description}`);
    if (b.value) lines.push(`- Unique value: ${b.value}`);
    if (b.audience) lines.push(`- Audience I serve: ${b.audience}`);
    if (Array.isArray(b.tones) && b.tones.length) lines.push(`- Tones: ${b.tones.join(", ")}`);
    if (b.voiceNotes) lines.push(`- Voice notes: ${b.voiceNotes}`);

    const guidelines = [];
    if (b.replyLength) guidelines.push(`length: ${b.replyLength}`);
    if (b.emojis) guidelines.push(`emojis: ${b.emojis}`);
    if (b.hashtags) guidelines.push(`hashtags: ${b.hashtags}`);
    if (b.pov) {
      const pov = { i: '"I" (first person)', we: '"We" (team)', brand: "brand voice (third person)" }[b.pov] || b.pov;
      guidelines.push(`pov: ${pov}`);
    }
    if (b.questions) guidelines.push(`ask questions back: ${b.questions}`);
    if (guidelines.length) lines.push(`- Style: ${guidelines.join("; ")}`);

    if (b.hardRules) {
      lines.push("");
      lines.push("HARD RULES — never violate, no matter what:");
      lines.push(b.hardRules);
    }

    if (b.examples) {
      lines.push("");
      lines.push("Sample posts in my voice (match this cadence):");
      lines.push(b.examples);
    }

    if (b.ctaLink && b.ctaBlurb) {
      lines.push("");
      if (mode === "tweet") {
        lines.push(
          `GOAL: I'm using public replies on X to grow this product. When the tweet's topic relates to my audience, value, or problem space, lean in — steer the conversation toward what I'm building. Across the 4 suggestions:`
        );
        lines.push(
          `- At least 2 should plant a seed that bridges the discussion back to my product (a relevant story, an opinion grounded in what I built, a question that surfaces the problem my product solves).`
        );
        lines.push(
          `- At least 1 should mention the offer or link directly when the bridge is clean — phrased like a builder sharing what they made, never a sales pitch ("Check out our X" energy is forbidden).`
        );
        lines.push(
          `- The 4th can be pure engagement (no product reference) so I have an option when the bridge isn't clean.`
        );
        lines.push(
          `If the tweet has zero connection to my product/audience, all 4 can be pure engagement — don't force it. But default to leaning in.`
        );
        lines.push(`Reference offer (rephrase in my voice; don't paste verbatim):`);
        lines.push(`"${b.ctaBlurb}" (link: ${b.ctaLink})`);
      } else {
        lines.push(
          `If — and only if — the conversation naturally invites it, mention this offer in my own words: "${b.ctaBlurb}" (link: ${b.ctaLink}). Do not force it.`
        );
      }
    }

    return lines.join("\n") + "\n\n";
  }

  // Heuristic: right-aligned bubble = sent by me; left-aligned = received.
  // Compare each message's distance from the message-list edges.
  function detectSender(textEl, listEl) {
    if (!listEl) return "them";
    const bubble = textEl.closest('[data-testid^="message-"]') || textEl.parentElement;
    const r = bubble.getBoundingClientRect();
    const lr = listEl.getBoundingClientRect();
    const distLeft = r.left - lr.left;
    const distRight = lr.right - r.right;
    return distRight < distLeft ? "me" : "them";
  }

  function getRecentMessages(maxCount = 8) {
    const list = document.querySelector('[data-testid="dm-message-list"]');
    const all = document.querySelectorAll(MESSAGE_TEXT_SEL);
    const slice = Array.from(all).slice(-maxCount);
    return slice.map((el) => ({
      from: detectSender(el, list),
      text: (el.textContent || "").replace(/\s+/g, " ").trim(),
    })).filter((m) => m.text);
  }

  // Wait until X has rendered at least one message-text node for the
  // current chat. Guards us against scraping immediately after a SPA nav
  // when the message list hasn't repainted yet.
  async function waitForMessages(timeoutMs = 2500) {
    if (document.querySelector(MESSAGE_TEXT_SEL)) return true;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 80));
      if (document.querySelector(MESSAGE_TEXT_SEL)) return true;
    }
    return false;
  }

  // Try to find the conversation's display name from the chat header (X
  // exposes it under [data-testid="dm-conversation-username"]).
  function getCounterpartName() {
    const el = document.querySelector('[data-testid="dm-conversation-username"]');
    return (el?.textContent || "").trim();
  }

  function extractTweetContext(article) {
    const text = (article.querySelector(TWEET_TEXT_SEL)?.textContent || "").replace(/\s+/g, " ").trim();
    const author = (article.querySelector(TWEET_USER_SEL)?.textContent || "").replace(/\s+/g, " ").trim();
    return { tweetText: text, author };
  }

  // Find the tweet article most relevant to the active reply composer.
  // Priority: modal dialog target → URL status ID → first tweet on page.
  function getTweetReplyContext(input) {
    // Strategy 1: replying via modal — the dialog usually contains exactly
    // one tweet (the target) plus the composer. If multiple tweets exist
    // in the modal (e.g., quoted tweet), the first article in DOM order
    // is the parent tweet.
    const modal = input.closest('[role="dialog"], [aria-modal="true"]');
    if (modal) {
      const target = modal.querySelector(TWEET_ARTICLE_SEL);
      if (target) {
        LOG("tweet context strategy: modal dialog");
        return extractTweetContext(target);
      }
    }

    // Strategy 2: detail page URL like /<user>/status/<id> — the tweet
    // whose self-link contains that ID is the canonical "main" tweet of
    // the page (i.e. the one inline replies target).
    const statusMatch = location.pathname.match(/\/status\/(\d+)/);
    if (statusMatch) {
      const id = statusMatch[1];
      const tweets = document.querySelectorAll(TWEET_ARTICLE_SEL);
      for (const t of tweets) {
        if (t.querySelector(`a[href*="/status/${id}"]`)) {
          LOG("tweet context strategy: URL status id", id);
          return extractTweetContext(t);
        }
      }
    }

    // Strategy 3: top-of-page fallback. NOT "closest above the composer"
    // — that picks the last reply in a thread instead of the actual
    // target tweet.
    const all = Array.from(document.querySelectorAll(TWEET_ARTICLE_SEL));
    if (!all.length) return null;
    all.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    LOG("tweet context strategy: first-tweet-on-page fallback");
    return extractTweetContext(all[0]);
  }

  // Walk up from the tweet textarea to find the smallest ancestor that
  // contains the tweet send button — that's the right insertion parent.
  function getTweetComposerContainer(input) {
    let el = input.parentElement;
    while (el && el !== document.body) {
      if (el.querySelector(TWEET_SEND_SEL)) return el;
      el = el.parentElement;
    }
    return input.parentElement;
  }

  // The same tweetTextarea_0 selector matches both reply composers AND
  // the "What's happening?" new-tweet composer on the home timeline.
  // Suggestions only make sense for replies, so gate on having a clear
  // reply target.
  function isReplyComposer(input) {
    // A reply modal contains exactly the target tweet plus the composer.
    const modal = input.closest('[role="dialog"], [aria-modal="true"]');
    if (modal && modal.querySelector(TWEET_ARTICLE_SEL)) return true;

    // Inline reply on a status detail page: /<user>/status/<id>.
    if (/\/status\/\d+/.test(location.pathname)) return true;

    return false;
  }

  // Detect which composer is active and return an adapter describing how
  // to read context, fill text, send — and where in the DOM to inject
  // the bar without fighting the surrounding flex layout.
  function getActiveComposer() {
    const dm = document.querySelector(TEXTAREA_SEL);
    if (dm) {
      const composer = dm.closest(CONTAINER_SEL) || dm.parentElement;
      // Place a small chip-sized bar INSIDE the composer on the left
      // (order: -1 in the bar styles puts it before the avatar). The
      // suggestions panel pops UP via position: absolute so it doesn't
      // push the layout around — preserves the chat pane and keeps the
      // textarea + send button fully clickable on the right.
      return {
        kind: "dm",
        input: dm,
        container: composer,
        placementParent: composer,
        placementBefore: composer.firstElementChild,
        compactInline: true,
        sendBtnSelector: '[data-testid="dm-composer-send-button"], [data-testid="dmComposerSendButton"]',
        verifySelector: MESSAGE_TEXT_SEL,
      };
    }
    const tweet = document.querySelector(TWEET_INPUT_SEL);
    if (tweet && isReplyComposer(tweet)) {
      const composer = getTweetComposerContainer(tweet);
      return {
        kind: "tweet",
        input: tweet,
        container: composer,
        // Tweet composer row is a non-wrapping flex (avatar | textarea |
        // post button). Inserting inside squeezes us between siblings, so
        // place the bar BEFORE the composer in the parent's vertical flow.
        placementParent: composer.parentElement || composer,
        placementBefore: composer,
        sendBtnSelector: TWEET_SEND_SEL,
        verifySelector: null,
      };
    }
    return null;
  }

  function staticFallback(messages) {
    const last = messages.length ? messages[messages.length - 1].text.toLowerCase() : "";
    if (/\?\s*$/.test(last)) return ["Yes", "No", "Not sure", "Let me check"];
    if (/thanks|thank you|🙏/.test(last)) return ["Anytime!", "You're welcome", "No problem"];
    if (/sorry|apolog/.test(last)) return ["No worries!", "All good", "It's fine"];
    if (/^(hi|hey|hello|sup|yo)\b/.test(last)) return ["Hey!", "Hi! How are you?", "What's up?"];
    return ["Got it", "Thanks!", "Sounds good", "Let me check"];
  }

  function buildPromptForDM(messages, counterpartName, brand) {
    const transcript = messages
      .map((m, i) => `${i + 1}. ${m.from === "me" ? "Me" : (counterpartName || "Them")}: ${m.text}`)
      .join("\n");
    const brandBlock = renderBrandContext(brand, "dm");
    return `${brandBlock}You are helping me draft a quick reply in a direct message conversation on X (Twitter).

Recent messages (oldest to newest):
${transcript}

Generate 4 short reply messages I (Me) might send next.
- Each under 80 characters.
- Match the conversation's language and tone.
- Vary the angle — agreement, question, deflection, follow-up — so I have real choices.
- Reply in the SAME LANGUAGE as the latest messages.
- Sound like ME, not generic. Match my voice notes and tone preferences above.
- Respect any HARD RULES above absolutely.
- No quotes, no numbering, no commentary — just the message text.`;
  }

  function buildPromptForTweetReply(ctx, brand) {
    const author = ctx.author || "the author";
    const tweet = ctx.tweetText || "(could not read the tweet text)";
    const brandBlock = renderBrandContext(brand, "tweet");
    return `${brandBlock}You are helping me draft a public reply to a tweet on X (Twitter).

The tweet (by ${author}):
"${tweet}"

Generate 4 short reply tweets I might post.
- Each under 240 characters.
- Public-facing tone — engaging, concise, value-adding, not just "nice tweet".
- Vary the angle — agree-and-extend, friendly disagreement, question, joke, share an experience.
- Match the language of the tweet.
- Sound like ME, not generic. Match my voice notes and tone preferences above.
- Respect any HARD RULES above absolutely.
- No "@" prefixes.
- No quotes, no numbering, no commentary — just the reply text.`;
  }

  async function fetchGeminiSuggestions(prompt) {
    LOG("calling Gemini, prompt length:", prompt.length);
    const res = await fetch(await getGeminiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.8,
          // Bumped from 300 — 2.5 Flash uses thinking tokens by default.
          // Even with thinking disabled below, leave headroom for JSON.
          maxOutputTokens: 800,
          // Disable Gemini 2.5 thinking — for short reply suggestions we
          // don't need it, and it eats the entire output budget.
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              suggestions: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["suggestions"],
          },
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    LOG("Gemini raw response:", data);

    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== "STOP") {
      LOG("non-STOP finishReason:", candidate.finishReason, "safetyRatings:", candidate.safetyRatings);
    }

    // Walk all parts and concatenate any text — guards against thinking
    // tokens at parts[0] or response shapes I haven't seen.
    const parts = candidate?.content?.parts || [];
    const text = parts.map((p) => p?.text || "").filter(Boolean).join("");
    if (!text) {
      throw new Error(`Gemini returned no text (finishReason=${candidate?.finishReason || "none"})`);
    }

    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
    if (!list.length) throw new Error("Gemini returned an empty suggestion list");
    return list.slice(0, 4);
  }

  async function getSuggestions(adapter) {
    if (!adapter) return staticFallback([]);

    const brand = await readBrand();
    LOG("brand profile loaded:", brandHasContent(brand) ? "yes" : "empty");

    if (adapter.kind === "dm") {
      const messages = getRecentMessages(8);
      LOG("recent DM messages scraped:", messages);
      if (!messages.length) {
        LOG("no messages — using static fallback");
        return staticFallback(messages);
      }
      try {
        const prompt = buildPromptForDM(messages, getCounterpartName(), brand);
        const suggestions = await fetchGeminiSuggestions(prompt);
        LOG("Gemini DM suggestions:", suggestions);
        return suggestions;
      } catch (err) {
        console.error("[XBoost suggestions] Gemini DM failed, using fallback:", err);
        return staticFallback(messages);
      }
    }

    if (adapter.kind === "tweet") {
      const ctx = getTweetReplyContext(adapter.input);
      LOG("tweet context scraped:", ctx);
      if (!ctx || !ctx.tweetText) {
        LOG("no tweet context — using static fallback");
        return ["Great point", "Curious to hear more", "Thanks for sharing", "Interesting take"];
      }
      try {
        const prompt = buildPromptForTweetReply(ctx, brand);
        const suggestions = await fetchGeminiSuggestions(prompt);
        LOG("Gemini tweet suggestions:", suggestions);
        return suggestions;
      } catch (err) {
        console.error("[XBoost suggestions] Gemini tweet reply failed, using fallback:", err);
        return ["Great point", "Curious to hear more", "Thanks for sharing", "Interesting take"];
      }
    }

    return staticFallback([]);
  }

  function setReactValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;

    // React tracks the input's "previous value" in el._valueTracker. If we
    // skip this, React sometimes doesn't fire its onChange because tracker
    // value already equals the new value (intermittent miss → send button
    // stays disabled even though textarea visibly shows our text).
    if (el._valueTracker && typeof el._valueTracker.setValue === "function") {
      el._valueTracker.setValue("");
    }

    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // X uses <div role="button"> for the DM send button and listens to
  // *pointer* events (which is why touch works but a plain mouse .click()
  // doesn't). Fire the full pointer + mouse + click sequence with real
  // coordinates so React's synthetic event handlers all see what they
  // expect from a genuine user tap.
  function realClick(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, button: 0, clientX: cx, clientY: cy };
    const ptr = { ...base, pointerType: "mouse", pointerId: 1, isPrimary: true, width: 1, height: 1, pressure: 0.5 };

    try {
      el.dispatchEvent(new PointerEvent("pointerover", ptr));
      el.dispatchEvent(new PointerEvent("pointerenter", { ...ptr, bubbles: false }));
      el.dispatchEvent(new PointerEvent("pointerdown", ptr));
    } catch (e) { /* ignore — old engines without PointerEvent ctor */ }

    el.dispatchEvent(new MouseEvent("mouseover", base));
    el.dispatchEvent(new MouseEvent("mousedown", base));

    try { el.dispatchEvent(new PointerEvent("pointerup", ptr)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.dispatchEvent(new MouseEvent("click", base));
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Inline SVG icons (Lucide-style). Use currentColor so they pick up the
  // surrounding text color in any X theme.
  const ICON = {
    sparkles: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.937A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .963L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; display:block;"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M20 6 9 17l-5-5"/></svg>',
  };

  function makeChip(html, onClick) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "xb-chip";
    chip.innerHTML = html;
    chip.style.cssText = [
      "display: inline-flex",
      "align-items: center",
      "gap: 6px",
      "background: rgba(127,127,127,0.12)",
      "border: 1px solid rgba(127,127,127,0.18)",
      "color: inherit",
      "padding: 5px 12px",
      "border-radius: 100px",
      "font-size: 13px",
      "font-weight: 500",
      "line-height: 1.3",
      "cursor: pointer",
      "font-family: inherit",
      "transition: background 0.15s, border-color 0.15s, transform 0.1s",
      "max-width: 100%",
      "white-space: nowrap",
    ].join("; ") + ";";
    chip.addEventListener("mouseenter", () => {
      chip.style.background = "rgba(127,127,127,0.2)";
      chip.style.borderColor = "rgba(127,127,127,0.3)";
    });
    chip.addEventListener("mouseleave", () => {
      chip.style.background = "rgba(127,127,127,0.12)";
      chip.style.borderColor = "rgba(127,127,127,0.18)";
    });
    chip.addEventListener("mousedown", (e) => { e.stopPropagation(); chip.style.transform = "scale(0.96)"; });
    chip.addEventListener("mouseup", (e) => { e.stopPropagation(); chip.style.transform = "scale(1)"; });
    // stopPropagation + capture phase so X's composer-level click handlers
    // don't run before/after ours — that interference is why some clicks
    // (notably "Hide suggestions") were dropping intermittently.
    chip.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); }, true);
    return chip;
  }

  // Fill the active composer with text. Textarea uses React's native value
  // setter; contenteditable uses execCommand('insertText') to play nicely
  // with Draft.js.
  function setComposerText(input, text) {
    input.focus();
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      setReactValue(input, text);
      return;
    }
    // contenteditable (tweet composer)
    // Select all existing content so insertText replaces, doesn't append.
    const range = document.createRange();
    range.selectNodeContents(input);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("insertText", false, text);
  }

  // Send the active composer's content through X's UI.
  // Exposed as window.xboostSendDirectly so sidepanel.js can reuse the same
  // working send pipeline instead of maintaining its own.
  async function sendDirectly(text) {
    LOG("sendDirectly start, text:", JSON.stringify(text));

    // Re-detect the active composer fresh — closure capture may be stale.
    const adapter = getActiveComposer();
    if (!adapter) {
      LOG("sendDirectly: no active composer found");
      throw new Error("No composer found");
    }
    const textarea = adapter.input;
    LOG("composer kind:", adapter.kind, "isConnected:", textarea.isConnected, "tagName:", textarea.tagName);

    textarea.focus();
    LOG("focused, activeElement matches?", document.activeElement === textarea);

    setComposerText(textarea, text);
    const valueNow = "value" in textarea ? textarea.value : textarea.textContent;
    LOG("setComposerText done, value:", JSON.stringify(valueNow));

    // Give React two animation frames to flush the value change and re-render
    // the send button's enabled state.
    await nextFrame();

    // Poll for the send button to appear and enable.
    const start = Date.now();
    let sendBtn = null;
    let attempts = 0;
    while (Date.now() - start < 2500) {
      attempts++;
      sendBtn = document.querySelector(adapter.sendBtnSelector);
      if (sendBtn) {
        const ad = sendBtn.getAttribute("aria-disabled");
        const disabled = sendBtn.disabled || ad === "true";
        if (attempts === 1 || (Date.now() - start) % 240 < 80) {
          LOG(`poll #${attempts}: sendBtn found, tag=${sendBtn.tagName}, aria-disabled=${ad}, .disabled=${sendBtn.disabled}`);
        }
        if (!disabled) break;

        // The button is here but disabled — React might have missed our
        // value update. Re-fire it to nudge React.
        if (attempts % 6 === 0) {
          LOG("button still disabled — re-firing setComposerText to nudge React");
          setComposerText(textarea, text);
        }
      } else if (attempts === 1) {
        LOG("poll #1: send button not found yet");
      }
      await new Promise((r) => setTimeout(r, 60));
    }

    // Verification strategy depends on composer kind. For DMs we count
    // [data-testid="message-text-..."] nodes; a new one appearing means
    // the message was delivered. For tweet replies, X clears the editor
    // after a successful post, so we check the input is empty/unmounted.
    const beforeCount = adapter.verifySelector
      ? document.querySelectorAll(adapter.verifySelector).length
      : 0;
    LOG("verify baseline (kind=", adapter.kind, "): beforeCount=", beforeCount);

    async function verifySent(timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 80));
        if (adapter.verifySelector) {
          const now = document.querySelectorAll(adapter.verifySelector).length;
          if (now > beforeCount) return true;
        } else {
          // Tweet composer clears (or unmounts) on successful send.
          const live = document.querySelector(TWEET_INPUT_SEL);
          if (!live || (live.textContent || "").trim() === "") return true;
        }
      }
      return false;
    }

    // Path 1: plain .click() on send button.
    if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute("aria-disabled") !== "true") {
      await nextFrame();
      LOG("path 1: sendBtn.click()");
      sendBtn.click();
      if (await verifySent(1500)) { LOG("path 1 confirmed"); return true; }
      LOG("path 1 didn't verify — trying keyboard send");
    } else {
      LOG("send button not enabled within timeout — skipping to keyboard");
    }

    // Path 2: keyboard send. Tweet composer requires Cmd/Ctrl+Enter to
    // post; DM composer accepts plain Enter. Try the right combo.
    textarea.focus();
    setComposerText(textarea, text);
    await nextFrame();
    const baseEnter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const opts = adapter.kind === "tweet"
      ? { ...baseEnter, ctrlKey: true, metaKey: true }
      : baseEnter;
    LOG("path 2: keyboard Enter (cmd/ctrl=", adapter.kind === "tweet", ")");
    textarea.dispatchEvent(new KeyboardEvent("keydown", opts));
    textarea.dispatchEvent(new KeyboardEvent("keypress", opts));
    textarea.dispatchEvent(new KeyboardEvent("keyup", opts));
    if (await verifySent(1500)) { LOG("path 2 confirmed"); return true; }

    // Path 3: realClick (pointer+mouse sequence) on send button.
    if (sendBtn) {
      LOG("path 3: realClick");
      realClick(sendBtn);
      if (await verifySent(1500)) { LOG("path 3 confirmed"); return true; }
    }

    // Path 4: form submit (DM only — tweet composer isn't a <form>).
    if (adapter.kind === "dm") {
      const form = document.querySelector(FORM_SEL) || textarea.closest?.("form");
      if (form && typeof form.requestSubmit === "function") {
        LOG("path 4: form.requestSubmit()");
        try { form.requestSubmit(); } catch (err) { LOG("form.requestSubmit threw:", err); }
        if (await verifySent(1500)) { LOG("path 4 confirmed"); return true; }
      }
    }

    LOG("all send paths failed");
    return false;
  }
  window.xboostSendDirectly = sendDirectly;

  function makeOptionRow(initialText, onSend) {
    const row = document.createElement("div");
    row.className = "xb-option";
    row.style.cssText = [
      "display: flex",
      // Top-align: with multi-line wrapping the textarea grows downward;
      // we want the send button to sit at the top-right rather than drift.
      "align-items: flex-start",
      "gap: 6px",
      "background: rgba(127,127,127,0.10)",
      "border: 1px solid rgba(127,127,127,0.18)",
      "border-radius: 12px",
      "padding: 6px 6px 6px 12px",
      "transition: background 0.15s, border-color 0.15s",
    ].join("; ") + ";";

    const input = document.createElement("textarea");
    input.value = initialText;
    input.spellcheck = false;
    input.rows = 1;
    input.style.cssText = [
      "flex: 1",
      "min-width: 0",
      "background: transparent",
      "border: none",
      "outline: none",
      "color: inherit",
      "font-family: inherit",
      "font-size: 14px",
      "font-weight: 500",
      "line-height: 1.4",
      "padding: 6px 4px",
      "resize: none",          // hide the manual drag-handle
      "overflow: hidden",      // we auto-grow, no scrollbar needed
      "white-space: pre-wrap", // wrap long text instead of horizontal scroll
      "word-wrap: break-word",
    ].join("; ") + ";";

    // Auto-grow: set height = scrollHeight whenever the content changes.
    function autoGrow() {
      input.style.height = "auto";
      input.style.height = input.scrollHeight + "px";
    }
    input.addEventListener("input", autoGrow);
    // Run once after the row is in the DOM so scrollHeight is meaningful.
    requestAnimationFrame(autoGrow);

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.title = "Send this message";
    sendBtn.setAttribute("aria-label", "Send this message");
    sendBtn.innerHTML = ICON.send;
    sendBtn.style.cssText = [
      "flex-shrink: 0",
      "width: 32px",
      "height: 32px",
      // Stick the button to the top of the row so it doesn't slide down
      // as the textarea grows. (Row is align-items: flex-start.)
      "margin-top: 2px",
      "display: inline-flex",
      "align-items: center",
      "justify-content: center",
      "background: rgba(29,155,240,0.14)",
      "border: none",
      "border-radius: 50%",
      "color: rgb(29,155,240)",
      "cursor: pointer",
      "transition: background 0.15s, transform 0.1s",
    ].join("; ") + ";";
    sendBtn.addEventListener("mouseenter", () => { sendBtn.style.background = "rgba(29,155,240,0.24)"; });
    sendBtn.addEventListener("mouseleave", () => { sendBtn.style.background = "rgba(29,155,240,0.14)"; });
    sendBtn.addEventListener("mousedown", () => { sendBtn.style.transform = "scale(0.92)"; });
    sendBtn.addEventListener("mouseup", () => { sendBtn.style.transform = "scale(1)"; });

    // Subtle focus highlight on the row when the input is active.
    input.addEventListener("focus", () => {
      row.style.borderColor = "rgba(29,155,240,0.6)";
      row.style.background = "rgba(29,155,240,0.06)";
    });
    input.addEventListener("blur", () => {
      row.style.borderColor = "rgba(127,127,127,0.18)";
      row.style.background = "rgba(127,127,127,0.10)";
    });

    async function trigger() {
      if (sendBtn.disabled) return;
      const value = input.value.trim();
      if (!value) return;
      sendBtn.disabled = true;
      input.disabled = true;
      try {
        const ok = await onSend(value);
        if (ok === false) throw new Error("Send did not confirm");
        sendBtn.innerHTML = ICON.check;
        sendBtn.style.background = "rgba(0,186,124,0.18)";
        sendBtn.style.color = "rgb(0,186,124)";
        row.style.opacity = "0.55";
      } catch (err) {
        console.error("[XBoost] send failed:", err);
        sendBtn.disabled = false;
        input.disabled = false;
        // Flash red briefly to signal the failure.
        const prevBg = sendBtn.style.background;
        sendBtn.style.background = "rgba(244,33,46,0.2)";
        setTimeout(() => { sendBtn.style.background = prevBg; }, 600);
      }
    }

    sendBtn.addEventListener("click", (e) => { e.stopPropagation(); trigger(); });

    // Enter inside the input also sends.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        trigger();
      }
    });

    row.appendChild(input);
    row.appendChild(sendBtn);
    return row;
  }

  async function buildBar(textarea, adapter) {
    const bar = document.createElement("div");
    bar.className = BAR_CLASS;
    if (adapter.compactInline) {
      // Compact: small chip on the left of the composer row. Panel floats
      // up via position: absolute so opening it doesn't push the textarea
      // or send button.
      bar.style.cssText = [
        "display: inline-flex",
        "align-items: center",
        "padding: 0 4px",
        "box-sizing: border-box",
        "flex: 0 0 auto",
        "order: -1",
        "min-width: 0",
        "position: relative",
        "align-self: flex-start",
        "margin-top: -8px",
        "margin-bottom: 10px",
      ].join("; ") + ";";
    } else {
      // Default: full-width row above the composer.
      bar.style.cssText = [
        "display: flex",
        "flex-direction: column",
        "gap: 6px",
        "padding: 8px 14px",
        "box-sizing: border-box",
        "width: 100%",
        "flex: 0 0 100%",
        "flex-basis: 100%",
        "order: -1",
        "min-width: 0",
      ].join("; ") + ";";
    }

    // Header row — trigger always visible; refresh appears only when open.
    const header = document.createElement("div");
    header.style.cssText = adapter.compactInline
      ? "display: inline-flex; gap: 4px; align-items: center;"
      : "display: flex; gap: 6px; align-items: center; flex-wrap: wrap;";

    const triggerLabel = (open) =>
      open
        ? `${ICON.close}<span>Hide suggestions</span>`
        : `${ICON.sparkles}<span>Suggested replies</span>`;

    const trigger = makeChip(triggerLabel(false), () => toggle());
    const refreshBtn = makeChip(ICON.refresh, async () => {
      refreshBtn.disabled = true;
      try { await populate(); } finally { refreshBtn.disabled = false; }
    });
    refreshBtn.style.padding = "5px 8px";
    refreshBtn.title = "Regenerate suggestions";
    refreshBtn.setAttribute("aria-label", "Regenerate suggestions");
    refreshBtn.style.display = "none";

    header.appendChild(trigger);
    header.appendChild(refreshBtn);
    bar.appendChild(header);

    // Collapsible panel of column options.
    const panel = document.createElement("div");
    if (adapter.compactInline) {
      // Floats UP from the chip via position: absolute (so the popup looks
      // like a dropdown, not a layout shift). To prevent it from covering
      // the chat above, a sibling "spacer" is added above the composer at
      // injection time and grows to the panel's height when open — that
      // shrinks the message list, so messages reflow up.
      panel.style.cssText = [
        "display: none",
        "position: absolute",
        "bottom: calc(100% + 8px)",
        "left: 0",
        "min-width: 320px",
        "max-width: 480px",
        "max-height: 60vh",
        "overflow-y: auto",
        "flex-direction: column",
        "gap: 6px",
        "padding: 10px",
        "background: var(--xb-surface, rgba(20,20,20,0.96))",
        "color: inherit",
        "border: 1px solid rgba(127,127,127,0.25)",
        "border-radius: 14px",
        "box-shadow: 0 14px 40px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.2)",
        "z-index: 9999",
      ].join("; ") + ";";
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      if (bodyBg && bodyBg !== "rgba(0, 0, 0, 0)") panel.style.background = bodyBg;
    } else {
      panel.style.cssText = "display: none; flex-direction: column; gap: 6px; margin-top: 2px;";
    }
    bar.appendChild(panel);
    bar.__xbPanel = panel;

    let isOpen = false;

    async function populate() {
      // Pin the URL we're populating for; every async hop checks against it.
      const populateUrl = location.pathname;
      bar.dataset.convoUrl = populateUrl;

      // Skeleton loading state — 4 rows mirroring the option-row layout
      // (text bubble + circular send button) so the swap to real suggestions
      // is silent (no layout shift, no "Generating…" italic).
      panel.innerHTML = "";
      for (let i = 0; i < 4; i++) {
        const row = document.createElement("div");
        // Match xb-option visual: same row chrome, but with skeleton fills.
        row.style.cssText = [
          "display: flex",
          "align-items: center",
          "gap: 8px",
          "padding: 8px 10px 8px 14px",
          "background: rgba(127,127,127,0.10)",
          "border: 1px solid rgba(127,127,127,0.18)",
          "border-radius: 12px",
        ].join("; ") + ";";
        const widthPct = [88, 72, 60, 80][i];
        row.innerHTML = `
          <span class="xb-skel" style="flex: 1; min-width: 0; height: 14px; width: ${widthPct}%;"></span>
          <span class="xb-skel" style="flex-shrink: 0; width: 32px; height: 32px; border-radius: 50%;"></span>
        `;
        // Stagger the shimmer so the rows feel alive, not robotic.
        const delay = i * 0.12;
        row.firstElementChild.style.animationDelay = `${delay}s`;
        row.lastElementChild.style.animationDelay = `${delay}s`;
        panel.appendChild(row);
      }

      // Give X time to render the new chat's messages before scraping —
      // otherwise we'd see Array(0) and lock in the static fallback.
      await waitForMessages(2500);
      if (populateUrl !== location.pathname) {
        LOG("populate: URL drifted while waiting for messages — aborting");
        return;
      }

      const suggestions = await getSuggestions(adapter);
      if (populateUrl !== location.pathname) {
        LOG("populate: URL drifted mid-fetch — discarding stale suggestions");
        return;
      }

      panel.innerHTML = "";
      for (const text of suggestions) {
        panel.appendChild(makeOptionRow(text, async (finalText) => {
          const ok = await sendDirectly(finalText);
          if (ok && typeof window.xboostLogAction === "function") {
            const target = adapter.kind === "tweet"
              ? `reply to ${getTweetReplyContext(adapter.input)?.author || "tweet"}`
              : (getCounterpartName() || "current chat");
            window.xboostLogAction({
              type: "sent",
              target,
              text: finalText,
            });
          }
          // Panel content shrinks after a successful send (or stays the
          // same after a failure); re-measure either way.
          if (typeof bar.__xbSyncSpacer === "function") bar.__xbSyncSpacer();
          return ok;
        }));
      }
      // Panel content just changed size — re-measure the spacer.
      if (typeof bar.__xbSyncSpacer === "function") bar.__xbSyncSpacer();
    }

    function syncSpacer() {
      const spacer = bar.__xbSpacer;
      if (!spacer) return;
      if (isOpen) {
        // Measure the panel's actual rendered height (after display: flex
        // and after content paints) and set the spacer to match. Run on
        // next frame so the panel has laid out.
        requestAnimationFrame(() => {
          const h = panel.getBoundingClientRect().height;
          // +8 to account for the calc(100% + 8px) gap between chip and panel.
          spacer.style.height = h + 8 + "px";
        });
      } else {
        spacer.style.height = "0px";
      }
    }

    function toggle() {
      isOpen = !isOpen;
      panel.style.display = isOpen ? "flex" : "none";
      refreshBtn.style.display = isOpen ? "inline-flex" : "none";
      trigger.innerHTML = triggerLabel(isOpen);
      if (isOpen) {
        const stale = bar.dataset.convoUrl !== location.pathname;
        if (panel.children.length === 0 || stale) populate();
      }
      syncSpacer();
    }
    // Re-measure when populate() finishes — the panel's height changes
    // from "Generating…" placeholder to N option rows.
    bar.__xbSyncSpacer = syncSpacer;

    // Hook for the outer observer: refresh when the user switches chats
    // without remounting the composer container.
    bar.__xbOnConvoChange = () => {
      LOG("convo changed; bar isOpen =", isOpen, "old =", bar.dataset.convoUrl, "new =", location.pathname);
      if (isOpen) populate();
      else panel.innerHTML = ""; // next open will repopulate
    };

    return bar;
  }

  async function injectIfNeeded() {
    const adapter = getActiveComposer();
    if (!adapter) return;
    const { placementParent, placementBefore, kind, input } = adapter;
    if (!placementParent) { LOG("composer found but no placement parent — abort"); return; }

    // Existing bar is anchored to whichever parent we placed it in.
    const existing = placementParent.querySelector(`:scope > .${BAR_CLASS}`);
    if (existing) {
      if (existing.dataset.convoUrl && existing.dataset.convoUrl !== location.pathname) {
        if (typeof existing.__xbOnConvoChange === "function") existing.__xbOnConvoChange();
        existing.dataset.convoUrl = location.pathname;
      }
      return;
    }

    LOG("injecting bar (kind=", kind, ")");
    const bar = await buildBar(input, adapter);
    bar.dataset.convoUrl = location.pathname;
    bar.dataset.composerKind = kind;
    placementParent.insertBefore(bar, placementBefore);

    // Compact mode: add a sibling spacer ABOVE the composer that grows to
    // the panel's height when open. This shrinks the message list above
    // (it's a flex-grow:1 item in the column parent), making the chat
    // reflow up to clear the popup. Spacer height is 0 by default.
    if (adapter.compactInline) {
      const composerParent = placementParent.parentElement;
      if (composerParent) {
        const spacer = document.createElement("div");
        spacer.className = "xb-suggestions-spacer";
        spacer.style.cssText = [
          "height: 0px",
          "flex-shrink: 0",
          "transition: height 0.15s ease",
          "pointer-events: none",
        ].join("; ") + ";";
        composerParent.insertBefore(spacer, placementParent);
        bar.__xbSpacer = spacer;
      }
    }
    LOG("bar inserted; isConnected =", bar.isConnected, "rect =", bar.getBoundingClientRect());
  }

  // X re-renders aggressively on typing; throttle DOM checks to one per
  // animation frame so we don't thrash.
  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      injectIfNeeded();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  injectIfNeeded();
})();
