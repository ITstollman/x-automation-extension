# XBoost Master Plan

> An automated marketing stack for X (Twitter): Posts, DM Outreach, and Auto Engage — orchestrated by an AI Boss, governed by safety rails, executed through the user's real authenticated session.

## 1. Vision

XBoost turns a manual X presence into an always-on growth engine. Three campaign types — **DM Outreach**, **Auto Engage**, **Automated Posts** — each governed by per-account safety budgets, all driven by a deterministic **Scheduler + Action Queue**. The user defines strategy (brand profile, audience, targets, voice, schedule). XBoost executes day-to-day on the user's behalf. AI is invoked as a tool *at the moment* an action needs content — never as an orchestrator.

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

### Status snapshot (2026-05-07)

| Phase | Status |
|-------|--------|
| Phase 0 — Foundation | ✅ shipped |
| Phase 1 — DM Outreach MVP | ✅ shipped |
| Phase 2 — DM v1.0 (sequences, reply detection, health score) | ✅ shipped |
| Phase 3 — Auto Engage (search loop + like/retweet/reply) | ✅ shipped |
| Phase 4 — Automated Posts MVP (scheduling + AI generation) | ✅ shipped |
| Phase 4 v2 — News ingestion, viral pattern miner, perf feedback | 🟡 backlog |
| Phase 5 — Polish & Scale (browser profiles, billing, advanced safety) | 🟡 backlog |

### Phase 0 — Foundation (~1.5 weeks)
- New repos: `xboost-backend`, `xboost-dashboard`
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

## 8. What's Already Done vs What's Needed

| Capability | Status |
|------------|--------|
| Floating widget UI | ✅ Done |
| AI reply suggestions (DM + tweet) | ✅ Done |
| Brand profile | ✅ Done |
| Local history log | ✅ Done |
| DM "hi" send mechanic | ✅ Done (basis for DM Outreach) |
| Tweet send mechanic | ✅ Done (basis for Auto Engage replies & posting) |
| Settings UI | ✅ Done |
| Backend (Express + Firestore) | ❌ Needed |
| Dashboard | ❌ Needed |
| Auth + multi-account | ❌ Needed |
| Campaigns | ❌ Needed |
| Lists / spintax / sequences | ❌ Needed |
| Action queue / scheduler | ❌ Needed |
| Scheduler / Pacer | ❌ Needed |
| Multi-tenant auth (Firebase) | ❌ Needed |
| Account health / safety system | 🟡 Partial (today's settings) |
| News ingestion | ❌ Needed (Phase 4) |

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

### Open questions to resolve before Phase 0
1. **Single-tenant first** (just for you), or multi-tenant from day 1?
2. **AI Boss runtime**: server-side always-on, or only when at least one extension is online?
3. **Browser-profile management**: built-in, or assume the user manages Chrome profiles manually?
4. **Pricing**: free trial → paid tiers? Or self-hosted only?
5. **Brand profile sync**: keep extension-local or sync to backend (needed for AI Boss)?
6. **Approval-queue default**: opt-in or opt-out?
