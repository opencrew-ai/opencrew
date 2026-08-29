import type { AgentVersionConfig } from './types'

export type DiffLineKind = 'same' | 'added' | 'removed'

export interface DiffLine {
  kind: DiffLineKind
  /** Line number in the left (old) text, if present there. */
  leftNo: number | null
  /** Line number in the right (new) text, if present there. */
  rightNo: number | null
  text: string
}

/**
 * Line-level diff via LCS. Good enough for system prompts; O(n*m) which is
 * fine for prompt-sized inputs.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const n = a.length
  const m = b.length

  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', leftNo: i + 1, rightNo: j + 1, text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ kind: 'removed', leftNo: i + 1, rightNo: null, text: a[i]! })
      i++
    } else {
      lines.push({ kind: 'added', leftNo: null, rightNo: j + 1, text: b[j]! })
      j++
    }
  }
  while (i < n) {
    lines.push({ kind: 'removed', leftNo: i + 1, rightNo: null, text: a[i]! })
    i++
  }
  while (j < m) {
    lines.push({ kind: 'added', leftNo: null, rightNo: j + 1, text: b[j]! })
    j++
  }
  return lines
}

export interface FieldChange {
  field: string
  kind: 'changed' | 'added' | 'removed' | 'same'
  oldValue: string
  newValue: string
}

/**
 * Structured diff of two agent version configs. The system prompt gets a
 * line diff; scalar and list fields get field-level changes.
 */
export interface VersionDiff {
  promptDiff: DiffLine[]
  promptChanged: boolean
  fields: FieldChange[]
}

function listAsString(list: string[]): string {
  return list.length > 0 ? [...list].sort().join(', ') : '(none)'
}

export function diffVersions(
  oldCfg: AgentVersionConfig,
  newCfg: AgentVersionConfig
): VersionDiff {
  const fields: FieldChange[] = []

  const push = (field: string, oldValue: string, newValue: string) => {
    fields.push({
      field,
      kind: oldValue === newValue ? 'same' : 'changed',
      oldValue,
      newValue
    })
  }

  push('model', oldCfg.model, newCfg.model)
  push('skills', listAsString(oldCfg.skills), listAsString(newCfg.skills))
  push('tools', listAsString(oldCfg.tools), listAsString(newCfg.tools))
  push(
    'capabilities.canPostInChannels',
    listAsString(oldCfg.capabilities.canPostInChannels),
    listAsString(newCfg.capabilities.canPostInChannels)
  )
  push(
    'capabilities.maxRunsPerHour',
    String(oldCfg.capabilities.maxRunsPerHour),
    String(newCfg.capabilities.maxRunsPerHour)
  )
  push(
    'capabilities.requiresApprovalFor',
    listAsString(oldCfg.capabilities.requiresApprovalFor),
    listAsString(newCfg.capabilities.requiresApprovalFor)
  )

  const promptDiff = diffLines(oldCfg.systemPrompt, newCfg.systemPrompt)
  return {
    promptDiff,
    promptChanged: promptDiff.some((l) => l.kind !== 'same'),
    fields
  }
}
