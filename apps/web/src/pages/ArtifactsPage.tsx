import { useEffect, useMemo, useState } from 'react'
import type { Artifact } from '@opencrew/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'
import { Sidebar } from '../components/Sidebar'
import { ArtifactDocModal } from '../components/ArtifactCard'
import { useWorkspace } from '../lib/workspace'

// ---------------------------------------------------------------------------
// Folder tree model
// ---------------------------------------------------------------------------

interface FolderNode {
  name: string
  path: string
  children: Map<string, FolderNode>
  docs: Artifact[]
}

function makeNode(name: string, path: string): FolderNode {
  return { name, path, children: new Map(), docs: [] }
}

/**
 * Build the folder tree from artifact folder paths. Only the latest
 * non-discarded version of each (conversation, title) appears.
 */
function buildTree(all: Artifact[]): FolderNode {
  const latest = new Map<string, Artifact>()
  for (const artifact of all) {
    if (artifact.status === 'discarded') continue
    const key = `${artifact.conversationRootId}::${artifact.title}`
    const existing = latest.get(key)
    if (!existing || artifact.version > existing.version) latest.set(key, artifact)
  }

  const root = makeNode('', '')
  for (const artifact of latest.values()) {
    let node = root
    let path = ''
    for (const segment of artifact.folder.split('/').filter(Boolean)) {
      path = path ? `${path}/${segment}` : segment
      if (!node.children.has(segment)) node.children.set(segment, makeNode(segment, path))
      node = node.children.get(segment)!
    }
    node.docs.push(artifact)
  }
  return root
}

// ---------------------------------------------------------------------------
// Tree rendering
// ---------------------------------------------------------------------------

function relativeTime(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

interface DocRowProps {
  artifact: Artifact
  depth: number
  onOpen: (artifact: Artifact) => void
}

function DocRow({ artifact, depth, onOpen }: DocRowProps) {
  const { agents } = useWorkspace()
  const agent = agents.find((a) => a.id === artifact.createdByAgentId)
  return (
    <button
      onClick={() => onOpen(artifact)}
      style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
      className="flex w-full items-center gap-2 rounded py-1.5 pr-3 text-left text-sm transition hover:bg-zinc-900/60"
    >
      <span>{artifact.kind === 'change' ? '🧩' : '📄'}</span>
      <span className="min-w-0 flex-1 truncate text-zinc-200">{artifact.title}</span>
      <span className="text-[10px] text-zinc-600">v{artifact.version}</span>
      {artifact.status === 'review' ? (
        <span className="rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] uppercase text-sky-300">
          📚 in review
        </span>
      ) : artifact.status === 'proposed' ? (
        <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] uppercase text-amber-300">
          awaiting approval
        </span>
      ) : (
        <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[10px] uppercase text-emerald-300">
          ✓
        </span>
      )}
      {agent && <span className="text-xs text-zinc-600">{agent.avatarEmoji}</span>}
      <span className="w-16 text-right text-[10px] text-zinc-600">
        {relativeTime(artifact.updatedAt)}
      </span>
    </button>
  )
}

interface FolderRowProps {
  node: FolderNode
  depth: number
  onOpen: (artifact: Artifact) => void
}

function FolderRow({ node, depth, onOpen }: FolderRowProps) {
  const [isOpen, setIsOpen] = useState(true)
  const childFolders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
  const docs = [...node.docs].sort((a, b) => b.updatedAt - a.updatedAt)
  return (
    <div>
      <button
        onClick={() => setIsOpen((v) => !v)}
        style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
        className="flex w-full items-center gap-2 rounded py-1.5 pr-3 text-left text-sm text-zinc-300 transition hover:bg-zinc-900/60"
      >
        <span>{isOpen ? '📂' : '📁'}</span>
        <span className="flex-1 font-medium">{node.name}</span>
        <span className="text-[10px] text-zinc-600">
          {docs.length + childFolders.reduce((n, f) => n + countDocs(f), 0)}
        </span>
        <span className="text-xs text-zinc-600">{isOpen ? '▾' : '▸'}</span>
      </button>
      {isOpen && (
        <div>
          {childFolders.map((child) => (
            <FolderRow key={child.path} node={child} depth={depth + 1} onOpen={onOpen} />
          ))}
          {docs.map((artifact) => (
            <DocRow key={artifact.id} artifact={artifact} depth={depth + 1} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

function countDocs(node: FolderNode): number {
  return node.docs.length + [...node.children.values()].reduce((n, c) => n + countDocs(c), 0)
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ArtifactsPage() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [loading, setLoading] = useState(true)
  const [openArtifact, setOpenArtifact] = useState<Artifact | null>(null)

  useEffect(() => {
    api
      .get<Artifact[]>('/api/artifacts')
      .then(setArtifacts)
      .catch(() => {})
      .finally(() => setLoading(false))
    return wsClient.subscribe((event) => {
      if (event.type !== 'artifact_state') return
      setArtifacts((prev) => [
        event.artifact,
        ...prev.filter((a) => a.id !== event.artifact.id)
      ])
    })
  }, [])

  const tree = useMemo(() => buildTree(artifacts), [artifacts])
  const rootFolders = [...tree.children.values()].sort((a, b) => a.name.localeCompare(b.name))
  const rootDocs = [...tree.docs].sort((a, b) => b.updatedAt - a.updatedAt)
  const isEmpty = rootFolders.length === 0 && rootDocs.length === 0

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 overflow-y-auto p-6">
        <h1 className="text-xl font-bold">Artifacts</h1>
        <p className="mt-1 text-sm text-zinc-500">
          The crew's durable output — plans and docs, organized in folders. Docs awaiting
          approval are marked; open one to review, comment, and commit.
        </p>

        <div className="mt-5 max-w-3xl rounded-xl border border-zinc-800/60 bg-zinc-950/30 py-2">
          {loading && <p className="px-4 py-2 text-sm text-zinc-500">Loading…</p>}
          {!loading && isEmpty && (
            <p className="px-4 py-6 text-sm text-zinc-500">
              No artifacts yet — ask the crew for a plan and approve it, and it will land here.
            </p>
          )}
          {rootFolders.map((node) => (
            <FolderRow key={node.path} node={node} depth={0} onOpen={setOpenArtifact} />
          ))}
          {rootDocs.map((artifact) => (
            <DocRow key={artifact.id} artifact={artifact} depth={0} onOpen={setOpenArtifact} />
          ))}
        </div>
      </div>

      {openArtifact && (
        <ArtifactDocModal artifact={openArtifact} onClose={() => setOpenArtifact(null)} />
      )}
    </div>
  )
}
