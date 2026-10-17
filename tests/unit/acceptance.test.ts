import { describe, expect, it } from 'vitest'
import { transition, initialState, replay } from '../../src/workflow/controller.js'
import { brief, passed, snapshot, finding, atEvent, readyEvents } from '../fixtures/workflow.js'
import { reviewSchema } from '../../src/workflow/types.js'
import type { ReviewResult } from '../../src/workflow/types.js'
const finish = (result: ReviewResult) => transition(atEvent(7), { type: 'review-finished', runId: 'review-1', result, elapsedMs: 1 })
describe('required snapshot-bound acceptance evidence', () => {
  it.each([
    { ...passed, acceptance: undefined }, { ...passed, acceptance: [] }, { ...passed, unchecked: ['AC1'] },
    { ...passed, acceptance: [{ id: 'AC1', status: 'Not Verified', evidence: [] }] },
    { ...passed, acceptance: [{ id: 'AC1', status: 'Failed', evidence: [] }] },
    { ...passed, acceptance: [{ id: 'unknown', status: 'Passed', evidence: [] }] },
    { ...passed, acceptance: [passed.acceptance![0]!, passed.acceptance![0]!] },
    { ...passed, acceptance: [{ ...passed.acceptance![0]!, evidence: [] }] },
    { ...passed, acceptance: [{ ...passed.acceptance![0]!, evidence: [{ kind: 'verification', checkIndex: 1, explanation: 'Does not exist' }] }] },
  ])('rejects an incomplete or contradictory Passed report %#', result => {
    expect(() => finish(reviewSchema.parse(result))).toThrow()
  })
  it('requires coverage for every criterion and not just one', () => {
    const state = atEvent(7)
    state.brief = { ...brief, acceptanceCriteria: [...brief.acceptanceCriteria, { id: 'AC2', description: 'Second required result' }] }
    expect(() => transition(state, { type: 'review-finished', runId: 'review-1', result: passed, elapsedMs: 1 })).toThrow('incomplete')
    const complete = { ...passed, acceptance: [...passed.acceptance!, { ...passed.acceptance![0]!, id: 'AC2' }] }
    expect(transition(state, { type: 'review-finished', runId: 'review-1', result: complete, elapsedMs: 1 }).phase).toBe('Ready for Handoff')
  })
  it('does not allow a legacy Passed candidate to bypass final handoff validation', () => {
    const events = readyEvents().map(event => event.type === 'review-finished' ? { ...event, result: { ...passed, acceptance: undefined } } : event)
    const legacy = replay(events.map(event => ({ version: 1, event })))
    expect(legacy.phase).toBe('Ready for Handoff')
    expect(() => transition(legacy, { type: 'handoff-completed', snapshotId: snapshot.id, treeId: snapshot.treeId, briefRevision: 1 })).toThrow('Structured acceptance')
    expect(() => replay(events.map(event => ({ version: 2, event })))).toThrow('Structured acceptance')
  })
  it('retains repair findings after pause and human retry, without reusing Passed', () => {
    const changed = finish({ ...passed, outcome: 'Needs Changes', findings: [finding] })
    const paused = transition(changed, { type: 'paused', reason: 'Recoverable role failure' })
    const retried = transition(paused, { type: 'recovery-decided', questionId: 'retry', runId: null, action: 'retry', elapsedMs: 0 })
    expect(retried.phase).toBe('Needs Changes')
    expect(retried.review?.findings).toEqual([finding])
    const repairing = transition(retried, { type: 'implementation-started', runId: 'repair' })
    expect(repairing.snapshot).toBeNull()
    expect(() => transition(repairing, { type: 'handoff-completed', snapshotId: snapshot.id, treeId: snapshot.treeId, briefRevision: 1 })).toThrow()
    const oldPassed = transition(transition(atEvent(8), { type: 'paused', reason: 'Stop before handoff' }), { type: 'resumed' })
    expect(oldPassed.review).toBeNull()
    expect(oldPassed.phase).toBe('Staged')
  })
  it('keeps unsupported record versions and unapproved starts rejected', () => {
    expect(() => replay([{ version: 9, event: readyEvents()[0] }])).toThrow()
    expect(() => transition(initialState(), { type: 'implementation-started', runId: 'unapproved' })).toThrow()
  })
})
