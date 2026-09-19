import { describe, expect, it } from 'vitest'
import { draftsFromCheckboxes } from '../services/artifacts'

describe('a plan written as checkboxes is a task list', () => {
  it('turns unchecked boxes into medium-priority drafts and leaves the rest alone', () => {
    const doc = [
      '# Action items',
      '- [ ] Fix the 500 on /internal/notify/signup',
      '  * [ ] Add a retry on TransactionConflict',
      '- [x] Already done — stays in the doc only',
      '- Plain bullet, not a task',
      '- [ ]',
      ''
    ].join('\n')
    expect(draftsFromCheckboxes(doc)).toEqual([
      { content: 'Fix the 500 on /internal/notify/signup', priority: 'medium' },
      { content: 'Add a retry on TransactionConflict', priority: 'medium' }
    ])
  })
})
