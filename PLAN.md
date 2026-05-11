# Xlift Master Plan

> An automated marketing stack for X (Twitter): Posts, DM Outreach, and Auto Engage — orchestrated by an AI Boss, governed by safety rails, executed through the user's real authenticated session.

## 1. Vision

Xlift turns a manual X presence into an always-on growth engine. Three campaign types — **DM Outreach**, **Auto Engage**, **Automated Posts** — each governed by per-account safety budgets, all driven by a deterministic **Scheduler + Action Queue**. The user defines strategy (brand profile, audience, targets, voice, schedule). Xlift executes day-to-day on the user's behalf. AI is invoked as a tool *at the moment* an action needs content — never as an orchestrator.

### Decisions locked in (2026-05-07)
1. **Multi-tenant from day 1** — proper user isolation, billing-ready
2. **No AI Boss** — Scheduler + Queue + on-demand AI calls only
3. **User manages Chrome profiles manually** — one profile per X account; we don't build a profile manager
4. **Free tier → paid tiers** — Stripe in a later phase
5. **Aggressive default** — no approval queue gate; first action of a campaign goes out immediately. User can flip approval mode on per-campaign if they want it
6. **Brand profile syncs to backend** — needed for content generation across devices and for the dashboard's preview/edit experience

## 2. Architecture

Three components, mirroring the existing Reddit stack:

### Chrome Extension — the "hands"
- Runs in the user's browser, executes every actual X interaction through their authenticated session (no public API)
- Hosts the floating widget UI
- Polls the backend every 30–60s for next action; reports outcomes back
- Owns DOM scraping, click sequences, fingerprint-respectful pacing
- Never holds long-term state; the backend is source of truth

### Backend — the "scheduler"
- Express + Firebase Firestore on Railway (same shape as Reddit Automation Backend)
- Multi-tenant: every record scoped by `userId`, Firestore security rules enforce isolation
- Stores campaigns, lists, sequences, action queues, account state, history
- Runs the **Scheduler**: a cron worker that materializes upcoming actions from campaign rules into the queue at the right times, respects per-account caps, randomization, and working hours
- Owns Gemini keys (out of the extension); calls Gemini *on demand* at action time when content needs generating (no continuous AI loop)
- Optional later: news/RSS ingestion worker that creates "market event" actions
- Exposes auth, billing, account management, action queue endpoint

### Dashboard — the "control plane"
- React + Vite + Mantine (matches Reddit Dashboard)
- Where users author campaigns, build lists, write templates, review approval queues, see analytics
- Multi-account, multi-campaign at-a-glance
- Approval queues with batch actions

