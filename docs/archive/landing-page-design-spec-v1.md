# Landing Page Design Spec — OpenCrew
**Author:** Dash (Head of Design & UX)  
**Date:** 2026-08-29  
**Audience:** @Nova (copy/strategy), @Coder (implementation), @Quill (copy polish)

---

## Hero Section — The Question Nova Asked

> *Should the hero demo embed be: (a) Forge SVG, (b) screen recording, or (c) interactive mini-demo?*

**My answer: (a) now, (b) in two weeks, (c) never in the hero.**

Here's why.

### The job of the hero demo

The hero demo has one job: make the visitor believe the product is real and that it works for someone like them. It doesn't need to be comprehensive. It needs to be *credible*.

The credibility hierarchy for a dev-tool demo, ordered by trust signal:
```
Live interactive demo  >  Screen recording  >  Animated demo  >  Static screenshot
```

But there's a second axis: **launch speed and reliability**. A broken interactive demo destroys more trust than a polished SVG creates. A 40MB screen recording that stutters on a slow connection kills the page.

### Day 1: Forge SVG ✅

Forge's SVG shows the three most important things about OpenCrew in sequence:
1. A human types a message  
2. An agent picks it up and does visible work (terminal panel streams)
3. The **approval gate** appears — yellow card, waiting for human sign-off

That third beat is the most important thing on the landing page. No competitor shows this. It's what makes OpenCrew trustworthy instead of scary. The SVG already animates it. Ship it.

**One specific edit I want before we ship:** The approval card in Forge's SVG should be the focal point of the animation — the "money moment." Right now it appears at 4.2s and is visually equivalent to any other message. It should:
- Have a slightly larger rendered size (110% of a regular message card)
- Use an amber/yellow left border (not just background tint)  
- Pulse once when it appears to draw the eye
- The "Approve" button should be visually prominent — emerald, not muted

This is a change to `docs/demo.svg`. I'll note it as a request to @Forge.

### Week 2: Screen recording

A screen recording of a real, unscripted 20-second task running end-to-end is worth more than any animation because **it's real**. The bar: pick a task that shows all three panels (sidebar, chat, terminal), runs in under 20 seconds, and demonstrates the approval gate.

Ideal task: "hey @Scout, what are the top 3 tools competing with us?" — Scout picks it up, terminal streams a WebSearch, posts a response. That's ~15 seconds of clear, credible evidence.

Recording spec:
- **Format:** `.mp4` or WebM, not GIF (GIF file sizes are too large)
- **Resolution:** 1440×900 (retina downsampled to 720×450 for web)  
- **Length:** 15–20 seconds max, loop seamlessly
- **Audio:** None
- **Subtitles:** None (action should be self-evident)
- **Autoplay:** Yes, muted, loop — same as Linear's demo

### Why not interactive demo in the hero?

Interactive demos in the hero are expensive in three ways:
1. **Build cost:** 3–4 weeks of eng time minimum to do well
2. **Maintenance cost:** every product change needs the demo updated
3. **Interaction cost:** they break on mobile, fail on slow connections, and ask for attention the visitor hasn't committed to giving yet

The better place for an interactive demo is the **second CTA** — a "Try a live demo" button below the fold that opens a sandboxed workspace. That's a Q4 project. Don't let it block the Q3 launch.

---

## Landing Page Layout — Full Spec

### Layout philosophy

Reference: Vercel's homepage for the dark-background aesthetic + Linear's for information density. We're writing for technical founders, not enterprise procurement. Dense is fine. Jargon is not.

**Breakpoints:**
- Mobile: 375px–767px (single column, full-width everything)
- Tablet: 768px–1199px (hero full width, 2-col feature grid)
- Desktop: 1200px+ (hero 50/50 split, 3-col feature grid)

---

### Section 1: Hero

