import { describe, expect, it } from 'vitest'
import { initialState, replay, transition } from '../../src/workflow/controller.js'
import { recordSchema, submittedBriefSchema } from '../../src/workflow/types.js'
import { atEvent, brief, readyEvents } from '../fixtures/workflow.js'

describe('explicit command deadlines and durable execution wall-clock windows', () => {
  it('accepts increasing mixed history and refuses lower-version tails', () => {
    const event = (revision: number) => ({ type: 'requirements-submitted', brief: { ...brief, revision } })
    expect(replay([{ version: 1, event: event(1) }, { version: 2, event: event(2) }, { version: 3, event: event(3) }]).brief?.revision).toBe(3)
    for (const version of [1, 2]) expect(() => replay([{ version: 3, event: event(1) }, { version, event: event(2) }])).toThrow('cannot regress')
  })
  it('does not refund a deadline reached during the final durable settlement', () => {
    const state = transition(atEvent(2), { type: 'execution-budget-exhausted', executionWallMs: brief.executionBudgetMs + 1 })
    expect(state.phase).toBe('Paused')
    expect(() => transition(state, { type: 'resumed' })).toThrow('budget')
    expect(() => transition(state, { type: 'execution-budget-exhausted', executionWallMs: 0 })).toThrow('monotonic')
  })
  it.each([0, -1, 1.5, 2147483648])('rejects unsupported timeoutMs %s', timeoutMs => {
    expect(() => submittedBriefSchema.parse({ ...brief, verificationCommands: [{ ...brief.verificationCommands[0], timeoutMs }] })).toThrow()
  })
  it('requires explicit deadlines and execution intent for new submissions without rewriting legacy records', () => {
    const { executionIntent: _legacyIntent, ...withoutIntent } = brief
    const legacy = { ...withoutIntent, verificationCommands: [{ executable: 'node', args: ['--version'] }] }
    expect(() => submittedBriefSchema.parse(legacy)).toThrow()
    expect(() => transition(initialState(), { type: 'requirements-submitted', brief: legacy })).toThrow('timeoutMs')
    expect(replay([{ version: 2, event: { type: 'requirements-submitted', brief: { ...withoutIntent, verificationCommands: [{ executable: 'node', args: ['--version'], timeoutMs: 60000 }] } } }]).brief?.executionIntent).toBeUndefined()
    const records = [{ version: 2, event: { type: 'requirements-submitted', brief: legacy } }, { version: 2, event: readyEvents()[1] }]
    const before = JSON.stringify(records)
    expect(replay(records).phase).toBe('Approved')
    expect(JSON.stringify(records)).toBe(before)
  })
  it('preserves wall-clock consumption on revised approval and across replay', () => {
    const events = [readyEvents()[0]!, readyEvents()[1]!, { type: 'execution-window-started' as const, id: 'window' }, { type: 'execution-window-finished' as const, id: 'window', elapsedMs: 123 }, { type: 'requirements-submitted' as const, brief: { ...brief, revision: 2 } }]
    const state = replay(events.map(event => ({ version: 3, event })))
    expect(state.executionWallMs).toBe(123)
    expect(state.executionWindow).toBeUndefined()
    expect(state.approval).toBeNull()
  })
  it('does not reset consumed legacy component runtime when a new window begins', () => {
    const state = transition({ ...atEvent(2), executionMs: 70 }, { type: 'execution-window-started', id: 'window' })
    expect(state.executionWallMs).toBe(70)
    expect(transition(state, { type: 'execution-window-finished', id: 'window', elapsedMs: 30 }).executionWallMs).toBe(100)
  })
  it('requires drained matching windows and forbids revision or cancellation while unresolved', () => {
    const state = transition(atEvent(2), { type: 'execution-window-started', id: 'window' })
    expect(() => transition(state, { type: 'execution-window-started', id: 'second' })).toThrow('unresolved')
    expect(() => transition(state, { type: 'execution-window-finished', id: 'wrong', elapsedMs: 1 })).toThrow('owned')
    expect(() => transition(state, { type: 'requirements-submitted', brief: { ...brief, revision: 2 } })).toThrow('Stop active')
    expect(() => transition(state, { type: 'cancelled', reason: 'not drained' })).toThrow('termination')
    const active = transition(state, { type: 'implementation-started', runId: 'worker' })
    expect(() => transition(active, { type: 'execution-window-finished', id: 'window', elapsedMs: 1 })).toThrow('drained')
  })
  it('pauses when wall time expires even if component runtime has budget left', () => {
    const state = transition(atEvent(2), { type: 'execution-window-started', id: 'window' })
    const finished = transition(state, { type: 'execution-window-finished', id: 'window', elapsedMs: brief.executionBudgetMs })
    expect(finished.phase).toBe('Paused')
    expect(finished.executionMs).toBe(0)
    expect(() => transition(finished, { type: 'resumed' })).toThrow('budget')
  })
  it('requires human recovery and consumes all unknown remaining wall time', () => {
    const state = transition({ ...atEvent(2), executionWallMs: 10 }, { type: 'execution-window-started', id: 'lost' })
    expect(() => transition(state, { type: 'recovery-decided', questionId: 'human', runId: null, action: 'recover-interrupted', elapsedMs: 0 })).toThrow('unknown remaining')
    const recovered = transition(state, { type: 'recovery-decided', questionId: 'human', runId: null, action: 'recover-interrupted', elapsedMs: brief.executionBudgetMs - 10 })
    expect(recovered.executionWindow).toBeUndefined()
    expect(recovered.executionWallMs).toBe(brief.executionBudgetMs)
    expect(() => transition(recovered, { type: 'resumed' })).toThrow('budget')
  })
  it('leaves unconfirmed windows unresolved and rejects window events under old record versions', () => {
    const state = transition(atEvent(2), { type: 'execution-window-started', id: 'lost' })
    expect(transition(state, { type: 'recovery-decided', questionId: 'human', runId: null, action: 'leave-paused', elapsedMs: 0 })).toEqual(state)
    for (const version of [1, 2]) expect(() => recordSchema.parse({ version, event: { type: 'execution-window-started', id: 'lost' } })).toThrow()
  })
})
