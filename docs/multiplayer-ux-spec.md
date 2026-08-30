# Multiplayer UX Spec — OpenCrew Co-working
**Author:** Dash (Head of Design & UX)
**Date:** 2026-08-29
**Status:** DRAFT — awaiting Anup's approval before any code is written

---

## The Mental Model

Anup's description is precise: a workspace where people are invited, they can watch each other work, but each person controls only their own laptop.

The right analogy isn't Slack (async messaging) or Google Docs (same document). It's a **co-working space with glass walls:**

- The **open floor** (shared channels) — everyone sees and participates
- Your **desk** (personal workspace) — your crew, your tasks, your approvals
- The **glass walls** (spectator mode) — you can watch anyone's desk from a distance
- **Walking up to someone's desk** (collaboration) — joining their workspace with permission

This is a new social experience: watching AI labor happen in real-time, alongside other humans doing the same thing. Nobody has designed this before. We get to define it.

---

## Four Layers of the Multiplayer Experience

### Layer 1: Presence Bar — "Who's in the office"

A persistent strip at the top of the workspace showing every online member as an avatar bubble. Always visible, never in the way.

```
┌──────────────────────────────────────────────────────────────┐
│ ⚓ OpenCrew HQ    [Anup🟢] [Sarah🟡] [James⚫] [+2 agents🔵]  │
└──────────────────────────────────────────────────────────────┘
```

**Avatar states:**
- 🟢 **Online** — present, in the app
- 🟡 **Working** — running agents right now (amber pulse, same as the existing `running` state)
- ⚫ **Offline** — not in the app
- 🔵 **Agent** — condensed count of active agents across the workspace (not per-agent, too noisy)

**Click behavior:**
- Click a human avatar → peek card appears (see Layer 3: Spectator Mode)
- Click agent count → show which agents are currently running across all users

**What it communicates:** At a glance, you know if the office is busy or quiet. You know who's in the flow. You can see when Sarah kicks off a bunch of tasks (her avatar starts pulsing). This is social without being intrusive.

---

### Layer 2: Shared Channels — "The open floor"

Shared channels work today. What changes with multiplayer is **attribution and identity** — when multiple humans are present, you need to know who is directing what.

**Current:** Messages show agent emoji + name ("🔍 Scout"). Doesn't tell you whose Scout it is.

**Multiplayer:** Messages show the directing human + agent as a pair.

```
Before:
🔍 Scout    agent    10:14
Found 6 competitors. Handing to @Quill...

After:
🔍 Scout (Anup's)   agent    10:14
Found 6 competitors. Handing to @Quill...

or more elegantly:

🔍 Scout ·̣ Anup   agent    10:14
Found 6 competitors. Handing to @Quill...
```

**Agent attribution tag:** A subtle "· Anup" after the agent name in muted zinc-500. Not intrusive, but scannable. Clicking it highlights all messages from that user's agents in the conversation.

**Cross-user @mentions:** `@Sarah` mentions another human user (not an agent). Triggers a notification. Her avatar in the presence bar briefly brightens.

**Channel presence:** At the top of each channel, a row of avatar dots for who's currently reading this channel:

```
# general   👤·👤·👤   3 people here
```

Hovering shows names. This makes the channel feel alive — you can see if someone is watching when you type.

---

### Layer 3: Spectator Mode — "Watching through the glass"

The most novel and distinctive feature. Watch another user's workspace in real-time — their terminal streams, their agent activity, their approval gates — without being able to interact.

**Entry:** Click any online human avatar in the presence bar → peek card appears:

```
┌─────────────────────────────────────┐
│ Sarah Chen                          │
│ 🟡 3 agents running                 │
│                                     │
│ Recent activity:                    │
│ • Coder: writing landing page...    │
│ • Scout: researching competitors... │
│ • Nova: drafting tweet...           │
│                                     │
│ [👁 Watch workspace]  [✉ Message]  │
└─────────────────────────────────────┘
```

**Clicking "Watch workspace"** opens a spectator panel on the right side of the screen (same position as the terminal drawer, but different state):

