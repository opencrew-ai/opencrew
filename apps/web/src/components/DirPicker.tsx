import { useEffect, useState } from 'react'
import { api } from '../lib/api'

interface DirListing {
  path: string
  parent: string | null
  home: string
  dirs: string[]
}

interface DirPickerProps {
  initialPath?: string
  onSelect: (path: string) => void
  onClose: () => void
}

/** Server-backed folder browser for choosing an agent's working directory. */
export function DirPicker({ initialPath, onSelect, onClose }: DirPickerProps) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = (path?: string) => {
    setError(null)
    const query = path ? `?path=${encodeURIComponent(path)}` : ''
    api
      .get<DirListing>(`/api/fs/dirs${query}`)
      .then(setListing)
      .catch((err) => setError(err instanceof Error ? err.message : 'failed'))
  }

  useEffect(() => {
    load(initialPath && initialPath.startsWith('/') ? initialPath : undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="mt-2 rounded-lg border border-zinc-700 bg-zinc-900 p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-secondary px-2 py-1 text-xs"
          onClick={() => listing?.parent && load(listing.parent)}
          disabled={!listing?.parent}
        >
          ↑ up
        </button>
        <button
          type="button"
          className="btn-secondary px-2 py-1 text-xs"
          onClick={() => listing && load(listing.home)}
        >
          ⌂ home
        </button>
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-400">
          {listing?.path ?? '…'}
        </code>
        <button
          type="button"
          className="text-zinc-500 hover:text-white"
          onClick={onClose}
          title="Close"
        >
          ✕
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-zinc-800">
        {listing?.dirs.length === 0 && (
          <p className="px-3 py-2 text-xs text-zinc-500">No subfolders.</p>
        )}
        {listing?.dirs.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => load(`${listing.path === '/' ? '' : listing.path}/${name}`)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-zinc-300 hover:bg-zinc-800"
          >
            📁 {name}
          </button>
        ))}
      </div>

      <div className="mt-2 flex justify-end">
        <button
          type="button"
          className="btn-primary px-3 py-1.5 text-xs"
          disabled={!listing}
          onClick={() => listing && onSelect(listing.path)}
        >
          Use this directory
        </button>
      </div>
    </div>
  )
}
