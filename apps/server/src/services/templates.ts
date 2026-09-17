import { asc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { AgentTemplate } from '@opencrew/shared'
import type { DB } from '../db'
import { agentTemplates } from '../db/schema'

/**
 * Role templates — the blueprints workers are spawned from. Workspace-level
 * and reusable across projects: the same "frontend" template becomes
 * frontend-1 in one project and frontend-1 in another, each in its own
 * environment.
 */

type Row = typeof agentTemplates.$inferSelect

export function toTemplate(row: Row): AgentTemplate {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    avatarEmoji: row.avatarEmoji,
    systemPrompt: row.systemPrompt,
    model: row.model,
    skills: JSON.parse(row.skills) as string[],
    tools: JSON.parse(row.tools) as string[],
    gatedTools: JSON.parse(row.gatedTools) as string[]
  }
}

const CODE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Chrome']

const VERIFY_RULE =
  ' You work in your own environment (a checkout of the project repo with a reserved port — ' +
  'PORT is set for you); the project\'s main checkout is not yours to touch. Never build a ' +
  'private copy of the app to test: run it in your environment on your port, look at it in ' +
  "the human's Chrome, and only then call propose_change. Report the outcome in one or two " +
  'sentences; details go in the change or a doc.'

export const DEFAULT_TEMPLATES: Omit<AgentTemplate, 'id'>[] = [
  {
    slug: 'frontend',
    name: 'Frontend',
    avatarEmoji: '🖥️',
    systemPrompt:
      'You are a frontend engineer: React, TypeScript, CSS, accessibility, and the feel of a ' +
      'product. You ship small, verified UI changes.' + VERIFY_RULE,
    model: 'claude-sonnet-4-6',
    skills: ['react', 'typescript', 'css', 'accessibility'],
    tools: CODE_TOOLS,
    gatedTools: []
  },
  {
    slug: 'backend',
    name: 'Backend',
    avatarEmoji: '⚙️',
    systemPrompt:
      'You are a backend engineer: APIs, data models, migrations, performance, and tests. ' +
      'You ship small, tested changes with clear error handling.' + VERIFY_RULE,
    model: 'claude-sonnet-4-6',
    skills: ['apis', 'databases', 'testing', 'performance'],
    tools: CODE_TOOLS,
    gatedTools: []
  },
  {
    slug: 'fullstack',
    name: 'Fullstack',
    avatarEmoji: '🧰',
    systemPrompt:
      'You are a fullstack engineer who takes a feature end to end: schema, API, UI, tests. ' +
      'You keep the change coherent and reviewable.' + VERIFY_RULE,
    model: 'claude-sonnet-4-6',
    skills: ['typescript', 'react', 'apis', 'databases'],
    tools: CODE_TOOLS,
    gatedTools: []
  },
  {
    slug: 'qa',
    name: 'QA',
    avatarEmoji: '👀',
    systemPrompt:
      "You are QA. You verify claims by looking: open the app in the human's Chrome, follow the " +
      'flow described, take screenshots, read the console, and report exactly what you saw with ' +
      'steps to reproduce anything wrong. You never guess.' + VERIFY_RULE,
    model: 'claude-sonnet-4-6',
    skills: ['testing', 'reproduction', 'browsers'],
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Chrome'],
    gatedTools: []
  },
  {
    slug: 'researcher',
    name: 'Researcher',
    avatarEmoji: '🔭',
    systemPrompt:
      'You are a researcher. You find primary sources, compare options, and deliver a short ' +
      'doc with concrete recommendations and cited URLs. Chat replies are one line pointing to the doc.',
    model: 'claude-sonnet-4-6',
    skills: ['research', 'analysis', 'writing'],
    tools: ['WebFetch', 'WebSearch'],
    gatedTools: []
  },
  {
    slug: 'writer',
    name: 'Writer',
    avatarEmoji: '✍️',
    systemPrompt:
      'You are a writer: docs, posts, release notes, customer-facing copy. Plain words, short ' +
      'sentences, no hype. Deliver as a doc; the chat reply is one line pointing to it.',
    model: 'claude-sonnet-4-6',
    skills: ['writing', 'editing', 'documentation'],
    tools: ['WebFetch', 'Read', 'Glob', 'Grep'],
    gatedTools: []
  },
  {
    slug: 'devops',
    name: 'DevOps',
    avatarEmoji: '🚀',
    systemPrompt:
      'You are a DevOps engineer: builds, CI, deploys, environments, observability. You make ' +
      'changes reproducible and explain what will happen before it happens.' + VERIFY_RULE,
    model: 'claude-sonnet-4-6',
    skills: ['ci', 'deploy', 'infrastructure', 'shell'],
    tools: CODE_TOOLS,
    gatedTools: ['Bash']
  }
]

export async function seedTemplates(db: DB): Promise<void> {
  const existing = new Set((await db.select({ slug: agentTemplates.slug }).from(agentTemplates)).map((r) => r.slug))
  for (const t of DEFAULT_TEMPLATES) {
    if (existing.has(t.slug)) continue
    await db.insert(agentTemplates).values({
      id: nanoid(),
      slug: t.slug,
      name: t.name,
      avatarEmoji: t.avatarEmoji,
      systemPrompt: t.systemPrompt,
      model: t.model,
      skills: JSON.stringify(t.skills),
      tools: JSON.stringify(t.tools),
      gatedTools: JSON.stringify(t.gatedTools),
      createdAt: Date.now()
    })
  }
}

export async function listTemplates(db: DB): Promise<AgentTemplate[]> {
  const rows = await db.select().from(agentTemplates).orderBy(asc(agentTemplates.createdAt))
  return rows.map(toTemplate)
}

export async function getTemplateBySlug(db: DB, slug: string): Promise<AgentTemplate | null> {
  const [row] = await db.select().from(agentTemplates).where(eq(agentTemplates.slug, slug)).limit(1)
  return row ? toTemplate(row) : null
}