### Data flow
1. User authors campaign in Dashboard
2. Backend stores it. Scheduler materializes the campaign into queued actions: e.g., for a DM outreach with 100 prospects, it creates 100 `actions` rows with `scheduledFor` timestamps spaced per pacing rules
3. Extension (logged into user's X account) polls backend every 30–60s for the next due action
4. Backend returns it ("DM @user with content X" or "Post tweet Y")
5. Extension executes, reports outcome
6. Backend updates state; Scheduler re-paces based on outcome (e.g., on rate-limit error → push remaining actions further out, mark account `cooldown`)
7. Loop continues until queue is drained, campaign is paused, or user goes offline. **Caveat**: actions only execute while the extension is running in a browser logged into the target X account. Closed browser = paused execution.

## 3. Data Model (Firestore)

```
users/{userId}
  email, name, plan, billingStatus, createdAt

xAccounts/{accountId}
  userId, handle, displayName, avatar
  status: 'active' | 'paused' | 'cooldown' | 'banned'
  connectedAt, lastSeenAt
  cooldownUntil, suspensionReason
  dailyCaps: { likes, retweets, replies, dms, follows, posts }
  workingHours: { tz, startHour, endHour, weekendFactor }
  healthScore: 0-100
  aggressiveness: 'conservative' | 'default' | 'aggressive'

campaigns/{campaignId}
  userId, accountIds[]
  type: 'dm-outreach' | 'auto-engage' | 'auto-posts'
  name, status: 'draft' | 'pending-approval' | 'running' | 'paused' | 'done'
  config: { ...type-specific... }
  metrics: { sent, delivered, replied, errors, ... }
  createdAt, startedAt, lastActionAt

lists/{listId}                       // for DM outreach
  userId, name
  source: 'csv' | 'keyword' | 'similar' | 'manual'
  handles: [{ handle, addedAt, status, lastDmAt, fromCampaigns[], hookCache }]

templates/{templateId}               // spintax-aware
  userId, type: 'dm' | 'post' | 'reply'
  body: "Hey {name|there}, {great|awesome} post about..."
  variables: ['name', 'first_topic']

sequences/{sequenceId}               // for DM outreach
  userId, campaignId
  steps: [
    { kind: 'dm',      templateId, delayHours: 0 },
    { kind: 'dm',      templateId, delayHours: 48, condition: 'no-reply' },
    { kind: 'mention', templateId, delayHours: 96, condition: 'no-reply' },
  ]

actions/{actionId}                   // the queue
  userId, accountId, campaignId
  type: 'send-dm' | 'post' | 'like' | 'retweet' | 'comment' | 'follow' | 'search'
  payload, scheduledFor, executedAt
  status: 'queued' | 'in-progress' | 'done' | 'failed' | 'awaiting-approval'
  result: { ok, error?, data? }

events/{eventId}                     // market intelligence
  source: 'x-mention' | 'rss' | 'gdelt' | ...
  topic, payload, ingestedAt, relevance: 0-1

history/{historyId}                  // mirror of extension's local log
  userId, accountId, type, target, text, ts, campaignId?

brandProfile/{userId}                // already in extension; mirror to backend
  ...existing fields...
```

## 4. Campaign Types in Detail

### 4.1 DM Outreach

**Goal**: programmatic personal-feeling outreach with multi-step follow-ups, multi-account, with safeguards.

**Setup flow**
1. Create campaign → name + linked X accounts
2. Build a list:
   - **CSV/manual**: paste handles or upload CSV
   - **Keyword search**: "shopify dropshipping coach" → run X search via extension → import top N matching filters (followers > 1k, recently active, etc.)
   - **Similar-handle expansion**: enter 1–3 seeds → AI suggests similar via overlap analysis (their followers + Gemini judgment using bio/recent tweets)
   - **Live add-as-you-type**: typing a handle suggests similar in real time
3. Author content:
   - Initial DM template (with spintax: `{Hi|Hey|Hello} {name}, {great|awesome|nice} {post|tweet|thread} about...`)
   - Optional follow-up #1 (e.g., +48h if no reply)
   - Optional follow-up #2 (e.g., +96h if no reply)
   - Optional fallback `@`-reply ("Hey @handle, tried DMing — better way to reach you?")
4. Configure safeguards (per-day cap, working hours, randomization profile)
5. Submit for approval — first 5 DMs of every campaign require manual approval before send (gradual trust)
6. Run

**Spintax engine** (server-side)
- Syntax: `{a|b|c}`, nested: `{Hey|{Hi|Hello}}`
- Variable substitution: `{name}`, `{handle}`, `{first_tweet_topic}`, `{personal_hook}`
- `{personal_hook}` is AI-generated per-prospect (one-liner about their recent activity), cached on the list entry

**Sequencing logic**
- Step 1 sends → marked delivered
- Wait N hours, poll for reply
- If reply: pause sequence, log it, hand off to AI reply-suggestions for a contextual response (or notify user)
- Else: send step 2 → repeat
- Final fallback step: public `@`-reply (riskier — opt-in)

**Pacing per account**
- DMs/day cap: 10 to non-followers / 30 to followers (default)
- Random delay between DMs: 5–30 min
- Sub-action wandering: visit profile (15–40s scroll), then DM
- Working hours: 9am–6pm in account's tz, with random pauses
- Multi-account rotation: round-robin OR weighted by health score

**Safety**
- Watchdog: reply rate < 1% over 50 DMs → auto-pause campaign for review (likely flagged)
- Hard rule: never DM same handle twice in 30 days across all campaigns
- CAPTCHA / "limit reached" detector → pause account 4–24h
- First 5 DMs go through approval queue

### 4.2 Auto Engage

**Goal**: build topical authority by engaging in real time on tweets matching keywords/phrases, growing impressions and inbound follows.

**Setup**
1. Create campaign → linked accounts + engagement style
2. Triggers:
   - Keywords: "shopify SEO", "ranktail" *(avoid your own brand to look organic)*
   - Phrases: "looking for shopify app"
   - From-list: tweets by specific handles you want to engage with
3. Filter rules:
   - Min likes / min reposts (skip < 10 engagement)
   - Max age (skip > 6h)
   - Skip if author is large competitor / blocked
   - Skip on exclusion words ("hiring", "for sale", etc.)
4. Action mix (per matching tweet, probabilities):
   - 60% like, 25% reply, 10% retweet, 5% retweet + comment
5. Pacing + caps + working hours

**Execution**
- Backend periodically asks extension to search X (cheap, just a search)
- Backend ranks results by AI relevance + filter rules
- Backend queues actions per account
- Extension executes, randomized cadence

**Reply generation**
- Reuses the existing reply-suggestions Gemini prompt
- Brand profile injects voice/tone
- Confidence < threshold → approval queue

**Safety**
- Per-day caps (likes/replies/retweets/RT-comments)
- Per-tweet exclusivity (never engage same tweet twice)
- Per-author cooldown: max 3 actions/week per author
- Quality gate via AI confidence score

### 4.3 Automated Posts

**Goal**: always-on top-of-feed presence, 2–10 posts/day, mix of evergreen brand content + reactive market commentary.

**Content sources**
1. **Template library** — 20–50 templates by category (story, tip, hot take, question, build-in-public)
2. **Market events** — news ingestion (RSS, GDELT) + X firehose for big accounts in user's industry → AI scores relevance → if high, generate post connecting event to user's product
   - *Example*: Shopify announces Q1 earnings, "AI drove 10× more traffic" → AI Boss recognizes Ranktail relevance → generates take linking the trend to Ranktail's value
3. **Viral pattern miner** — track top-performing tweets in user's niche → extract structural patterns (hook + body + CTA shape) → use as scaffolds
4. **User analytics** — what posted well last 30d → reweight template mix

**Generation pipeline**
1. Scheduler decides next post slot (timing chosen by performance data)
2. Pick angle: brand template, market event, or viral remix
3. Gemini call with brand profile + scaffold → 3 variants
4. Top variant goes to scheduled queue (or approval queue if user opts in)

**Scheduling**
- Posts/day target: 2–10 (configurable)
- Time-of-day learning: track engagement vs. hour-of-day, weight future posts toward proven windows
- Spread: enforce min interval between posts (e.g., 90 min)

**Performance loop**
- 24h after posting, scrape engagement (likes, retweets, replies, impressions)
- Attribute to: template used, hour, day, market event link
- Update internal weights for future generation

## 5. Safety System

### Account health score (0–100)
- 100 = pristine, 0 = banned
- **Decreased** by: errors, X warnings, low reply rates, fast action sequences, off-hour activity
- **Increased** by: organic-feeling pacing, replies received, follower growth
- < 70 → reduced caps + cooldown
- < 40 → pause all campaigns + alert user

### Action budgets per account/day
| Action | Conservative | Default | Aggressive |
|--------|--------------|---------|------------|
| Likes | 25 | 50 | 100 |
| Retweets | 5 | 15 | 30 |
| Replies | 10 | 30 | 50 |
| DMs (non-follower) | 3 | 10 | 25 |
| DMs (follower) | 10 | 30 | 50 |
| Posts | 1 | 4 | 10 |
| Follows | 10 | 30 | 60 |

### Randomization layers
1. Inter-action delay: log-normal distribution centered at action's mean, with min floor
2. Sub-action wandering: scroll, hover, sometimes click profile before action
3. Idle pauses: 10–30% chance of "user got distracted" pause for 5–30 min
4. Working hours respect (per-account configurable)
5. Day-of-week variance (weekends quieter)
6. Optional "human mistake" mode: rare typo + edit (most human signal, opt-in)

### Approval queue (opt-in per campaign)
- **Default**: aggressive — actions execute as soon as the scheduler dispatches them
- **Opt-in**: per-campaign toggle to route actions through human review pre-execution
- "Auto-approve after N successful manual approvals" pattern available for users who want gradual trust
- When enabled: visible in dashboard, executed when user clicks Send

### Detection avoidance
- Per-account browser profile (separate Chrome profiles, helped by dashboard)
- Use the extension's session — never the public X API for actions
- Honor X HTML/CSP signals — if X shows "We've limited some of your activity", pause immediately
- Never two accounts targeting the same person in 24h

## 6. Scheduler & Pacing Engine

A deterministic worker, not an AI orchestrator. Two pieces, both server-side:

### Materializer (campaign → actions)
When a campaign is created or resumes:
1. Read campaign config + linked accounts + remaining daily budgets
2. Compute the action plan:
   - **DM Outreach**: one `send-dm` per prospect × per sequence step, scheduled with random delays (5–30 min between sends) within working hours, rotated across linked accounts
   - **Auto Engage**: a recurring `search` action (every 10–30 min) that the extension performs; matched tweets become `like`/`reply`/`retweet` actions queued at random offsets
   - **Automated Posts**: posts/day ÷ working hours = base interval; jitter ±30%; queue N upcoming posts ahead
3. Insert all actions into `actions/` with `scheduledFor` timestamps
4. Don't generate content yet — that happens on-demand at execution time, so we don't waste Gemini calls on stale plans

### Pacer (queue → execution)
Per-account, every poll cycle:
1. Find the next `actions` row where `scheduledFor <= now` AND `accountId == this account` AND `status == queued`
2. Check the account's remaining day budget for that action type — if zero, skip and re-schedule for tomorrow
3. Generate content if needed (Gemini, with brand profile + context); cache on the action row
4. Hand the action to the extension
5. On reported outcome: mark `done`/`failed`; if rate-limited or CAPTCHA'd, push remaining queue back N hours, mark account `cooldown`

### What replaces AI Boss in practice
Use case → How we handle it without an orchestrator:

| AI Boss would have done… | Without AI Boss, we… |
|--------------------------|---------------------|
| "Pick what to post next based on what's trending" | User defines content sources (templates + optional RSS topics). Scheduler picks slot, calls Gemini once with the prompt. |
| "Re-rank prospects in real time as engagement comes in" | Reply detection auto-pauses replied prospects. Lead scoring is a one-time AI pass when list is built (cached on prospect). |
| "Continuously decide engagement targets" | User sets keywords + filter rules. Scheduler runs the search loop deterministically. |
| "Adapt timing based on performance" | Simple per-account heuristic: track engagement-by-hour, weight future post slots toward proven windows (no LLM needed). |

Net effect: predictable, debuggable, cheaper. The AI is a tool the system *calls*, not an agent that *decides*.

## 7. Phased Roadmap

### Status snapshot (2026-05-11)

| Phase | Status |
|-------|--------|
| Phase 0 — Foundation | ✅ shipped |
| Phase 1 — DM Outreach MVP | ✅ shipped |
| Phase 2 — DM v1.0 (sequences, reply detection, health score) | ✅ shipped |
| Phase 3 — Auto Engage (search loop + like/retweet/reply) | ✅ shipped |
| Phase 4 — Automated Posts MVP (scheduling + AI generation) | ✅ shipped |
| Phase 4 v2 — News ingestion, viral pattern miner, perf feedback | 🟡 backlog |
| Phase 5 — Polish & Scale (browser profiles, billing, advanced safety) | 🟡 backlog |
| Phase 6 — Lead Scraper (bio / followers-of / engagers) | ✅ shipped (v1) |
| Phase 7 — DM Co-pilot (Draft mode v1; full-auto poller v1.1) | ✅ shipped (v1) |
| Phase 8 — Analytics & Reporting | ✅ shipped (v1) |
| Phase 9 — Follow/Unfollow campaigns | ✅ shipped (v1) |
| Phase 10 — Multi-account hardening | ✅ shipped (v1) |
| Phase 11 — Inbox v1.1 (Mentions + Replies) | ✅ shipped (v1) |
| Phase 12 — Stripe billing + plan caps | ✅ shipped (v1) |
| Phase 13 — Production hardening (DM action wire-up, approvals, warming, alerts, retries) | ✅ shipped (v1) |
| Phase 14 — Workflow & Intelligence Layer (calendar, triggers, context, prospects, trust, opt-out, notifications, reliability, observability) | 🟡 in progress — 14A/14C/14F shipped, 14E/14I shipped (subset); 14B/14D/14G/14H pending; 14E send-test+undo + 14I Sentry/dashboard deferred |
| Phase 15 — Platform quality sweep (code-split, autosave, worker isolation, prompt A/B, TypeScript, tests) | 📋 planned |
| Phase 16 — Core capability depth (more X actions, content sourcing, smarter scraping/engagement, sequence branches, conversation depth, queue robustness) | 📋 planned |
| Phase 17 — Operator workflow depth (smart lists, suppression, outcome learning, per-prospect context, inbox ergo, trigger chains, pacing depth, brand+prompt depth, template engine, workflow ergo) | 📋 planned |
| Phase 18 — AI Operator Layer (campaign gen, chat-with-data, voice digest, daily assistant, prompt visibility, self-moderation, list cleaner, brand improver, voice control, migration AI) | 📋 planned |
| Phase 19 — Workflow Engine (unified trigger+delay+condition+action graph; visualizer; multi-path; wait-for-event; cron schedules; library; debug mode) | 📋 planned |
| Phase 20 — Public API + Integration Platform (REST + GraphQL; webhook firehose; native Zapier/Make/n8n; embeddable widgets; developer docs) | 📋 planned |
| Phase 22 — Predictive intelligence (outcome prediction; smart pacing; routing; reply-timing; engagement score; super-fan detection) | 📋 planned |

### Phase 0 — Foundation (~1.5 weeks)
- New repos: `xlift-backend`, `xlift-dashboard`
- Backend scaffold: Express + Firestore + auth (clone Reddit pattern)
- Dashboard scaffold: React + Mantine
- Extension ↔ backend: auth flow, account connection, action poll/report protocol
- Logged-in X account detection (extension reports handle)
- Migrate existing local-storage history to Firestore

### Phase 1 — DM Outreach MVP (~3 weeks)
- Lists: CSV import + manual handle entry
- Templates with spintax engine (server-side)
- Single-step DM campaign (no sequences yet)
- Action queue + extension polling executor
- Pacing engine v1 (random delays, working hours, daily caps)
- Approval queue for first 5 actions per campaign
- Dashboard: campaign list, list builder, template editor, queue viewer

### Phase 2 — DM Outreach v1.0 (~2 weeks)
- Sequences (multi-step follow-ups)
- `@`-mention fallback
- Multi-account rotation
- Keyword-search list builder (extension performs the search)
- Similar-handle expansion (AI-driven)
- Reply detection (auto-pause for replied prospects, hand off to AI reply-suggestions)
- Account health score v1

### Phase 3 — Auto Engage (~2 weeks)
- Trigger config (keywords, filters, action mix)
- Search execution loop
- Engagement actions (like/retweet/reply/quote-retweet)
- Reuses existing reply generation
- Approval queue for replies (likes/retweets auto-approve)

### Phase 4 — Automated Posts (~3 weeks)
- Template library + categories
- News/RSS ingestion (server-side worker)
- Market event → relevance scoring → post generation
- Scheduling engine with performance feedback
- Post analytics scraper

### Phase 4 v2 — Posts intelligence (backlog)
- News/RSS ingestion worker (cron-driven, Firestore-backed)
- Market-event relevance scoring → "should we post about this?" check
  before generating content
- Viral pattern miner — track top tweets in user's niche, extract
  hook/payoff structures, feed back into post generation as scaffolds
- Performance feedback loop — extension scrapes engagement (likes,
  reposts, impressions) 24h after post; backend updates per-template
  and per-hour-of-day weights for future scheduling

### Phase 5 — Polish & Scale (ongoing)
- Per-account browser profile manager (we explicitly punted this:
  users manage Chrome profiles manually for now)
- Advanced safety: CAPTCHA detector that pauses the account, automatic
  account-cooldown on detected suspension warning, daily-cap auto-tuning
  based on health score trajectory
- Team accounts / sub-users (org-level Firebase Auth, role gates)
- Pricing/billing (Stripe Checkout + portal, plan-based action caps)
- Code splitting (dashboard bundle is ~650KB gzipped; route-level lazy
  imports would cut initial load)
- Migration: today the GEMINI_API_KEY hardcoded in extension as the
  shared fallback should move to a dashboard-side "AI providers" page
  that stores keys server-side

**Total at scaffold time**: ~3 months to full vision MVP. As of this
commit, all four phase MVPs are shipped — what remains is intelligence,
polish, and scale.

---

### Phases 6–9: competitive parity & growth

Reference benchmark: **xreacher.com** ($67/mo Pro, $299/mo Scale). Their
moat is the four features below; ours is the deeper Brand profile, the
in-X side panel, Auto Engage on tweets (they're DM-only), and
Automated Posts. Closing the gap takes Xlift from "best-in-class
campaign engine" to "best-in-class outbound + inbound stack."

### Phase 6 — Lead Scraper (~1 week)

**Goal**: remove the cold-start problem on Lists. Today users have to
source handles elsewhere; this turns "what should I put in my list"
into "click Scrape, pick checkboxes, Add to list."

**Three sources, one data shape**
1. **Bio keyword search** — X GraphQL `SearchTimeline` with
   `result_filter=user`, cursor-paginated.
2. **Followers of @handle** — GraphQL `Followers` endpoint.
3. **Engagers of a tweet** — GraphQL `Favoriters` and `Retweeters`.

All three return X's `User` object (handle, name, bio, follower count,
avatar, verified, created_at), so the rest of the pipeline is one code
path: filter → dedupe against `scrapedLeads/{userId}/{handle}` cache →
display → bulk add to list.

**Backend**
- `lib/x-scraper.js` — wraps each endpoint, throttled at ~1 req/sec,
  honors per-account rate-limit budget, retries with exponential backoff
  on 429/5xx.
- `routes/scraper.js`:
  - `POST /api/scraper/search` — `{ accountId, source, query|handle|tweetId, filters, cap }`
    → returns deduped, filtered users. Cap: default 200, hard max 1000.
  - `POST /api/scraper/save-to-list` — `{ listId, handles[] }`. Reuses
    existing `addHandles`.
- New collection: `scrapedLeads/{userId}/{handle}` — caches profile
  data, marks "in list X" / "already DM'd by campaign Y" so re-runs are
  fast and dedupe is cheap.

**Safety** — biggest risk; this is where Xreacher's "100% safe" claim
is earned:
- Per-account daily scrape budget (default 1500 user lookups/day),
  tracked on `xAccounts/{id}.dailyCaps.scrapes`.
- 429 → set `rate_limited_until = now + 15min`, surface in UI.
- Synchronous, button-driven only — no background scrape loop in v1.

**Filters**: minFollowers, maxFollowers, hasAvatar, lang, accountAge,
excludeAlreadyOnList, excludeAlreadyContacted.

**Panel UI** — new `LeadsPage.jsx` at `/leads`:
- Source picker (bio / followers-of / engagers)
- Query input (changes label per source)
- Filter row + account dropdown + budget bar
- Results table: checkbox, avatar, @handle, name, bio snippet, followers, last active
- Bulk action: "Add selected to list →" (existing or "+ new list")

**v1 cap**: 200 results, synchronous (~3-4 min). Async batch jobs for
3,000+ scrapes go into a queue-worker (we already have the pattern from
the action queue) and ship in v1.1 — that's the difference between
Xreacher's free and Pro tiers.

### Phase 7 — DM Co-pilot (~2 weeks)

**Goal**: when prospects reply, an AI trained on the user's offer
answers 24/7 and converts the conversation toward a goal (book a call,
share email, click a link). Xreacher calls this "Cupid"; it's their
headline feature.

**Three modes** (per-account toggle):
1. **Draft-only** — drafts every reply, drops it in the chip-bar; user
   clicks Send. Same UX as today's reply suggestions, but for the full
   thread, with brand + offer + goal context.
2. **Assisted** — auto-sends when AI confidence ≥ threshold AND
   message is a routine acknowledgement; drafts everything else.
3. **Full-auto** — auto-sends every reply subject to per-conversation
   caps. Escalates to human on detected anger / negotiation /
   compliance-sensitive topic.

**New data**
```
dmCopilotConfigs/{accountId}
  enabled: bool, mode: 'draft' | 'assisted' | 'full-auto'
  goal: 'book-call' | 'collect-email' | 'send-to-link'
  goalLink, goalContext      // user-provided: "Cal.com URL", "what info to collect"
  maxRepliesPerConversation  // default 5
  escalationKeywords[]       // user list — refund, lawyer, etc.
  pausedUntil

dmCopilotThreads/{accountId}/{conversationId}
  status: 'active' | 'goal-reached' | 'escalated' | 'paused' | 'expired'
  goalReachedAt, goalEvidence  // "user shared email: x@y.com" or "user clicked Cal.com"
  messages: [{ role, text, ts, modelConfidence, autoSent }]
  outcomeSummary  // AI-generated when goal reached
```

**Trigger pipeline**
1. Extension detects new inbound message (DOM observer on
   `[data-testid="message-text-*"]` already exists for reply
   suggestions) → reports `inbound-dm-received` event to backend.
2. Backend: load thread, render context (brand profile + co-pilot
   config + last N messages + goal), call Gemini, score confidence.
3. If mode allows auto-send AND confidence passes threshold: queue
   `send-dm` action (existing executor). Else: push draft to
   chip-bar via the existing suggestions channel so the user clicks
   Send.

**Goal detection** — Gemini classifier on every inbound message:
"Did the user just (a) book a call, (b) share an email/contact, (c)
click the link, (d) ask a clarifying question, (e) decline, (f) get
angry?" Stores the verdict, transitions thread state.

**Safety**
- Hard cap: max N replies per conversation (default 5) before forced
  human takeover.
- Abuse / sensitive-topic detector → auto-escalate to user.
- Per-account daily auto-send cap (separate from outbound DM cap).
- Never auto-reply to first inbound from a user we've never DM'd
  (could be cold spam reaching us; user reviews).
- Audit log: every auto-sent message logged with prompt, confidence,
  goal verdict.

**Panel UI** — new section in `BrandPage` and a new `CopilotPage`:
- Brand page: extend with "Goal" config (already half there in the
  Promote card — formalize it).
- Co-pilot page: enable per-account, set mode, view active threads,
  manually take over any thread.

### Phase 8 — Analytics & Reporting (~1 week)

**Goal**: answer "is this working?" without grepping History. The
data already lives in `actions/` and `history/`; this is aggregation +
UI.

**Backend** — new `routes/analytics.js`:
- `GET /api/analytics/overview?range=7d|30d|90d`
  - DMs sent / replies received / reply rate
  - Auto Engage actions (likes/replies/RTs) and engagement-yielded
  - Posts published + impressions (from Phase 4 v2 scraper, when
    available)
  - New leads scraped, follow/unfollow ratio
  - Account health trend (avg score across connected accounts)
- `GET /api/analytics/campaigns/:id`
  - Funnel: queued → sent → replied → goal-reached
  - Per-template performance (if multiple templates wired)
  - Best-performing prospect attributes (followers band, bio keywords)
- `GET /api/analytics/accounts/:id`
  - Daily cap usage / remaining
  - Health score 30-day trend
  - Follower delta
  - Per-action-type 7d/30d totals

Aggregation strategy: compute on read for small datasets (per-user
data fits in memory), cached in `analyticsCache/{userId}/{key}` with
1-hour TTL. Heavy users → move to a precompute worker on a 5-min cron.

**Panel UI** — extend the existing `OverviewPage`:
- Top row: 4 stat cards (DMs sent today, reply rate 7d, leads added
  7d, account health avg).
- Time-series chart: actions per day, stacked by type.
- "Top campaigns" leaderboard.
- "Top performing scripts" leaderboard (reply rate per template).
- Per-account drill-down on Accounts page.

Charts: add `@mantine/charts` (already pulls in recharts; ~40KB).

### Phase 9 — Follow/Unfollow campaigns (~1 week)

**Goal**: a fourth campaign type that mirrors the classic
"follow-and-unfollow" growth play, with the same safety rails as the
others. Xreacher offers it on Scale tier ($299/mo).

**New campaign type**: `follow-unfollow`.

**Setup**
1. Create campaign → linked accounts.
2. Source: list (manual handles) OR scraper output OR keyword search.
3. Sequence config:
   - Day 0: follow.
   - Day N (default 5): if not following back AND we don't follow them
     organically → unfollow.
   - Day N+90: handle becomes eligible for follow again.
4. Daily caps: already in §5 (`Follows: 10 / 30 / 60`).

**New action types** (added to `actions.type`):
- `follow` — extension executes follow click on profile or hover-card.
- `unfollow` — extension executes unfollow + confirm.
- `check-follow-back` — extension reads relationship endpoint to
  decide whether to queue an unfollow.

**Extension executors** — new clicks-and-DOM handlers in
`lib/executor.js` for the follow/unfollow buttons. Profile-page route
needed (we already navigate for DM sends, this is similar).

**Safety**
- Never unfollow an account we follow organically (i.e. existed
  before any campaign followed them).
- Never unfollow an account that follows us back.
- Never re-follow same handle within 90 days.
- Same health-score rules as DMs: low reply rate equivalent here is
  low follow-back rate; under threshold → auto-pause for review.

**Panel UI** — new path under `/campaigns/new/follow-unfollow`,
mirroring the existing `NewAutoEngagePage` shape.

---

### Sequence + sizing

Recommended order (each block can ship independently):

1. **Phase 6 — Lead Scraper** (~1 week) — biggest unlock; makes Lists
   useful without leaving the app.
2. **Phase 8 — Analytics** (~1 week) — small, mostly aggregation +
   charts; gives users the "is this working?" answer they'll start
   asking the moment they have leads flowing.
3. **Phase 9 — Follow/Unfollow** (~1 week) — fills the fourth campaign
   slot, reuses the Scheduler/Pacer wholesale.
4. **Phase 7 — DM Co-pilot** (~2 weeks) — heaviest lift, biggest
   account-safety surface area; ship last so the autonomous responder
   sits on top of the analytics that prove it's working.

Total: ~5 weeks to full xreacher parity, with our existing
differentiators (Brand depth, Auto Engage, Posts, in-X side panel)
intact.

### Phase 10 — Multi-account hardening (~3 days)

**Problem.** The data model is correctly per-account end-to-end
(actions, history, conversations, dailyCaps, scrapesToday,
healthScore, workingHours, status, cooldown, copilotConfigs,
followStatus on prospects). But three product surfaces still treat
the user as if they have one X account:

1. **Brand profile is global** — `brandProfiles/{userId}` is a single
   doc that auto-engage, auto-posts, and the DM co-pilot all consume.
   A user running `@business` and `@personal` gets the same voice /
   tagline / CTA / hard rules across both. Loud mismatch.
2. **Analytics overview has no per-account pivot** — totals are
   blended; the top-campaigns leaderboard doesn't even show which
   account each campaign ran on. You can drill into one account via
   `/accounts/:id` but can't compare two side by side.
3. **Campaign detail blends multi-account metrics** — for a campaign
   targeting 3 accounts, the stat cards + activity chart aggregate
   everything; no per-account split inside the campaign view.

**10A — Brand override per account (biggest, ~1.5 days)**

- `xAccounts/{id}.brandOverride` — sparse object holding only the
  fields the user explicitly set per-account. Empty fields fall
  through to the global `brandProfiles/{userId}` doc.
- New `lib/brand-merge.js` with `mergeBrand(global, override)` that
  fills in from global for any missing/empty field on the override.
- `lib/auto-engage`, `lib/auto-posts`, `lib/dm-copilot` all replace
  their direct `brandProfiles/{userId}` read with
  `loadBrandFor({ userId, accountId })` which returns the merged
  brand. The drafter prompt sees one brand object — no caller knows
  whether it came from global, override, or both.
- New routes: `GET /api/brand/account/:accountId`,
  `PUT /api/brand/account/:accountId`,
  `DELETE /api/brand/account/:accountId`.
- Panel: new "Brand override" section on `AccountDetailPage`. Same
  fields as `BrandPage`, each placeholder shows the global value.
  "Reset override" button clears the per-account patch.

**10B — Analytics per-account pivots (~1 day)**

- `lib/analytics.overview()` accepts `accountId`. When set, filters
  `history` rows + `topCampaigns` aggregator by that account. Cache
  key includes accountId.
- `lib/analytics.forCampaign()` returns a `byAccount` array when the
  campaign targets 2+ accounts: `[{ accountId, handle, sent, replies,
  errors, replyRate }, ...]`.
- Panel `OverviewPage` gets an account `Select` next to the range
  toggle. Top-campaigns leaderboard shows the account chip(s) on
  each row.
- Panel `CampaignDetailPage` adds a "Per-account breakdown" card when
  `byAccount.length > 1`.

**10C — Cleanup (~half day)**

- Document the soft-delete cascade story (today: archived accounts
  leave their actions / copilotConfigs / scrapesToday docs in place;
  worker filters by status so they never dispatch — fine, but worth
  a runbook entry).
- Note remaining "global" surfaces that are correctly global:
  templates (shared library, accounts pick from), lists (same), brand
  base (override layered on top). These are not gaps — different
  semantics from the three above.

### Phase 13 — Production hardening (~1 day)

Audit pass against "what's missing for perfect end-to-end" turned up
silent failures + operational gaps + polish that all need to land
before the product is shippable to paying users.

**13A — Silent failures (blocks the core flow)**
- **DM send via worker.** `cookie-executor.sendDmHandler` returned a
  stub error; DM Outreach campaigns dispatched by the worker errored
  out silently. ChatPage's manual-send path already worked via
  `routes/conversations` → `x.sendDM` → `x-raw.sendDm`. Fix wires
  the same x-raw path into the action handler so materialized
  `send-dm` actions actually send.
- **Approval queue.** Campaigns with `approvalMode: true` queue
  actions as `status='awaiting-approval'` but the panel had no
  surface to approve them — they sat forever. Add an `/approvals`
  page (list + per-action approve/reject + bulk approve) and
  matching POST endpoints.

**13B — Operational gaps**
- **needs_reauth notifications.** Today an account that loses its
  session just stops dispatching; the user finds out only when they
  notice silence. Hook into the existing Telegram founder bot
  (`lib/telegram.js`) and ping the owner when an account transitions
  to `needs_reauth`.
- **Auto-pause on health degradation.** Health score exists per
  account but isn't enforced. Add a worker tick that pauses any
  running campaign on an account with `healthScore < 40`, and a
  status badge on the panel.
- **Account warming.** Fresh accounts get hit by full caps on day
  one and die fast. Add a `warmingStartedAt` field on `xAccounts`;
  the Pacer multiplies the effective `dailyCaps` by a ramp factor
  that grows from 0.2 on day 1 to 1.0 by day 14. UI toggle on the
  account detail page.
- **Onboarding breadcrumb.** New users land on an empty Overview
  with no path forward. Surface a 4-step checklist (connect account
  → set brand → build list → launch campaign) that disappears once
  they've completed each step.

**13C — Polish**
- **Stale-claim sweep.** If the worker crashes mid-action, the
  `in-progress` row never flips back. A 5-min sweep finds rows
  older than 10 minutes and resets them to `queued`.
- **Retry-with-backoff.** Transient failures (network, 5xx, 429)
  today land in `failed` and stay there. Add up to 3 retries with
  exponential backoff before the action is truly failed.
- **Firestore indexes.** The `inboundEvents` route does
  (userId, type, accountId, ts desc) queries that need composite
  indexes. Add to `firestore.indexes.json` so they deploy cleanly.

**Deferred to v1.1**: co-pilot full-auto poller (separately scoped
in Phase 7's v1.1 follow-ups).

### Phase 14 — Workflow & Intelligence Layer (~5 weeks)

The shift this phase makes: the operator stops chasing the queue, and
the app starts working *for* them. Nine sub-phases, ordered by user-
visible impact and dependency.

**14A — Content calendar + edit-in-place (~1 week)**
Every queued action (Posts, Auto Engage replies, DM follow-ups) lives
in a flat queue today. Replace with a `/calendar` view (week + month,
drag-drop reschedule, color-coded by campaign type, filterable by
account). Clicking any cell opens an editor modal: edit text with
live X-style preview + char count, change `scheduledFor`, swap the
linked account, "Regenerate" (re-roll the draft via Gemini), delete.
Bulk operations: multi-select to reschedule a week forward, or
regenerate with a new tone. Data's already there
(`actions.payload.text` is filled at materialization); this is a UI
pass plus a tiny PATCH endpoint on `/api/actions/:id`.

**14B — Trigger engine (~1.5 weeks) — the killer feature**
Today everything is push (campaign → outbound). Triggers are pull:
something happens *to* the user on X → an action fires automatically.

New collection `triggers/{userId}/{id}` with
`{ source, filter, throttle, condition, action }`.

Sources (event types): `comment-on-our-post`, `quote-of-our-post`,
`like-on-our-post`, `follow`, `reply-to-keyword`, `inbound-dm`.
Filters: min followers, has bio, language, exclude verified, regex.
Throttle: max fires/day per trigger; cool-down per source.
Conditions: "not already DM'd in 30d," "not in list X," "not opted
out" (uses the prospect entity from 14D + the DNC from 14F).
Actions: `send-dm | send-reply | add-to-list | enroll-in-campaign |
telegram-alert | webhook`.

The inbound poller already detects mentions + replies; extend it to
also catch likes, quote-tweets, and follows (Apify can scrape each).
Panel `/triggers` page: list + builder + activity feed showing every
fire ("Auto-DMed @x after they replied to your post about Y").

**14C — Context-aware drafter (~3 days)**
The reply drafter today sees the parent tweet and the brand. Expand
to: full conversation thread (parent + siblings + ancestors via
`conversationId`), the author's recent 5–10 tweets (cached), the
author's bio, what the user has already said to them across all
surfaces (cross-conversation memory from `history`). Same upgrade
on the DM co-pilot — cold openers that reference the prospect's last
week of posts convert 3–5× generic ones.

A "Context preview" toggle on every drafter surface — show the user
exactly what the AI saw before drafting. Debuggability + user trust.

**14D — Prospect timeline + light CRM (~1 week) — connective tissue**
Every handle in a list or scrape becomes a real entity at
`prospects/{userId}/{handle}` aggregated from history + lists +
triggers + co-pilot threads. Prospect detail page renders a
chronological feed (sent DM, they replied, you liked their post, they
followed you, call booked), stage badge, manual notes.

Pipeline kanban at `/pipeline`: columns =
`cold → engaged → replied → goal-reached → customer`. Drag to move,
or auto-transitions (reply → engaged; co-pilot detected goal-reached
→ goal-reached; manual close → customer).

This is the connective tissue: powers the "don't bother them again"
check 14B's triggers need, and the cross-conversation memory 14C's
drafter uses.

**14E — Trust & Control bundle (~1 week)**
Where users have no recourse today. Five pieces:
- **Send-test before launch** — fire one DM to yourself or a sandbox
  handle before a 500-prospect campaign goes live; verify draft +
  spintax + image attach
- **60-second undo** on every scheduled action that's about to
  dispatch (matches X's own undo window)
- **Per-action queue controls** — "skip this prospect / send now /
  regenerate / swap account," mid-campaign, without pausing the
  whole campaign
- **Universal kill switch** in the header — pause everything across
  all accounts in one click (vacation, oops, X is angry)
- **"What actually went out"** — raw post-spintax message on every
  history row, not just the template

**14F — Opt-out + DNC system (~3 days) — not optional**
Every day without this is a ban + legal risk:
- **Opt-out keyword detector** — auto-flag inbound DMs containing
  `stop | remove me | unsubscribe | not interested | spam`. Mark the
  prospect DNC across **every** campaign forever.
- **Cross-campaign re-contact lockout** — never DM the same handle
  within N days regardless of which campaign queued them
  (configurable per-user; default 30d)
- **User-managed block list** — handles you never want contacted
- **Pre-send pattern detection** — Gemini rates "looks generic /
  scammy / clearly AI" with rewrite suggestions before launch
- **Reply-rate watchdog** — campaigns at <1% reply rate over 50 sends
  auto-pause and surface "your hook might be the problem"
- **"You've already DM'd 80% of this list"** warning before
  bulk-adding more prospects

**14G — User-facing notifications (~3 days)**
Users miss the wins today. Ship:
- Email digest (daily / weekly toggle): replies received, campaigns
  running, accounts needing attention
- "You got a reply!" instant push (browser notification + optional
  email)
- Approval-queue alert when items pile up (actionable from email)
- Campaign-completed celebration — "Cold DM Round 1: 7/100 replies,
  3 calls booked"
- Telegram alerts already exist for the founder; this is user-facing
  via Postmark / Sendgrid (TBD provider; suggest Postmark for
  transactional simplicity)

**14H — Reliability + safety bundle (~1 week)**
Architecture-level fixes that don't move pixels but prevent
silent corruption:
- **Idempotency keys** on every state-changing route (campaign
  create, materialize, approve, reject) — header `Idempotency-Key`
  stored in a Firestore TTL collection; replays no-op
- **Plan-downgrade enforcement** — Pro → Free user has surplus
  accounts soft-disabled (status `paused-by-plan`) instead of
  the system pretending nothing happened
- **Stripe webhook replay protection** — per-event idempotency on
  `stripeEventId` (current `set merge` is best-effort)
- **Audit log** on destructive actions — `auditLog/{userId}/{eventId}`
  records who deleted what + when. First time a user asks "who
  deleted my campaign?" you have an answer
- **Optimistic UI** on approve / pause / start / reject — instant
  feedback, roll back on error (the user-visible payoff of all of
  the above)

**14I — Observability bundle (~3 days)**
You can't run a paying SaaS on Railway console logs:
- **Sentry** on panel + backend (error tracking, source maps, release
  tagging)
- **Structured JSON logging** with a `traceId` per request,
  propagated to worker dispatch + Gemini calls + Firestore writes
- **One dashboard** (Grafana / Axiom / Datadog) covering actions/min,
  error rate, Gemini p95 latency, worker queue depth, retries/hour
- **Error-rate alerts** to the founder Telegram bot (>5% 5xx in 5min)

### Phase 15 — Platform quality sweep (~3 weeks)

When Phase 14 is in. These are the "no new feature, just stops
feeling janky" wins.

**15A — Code-split + skeleton loaders + optimistic UI (~3 days)**
- Route-level lazy imports on every page (panel bundle is 353KB
  gzipped today, Login alone pulls recharts + every page component)
- Skeleton placeholders for header / stat cards / chart / table on
  every detail page (the jumping logo for whole-page loads stays, but
  rich pages render chrome immediately)
- Optimistic UI on every mutation that currently waits for the
  server (approve, pause, start, send-message, save-brand)

**15B — Form autosave + client validation + universal confirms (~3 days)**
- Debounced autosave to localStorage on Brand profile, template
  editor, new-campaign forms — nav away mid-edit no longer loses
  work
- Client-side validation matching backend rules (auth_token hex
  format, campaign name length, etc.)
- Standardized `confirm()` patterns: `useConfirm()` hook with consistent
  copy on all destructive actions (currently inconsistent coverage)

**15C — Worker isolation + global X dispatch governor (~1 week)**
- Move `lib/worker.js` out-of-process into a separate Cloud Run job
  (or Railway second service) — API restarts no longer orphan
  in-flight actions
- Cross-account dispatch governor — global rate limit on outbound X
  calls regardless of which account is sending. Today each account is
  in-flight-gated but 5 accounts firing simultaneously from one
  Railway egress IP is a flag
- SIGTERM handling: drain in-flight before exit

**15D — Prompt versioning + A/B + user-edit feedback loop (~1 week)**
- All Gemini prompts pulled out of source into versioned `lib/prompts/`
  (one file per use case — reply, post, brand-generate, co-pilot
  draft, goal-classifier)
- Per-user variant assignment — roll a new prompt to 10% of users,
  measure reply-rate / goal-rate lift
- Capture user edits to AI drafts as training signal — when a user
  edits an AI draft before sending, store the (prompt, original,
  edited) triple; aggregate weekly into a per-user prompt suffix
- Model escalation: high-stakes drafts (cold DM to 50k+ follower
  target) route to Gemini Pro; routine drafts stay on Flash

**15E — TypeScript migration (~3 days, then ongoing)**
Backend first (smaller surface), then panel. Start by typing the
public route contract — every `apiFetch` in `panel/src/lib/api.js`
gets a typed return shape that matches the route handler's response.
Catches the entire class of "panel renders undefined.handle" bugs.

**15F — Tests (~ongoing)**
Zero today. The minimum viable bet:
- **Contract tests** on every route (200 + auth-required + bad-input
  cases). Run on CI.
- **Smoke tests** on the worker happy paths: `materialize → claim →
  dispatch → report → chain`. Run before every deploy.
- **One end-to-end** via Playwright: connect cookie account → create
  DM campaign → start → see action queued. Run nightly.

### Post-Phase-15 polish backlog

Tier 4 — Intelligence:
- "What should I post today?" daily 3-suggestion generator
- Hook diagnostic (low-reply campaigns get AI-rewrite + A/B)
- Competitor tracker (pin 3-5 accounts; cadence + what's working)
- Time-of-day intelligence (schedule DMs for each prospect's peak
  activity hour)
- "Don't sound like AI" pre-flight filter
- Voice-match auto-fill (analyze user's last 100 tweets to pre-fill
  brand profile)
- Cohort analytics ("DMs Mon-Thu convert 2× Fri")

Tier 5 — Power user:
- Cmd+K global search (prospects / campaigns / templates / conversations)
- Keyboard shortcuts on approval queue + tables
- Multi-tag prospects + saved filters on every list view
- "Duplicate this campaign" + "Copy brand from account A to B"
- Bulk prospect operations

Tier 6 — Ecosystem + ops:
- Webhook actions (Zapier-style outbound on reply / goal / trigger)
- Cal.com / Calendly detection in goal context (auto-tag the booking
  link)
- Exportable reports (PDF monthly digest, per-template ROI, CSV
  exports anywhere)
- Vacation mode (pause-all + scheduled resume + Telegram-resume
  alert)
- Sample campaign starters per industry (clone-and-customize
  playbooks)

Tier 7 — UX completeness:
- Dark mode toggle (Mantine supports it; just wire the toggle)
- Time-zone setting per user (UTC pin option for power users)
- Mobile-first thread composer (current is thumb-typeable but not
  designed for it)
- Approve-from-phone (single-tap approve/reject, no modal)
- Global account switcher in the header (filters every page to that
  account's data)

Tier 8 — Scale/compliance:
- Firestore Security Rules layer (defense-in-depth beyond
  `where userId == req.userId`)
- Encryption-key rotation via KMS
- History archival (>90d rows move to cold storage)
- PII redaction in Gemini prompts (regex strip emails/phones before
  send)
- Multi-region failover (Apify, Stripe, Telegram each have single
  points today)
- Usage-based metering per plan (Gemini calls + scrape volume, not
  just account count)

The order through Tier 4-8 isn't fixed — pull in based on which
real user pain shows up first. The Phase 14-15 commitment is the
intentional plan; everything below is the option pool.

### Phase 16 — Core capability depth (~6–8 weeks)

What the engine itself can't yet do *on X*. Nine sub-phases covering
new action types, content sourcing, smarter scraping/engagement,
richer sequence mechanics, conversation depth, account robustness,
posting intelligence, and queue-level ops. Independent of the
workflow / quality / business work in Phases 14–15 + Tiers 4–8.

**16A — More native X action types (~1.5 weeks)**
The product today supports send-dm, post, like, retweet, reply,
follow, unfollow, search. The native surface is way bigger:
- **Quote-tweet campaigns** as a primary type (not just inside Auto
  Engage's 5% action mix)
- **Bookmarking** as an action — silent engagement signal X weighs
  positively
- **X Lists management** — create, add, remove members
  programmatically; bulk-add a scraped cohort into a list for
  research / engagement targeting
- **Pin / unpin posts** — auto-pin your week's best
- **Auto-delete posts after N days** — privacy / pivot cleanup
- **Profile updates on a schedule** — bio, name, location, website,
  pinned-tweet rotation; A/B test bio CTAs
- **Profile picture / banner scheduling** — seasonal swaps
- **Threads composer** as first-class campaign content — currently
  Auto Posts is single-post; threads are where engagement lives
- **X Spaces scheduling** + auto-promote via post + DM blast
- **Group DMs** — create a thread with N people at once
- **Mention/tag** specific accounts when scheduling posts
- **Bulk delete old tweets** — privacy + pivot cleanup
- **Block / mute** as defensive automation actions

New action types: `quote`, `bookmark`, `list-create`, `list-add`,
`list-remove`, `pin`, `unpin`, `delete-post`, `profile-update`,
`thread`, `space-schedule`, `group-dm`, `block`, `mute`.
Each needs an executor handler in cookie-executor + worker chain
support if the action triggers a downstream effect.

**16B — Content sourcing pipelines (~1 week)**
Auto Posts today only generates from brand profile + topic. Real
content engines pull from outside X:
- **RSS / Substack / Medium feed ingestion** — your own blog
  publishes → AI summarizes into a tweet → schedules it
- **Reddit / Hacker News** scraper → niche-relevant repurposing
- **Google News / news API** alerts → reactive commentary on
  breaking industry events
- **YouTube channel watcher** → auto-tweet on new uploads
- **Podcast RSS** → auto-clip-and-post the headline soundbite
- **Webhook → post** — external system triggers a tweet
  (Webflow CMS publish, Zapier, etc.)
- **Evergreen recycling pool** — flag a post as evergreen; app
  recycles winners every N months
- **Tweet-from-Google-Sheets** — sync sheet rows → scheduled posts

New collection `contentSources/{userId}/{sourceId}` with
`{ type, config, scheduleRule, mappingTemplate }`. New action type
`source-ingest` that runs the source, generates draft tweets, and
queues them through Auto Posts' normal pipeline (so the same
human-shape pacing applies).

**16C — Scraper depth (~1 week) — highest leverage in the phase**
The Lead Scraper today does keyword tweet search (dedup authors),
followers-of-handle, and retweeters-of-tweet. Adds:
- **Likers of a tweet** — explicitly noted as v1.1 in Phase 6,
  never shipped (Apify can do it)
- **Following list of a handle** — audience-of-audience is often
  higher-quality than just followers
- **X List members** — scrape members of any public list
- **Date-range tweet search** — "all @x tweets between Jan-Mar"
  historical mining
- **True bio-keyword search** — currently the "keyword" path searches
  tweets and dedupes authors; this is the same query against
  bios (Apify's profile-search actor)
- **Geographic search** — accounts / tweets from a city or country
- **Engagement-threshold filter** — "accounts with >10k followers AND
  >100 avg likes per recent post"
- **Behavior-based scrape** — "accounts that engaged with competitor
  @x in the last 30 days"
- **Bulk profile enrichment** — paste a list of handles, get follower
  count / bio / last tweet / language for each
- **AI lead scoring** — Gemini scores each scraped lead 1-100 on fit
  against the user's brand profile; the panel sorts highest-first

`lib/x-scraper` extends to new sources; each routes through Apify
(actor variants) or rettiwt depending on rate-limit profile.
`scrapedLeads/{userId}/{handle}` doc gains `aiFitScore`, `lastSeenAt`,
`tagsFromScrape[]`.

**16D — Engagement intelligence (~1.5 weeks)**
Auto Engage today is "search keywords → engage on matches." Smart
engagement layers on top:
- **Reply boost** — when one of YOUR posts crosses an engagement
  threshold in the first 30 min, auto-engage with the top
  commenters (sub-15-min reply window converts best on X)
- **Quote-tweet farming** — find viral posts in your niche
  (`>N likes in <T hours` filter), auto-generate add-on commentary
  as a QT
- **Niche timeline mining** — instead of keyword search, follow
  N seed accounts and Auto Engage on **their** timelines
- **Topical "join the conversation"** — detect trending topics in
  your niche (Apify trends actor), auto-generate a relevant post in
  time to ride the wave
- **Defensive engagement** — auto-detect hostile replies to your
  posts → de-escalation reply (Gemini-classified hostility +
  pre-approved templates)
- **Engagement pods** coordination (multi-account boost) — gated
  behind explicit consent + clear safety messaging

New campaign type `reply-boost` that watches your own recent posts
+ dispatches engagement actions on hot ones. New trigger sources
match (`our-post-going-viral`, `niche-trend-detected`,
`hostile-reply-on-our-post`).

**16E — Sequence mechanics (~1.5 weeks)**
DM Outreach today is linear: step 0 → step 1 → step 2. Real outbound
needs:
- **Conditional branches** — "if they engaged with step 1, send
  step 2A; else step 2B" (engagement = like / reply / view / open)
- **A/B test campaigns** at the campaign level (not just post
  variants) — same list, two templates, split 50/50, auto-declare
  winner after N replies
- **Multi-channel coordinated sequences** — like → wait 2d → reply
  → wait 3d → DM (warm-then-strike pattern)
- **Re-engagement / win-back campaigns** — past prospects who
  replied positively but never converted, quarterly outreach
  with a different angle
- **Send-time personalization** — at dispatch time, re-write the DM
  using the prospect's last 24h of tweets (more relevant than
  materialization-time generation)
- **Dynamic variables resolved at send-time** —
  `{{last_tweet}}`, `{{follower_count}}`, `{{recent_topic}}`,
  `{{day_of_week}}` filled in microseconds before send
- **Pause campaign at N count for review** — "send 50 then auto-
  pause" so the user can sanity-check the response rate
- **Resume preview** — show the next 5 prospects + final drafts
  before clicking resume

Sequence schema extends to support conditions on each step
(`{ if: 'engagement', then: stepId, else: stepId }`).

**16F — Conversation depth (~1 week)**
The Inbox + Co-pilot work today, but conversations are flat:
- **Inbox auto-categorization** — Gemini buckets inbound DMs into
  `lead | customer | spam | noise | support` so you triage at a
  glance
- **Auto-tag conversations** with topic + outcome (`asked-pricing`,
  `complaint`, `integration-question`, `objection`, `interested`)
- **One-line conversation summary** at the top of every thread
- **Promised-follow-up tracker** — AI detects "I'll send you the
  link tomorrow" → reminder fires tomorrow with the original context
- **DM voice notes** — record audio inside the panel and attach
- **DM image with auto-caption** — drop image, AI captions in your
  voice
- **Conversation summary** on every prospect detail page —
  one-paragraph synthesis of the entire history

New collections / fields: `dmCopilotThreads.{tags, category,
summary, promisedFollowUps[]}`.

**16G — Account robustness (~1 week)**
Cookie sessions are fragile. Make them less fragile:
- **Background heartbeat probe** — every 30 min, GET
  `/account/settings` on every active account to validate the
  session before it dies mid-campaign
- **Auto-refresh ct0** — we capture rotated ct0 when X mints one in
  a write response, but never proactively refresh; should run a
  scheduled mint via a no-op write
- **Shadowban / soft-suspension probe** — periodic "does my last
  tweet appear in search?" + "does my profile load when logged out?"
  checks; flag account
- **DM-to-self ownership verify** on connect — confirms the user
  actually owns the X account they're pasting cookies for
- **Multi-cookie failover** per account — accept multiple sets of
  cookies, rotate on 401
- **Handle-change detector** — alert when the user renames their X
  account so we re-resolve `userIdOnX` and update everywhere

`xAccounts.heartbeatStatus`, `lastHeartbeatAt`, `shadowbanProbe`.
New worker tick variant for the heartbeat sweep.

**16H — Posting intelligence (~1 week)**
Auto Posts is dumb-scheduled today. Make it smart:
- **Best time per content type** — informational posts ≠ hot takes
  ≠ memes; each has a different optimal window per account
- **Day-of-week themes** — Monday motivation, Tuesday tip, Friday
  wins (user-configurable per account)
- **Evergreen pool with auto-recycling** — your top 10 posts replay
  every quarter
- **Draft pool / pile** — write 20 posts in one session, schedule
  from a draft library on a cadence
- **Style fingerprint** — analyze user's last 100 tweets, capture
  metrics (avg length, emoji rate, sentence structure, hook
  patterns, paragraph cadence)
- **Style consistency score** — every outgoing draft scored against
  the fingerprint; drift alert if 5 in a row deviate
- **Tone toggle per campaign** — friendly / professional / contrarian
  / playful switch that adjusts the generator prompt

`brandProfile.styleFingerprint` (computed), `auto-posts.config.theme`,
`auto-posts.draftPool[]`.

**16I — Queue + campaign ops robustness (~3 days)**
Operating long-running campaigns at scale needs more controls:
- **Bulk reschedule** — "shift all pending actions for @account by
  4 hours" / "compress all of next week into 3 days"
- **Account swap mid-campaign** — move running queue from account A
  to account B (e.g., A hit warming wall, B has headroom)
- **Reusable sequence library** — save a sequence ("3-step founder
  cold reach") + reuse across campaigns
- **Reusable campaign templates** — save full campaign config
  (sequence + filters + accounts + approval mode) as a clonable
  template
- **Per-prospect DM count display** — before scheduling, the panel
  shows "we've DM'd them 4 times in 6 months across 2 campaigns"
- **Link rotation** — instead of same URL in every DM, rotate
  through tracked variants per prospect
- **Auto UTM appending** on outbound links per campaign

New collections: `sequenceTemplates/{userId}/{id}`,
`campaignTemplates/{userId}/{id}`. New routes for bulk-reschedule
+ account-swap + link-rotation config.

### Recommended Phase 16 build order

Different from the alphabetical labels. Optimized for needle-moving
per dev-day given Xlift's current state:

1. **16C — Scraper depth** *(1 week)* — biggest leverage; the lead
   side is shallow and most user wins start with better targeting
2. **16E — Sequence mechanics** *(1.5 weeks)* — conditional + send-
   time personalization make every existing DM Outreach campaign
   convert better without new collections
3. **16D — Engagement intelligence** *(1.5 weeks)* — reply-boost +
   niche timeline mining unlock the "free engagement" tactic that's
   hardest to do manually
4. **16A — X action types** *(1.5 weeks)* — biggest "things we should
   already do" pile; threads composer alone is a top-three feature
   ask in this category
5. **16F — Conversation depth** *(1 week)* — triages the inbox at
   scale, sets up real CRM later
6. **16G — Account robustness** *(1 week)* — prevents the silent
   session failures that kill long-running campaigns
7. **16B — Content sourcing** *(1 week)* — Auto Posts content
   engine; one-shot value once it's in
8. **16H — Posting intelligence** *(1 week)* — drives Auto Posts
   from dumb-scheduled to actually-good
9. **16I — Queue ops robustness** *(3 days)* — quality-of-life pass
   to close out

Total: ~9 weeks of focused build for Phase 16. Combined with Phases
14-15 (~8 weeks), the next-three-phase plan is ~17 weeks of work to
get from current state to "everything a serious X operator could
ask for, plus the underlying engine to support it."

### Phase 17 — Operator workflow depth (~5–6 weeks)

The capability gaps in Phase 16 are about *what the engine can do*.
Phase 17 is about *what running it day-to-day actually feels like
for someone who lives inside it 6 hours a day*. Ten sub-phases —
each one is "user already wanted this on day 7 but tolerated its
absence."

**17A — Smart / dynamic lists + suppression layer (~1 week)**
Lists today are static collections of handles. Real operators want:
- **Dynamic / smart lists** — a list defined by a query that
  auto-updates (e.g., "all founders in SaaS, 1k-10k followers,
  posted in last 7 days"). Re-evaluates daily.
- **Saved searches** in the Lead Scraper — same idea on the
  scraper side
- **Suppression lists** — global do-not-contact, "already-customer"
  list, "churned-customer" list. Cross-campaign suppression that's
  semantically richer than the opt-out DNC (which is triggered
  reactively).
- **List intersection / union / difference** — "everyone in A
  AND B," "in A but not B," "in A or B"
- **Prospect dedup across lists** — if a handle is in 3 lists,
  treat as one entity in pipeline + history
- **Auto-prune** banned / deleted / suspended accounts from lists
  on a schedule
- **Freshness indicator** — last-tweet >90 days = inactive,
  deprioritize in dispatch order

**17B — Recurring scrapes + persona presets (~3 days)**
The Lead Scraper today is one-shot. Set-and-forget pipelines:
- **Saved scrape sessions** — re-run yesterday's query with one
  click
- **Recurring scrapes** — daily / weekly cadence, results auto-add
  to a designated list (with the freshness filter so you only get
  *new* accounts each run)
- **Diff scrapes** — "show me accounts that match today but didn't
  yesterday" — surfaces just-followed, just-engaged-with-X, etc.
- **Negative filters** — "anyone matching X BUT EXCLUDE accounts
  that follow @competitor-handle" (audience anti-overlap)
- **Persona template library** — predefined criteria for common
  targets: "indie hackers," "SaaS founders," "agency owners,"
  "recruiters." Clone-and-tweak.

**17C — Outcome learning loop (~1 week) — compounds over time**
Every conversation that ends without a win-tag is wasted
intelligence. Build the feedback loop:
- **Win / loss tagging** at conversation end — `booked-call`,
  `interested-no-action`, `pricing-objection`, `not-fit`, `ghosted`,
  `customer`, `churned-customer`. AI suggests; user confirms.
- **Outcome attribution** — "this DM led to a booked call" / "this
  reply led to a sale of $X." Manual at first, plus auto-detection
  via Cal.com / Stripe webhook integration where wired.
- **Reply rate prediction per template / hook** — Gemini scores
  every draft against the user's historical reply-rate data on
  similar hooks: "this opener has a 12% predicted reply rate vs
  your historical average of 7%."
- **Template performance ranking** — weekly auto-ranking of all
  active templates by reply rate + win rate; flag bottom-quartile
  for retirement
- **Suggestion engine** — based on win/loss data, AI suggests
  template tweaks ("your top hook started with a question; your
  bottom hooks all started with 'Hey'")
- **Wins feed** in the panel — every reply, every booked call,
  every goal-reached surfaces as a card on the Overview

New collection `outcomes/{userId}/{conversationId}` plus tag
metadata on `dmCopilotThreads` and `history`.

**17D — Per-prospect context + universal tagging (~1 week)**
The drafter today knows the brand and the conversation. Power
operators also know specific things about specific prospects:
- **Per-prospect notes** visible to the AI in every draft — "founder
  of Acme, met at SaaStr, talked about pricing, wants discount"
- **Universal tagging** as a first-class concept on prospects,
  campaigns, lists, templates, and history. Multi-tag (not just
  stage). Filter and segment everywhere by tag.
- **Recently viewed prospects bar** — fast back-and-forth between
  prospects you're working
- **Quick-actions context menu** on every prospect row — DM now,
  add to list, block, copy URL, view on X, jump to convo
- **Drag-drop prospects between lists**
- **Per-prospect DM count display** before scheduling — "we've DM'd
  them 4 times across 2 campaigns in 6 months; sure?"
- **Pipeline stages auto-update from outcome tags** (17C feeds 17D)

**17E — Inbox ergonomics (~1 week)**
The unified Inbox today shows conversations and lets you reply.
Power-user table stakes:
- **Saved replies** — quick canned responses (separate from
  campaign templates) for the same canned replies users send 20×/day
  ("Sure, here's the link" / "Let me check and circle back")
- **Conversation snooze** for N days — disappears, comes back as
  a tracked reminder
- **Pin** important threads to top
- **Mark unread** after viewing (re-surface later)
- **Bulk archive** old threads
- **Search within a conversation**
- **Translate conversation** — view in your language if prospect
  wrote in theirs; reply in theirs auto-translated
- **DM scheduling** for one-off sends — write now, send at 2am
  their time (not part of a campaign)
- **Multi-message DM** — split a long message across N consecutive
  sends with delay (human-shape)
- **DM read receipts surfaced** — X exposes them via the same
  endpoint; show "delivered / read / replied"
- **Quick context menu** per conversation (mark spam / customer /
  follow-up / etc.)

**17F — Trigger sophistication (~1 week) — beyond Phase 14B basics**
Phase 14B ships a one-shot trigger model. Real automation graphs
need:
- **Trigger chains** — trigger A fires → trigger B watches → trigger
  C fires conditional on B's result. Multi-step.
- **Delayed triggers** — "3 days after they followed → DM"; "1 week
  after no reply → polite nudge"
- **Trigger A/B testing** — same trigger, two action variants,
  auto-declare winner
- **Trigger preview / dry-run** — "given yesterday's data, this
  trigger would have fired N times against these accounts" before
  flipping on
- **Trigger fire history** — every fire logged with the matching
  event, what was sent, and the outcome
- **Quiet-mode triggers** — fire at most once per N hours regardless
  of how many events match
- **Cross-account triggers** — "if any of my 5 accounts gets
  mentioned, trigger fires from a specific account"

**17G — Pacing depth (~3 days)**
The pacer today knows: random gap, working hours, daily caps,
warming. More realism + safety:
- **Per-action-type pacing** — DMs in 9-6, posts at 11am/3pm/8pm,
  replies anytime, follows weighted toward weekday mornings
- **Lunch break gap** — auto-pause 12-1pm in account's tz
- **Holiday calendar** — auto-pause on national holidays (US
  Federal default, configurable per-account)
- **Per-prospect time zone scheduling** — when prospect has a stated
  tz / city, schedule DM dispatch for their working hours, not the
  operator's
- **Circuit breaker** — auto-pause campaign if failure rate crosses
  threshold (say >20% over 10 actions)
- **Burst protection** — hard cap on max N actions per T minutes
  per account, regardless of campaign config

**17H — Brand + prompt depth (~1 week)**
The brand profile gives the drafter style. More handles:
- **Per-campaign tone override** — campaign-level "be aggressive"
  or "be gentle" overlay without rewriting brand
- **Forbidden words list** — concrete words the drafter must never
  use ("unlock," "delve," "I'd be happy to," etc.)
- **Forbidden brand-mention list** — competitor names the drafter
  must never invoke
- **Few-shot examples per campaign** — paste 3 examples of "this
  is exactly how I want the DM to look"; AI uses them as anchors
- **Negative examples (rejected drafts)** — when a user edits or
  rejects a draft, capture both versions; AI gets "don't do this"
  in addition to "do this"
- **Cold open variation generator** — generate 5 distinct opening
  hooks for a single template, pick favorites to A/B
- **Auto-CTA insertion every N posts** — keep promotion present
  but subtle; rotate variants

**17I — Template engine depth (~3 days)**
The spintax + variable engine works; visibility into how it works
doesn't:
- **Spintax tester** — render 10 random samples of a template
  before launch with per-variant predicted reply rate
- **Template version history** — every save snapshotted; rollback
  to any prior version
- **Template performance comparison view** — side-by-side metrics
  for any N templates of the same type
- **Spintax richness score** — flag templates using `{a|b|c}` in
  only 1-2 spots ("try more variety in the hook")
- **Variable validation** — flag templates referencing
  `{{var_name}}` that doesn't exist on the linked list
- **Live preview** while editing — render with sample prospect
  data inline

**17J — Workflow ergonomics (~3 days)**
Death-by-a-thousand-cuts polish:
- **Bulk handle paste** — paste 500 handles, dedupe + validate +
  add to list in one action (better than CSV for ad-hoc lists)
- **DM preview as recipient sees it** — render the message exactly
  as it'll appear in their X inbox, mobile + desktop side-by-side
- **Campaign cloning with substitutions** — "duplicate this
  campaign but swap @accountA for @accountB and list X for list Y"
- **Manual retry button** on every failed action — separate from
  auto-retry-with-backoff; user-triggered "send this now"
- **Self-account auto-exclusion** — never include the user's own
  accounts in scrape targets, DM targets, or trigger fires
- **Recently viewed everything** quick-access bar — campaigns /
  prospects / templates / threads
- **Tweet detail page** — drill into one posted tweet, see all
  engagement (who liked, who replied, who QT'd, who bookmarked)

### Recommended Phase 17 build order

Different from the alphabetical labels. Optimized for compounding
impact:

1. **17C — Outcome learning loop** *(1 week)* — every other tier
   gets better the moment win/loss data starts flowing in
2. **17A — Smart lists + suppression** *(1 week)* — eliminates
   the manual list-curation tax that scales linearly with users
3. **17D — Per-prospect context + universal tagging** *(1 week)* —
   massive drafter quality lift; ties to 17C's outcome tags
4. **17F — Trigger sophistication** *(1 week)* — Phase 14B is
   one-shot; chains + delays + A/B make triggers an actual graph
5. **17E — Inbox ergo** *(1 week)* — table stakes for any user
   processing >20 DMs/day
6. **17H — Brand + prompt depth** *(1 week)* — drafter quality
   pass
7. **17B — Recurring scrapes** *(3 days)* — set-and-forget lead
   pipelines
8. **17G — Pacing depth** *(3 days)* — safety win, mostly invisible
9. **17I — Template engine depth** *(3 days)* — power-user polish
10. **17J — Workflow ergo** *(3 days)* — the last-mile polish

Total: ~6 weeks of focused build for Phase 17. Combined with
Phases 14-16, the four-phase commitment is ~23 weeks (~5.5 months)
to a product that's genuinely operator-grade.

### Phase 18 — AI Operator Layer (~4 weeks)

The product today asks the operator to configure everything (brand
fields, list filters, sequence steps, trigger conditions). Phase 18
turns the app into an agent that operates itself under direction —
the single biggest UX leap on the roadmap.

- **18A · AI campaign generator from goal** — type
  *"book 3 calls/week from SaaS founders, 1k–10k followers"* → AI
  generates target criteria + scrape + sequence + brand override +
  trigger config in one go. Operator approves; system runs.
- **18B · Chat with your data** — *"how many DMs sent last Tuesday?
  which template performed best?"* → Gemini queries Firestore +
  history via a function-calling layer and answers in plain English
- **18C · AI weekly digest in your voice** — Gemini reads your week's
  metrics + outcomes and writes the digest *as if you wrote it*
- **18D · Daily "what should I do next?" assistant** — three
  prioritized actions every morning based on state (paused campaign
  needs attention, 12 unread DMs from leads, scrape budget unused)
- **18E · AI prompt + reasoning visibility** — click any AI-generated
  artifact → see the prompt + which brand fields + which context fed
  it. Trust through transparency.
- **18F · Pre-publish self-moderation** — every outbound DM / post
  scanned by Gemini for things you'd regret: broken link, typo,
  factual error vs. past statements, brand-tone drift, legally risky
  claim, link to deleted resource
- **18G · AI list cleaner** — analyze an existing list, flag handles
  unlikely to convert (inactive, bot-shape, follower:following ratio
  off, mismatched language, behavioral signals of spam accounts)
- **18H · AI brand-profile improver** — *"your brand is thin on
  audience + voice notes; here's what to add based on your top-
  performing tweets"* — read your last 100 tweets, suggest fills
- **18I · Voice control** — Whisper-driven hotkey ("Hey Xlift, pause
  all campaigns" / "schedule a post about X for tomorrow noon")
- **18J · Migration AI** — point at a competitor export
  (xreacher / MagicReply / etc.) → Gemini maps it into Xlift's
  schema and imports brand + lists + templates in one shot

### Phase 19 — Workflow Engine (~3 weeks)

Today the app has three overlapping abstractions: **campaigns**
(start → run), **triggers** (event → action), **sequences** (step
ladder). Phase 19 unifies them into one primitive that's strictly
more powerful than any of them alone.

- **19A · Workflow primitive** — every automation is a directed
  graph: `trigger → delay → condition → action → branch → merge`.
  Campaigns become "workflows with a list as the source." Triggers
  become "workflows with an event source." Sequences become
  "workflows with serial steps." One data model, one engine, one
  worker handler dispatching all of them.
- **19B · Workflow visualizer** — flowchart view of the graph,
  drag-drop to edit nodes, hover any node to see fire history and
  what's pending; live status (green = fired, yellow = waiting, red
  = blocked)
- **19C · Multi-path workflows** — forking branches that re-converge
  ("if engaged → A; else → B; both converge to C"). Today's Phase
  14B triggers + Phase 16E conditional branches handle linear
  branching but not true graphs.
- **19D · Wait-for-event blocks** — "*wait until they reply OR 7
  days pass, whichever first*"; the engine subscribes to the event
  source and resumes at first match
- **19E · Cron-style standalone schedules** — workflows that aren't
  tied to a campaign or a trigger ("*every Monday 9am, scrape my
  followers, add new ones to list X*")
- **19F · Workflow library** — save / share / clone any workflow as
  a template; eventually a public marketplace
- **19G · Debug mode** — step through a workflow on test data, see
  exactly which branch fires at every node and why

This is a refactor as much as a new feature: Phases 14B (triggers)
and 16E (sequence mechanics) get re-implemented on top of the
workflow primitive. After this, every new automation feature is
"add a node type" instead of "build a new subsystem."

### Phase 20 — Public API + Integration Platform (~4 weeks)

The product is an island today. Phase 20 makes Xlift extensible —
critical for agencies, power users, and enterprise demos.

- **20A · Public REST API** — OAuth 2.0 tokens, scoped permissions,
  rate-limited per plan. Every panel operation has an API equivalent.
- **20B · GraphQL endpoint** — single-query access to "all my
  campaigns + their actions + outcomes" for power users + agency
  dashboards
- **20C · Webhook event firehose** — emit every system event (action
  dispatched, reply received, trigger fired, goal reached, campaign
  paused) to a user-configured URL. Inverse of incoming webhooks
  from Tier 6.
- **20D · Native Zapier app** — public listing in Zapier marketplace
  with pre-built actions + triggers. Same for Make.com + n8n. Three
  native integrations unlock thousands of pre-built downstream
  automations users get for free (Notion, Sheets, Slack, etc.).
- **20E · Embeddable dashboard widgets** — agencies embed Xlift
  charts on their client portal via iframe or React widget
- **20F · API-first feature parity** — every new Phase 14-19 feature
  ships with API endpoints first, UI second. Token usage inspection,
  per-token throttling, revocation, audit
- **20G · Developer docs site** at `developers.xlift.ai` with curl
  / JS / Python examples and a sandbox playground

### Phase 22 — Predictive intelligence (~3 weeks)

Slots in after Phase 18 + Phase 17C's outcome-learning loop produce
enough data to train against. Turns the AI from "drafts text" into
"predicts outcomes":

- **22A · Conversation outcome prediction** — at each step of a
  sequence, predict the probability of reply / goal-reached / churn
  ("this prospect has 60% chance of replying, 25% of booking")
- **22B · Smart adaptive pacing** — engine learns from rate-limit
  signals across accounts; auto-tightens caps *before* X tightens
  for us (rather than after)
- **22C · Account routing** — best-account-to-send-from prediction
  per prospect (one of your accounts has historically converted
  this prospect's demographic better; route there)
- **22D · Reply-timing prediction** — when this specific prospect is
  most likely to respond, optimize dispatch timing accordingly
- **22E · Per-prospect engagement scoring** — every prospect gets a
  rolling responsiveness score that informs sequence aggressiveness
- **22F · Super-fan detection** — cross-account follower analysis;
  "*these 23 people follow 4 of your 5 accounts — they're already
  bought in*"
- **22G · Content recommendation engine** — beyond the brand-driven
  generator, AI recommends what to post based on niche trends + your
  past wins

### Updated roadmap totals

- **Committed plan (14–17):** ~23 weeks
- **Plus Phase 18 (AI Operator):** +4 weeks → ~27 weeks
- **Plus Phase 19 (Workflow Engine):** +3 weeks → ~30 weeks
- **Plus Phase 20 (Public API):** +4 weeks → ~34 weeks (~8 months)
- **Plus Phase 22 (Predictive):** +3 weeks → ~37 weeks (~9 months)

The 14–17 commitment is enough to ship a product that's
operator-grade. 18–22 take it to *agent-grade*. Each phase is
independently shippable; pick the order based on which growth
bottleneck shows up first.

**X-only strategic commitment:** multi-platform expansion (LinkedIn
/ Reddit / Threads / Bluesky) is explicitly off the roadmap. The
product is X-native end-to-end — cookie-mode auth, Apify scrapers,
rettiwt transport, the warming model, all tuned for X's specific
anti-bot signal landscape. Going multi-platform would double the
addressable market but require a PlatformAdapter refactor + ongoing
platform-keep-up cost (X's API + counter-bot tactics change
frequently; tracking two platforms doubles that ongoing burden).
Better to be unambiguously the best X tool than mediocre at four.

## 8. Current capability snapshot

As of Phase 13, the panel + backend stack at `app.xlift.ai` is shippable
end-to-end. The legacy "what's done vs needed" table from Phase-0
planning was replaced with this snapshot of real surfaces.

| Surface | Status | Notes |
|---------|--------|-------|
| Backend (Express + Firestore) on Railway | ✅ | multi-tenant, Firebase Auth |
| Panel (React + Mantine + Vite) | ✅ | `app.xlift.ai`, full mobile responsive |
| Chrome extension (in-X widget + reply suggestions) | ✅ | Dashboard/Topics/Accounts stubs in `sidepanel.html` are legacy decorative |
| Cookie-mode X auth (paste cookies + sticky proxy) | ✅ | encrypted at rest, rotate via "Update cookies" |
| DM Outreach campaigns | ✅ | sequences + spintax + skip-if-replied via worker |
| Auto Engage campaigns | ✅ | search via Apify (rettiwt 404s from data-center IP) |
| Automated Posts campaigns | ✅ | Gemini-generated, scheduled, single-account |
| Follow / Unfollow campaigns | ✅ | day-0 follow → day-N check → conditional unfollow |
| Lead scraper (bio / followers-of / retweeters) | ✅ | per-account daily budget, Apify-backed |
| Inbox (DMs + Mentions + Replies) | ✅ | mentions/replies need `APIFY_TOKEN` |
| DM Co-pilot Draft mode | ✅ | brand-aware drafts in ChatPage |
| DM Co-pilot Assisted / Full-auto | 🟡 v1.1 | UI labelled, poller deferred |
| Brand profile + per-account override | ✅ | sparse merge over global |
| Multi-account analytics + per-campaign breakdown | ✅ | overview/campaign/account endpoints |
| Approval queue | ✅ | `/approvals` page + bulk approve |
| Stripe billing (Free / Pro $67 / Scale $299) | ✅ | inert until env vars set |
| Plan-based account caps | ✅ | enforced on connect-cookie |
| Per-account health score + auto-pause < 40 | ✅ | watchdog tick every 5 min |
| Account warming (20% → 100% over 14d) | ✅ | auto-enabled on new connects |
| Retry-with-backoff on transient failures | ✅ | 3 attempts, exponential |
| Stale-claim sweep (worker crash recovery) | ✅ | every 5 min |
| Telegram founder-bot alerts (needs_reauth + health) | ✅ | needs `TELEGRAM_BOT_TOKEN` |
| News / RSS ingestion for Auto Posts | 🟡 v1.1 | Phase 4 v2 backlog |
| Viral pattern miner + post performance feedback | 🟡 v1.1 | Phase 4 v2 backlog |

## 9. Tech Stack

- **Backend**: Express + Firebase Firestore + Gemini + node-cron, hosted on Railway
- **Dashboard**: React 18 + Vite + Mantine UI + TanStack Query, hosted on Railway
- **Extension**: existing MV3 stack (vanilla JS + Shadow DOM)
- **Auth**: Firebase Auth (email link or Google)
- **Payments**: Stripe (later phase)
- **Monitoring**: Firestore logs initially, Sentry later

## 10. Risks & Open Questions

### Risks
1. **X account suspension** — primary risk. Mitigation: aggressive safety, opt-in approval, conservative defaults, transparent caps, account health score.
2. **X DOM/API changes** — testid renames break extension. Mitigation: telemetry on every selector, alert-on-break, fallback heuristics already in place.
3. **Gemini cost at scale** — every post + reply is a Gemini call. Mitigation: cache prospect-research results, batch where possible, fall back to templates when rate-limited.
4. **CAPTCHA / login challenges** — X may step up challenges on automated accounts. Mitigation: pause-on-challenge, alert user, never auto-solve.
5. **TOS / legal** — automated DM at scale may violate X's policies. Document the risk in onboarding; users assume responsibility.

### Resolved architecture decisions (locked in over Phases 0–13)
The Phase-0 open questions are all settled. Recording outcomes here so
future re-litigation has a baseline:

1. **Multi-tenant from day 1** — Firebase Auth on the panel, every
   Firestore doc scoped by `userId`. (Shipped Phase 0.)
2. **No AI Boss** — deterministic Scheduler + Materializer + on-demand
   Gemini calls at action time. AI is a tool the system invokes,
   never an orchestrator. (Settled before Phase 1.)
3. **No built-in browser-profile manager** — users run separate
   Chrome profiles per X account themselves; the panel doesn't
   try to orchestrate the browser. (Cookie-mode + sticky proxy is
   the cloud equivalent. Shipped Phase 1 / 6.)
4. **Free + paid tiers via Stripe** — Free (1 account) / Pro $67
   (3 accounts) / Scale $299 (25 accounts). Inert without
   `STRIPE_*` env vars. (Shipped Phase 12.)
5. **Brand profile syncs to backend** — `brandProfiles/{userId}`
   global + optional `xAccounts/{id}.brandOverride` patch. Consumed
   by auto-engage, auto-posts, and the co-pilot via
   `lib/brand-merge.loadBrandFor`. (Shipped Phase 10A.)
6. **Approval queue is opt-in per campaign** — `approvalMode` flag;
   when on, actions wait in `/approvals` for human review.
   (Shipped Phase 13.)