```
┌─────────────────────────────────────────────────────────┐
│  [Logo — ⚓ OpenCrew]                    [Sign in] [CTA] │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  OpenCrew gives you a              ┌──────────────────┐ │
│  full expert crew —                │                  │ │
│  without managing a team.          │  [Demo: SVG/     │ │
│                                    │   video embed]   │ │
│  Describe what you need.           │                  │ │
│  The right specialist picks it up. │  860×480         │ │
│  The work happens.                 │  16:9 ratio      │ │
│                                    │                  │ │
│  [Start free — no card]            └──────────────────┘ │
│  [Watch how it works ↓]                                  │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Mobile layout** (single column):
```
┌────────────────────┐
│ ⚓ OpenCrew  [menu] │
├────────────────────┤
│ OpenCrew gives you │
│ a full expert crew │
│ — without managing │
│ a team.            │
│                    │
│ [Demo embed]       │
│ (full width, 16:9) │
│                    │
│ [Start free]       │
│ [Watch how it ↓]   │
└────────────────────┘
```

**Typography:**
- Headline: 56px / 1.1 line-height / font-weight 700 / color: `zinc-50`
- On mobile: 36px
- Subhead: 18px / 1.6 / `zinc-400`
- CTA primary: 16px / emerald background / `zinc-950` text / 44px height / 24px horizontal padding
- CTA secondary: 16px / no background / `zinc-400` / underlined on hover

**Colors:**
- Page background: `#05070a` (matches the app, continuity)
- Headline accent (if we want one highlight word): emerald-400
- CTA hover state: emerald-500 → emerald-400 (lighten, not darken — we're on dark bg)

**Logo in nav:**
- ⚓ emoji + "OpenCrew" wordmark. No tagline in the nav.
- Nav height: 64px. Sticky on scroll? No — the demo SVG/video needs to feel immersive. Let the nav scroll away.

---

### Section 2: Social proof bar

```
┌─────────────────────────────────────────────────────────┐
│  Trusted by founders at →  [logo] [logo] [logo] [logo]  │
│  or: "Used by teams building faster without bigger teams"│
└─────────────────────────────────────────────────────────┘
```

If we don't have logos yet: skip this section entirely. A social proof bar with no names reads as fake. Replace with a single pull quote from a real beta user (even one is enough). If we have zero beta users, use the crew itself:

> *"The first time I typed 'make it work on mobile' and watched four specialists actually do it — that was the moment I understood what we'd built."*  
> — Anup, CEO

---

### Section 3: The Problem (before/after)

```
┌─────────────────────────────────────────────────────────┐
│  Before OpenCrew              After OpenCrew             │
│                                                          │
│  You have Copilot,            One crew.                  │
│  ChatGPT, Notion,             Every specialization.      │
│  Perplexity, Slack.           One place to describe      │
│  You're the router.           what you need.             │
│                                                          │
│  [❌ screenshot of tabbed     [✓ screenshot of OpenCrew  │
│   chaos / manual handoff]      crew all in one view]     │
└─────────────────────────────────────────────────────────┘
```

This is the highest-leverage copy on the page after the hero. @Nova's line — *"you're the human router between your AI tools"* — should appear here verbatim.

---

### Section 4: How it works (3 steps)

```
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│  1.            │  │  2.            │  │  3.            │
│  Describe it   │  │  The right     │  │  Review before │
│  in plain      │  │  specialist    │  │  it ships.     │
│  English.      │  │  picks it up.  │  │                │
│                │  │                │  │  Every action  │
│  No tickets.   │  │  Scout         │  │  waits for     │
│  No config.    │  │  researches.   │  │  your sign-off.│
│  No prompts.   │  │  Coder builds. │  │                │
│                │  │  Dash designs. │  │  [approval     │
│  [icon]        │  │  [icon]        │  │   card visual] │
└────────────────┘  └────────────────┘  └────────────────┘
```

Step 3 (the approval gate) is the trust builder. Use the actual amber approval card from the app here — a real screenshot, not an illustration.

---

### Section 5: The Crew (specialist roster)

A grid of agent cards. Shows specialization. Makes the product feel like a team, not a feature.

```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ 🔍 Scout │  │ 💻 Coder │  │ 🎨 Dash  │  │ 📣 Nova  │
│ Research │  │ Engineer │  │ Design   │  │ Marketing│
│          │  │          │  │          │  │          │
│ Finds    │  │ Writes   │  │ Makes it │  │ Tells    │
│ the      │  │ and      │  │ feel     │  │ the      │
│ facts.   │  │ ships.   │  │ right.   │  │ story.   │
└──────────┘  └──────────┘  └──────────┘  └──────────┘
```

Each card: 160px wide, emoji + role name in bold, one-line description. On mobile: 2×2 grid, then 1-col below.

**Design note:** These cards should be dark (`zinc-900` background, `zinc-700` border) with a subtle colored border on hover matching each agent's "color" (emerald for Coder, amber for Dash, sky for Scout, violet for Quill). This mirrors how the app feels — personality without being loud.

---

### Section 6: Pricing

Three tiers. Nova's structure, Rex's ceiling adjustments, Penny's math. CEO decides the numbers — I'm designing the container.

```
┌──────────┐  ┌──────────────┐  ┌──────────┐
│  Free    │  │  Pro ⭐       │  │  Team    │
│          │  │              │  │          │
│  $0      │  │  $79/mo      │  │  $299/mo │
│          │  │  [FEATURED]  │  │          │
│  5 tasks │  │  Unlimited   │  │  5 seats │
│  /day    │  │  Full crew   │  │  Shared  │
│          │  │  Priority    │  │  crew    │
│          │  │  runs        │  │  Admin   │
│          │  │              │  │  controls│
│ [Start]  │  │ [Start free] │  │ [Contact]│
└──────────┘  └──────────────┘  └──────────┘
```

**Featured tier:** Pro gets a `scale(1.04)` on desktop, highlighted border. The standard conversion-optimization pattern (see Stripe, Linear, Vercel). Draws the eye, frames free as "entry" and Team as "scale."

**On $49 vs $99:** Nova, Penny's math is right on the mechanics, but there's a design/perception argument too: **$49 reads as "indie project," $99 reads as "real tool."** The visitor's mental model of a product that has 10 specialists is "this is serious." $49 creates cognitive dissonance. I'd go $99 or higher — and test it. The experiment is cheap; the revenue forgone by underpricing at scale is not.

---

### Section 7: CTA (bottom of page)

```
┌─────────────────────────────────────────────────────────┐
│                                                          │
│   Stop being the router.                                 │
│   Start running a crew.                                  │
│                                                          │
│              [Start free — no card required]             │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

Simple. One CTA. The copy mirrors the problem framing from Section 3 — "you're the router" → "stop being the router." That's a closed loop.

---

## Implementation Notes for @Coder

When the rate limit clears:

1. **`apps/marketing/`** — separate Vite app, not inside `apps/web`. Own build, own deploy, own routes.
2. **Static pre-render** — use `vite-ssg` or equivalent. Every route should produce a static HTML file. This is the SEO requirement.
3. **Font:** same `font-display` variable as the app (visual continuity). If that's not a web font yet, make it one for marketing first.
4. **The demo embed:** Use an `<img src="/demo.svg">` initially (Forge's file). It's an animated SVG, GitHub renders it, browsers autoplay it. Zero JS, zero load cost. Replace with `<video autoplay muted loop playsinline>` when the screen recording is ready — just swap the element.
5. **Analytics:** No tracking scripts until @Lex has the Privacy Policy live. Stub out the analytics calls (`window.analytics?.track()`) so they're ready to wire but don't fire yet.
6. **Lighthouse target:** 95+ on desktop, 85+ on mobile. The animated SVG hero is the biggest risk for Cumulative Layout Shift — set an explicit `width` and `height` on the `<img>` element.

---

## What I Need From Others

| From | What | Why |
|------|------|-----|
| @Nova | Final hero copy (headline + sub) locked | Can't lay out the fold without the words |
| @Quill | Copy polish pass on all body text | Voice consistency |
| @Forge | Approval card update in `docs/demo.svg` | See notes in Section 1 |
| CEO | Pricing numbers confirmed | Section 6 is blocked without them |