```
┌──────────────────────┐
│ 👁 Watching Sarah    │
│ 3 agents running     │
│                [✕]   │
├──────────────────────┤
│ 💻 Coder              │
│ [00:14] ⚡ claude-... │
│ $ write LandingPage  │
│ ✓ wrote 200 lines    │
│                      │
│ 🔍 Scout             │
│ [00:22] ⚡ claude-... │
│ $ WebSearch "devin"  │
│ ✓ found 12 results   │
│                      │
│ ⏸ APPROVAL PENDING   │
│ Scout wants: Bash    │
│ (you can't approve)  │
│ → waiting for Sarah  │
└──────────────────────┘
```

**Rules of spectator mode:**
- You see their terminal streams in real-time
- You see approval gate cards (but they're grayed out — you cannot approve or deny)
- You cannot send messages into their workspace
- You cannot run tasks
- The person being watched sees a "👁 2 watching" indicator — they always know

**The social electricity:** Watching someone else's approval gate is genuinely exciting. The crew pauses, the amber card appears, and the room (metaphorically) holds its breath. Spectator mode lets others share that moment.

**Reactions (lightweight social layer):**
While spectating, you can drop emoji reactions that float briefly over the terminal stream:
- 🔥 (nice move)
- 😬 (that command looks risky)
- 👍 (approve that!)

These are ephemeral — they appear for 3 seconds and disappear. They don't create messages or leave a record. Pure vibes. This is the "fun" layer.

---

### Layer 4: Personal Workspace — "Your desk"

Each user has a private workspace that's separate from shared channels. It's where you work with your crew without narrating every step to the whole team.

**Access:** A "My Workspace" button in the sidebar, below the channel list:

```
CHANNELS
# general ●
# builds

MY WORKSPACE          ← new
□ Private lab

OTHERS (click to watch)
○ Sarah (3 running)
○ James (idle)
```

**Private lab:** A private channel, visible only to you and any agents you run. Conversations here stay here unless you explicitly post to a shared channel. Like the "Drafts" of your workspace.

**Your desk panel:** When you click "My Workspace," the main view splits:
- Left: your private channel / conversation history
- Right: your running agents' terminal streams (same as today's terminal drawer, but always visible)

**Approval queue:** Your pending approvals appear as a badge count on your workspace button. You can't miss them.

---

## The Multiplayer Layout

On desktop, the full multiplayer workspace looks like this:

```
┌─────────────────────────────────────────────────────────────────────┐
│ ⚓ OpenCrew HQ   [Anup🟢] [Sarah🟡·3] [James⚫]   [Settings ⚙]      │  ← Presence bar
├─────────┬───────────────────────────────────┬───────────────────────┤
│         │                                   │                       │
│ Channels│  # general                         │  👁 Watching Sarah    │  ← Spectator panel
│         │                                   │  (or terminal drawer) │
│ # gen ● │  ┌─────────────────────────────┐  │                       │
│ # builds│  │ 👤 Anup                     │  │  💻 Coder             │
│         │  │ make it work on mobile       │  │  [00:14] $ write...  │
│ MY WKSPC│  │  💻 Coder  Fixed h-dvh...   │  │                       │
│ □ Lab   │  │  🔨 Forge  Spec filed...    │  │  🔍 Scout             │
│         │  └─────────────────────────────┘  │  [00:22] $ WebSearch │
│ OTHERS  │                                   │                       │
│ ○ Sarah │  ┌─────────────────────────────┐  │  ⏸ Approval pending  │
│   🟡·3  │  │ 👤 Sarah                    │  │  (Sarah must approve)│
│ ○ James │  │ draft the landing page copy  │  │                       │
│   ⚫    │  │  📣 Nova  Wrote headline...  │  │                       │
│         │  └─────────────────────────────┘  │                       │
├─────────┴───────────────────────────────────┴───────────────────────┤
│ Message #general…                                                    │  ← Input
└─────────────────────────────────────────────────────────────────────┘
```

**Mobile layout:** Presence bar condenses to avatar dots in the header. Spectator mode is a full-screen view (swipe right from the main view to enter it). Personal workspace is accessible from the bottom nav.

---

## Invite Flow

Simple, Slack-inspired. No friction.

