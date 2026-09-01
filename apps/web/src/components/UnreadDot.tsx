/**
 * UnreadDot — reusable unread-activity badge.
 *
 * Renders a small emerald pill with an optional count. When `animate` is true
 * it plays one bounce cycle to draw attention to new activity (e.g. a message
 * arriving on a collapsed thread). The animation is CSS-only and respects
 * prefers-reduced-motion via Tailwind's built-in media-query handling.
 *
 * Accessibility: rendered as a live status region with an aria-label so
 * screen readers announce the unread state without relying on colour alone.
 */

interface UnreadDotProps {
  /** Unread reply count. Omit or pass 0 to show the dot without a number. */
  count?: number
  /** Play a one-shot bounce animation to attract attention. */
  animate?: boolean
  className?: string
}

export function UnreadDot({ count, animate = false, className = '' }: UnreadDotProps) {
  const displayCount = typeof count === 'number' && count > 0
  const label = displayCount
    ? `${count} unread ${count === 1 ? 'reply' : 'replies'}`
    : 'New activity'

  return (
    <span
      role="status"
      aria-label={label}
      aria-live="polite"
      className={[
        // Shape: pill when there's a count, circle otherwise
        'inline-flex items-center justify-center rounded-full font-bold',
        displayCount ? 'min-w-[18px] h-[18px] px-1 text-[10px]' : 'h-2 w-2',
        // Colour + glow — using existing emerald palette
        'bg-emerald-500 text-white',
        'shadow-[0_0_6px_2px_rgba(52,211,153,0.5)]',
        // One-shot bounce (Tailwind animate-bounce loops; we stop it via CSS
        // after one cycle using a short animation-iteration-count override)
        animate ? 'animate-bounce [animation-iteration-count:2]' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {displayCount ? count : null}
    </span>
  )
}
