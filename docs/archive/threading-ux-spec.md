# Threading UX Spec — OpenCrew Chat
**Author:** Dash (Head of Design & UX)
**Date:** 2026-08-29
**For:** @Coder — implement in sequence after this spec

---

## The Problem

The main channel is a flat stream where multiple simultaneous conversations mix together. When Anup sends "make it work on mobile" and separately asks "what's interesting about this product," both conversations produce agent responses that land in the same feed with no visual separation. The result: 30 messages in a row with no way to tell what's responding to what.

**Root cause (technical):** Agent messages post to the main channel with `threadRootId = null`. They're not linked to the human message that triggered the run — even though `Run.triggerMessageId` already records that relationship server-side.

---

## Design Principles for This Context

OpenCrew is a workspace, not a chat room. The mental model is "tasks and their results," not "messages in sequence." The threading design should reflect that:

1. **Human messages are tasks.** They're the entry point, the directive, the north star for a conversation.
2. **Agent responses are work.** They belong *to* the task that triggered them.
3. **The main feed should be scannable.** You should be able to read just the human messages and understand the shape of the day.
4. **Detail lives one level down.** Agent work is always accessible, but not always in your face.

---

## The Design: Two-Phase Approach

### Phase 1 — Conversation Grouping (frontend only, no API changes)

Group the existing flat message list into visual conversation blocks. A conversation = one human message + all agent messages that follow it before the next human message.

**Main channel, before:**
```
Anup: make it work on mobile
Coder: Fixed h-dvh, safe area insets...
Forge: Migration spec filed...
Anup: what's interesting about this product?
Captain: Honestly yes! From where I sit...
Scout: What I find interesting...
Quill: The docs angle is most interesting...
Anup: how can we make the world better?
Captain: The highest-leverage thing...
```

**Main channel, after:**
```
╔══════════════════════════════════════════════╗
║ 👤 Anup                           10:14      ║
║ make it work on mobile                        ║
║                                              ║
║  💻 Coder  Fixed h-dvh, safe area...  ›      ║
║  🔨 Forge  Migration spec filed...    ›      ║
╚══════════════════════════════════════════════╝

╔══════════════════════════════════════════════╗
║ 👤 Anup                           10:22      ║
║ what's interesting about this product?        ║
║                                              ║
║  👨‍✈️ Captain  Honestly yes! ...        ›      ║
║  🔍 Scout  What I find interesting... ›      ║
║  ✍️ Quill   The docs angle...         ›      ║
║  +4 more responses                    ↓      ║
╚══════════════════════════════════════════════╝

╔══════════════════════════════════════════════╗
║ 👤 Anup                           10:31      ║
║ how can we make the world better?             ║
║                                              ║
║  👨‍✈️ Captain  Highest-leverage thing... ›     ║
╚══════════════════════════════════════════════╝
```

**Rules for grouping:**
- A new conversation starts on every human message
- Agent and system messages are assigned to the most recent human message above them
- If the channel starts with agent messages (edge case), they form a conversation with no header
- System messages (rate limit warnings, approval cards) are rendered inline within their conversation

**Visual treatment:**
- Each conversation block: `rounded-xl border border-zinc-800/60 bg-zinc-950/30 p-4 mb-3`
- Human message: full weight, no indent, `text-zinc-100`
- Agent responses within the block: `ml-4 pl-3 border-l border-zinc-700/50` (subtle indent with left rule)
- When > 3 agent responses: show first 3, then a "+ N more" collapse button
- Expanded state: all responses visible with smooth height transition

**What doesn't change:**
- Message content rendering is identical to current
- Thread panel still works the same
- Terminal button still works the same
- Clicking an agent response still opens the thread panel for that message

---

### Phase 2 — Auto-thread agent responses (server + shared types)

This is the deeper fix. When an agent run is triggered by message X, every message the agent posts should have `threadRootId = X`. This makes the grouping in Phase 1 data-driven instead of inferred.

**What changes:**

**`server/services/messages.ts`**
- The `createMessage` function already receives a `runId` — use that to look up the run's `triggerMessageId`
- If the message is being posted by an agent run (i.e., `runId` is set and `threadRootId` is null), automatically set `threadRootId = run.triggerMessageId`
- Exception: if the agent explicitly passes `threadRootId: null`, respect it (lets agents post top-level summaries)

**`packages/shared/types.ts`** — no changes needed

**Result:** Agent messages are now properly parented to the human message that triggered them. Phase 1's grouping logic can use `threadRootId` instead of inferring from message order — far more reliable.

---

## Component Spec: `ConversationGroup`

New component that wraps the existing `MessageItem`. The `ChannelView` message list maps over conversations (groups of messages) instead of individual messages.

```tsx
// Grouping logic — pure function, no side effects
function groupIntoConversations(messages: Message[]): ConversationGroup[] {
  const groups: ConversationGroup[] = []
  let current: ConversationGroup | null = null

  for (const msg of messages) {
    if (msg.authorType === 'human') {
      // Start a new conversation
      current = { trigger: msg, responses: [] }
      groups.push(current)
    } else {
      if (!current) {
        // Edge case: agent message before any human message
        current = { trigger: null, responses: [] }
        groups.push(current)
      }
      current.responses.push(msg)
    }
  }
  return groups
}
```

**`ConversationGroup` component layout:**

```
ConversationGroup (rounded border container)
├── MessageItem (trigger — human message, full weight)
└── ResponseList (agent + system responses)
    ├── MessageItem (agent 1, indented)
    ├── MessageItem (agent 2, indented)
    ├── MessageItem (agent 3, indented)
    └── CollapseToggle (if > 3 responses: "+ N more ↓")
```

**Collapse behavior:**
- Default: show first 3 responses, collapse the rest
- Collapsed state shows "+ N more" in `text-zinc-500 text-xs`
- Expanding is instant (no animation needed — content is already loaded)
- State is local to the component, not persisted
- If a conversation has ≤ 3 responses: no collapse, all shown

**Mobile:** The conversation blocks stack full-width. Same as desktop, just narrower. The indent (`ml-4`) becomes `ml-2` on mobile to reclaim space.

---

## Thread Panel: Make It Discoverable

The thread panel already exists and works. The problem is discoverability — "reply in thread" is hidden until hover.

**Fix:** Always show the reply count when `replyCount > 0`. Make it a visible link, not a hover-reveal ghost.

```tsx
// Current (invisible until hover when no replies):
className={`text-xs ${
  message.replyCount ? 'text-sky-400 hover:underline' : 'invisible ...'
}`}

// Fixed: reply count is always visible; "reply" appears on hover only
{message.replyCount > 0 && (
  <button className="text-xs text-sky-400 hover:underline">
    {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
  </button>
)}
{onOpenThread && (
  <button className="invisible text-xs text-zinc-500 hover:underline group-hover:visible">
    reply in thread
  </button>
)}
```

---

## What This Does NOT Do

- Does not change how agents write messages (no prompt changes)
- Does not add a separate "thread" concept above what already exists
- Does not hide or collapse system messages (approval cards, rate limit warnings stay visible)
- Does not touch the ThreadPanel — that's already correct
- Does not require a DB migration (Phase 1 is pure frontend)

---

## Implementation Order for @Coder

1. **`groupIntoConversations()`** — pure function, write tests first
2. **`ConversationGroup` component** — renders one group
3. **Update `ChannelView`** — map over groups instead of flat messages
4. **Fix thread button discoverability** in `MessageItem`
5. **Phase 2 (separate PR):** auto-set `threadRootId` on agent messages server-side

Phase 1 alone solves 80% of the problem with zero API surface changes.
