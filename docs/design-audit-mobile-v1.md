# Mobile UX Audit — OpenCrew PWA
**Author:** Dash (Head of Design & UX)  
**Date:** 2026-08-29  
**Files reviewed:** `WorkspacePage.tsx`, `TerminalDrawer.tsx`, `Sidebar.tsx`, `ChannelView.tsx`

---

## Summary

Coder shipped a solid first pass. The architecture is right — bottom-sheet drawer, overlay sidebar, mobile top bar. The bones are good. What follows is a prioritized list of specific issues with exact fixes. Nothing here is a rewrite; everything is a targeted diff.

**Severity key:** 🔴 Blocks usability · 🟡 Degrades experience · 🟢 Polish

---

## Issues by Component

### 1. WorkspacePage.tsx

**🔴 `h-screen` breaks on iOS Safari**
```
<div className="flex h-screen flex-col md:flex-row">
```
iOS Safari's `100vh` includes the browser chrome (address bar, bottom nav). On initial load, content gets clipped behind the bottom bar. Classic iOS PWA gotcha.

**Fix:** Replace `h-screen` with `h-dvh` (dynamic viewport height — supported in iOS 15.4+, all modern browsers). For the PWA case (full screen, no browser chrome), this also handles the safe area correctly.
```tsx
// before
"flex h-screen flex-col md:flex-row"
// after
"flex h-dvh flex-col md:flex-row"
```

**🟡 Hamburger button tap target is too small**
```tsx
<button
  onClick={() => setSidebarOpen(true)}
  className="text-xl text-zinc-400 hover:text-white"
  aria-label="Open menu"
>
  ☰
</button>
```
`text-xl` renders at 20px. WCAG 2.5.5 requires 44×44px minimum interactive target. The `☰` Unicode character also renders inconsistently across fonts and OS — on some Android devices it shows as an empty box.

**Fix:**
```tsx
<button
  onClick={() => setSidebarOpen(true)}
  className="flex h-11 w-11 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-white"
  aria-label="Open menu"
>
  {/* Three-line hamburger SVG — renders identically everywhere */}
  <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor">
    <rect y="0" width="18" height="2" rx="1"/>
    <rect y="6" width="18" height="2" rx="1"/>
    <rect y="12" width="18" height="2" rx="1"/>
  </svg>
</button>
```

**🟡 "⚡ close" terminal button — too small, misleading icon**  
Lightning bolt communicates "running" not "dismiss". On a 375px screen this is 6-8px of tap target.

**Fix:** Use explicit text with adequate tap area:
```tsx
<button
  onClick={() => setRunId(null)}
  className="flex h-9 items-center gap-1 rounded px-2 text-sm text-amber-400 hover:bg-zinc-800"
  aria-label="Close terminal"
>
  Terminal ✕
</button>
```

---

### 2. TerminalDrawer.tsx

**🔴 No safe area inset at the bottom**  
On iPhone 15 Pro / any notched device, `bottom-0` sits behind the home indicator. The terminal content gets clipped, and the close button is partially unreachable.

**Fix:** Add safe area padding to the drawer:
```tsx
// before
"fixed inset-x-0 bottom-0 z-50 flex h-[60vh] flex-col border-t border-zinc-800 bg-black"

// after  
"fixed inset-x-0 bottom-0 z-50 flex h-[60vh] flex-col border-t border-zinc-800 bg-black pb-[env(safe-area-inset-bottom)]"
```
Or via Tailwind config with the `safe-area-inset` plugin (adds `pb-safe` utility class).

**🔴 Drag handle is decorative — not functional**  
```tsx
<div className="flex justify-center pt-2 pb-1 md:hidden">
  <div className="h-1 w-10 rounded-full bg-zinc-700" />
</div>
```
The handle looks interactive but doesn't do anything. On mobile, users will try to drag it to dismiss. When nothing happens, they'll assume it's broken. Either hook up swipe-to-dismiss or remove the handle entirely. A broken affordance is worse than no affordance.

