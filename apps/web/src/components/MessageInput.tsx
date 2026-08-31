import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ClipboardEvent } from 'react'
import { useWorkspace } from '../lib/workspace'
import { showAlert } from '../lib/dialogs'

interface MessageInputProps {
  placeholder: string
  onSend: (content: string, images: string[]) => Promise<void>
}

/** Resize an image File to ≤800px wide and encode as JPEG data URL. */
async function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const MAX = 800
      const ratio = Math.min(1, MAX / Math.max(img.width, img.height))
      const w = Math.round(img.width * ratio)
      const h = Math.round(img.height * ratio)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('no canvas context')); return }
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('image load failed')) }
    img.src = objectUrl
  })
}

async function processFiles(files: FileList | File[]): Promise<string[]> {
  const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'))
  return Promise.all(imageFiles.map(compressImage))
}

export function MessageInput({ placeholder, onSend }: MessageInputProps) {
  const { agents } = useWorkspace()
  const [value, setValue] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Slack-style @mention autocomplete for agents.
  const mentionQuery = useMemo(() => {
    const match = value.match(/@([A-Za-z0-9_-]*)$/)
    return match ? match[1]!.toLowerCase() : null
  }, [value])
  const suggestions = useMemo(() => {
    if (mentionQuery === null) return []
    return agents
      .filter((a) => a.status === 'active' && a.name.toLowerCase().startsWith(mentionQuery))
      .slice(0, 5)
  }, [agents, mentionQuery])

  const applySuggestion = (name: string) => {
    setValue(value.replace(/@[A-Za-z0-9_-]*$/, `@${name} `))
    textareaRef.current?.focus()
  }

  const addImages = async (files: FileList | File[]) => {
    const compressed = await processFiles(files)
    if (!compressed.length) return
    setImages((prev) => [...prev, ...compressed].slice(0, 10)) // max 10 images
  }

  const removeImage = (idx: number) => setImages((prev) => prev.filter((_, i) => i !== idx))

  const send = async () => {
    const content = value.trim()
    if ((!content && images.length === 0) || busy) return
    setBusy(true)
    try {
      await onSend(content, images)
      setValue('')
      setImages([])
    } catch (err) {
      void showAlert(err instanceof Error ? err.message : 'failed to send', { title: 'Send failed' })
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && suggestions.length > 0) {
      e.preventDefault()
      applySuggestion(suggestions[0]!.name)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith('image/'))
    if (!items.length) return
    e.preventDefault()
    const files = items.map((i) => i.getAsFile()).filter(Boolean) as File[]
    void addImages(files)
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault()
      setDragging(true)
    }
  }
  const onDragLeave = () => setDragging(false)
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    void addImages(e.dataTransfer.files)
  }

  const canSend = (value.trim().length > 0 || images.length > 0) && !busy

  return (
    <div
      className={`relative ${dragging ? 'ring-2 ring-emerald-500 rounded-lg' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* @mention autocomplete */}
      {suggestions.length > 0 && (
        <div className="absolute bottom-full left-0 mb-1 w-64 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-lg">
          {suggestions.map((a) => (
            <button
              key={a.id}
              onClick={() => applySuggestion(a.name)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-800"
            >
              <span>{a.avatarEmoji}</span>
              <span>{a.name}</span>
              <span className="ml-auto text-xs text-zinc-500">Tab</span>
            </button>
          ))}
        </div>
      )}

      {/* Image previews */}
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((src, i) => (
            <div key={i} className="relative group">
              <img
                src={src}
                alt={`attachment ${i + 1}`}
                className="h-20 w-20 rounded-md object-cover border border-zinc-700"
              />
              <button
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 hover:bg-red-900 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                aria-label="Remove image"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Drag-drop overlay label */}
      {dragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-zinc-900/80 pointer-events-none">
          <span className="text-sm text-emerald-400">Drop images here</span>
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2">
        {/* File picker button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-40 transition-colors"
          aria-label="Attach image"
          title="Attach image (or paste / drag-drop)"
        >
          {/* Paperclip SVG */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 8.5l-5.5 5.5a4 4 0 01-5.657-5.657l6.364-6.364a2.5 2.5 0 013.536 3.536l-6.01 6.01a1 1 0 01-1.414-1.414l5.303-5.303"/>
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) void addImages(e.target.files); e.target.value = '' }}
        />

        <textarea
          ref={textareaRef}
          rows={2}
          className="input resize-none font-normal flex-1"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        {/* Send button */}
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Send message"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          </svg>
        </button>
      </div>

      <p className="mt-1 text-xs text-zinc-600">
        Enter to send · Shift+Enter for newline · @mention · paste or drag images
      </p>
    </div>
  )
}
