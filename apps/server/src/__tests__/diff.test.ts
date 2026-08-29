import { describe, expect, it } from 'vitest'
import { diffLines, diffVersions, type AgentVersionConfig } from '@opencrew/shared'

const base: AgentVersionConfig = {
  systemPrompt: 'You are Scout.\nBe concise.\nCite sources.',
  model: 'claude-sonnet-4-6',
  skills: ['research'],
  tools: ['WebFetch'],
  capabilities: {
    canPostInChannels: ['c1'],
    maxRunsPerHour: 10,
    requiresApprovalFor: []
  }
}

describe('diffLines', () => {
  it('marks identical text as all-same', () => {
    const lines = diffLines('a\nb', 'a\nb')
    expect(lines.every((l) => l.kind === 'same')).toBe(true)
  })

  it('detects added and removed lines with correct line numbers', () => {
    const lines = diffLines('a\nb\nc', 'a\nx\nc')
    expect(lines).toEqual([
      { kind: 'same', leftNo: 1, rightNo: 1, text: 'a' },
      { kind: 'removed', leftNo: 2, rightNo: null, text: 'b' },
      { kind: 'added', leftNo: null, rightNo: 2, text: 'x' },
      { kind: 'same', leftNo: 3, rightNo: 3, text: 'c' }
    ])
  })

  it('handles pure insertion at the end', () => {
    const lines = diffLines('a', 'a\nb')
    expect(lines).toEqual([
      { kind: 'same', leftNo: 1, rightNo: 1, text: 'a' },
      { kind: 'added', leftNo: null, rightNo: 2, text: 'b' }
    ])
  })

  it('handles empty-to-content', () => {
    const lines = diffLines('', 'a')
    expect(lines.filter((l) => l.kind === 'added')).toHaveLength(1)
  })
})

describe('diffVersions', () => {
  it('reports no changes for identical configs', () => {
    const diff = diffVersions(base, base)
    expect(diff.promptChanged).toBe(false)
    expect(diff.fields.every((f) => f.kind === 'same')).toBe(true)
  })

  it('flags changed scalar and list fields', () => {
    const next: AgentVersionConfig = {
      ...base,
      model: 'claude-opus-5',
      tools: ['WebFetch', 'Bash'],
      capabilities: { ...base.capabilities, maxRunsPerHour: 99, requiresApprovalFor: ['Bash'] }
    }
    const diff = diffVersions(base, next)
    const changed = Object.fromEntries(
      diff.fields.filter((f) => f.kind === 'changed').map((f) => [f.field, f])
    )
    expect(changed['model']?.newValue).toBe('claude-opus-5')
    expect(changed['tools']?.newValue).toContain('Bash')
    expect(changed['capabilities.maxRunsPerHour']?.newValue).toBe('99')
    expect(changed['capabilities.requiresApprovalFor']?.newValue).toBe('Bash')
    expect(changed['skills']).toBeUndefined()
  })

  it('list order does not produce phantom changes', () => {
    const reordered: AgentVersionConfig = {
      ...base,
      tools: ['WebFetch'],
      skills: [...base.skills].reverse()
    }
    const diff = diffVersions(base, reordered)
    expect(diff.fields.every((f) => f.kind === 'same')).toBe(true)
  })

  it('diffs the system prompt line by line', () => {
    const next = { ...base, systemPrompt: 'You are Scout.\nBe thorough.\nCite sources.' }
    const diff = diffVersions(base, next)
    expect(diff.promptChanged).toBe(true)
    expect(diff.promptDiff.filter((l) => l.kind === 'removed').map((l) => l.text)).toEqual([
      'Be concise.'
    ])
    expect(diff.promptDiff.filter((l) => l.kind === 'added').map((l) => l.text)).toEqual([
      'Be thorough.'
    ])
  })
})