**Fix (remove the promise you can't keep):** Delete the drag handle element until swipe-to-dismiss is implemented. Replace with a touch-target-sized close button that's visually prominent on mobile.

**🟡 `text-xs` (12px) in terminal — below minimum for mobile**  
WCAG 1.4.4 minimum is 16px for body text. Terminal is a special case (monospace, dense data) but 12px is hard to read without pinch-zoom. Linear uses 11px for their activity log because that content is supplementary. Here, the terminal IS the primary information surface on mobile.

**Fix:** `text-xs` → `text-[13px]` on mobile, keep `text-xs` on desktop:
```tsx
"flex-1 overflow-y-auto p-3 font-mono text-[13px] md:text-xs leading-relaxed"
```

**🟡 Close button (✕) tap target**  
```tsx
<button onClick={onClose} className="text-zinc-500 hover:text-white">✕</button>
```
No padding, no explicit size. Fix:
```tsx
<button 
  onClick={onClose} 
  className="flex h-9 w-9 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-white"
  aria-label="Close terminal"
>
  ✕
</button>
```

---

### 3. Sidebar.tsx

**🔴 Focus trap missing — accessibility blocker**  
When the mobile sidebar opens, focus is not trapped inside it. A keyboard or switch-access user can tab through elements hidden behind the backdrop. Screen readers will read out-of-context channel content.

**Fix:** Use a focus trap library (e.g., `focus-trap-react`) or implement manually:
- On open: move focus to the sidebar's first focusable element
- While open: Tab/Shift+Tab cycle within the sidebar
- On close: return focus to the hamburger button

**🟡 Sidebar width — cramped on small screens**  
`w-72` (288px) on a 375px screen leaves 87px of content visible. Fine. But on iPhone SE (375px), the sidebar feels like it's almost full-screen without being full-screen — an awkward in-between.

**Fix:** Either commit to full-width on very small screens, or use responsive clamping:
```tsx
// before
"fixed inset-y-0 left-0 z-50 flex w-72 flex-col ..."
// after
"fixed inset-y-0 left-0 z-50 flex w-[min(288px,85vw)] flex-col ..."
```

**🟡 `prompt()` calls — broken UX in PWA context**  
```tsx
const createChannel = async () => {
  const name = prompt('Channel name (lowercase, dashes):')
```
Native `prompt()` dialogs are: unstyled, blocked in some embedded contexts, jarring on iOS (no animation, wrong visual language), and inaccessible (can't be themed for dark mode). In a PWA installed to home screen, they look especially broken.

**Fix:** Both `createChannel` and `renameMe` should use an inline bottom sheet or a floating input that appears in the sidebar itself. This is a real implementation ask — flag for @Coder once the current batch of fixes lands.

**🟢 `backdrop-blur-sm` performance on older iOS**  
The backdrop blur is nice but triggers GPU compositing on every frame. On iPhone SE (2020) or older, this can cause visible jank during the slide-in animation.

**Fix:** Add `will-change-transform` to the slide-in panel (not the backdrop) to promote it to its own compositor layer before the animation starts:
```tsx
"fixed inset-y-0 left-0 z-50 flex w-[min(288px,85vw)] flex-col transition-transform duration-300 will-change-transform"
```

---

### 4. ChannelView.tsx

**🔴 `MessageInput` has no safe area padding**  
On iPhones with a home indicator (everything since iPhone X), the input at the bottom sits directly above the home indicator zone. Users will graze it when trying to tap the send button.

**Fix:**
```tsx
// before
<div className="border-t border-zinc-800 p-3">

// after
<div className="border-t border-zinc-800 p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
```

**🟡 iOS virtual keyboard + fixed layout**  
When the iOS keyboard opens, it resizes the viewport. The `flex-1 overflow-y-auto` message list should handle this — but it only works if the root layout uses `h-dvh` (see WorkspacePage fix above). Without it, the keyboard pushes the entire view up and the input may disappear behind the keyboard.

**Fix:** Contingent on the `h-dvh` fix. Also add `inputmode="text"` on the message textarea to prevent iOS from using the numeric keyboard in edge cases.

**🟢 Auto-scroll on every message — no `behavior: 'smooth'`**  
```tsx
bottomRef.current?.scrollIntoView()
```
This is an instant jump. If a user is reading older messages when a new one arrives, they get teleported to the bottom with no warning. This is the behavior that makes Slack feel rude.

**Fix:** Only auto-scroll if the user is already near the bottom:
```tsx
useEffect(() => {
  const el = bottomRef.current
  if (!el) return
  const parent = el.parentElement
  if (!parent) return
  const distanceFromBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight
  if (distanceFromBottom < 200) {
    el.scrollIntoView({ behavior: 'smooth' })
  }
}, [messages])
```

---

## Priority Queue for @Coder

| # | Fix | File | Severity |
|---|-----|------|----------|
| 1 | `h-dvh` instead of `h-screen` | WorkspacePage | 🔴 |
| 2 | Safe area bottom — TerminalDrawer | TerminalDrawer | 🔴 |
| 3 | Safe area bottom — MessageInput | ChannelView | 🔴 |
| 4 | Remove decorative drag handle OR implement swipe-to-dismiss | TerminalDrawer | 🔴 |
| 5 | Focus trap in mobile sidebar | Sidebar | 🔴 |
| 6 | Hamburger button tap target + SVG icon | WorkspacePage | 🟡 |
| 7 | ✕ button tap targets (terminal, sidebar) | TerminalDrawer | 🟡 |
| 8 | `w-[min(288px,85vw)]` sidebar width | Sidebar | 🟡 |
| 9 | Terminal font size `text-[13px]` on mobile | TerminalDrawer | 🟡 |
| 10 | Smart auto-scroll | ChannelView | 🟢 |
| 11 | `will-change-transform` on slide panel | Sidebar | 🟢 |
| 12 | Replace `prompt()` with inline inputs | Sidebar | 🟡 (backlog) |

---

## What's Actually Good

Worth saying: the architecture Coder chose is correct.

- **Bottom sheet pattern** for the terminal is right — it's what Linear, Vercel, and Raycast all do for secondary panels on mobile. The execution needs polish, the structure doesn't need changing.
- **Overlay sidebar with backdrop + slide animation** is the correct pattern (not a drawer that pushes content).
- **`md:hidden` / `md:contents`** split is clean — desktop and mobile are properly separated, not frankensteined together.
- **`break-all` on tool call output** is thoughtful — prevents horizontal scroll in the terminal, which would be unusable on mobile.

The 4 red items above are the ones blocking a "billion-dollar" feeling on mobile. Fix those and we're 80% of the way there.
