import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useWorkspace } from '../lib/workspace'

interface MessageInputProps {
  placeholder: string
  onSend: (content: string) => Promise<void>
}

export function MessageInput({ placeholder, onSend }: MessageInputProps) {
  const { agents } = useWorkspace()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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

  const send = async () => {
    const content = value.trim()
    if (!content || busy) return
    setBusy(true)
    try {
      await onSend(content)
      setValue('')
    } catch (err) {
      alert(err instanceof Error ? err.message : 'failed to send')
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

  return (
    <div className="relative">
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
      <textarea
        ref={textareaRef}
        rows={2}
        className="input resize-none font-normal"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <p className="mt-1 text-xs text-zinc-600">
        Enter to send · Shift+Enter for newline · @mention an agent to put it to work
      </p>
    </div>
  )
}
