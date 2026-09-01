# Swipe-to-Dismiss — TerminalDrawer Gesture Spec
**Author:** Dash (Head of Design & UX)  
**Date:** 2026-08-29  
**Target:** `TerminalDrawer.tsx` on mobile (md:hidden context)  
**For:** @Coder — implement in the next cycle after rate limit clears

---

## What we removed (and why)

The pill-shaped drag handle (`h-1 w-10 rounded-full bg-zinc-700`) was removed in the current cycle because it was a broken affordance: it *looked* draggable but didn't respond to touch. A decorative handle is worse than no handle — it creates an expectation it can't fulfill.

This spec defines how to implement the real thing.

---

## Interaction model

### Trigger
Touch-start on the drag handle region (top 48px of the bottom sheet), then pan vertically downward.

### States
```
Resting          →  Dragging (handle touched, finger moving down)
Dragging         →  Dismissing (velocity threshold crossed OR drag > 40% of sheet height)
Dragging         →  Snapping back (finger lifted, threshold NOT crossed)
Dismissing       →  Dismissed (sheet slides fully off screen, onClose() fires)
Snapping back    →  Resting (sheet returns to h-[60vh] position)
```

### Thresholds
| Signal | Value | Notes |
|--------|-------|-------|
| Min drag to commit | 40% of sheet height | On 60vh sheet (~360px at 600px screen), that's ~144px |
| Velocity threshold | 500px/s downward | Fast flick dismisses even if drag < 40% |
| Snap-back animation | 250ms ease-out | Spring feel, not linear |
| Dismiss animation | 200ms ease-in | Slightly faster than snap-back — feels decisive |

These numbers mirror iOS native bottom sheet behavior (UISheetPresentationController). Users already have the muscle memory.

---

## Visual feedback during drag

### The handle

Restore the pill handle — but only when the gesture is actually implemented:

```tsx
{/* Drag handle — touch target is the full top bar, not just the pill */}
<div
  className="flex justify-center pt-2 pb-1 md:hidden touch-none select-none"
  onPointerDown={handleDragStart}
>
  <div className={`h-1 w-10 rounded-full transition-colors ${
    isDragging ? 'bg-zinc-500' : 'bg-zinc-700'
  }`} />
</div>
```

The pill brightens (`zinc-700` → `zinc-500`) the moment the user touches it — immediate feedback that the affordance is live.

### Sheet position during drag

Use CSS `transform: translateY(Xpx)` — NOT `height` or `top`. Transform is GPU-composited and stays at 60fps.

```tsx
<div
  style={{
    transform: isDragging ? `translateY(${dragOffset}px)` : undefined,
    transition: isDragging ? 'none' : 'transform 250ms ease-out',
  }}
  className="fixed inset-x-0 bottom-0 z-50 flex h-[60vh] flex-col ..."
>
```

`transition: none` while dragging (don't fight the finger), restore transition when not dragging (enables snap-back animation).

### Opacity fade during drag

As the user drags down, the sheet content fades slightly. This reinforces directionality.

```tsx
const opacity = isDragging
  ? Math.max(0.6, 1 - dragOffset / (sheetHeight * 0.6))
  : 1
```

Clamps at 0.6 minimum — don't fade to invisible before dismissal, that looks broken.

---

## Implementation skeleton

```tsx
// In TerminalDrawer.tsx — add alongside existing state
const sheetRef = useRef<HTMLDivElement>(null)
const [dragOffset, setDragOffset] = useState(0)
const [isDragging, setIsDragging] = useState(false)
const dragStart = useRef<{ y: number; time: number } | null>(null)

const handleDragStart = (e: React.PointerEvent) => {
  dragStart.current = { y: e.clientY, time: Date.now() }
  setIsDragging(true)
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

const handleDragMove = (e: React.PointerEvent) => {
  if (!isDragging || !dragStart.current) return
  const delta = Math.max(0, e.clientY - dragStart.current.y) // only downward
  setDragOffset(delta)
}

const handleDragEnd = (e: React.PointerEvent) => {
  if (!isDragging || !dragStart.current) return
  const sheetHeight = sheetRef.current?.offsetHeight ?? 360
  const velocity = dragOffset / ((Date.now() - dragStart.current.time) / 1000)
  const shouldDismiss = dragOffset > sheetHeight * 0.4 || velocity > 500

  if (shouldDismiss) {
    // Animate off then call onClose
    setDragOffset(sheetHeight + 60) // slide fully below screen
    setTimeout(() => {
      setDragOffset(0)
      setIsDragging(false)
      onClose()
    }, 200)
  } else {
    // Snap back
    setDragOffset(0)
    setIsDragging(false)
  }
  dragStart.current = null
}
```

Attach `onPointerMove` and `onPointerUp` to the sheet root div (not just the handle) so dragging doesn't break if the finger leaves the handle area.

---

## Accessibility

- The handle div should have `role="button" aria-label="Dismiss terminal"` — keyboard users get a button that triggers `onClose()` when pressed
- The gesture is an enhancement; the close button remains the primary dismiss mechanism
- `touch-none` on the handle prevents scroll-interference on the drag target

---

## What NOT to do

❌ Don't implement drag using `mousedown/mousemove` — use Pointer Events API (works for both mouse and touch, no dual-handler mess)

❌ Don't use `height` or `bottom` for the drag transform — only `translateY`. Height changes trigger layout; transform doesn't.

❌ Don't animate while dragging (`transition: none` while `isDragging === true`)

❌ Don't add `overflow: hidden` to the outer shell — it will clip the shadow during the drag animation

---

## When this is ready

Restore the drag handle pill. Until then (current state), the close button in the header is the only dismiss path — that's intentional and correct.
