import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface ImageLightboxProps {
  src: string
  alt?: string
  onClose: () => void
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKey)
    // Prevent body scroll while open
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = prev
    }
  }, [handleKey])

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? 'Image preview'}
    >
      {/* Close button */}
      <button
        className="absolute right-4 top-4 rounded-full bg-zinc-800/80 p-1.5 text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white"
        onClick={onClose}
        aria-label="Close"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
          <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22z" />
        </svg>
      </button>

      {/* Image — stop propagation so clicking it doesn't close */}
      <img
        src={src}
        alt={alt ?? 'Attachment'}
        className="max-h-[90vh] max-w-[90vw] cursor-default rounded-lg object-contain shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body
  )
}
