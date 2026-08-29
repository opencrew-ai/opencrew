import { listOpenCrewTools } from './registry'

/**
 * Claude Code built-in tools an admin can grant to an agent. Agents run as
 * Claude Code sessions, so these come for free from the runtime.
 */
export const BUILTIN_TOOLS: Array<{ name: string; description: string }> = [
  { name: 'WebFetch', description: 'Fetch and read web pages' },
  { name: 'WebSearch', description: 'Search the web' },
  { name: 'Bash', description: 'Run shell commands in the agent workspace' },
  { name: 'Read', description: 'Read files in the agent workspace' },
  { name: 'Write', description: 'Write files in the agent workspace' },
  { name: 'Edit', description: 'Edit files in the agent workspace' },
  { name: 'Glob', description: 'Find files by pattern' },
  { name: 'Grep', description: 'Search file contents' },
  { name: 'TodoWrite', description: 'Track a task list while working' },
  {
    name: 'Browser',
    description:
      'Drive a real local Chrome (persistent per-agent profile) — navigate, click, type. Log into sites once, the session sticks.'
  }
]

export interface ToolCatalogEntry {
  name: string
  description: string
  kind: 'builtin' | 'opencrew'
}

export function toolCatalog(): ToolCatalogEntry[] {
  return [
    ...BUILTIN_TOOLS.map((t) => ({ ...t, kind: 'builtin' as const })),
    ...listOpenCrewTools().map((t) => ({
      name: t.name,
      description: t.description,
      kind: 'opencrew' as const
    }))
  ]
}

export function isKnownToolName(name: string): boolean {
  return toolCatalog().some((t) => t.name === name)
}