1. Admin goes to Settings → Members → "Invite someone"
2. A shareable link is generated (already exists in the codebase: `/api/invites`)
3. Invited person clicks link → creates account → lands in the workspace immediately
4. They see the presence bar, the shared channels, and the "Others" section in the sidebar
5. Their personal workspace is empty to start (no crew configured) — a guided empty state helps them set up their first agent

**Empty state for a new invited member:**

```
Welcome to Anup's workspace 👋

You're in. Here's what's happening:
• Anup has 12 agents running their crew
• 3 conversations are active in #general

Start by setting up your crew →
Or just watch what's happening first 👁
```

Two clear paths: get started, or just watch. No commitment required to get value from day one.

---

## What Makes This "Truly Fun"

The fun isn't from gamification or animations. It's from the **social electricity of watching AI labor in real-time alongside other humans.**

- Watching Sarah's Scout hit an approval gate is a shared moment
- Seeing Anup's Coder ship something and posting "🔥" in reactions
- The quiet thrill of watching someone else's workspace when they don't know you're there (then realizing they always know — the 👁 indicator)
- Multiple humans + their crews all running simultaneously, the presence bar showing everyone in flow

The product doesn't need confetti to feel fun. The core experience — watching real work happen in real time — is inherently compelling. The design just needs to make it visible and social.

---

## What This Is NOT

- **Not shared control:** You cannot approve someone else's approvals. You cannot run tasks on their laptop. Hard boundary.
- **Not a chat app:** The social layer (reactions, presence) is lightweight and ephemeral. This isn't Slack 2.0.
- **Not surveillance:** Spectator mode is opt-in and always visible to the person being watched. No hidden observation.
- **Not complex to enter:** No roles setup, no permission matrices. Invite → join → start working.

---

## Performance Note for @Coder

**Terminal stream broadcasting to spectators is expensive if done naively.**

Figma throttles cursor position broadcasts aggressively — they send highly optimized diffs at low frequency, not raw position streams. The same principle applies here: if 3 people are spectating and an agent is streaming terminal output at 30 lines/second, that's 90 WebSocket events/second just for the social layer.

**Recommendation:** Spectator terminal streams should be:
- Buffered server-side (collect 500ms of output, then broadcast as a single batch)
- Capped at a visual framerate — spectators don't need sub-second fidelity
- Marked as a separate WebSocket event type (`spectator_stream`) so the server can throttle them independently from the owner's real-time feed (which stays full-speed)

The owner always gets the live feed. Spectators get a ~1-second delayed, batched view. Barely noticeable in practice, dramatically cheaper at scale.

---

## Implementation Phases

### Phase 1 — Presence bar + attribution (1–2 days)
- Presence bar with avatar bubbles in the header
- Agent attribution ("· Anup") on messages in shared channels
- Channel "N people here" indicator

### Phase 2 — Spectator mode (2–3 days)
- Peek card on avatar click
- Real-time spectator terminal panel
- "👁 N watching" indicator on the person being watched
- Ephemeral reactions (just client-side, no persistence needed)

### Phase 3 — Personal workspace (2–3 days)
- "My Workspace" section in sidebar
- Private lab channel (per-user, not visible to others)
- Personal agent terminals always visible in workspace view

### Phase 4 — Invite + onboarding (1 day)
- Invite flow polish (foundation already exists)
- New member empty state
- "Watch to learn" onboarding path

**Total estimate:** 6–9 days of engineering (Coder + Forge). Design is finished when Anup approves.

---

## Questions for Anup Before Build Starts

1. **Shared agents or personal agents?** Can Sarah use Anup's Scout, or does each person configure their own crew? (Recommendation: personal — each person's crew is their own, but you can watch others'.)

2. **What's public by default?** Is a new user's workspace visible to spectators from day one, or does it start private? (Recommendation: visible — privacy should be opt-in, not the default, to keep the social layer alive.)

3. **Reaction emoji set?** What 5–6 reactions do we support in spectator mode? (Recommendation: 🔥 👍 😬 👀 🎉 — keep it expressive but small.)

4. **Cross-workspace agent tasks?** Can Anup's agents post in Sarah's private workspace? (Recommendation: No. Hard wall between private workspaces. Shared channels only for cross-user agent posts.)
