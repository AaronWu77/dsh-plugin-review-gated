import { describe, expect, it } from 'vitest'
import { initialState, replay, transition, WorkflowController } from '../../src/workflow/controller.js'
import { briefSchema, recordSchema } from '../../src/workflow/types.js'
import { atEvent, brief, finding, passed, readyEvents, snapshot, verification } from '../fixtures/workflow.js'

const handoff = { type: 'handoff-completed' as const, snapshotId: snapshot.id, treeId: snapshot.treeId, briefRevision: 1 }
describe('strict workflow ordering', () => {
  it('requires approval before implementation', () => {
    for (const state of [initialState(), atEvent(1)]) expect(() => transition(state, { type: 'implementation-started', runId: 'w' })).toThrow('phase')
  })
  it('requires a requirement brief before approval', () => {
    expect(() => transition(initialState(), { type: 'requirements-decided', evidence: { questionId: 'q', revision: 1, approved: true } })).toThrow()
  })
  it('rejects stale approval and unresolved questions', () => {
    expect(() => transition(atEvent(1), { type: 'requirements-decided', evidence: { questionId: 'q', revision: 2, approved: true } })).toThrow('stale')
    const state = transition(initialState(), { type: 'requirements-submitted', brief: { ...brief, questions: ['Which records?'] } })
    expect(() => transition(state, { type: 'requirements-decided', evidence: { questionId: 'q', revision: 1, approved: true } })).toThrow('Unresolved')
  })
  it('records declined approval without permitting implementation', () => {
    const state = transition(atEvent(1), { type: 'requirements-decided', evidence: { questionId: 'q', revision: 1, approved: false } })
    expect(state.phase).toBe('Clarifying')
    expect(() => transition(state, { type: 'implementation-started', runId: 'w' })).toThrow()
  })
  it('rejects duplicate criterion IDs and skipped revisions', () => {
    expect(() => transition(initialState(), { type: 'requirements-submitted', brief: { ...brief, acceptanceCriteria: [...brief.acceptanceCriteria, ...brief.acceptanceCriteria] } })).toThrow('unique')
    expect(() => transition(atEvent(1), { type: 'requirements-submitted', brief: { ...brief, revision: 3 } })).toThrow('one')
  })
  it('cannot stage during implementation or start two writers', () => {
    expect(() => transition(atEvent(3), { type: 'snapshot-created', snapshot })).toThrow()
    expect(() => transition(atEvent(3), { type: 'implementation-started', runId: 'another' })).toThrow()
  })
  it('allows verification-only briefs to capture a clean snapshot but never start implementation', () => {
    const verificationOnly = { ...brief, executionIntent: 'verification-only' as const }
    const approved = transition(transition(initialState(), { type: 'requirements-submitted', brief: verificationOnly }), { type: 'requirements-decided', evidence: { questionId: 'q', revision: 1, approved: true } })
    expect(() => transition(approved, { type: 'implementation-started', runId: 'writer' })).toThrow('Verification-only')
    expect(() => transition(approved, { type: 'snapshot-created', snapshot })).toThrow('no changed paths')
    expect(() => replay([
      { version: 5, event: { type: 'requirements-submitted', brief: verificationOnly } },
      { version: 5, event: { type: 'requirements-decided', evidence: { questionId: 'q', revision: 1, approved: true } } },
      { version: 5, event: { type: 'snapshot-created', snapshot } },
    ])).toThrow('no changed paths')
    const staged = transition(approved, { type: 'snapshot-created', snapshot: { ...snapshot, changedPaths: [] } })
    expect(staged.phase).toBe('Staged')
    expect(staged.snapshot?.changedPaths).toEqual([])
  })
  it('pauses verification-only Needs Changes without entering repair', () => {
    const verificationOnly = { ...brief, executionIntent: 'verification-only' as const }
    const approved = transition(transition(initialState(), { type: 'requirements-submitted', brief: verificationOnly }), { type: 'requirements-decided', evidence: { questionId: 'q', revision: 1, approved: true } })
    const staged = transition(approved, { type: 'snapshot-created', snapshot: { ...snapshot, changedPaths: [] } })
    const verifying = transition(staged, { type: 'verification-started', runId: 'verify' })
    const checked = transition(verifying, { type: 'verification-recorded', runId: 'verify', evidence: verification })
    const reviewing = transition(checked, { type: 'review-started', runId: 'review' })
    const paused = transition(reviewing, { type: 'review-finished', runId: 'review', result: { ...passed, outcome: 'Needs Changes', findings: [finding] }, elapsedMs: 0 })
    expect(paused.phase).toBe('Paused')
    expect(paused.pausedFrom).toBe('Staged')
    expect(paused.pauseReason).toContain('cannot repair')
  })
  it('rejects another run result and pauses new requirement uncertainty', () => {
    expect(() => transition(atEvent(3), { type: 'implementation-finished', runId: 'wrong', result: { outcome: 'Blocked', reason: 'No API' }, elapsedMs: 0 })).toThrow('another')
    const state = transition(atEvent(3), { type: 'implementation-finished', runId: 'worker-1', result: { outcome: 'Needs Clarification', questions: ['CSV or Excel?'], summary: 'Waiting' }, elapsedMs: 5 })
    expect(state.phase).toBe('Paused')
    expect(() => transition(state, { type: 'resumed' })).toThrow('newly approved brief')
    expect(transition(state, { type: 'requirements-submitted', brief: { ...brief, revision: 2 } }).phase).toBe('Awaiting Approval')
  })
  it('rejects mismatched snapshot and verification identities', () => {
    expect(() => transition(atEvent(4), { type: 'snapshot-created', snapshot: { ...snapshot, briefRevision: 2 } })).toThrow('stale')
    expect(() => transition(atEvent(5), { type: 'verification-recorded', evidence: { ...verification, treeId: 'c'.repeat(40) } })).toThrow('another')
  })
  it.each([
    { ...verification, checks: [] },
    { ...verification, checks: verification.checks.map(check => ({ ...check, exitCode: 1 })) },
    { ...verification, checks: verification.checks.map(check => ({ ...check, signal: 'SIGTERM' })) },
    { ...verification, checks: verification.checks.map(check => ({ ...check, timedOut: true })) },
    { ...verification, checks: verification.checks.map(check => ({ ...check, command: { executable: 'echo', args: [] } })) },
  ])('requires exact successful verification commands (%#)', evidence => {
    const state = { ...atEvent(5), verification: evidence }
    expect(() => transition(state, { type: 'review-started', runId: 'review' })).toThrow('checks')
  })
  it('does not permit repair concurrently with review', () => {
    expect(() => transition(atEvent(7), { type: 'implementation-started', runId: 'repair' })).toThrow()
  })
  it.each([{ ...passed, briefRevision: 2 }, { ...passed, snapshotId: 'stale' }, { ...passed, treeId: 'c'.repeat(40) }])('rejects stale review results (%#)', result => {
    expect(() => transition(atEvent(7), { type: 'review-finished', runId: 'review-1', result, elapsedMs: 0 })).toThrow('stale')
  })
  it('rejects Passed with blocking findings', () => {
    expect(() => transition(atEvent(7), { type: 'review-finished', runId: 'review-1', result: { ...passed, findings: [finding] }, elapsedMs: 0 })).toThrow('blocking')
  })
  it('pauses Inconclusive and cannot hand it off', () => {
    const state = transition(atEvent(7), { type: 'review-finished', runId: 'review-1', result: { ...passed, outcome: 'Inconclusive', reason: 'Validation unavailable' }, elapsedMs: 0 })
    expect(state.phase).toBe('Paused')
    expect(() => transition(state, handoff)).toThrow()
    expect(() => transition(state, { type: 'resumed' })).toThrow('newly approved brief')
  })
  it('repairs only evidenced findings and requires another review', () => {
    expect(() => transition(atEvent(7), { type: 'review-finished', runId: 'review-1', result: { ...passed, outcome: 'Needs Changes' }, elapsedMs: 0 })).toThrow('evidenced')
    const changed = transition(atEvent(7), { type: 'review-finished', runId: 'review-1', result: { ...passed, outcome: 'Needs Changes', findings: [finding] }, elapsedMs: 0 })
    const repairing = transition(changed, { type: 'implementation-started', runId: 'repair' })
    expect(repairing.repairRounds).toBe(1)
    expect(repairing.snapshot).toBeNull()
    expect(() => transition(repairing, handoff)).toThrow()
  })
  it('stops at repair and execution limits', () => {
    const changed = transition(atEvent(7), { type: 'review-finished', runId: 'review-1', result: { ...passed, outcome: 'Needs Changes', findings: [finding] }, elapsedMs: 0 })
    expect(() => transition({ ...changed, repairRounds: 2 }, { type: 'implementation-started', runId: 'repair' })).toThrow('limit')
    expect(() => transition({ ...atEvent(2), executionMs: brief.executionBudgetMs }, { type: 'implementation-started', runId: 'worker' })).toThrow('budget')
    const exhausted = transition(atEvent(7), { type: 'review-finished', runId: 'review-1', result: passed, elapsedMs: brief.executionBudgetMs })
    expect(exhausted.phase).toBe('Paused')
  })
  it('invalidates approval and review when requirements change', () => {
    const state = transition(atEvent(8), { type: 'requirements-submitted', brief: { ...brief, revision: 2 } })
    expect(state.approval).toBeNull()
    expect(state.review).toBeNull()
    expect(() => transition(state, handoff)).toThrow()
  })
  it('permits only matching handoff and makes completion terminal', () => {
    expect(() => transition(atEvent(8), { ...handoff, treeId: 'c'.repeat(40) })).toThrow('stale')
    const completed = transition(atEvent(8), handoff)
    expect(completed.phase).toBe('Completed')
    expect(() => transition(completed, { type: 'resumed' })).toThrow('terminal')
  })
  it('requires quiescence before pause/cancel and can record interruption', () => {
    expect(() => transition(atEvent(3), { type: 'paused', reason: 'pause' })).toThrow('termination')
    expect(() => transition(atEvent(3), { type: 'cancelled', reason: 'cancel' })).toThrow('termination')
    const interrupted = transition(atEvent(3), { type: 'role-interrupted', runId: 'worker-1', reason: 'Process ended', elapsedMs: 10 })
    expect(interrupted.activeRunId).toBeNull()
    expect(interrupted.phase).toBe('Paused')
    expect(transition(interrupted, { type: 'resumed' }).phase).toBe('Approved')
  })
})

describe('explicit recovery decisions', () => {
  it.each([atEvent(3), transition(atEvent(5), { type: 'verification-started', runId: 'checks-1' }), atEvent(7)])('charges unknown interrupted runtime and cannot infer successful output', state => {
    const decision = { type: 'recovery-decided' as const, questionId: 'human-question', runId: state.activeRunId, action: 'recover-interrupted' as const, elapsedMs: brief.executionBudgetMs - state.executionMs }
    expect(() => transition(state, { ...decision, elapsedMs: 0 })).toThrow('remaining approved budget')
    expect(() => transition(state, { ...decision, runId: 'another-run' })).toThrow('another run')
    const paused = transition(state, decision)
    expect(paused.phase).toBe('Paused')
    expect(paused.activeRunId).toBeNull()
    expect(paused.executionMs).toBe(brief.executionBudgetMs)
    expect(() => transition(paused, { type: 'resumed' })).toThrow('budget')
    const revised = transition(paused, { type: 'requirements-submitted', brief: { ...brief, revision: 2, executionBudgetMs: brief.executionBudgetMs + 1000 } })
    expect(revised.executionMs).toBe(paused.executionMs)
    expect(revised.approval).toBeNull()
  })
  it('leaves an unconfirmed interrupted activity unresolved', () => {
    const state = atEvent(3)
    expect(transition(state, { type: 'recovery-decided', questionId: 'human-question', runId: state.activeRunId, action: 'leave-paused', elapsedMs: 0 })).toEqual(state)
    expect(() => transition(state, { type: 'cancelled', reason: 'old process might still run' })).toThrow('termination')
  })
  it('requires revision for uncertainty and preserves consumed time on revision', () => {
    const paused = transition(atEvent(7), { type: 'review-finished', runId: 'review-1', result: { ...passed, outcome: 'Inconclusive', reason: 'Scope unclear' }, elapsedMs: 1 })
    expect(() => transition(paused, { type: 'recovery-decided', questionId: 'human-question', runId: null, action: 'retry', elapsedMs: 0 })).toThrow('newly approved')
    const clarifying = transition(paused, { type: 'recovery-decided', questionId: 'human-question', runId: null, action: 'revise', elapsedMs: 0 })
    expect(clarifying.phase).toBe('Clarifying')
    expect(clarifying.approval).toBeNull()
    expect(clarifying.executionMs).toBe(paused.executionMs)
  })
})

describe('durable verification activity', () => {
  it('requires matching active verification and counts complete runtime', () => {
    const running = transition(atEvent(5), { type: 'verification-started', runId: 'checks-1' })
    expect(running.phase).toBe('Verifying')
    expect(() => transition(running, { type: 'verification-recorded', runId: 'checks-other', evidence: verification })).toThrow('another run')
    expect(() => transition(running, { type: 'verification-recorded', runId: 'checks-1', evidence: verification, elapsedMs: 0 })).toThrow('excludes')
    const finished = transition(running, { type: 'verification-recorded', runId: 'checks-1', evidence: verification, elapsedMs: 12 })
    expect(finished.executionMs).toBe(running.executionMs + 12)
    expect(finished.activeRunId).toBeNull()
    expect(finished.phase).toBe('Staged')
  })
  it('makes interrupted verification resumable only from a quiescent staged phase', () => {
    const running = transition(atEvent(5), { type: 'verification-started', runId: 'checks-1' })
    expect(() => transition(running, { type: 'paused', reason: 'stop' })).toThrow('termination')
    const interrupted = transition(running, { type: 'role-interrupted', runId: 'checks-1', reason: 'lost host', elapsedMs: 10 })
    expect(interrupted.pausedFrom).toBe('Staged')
    expect(transition(interrupted, { type: 'resumed' }).phase).toBe('Staged')
  })
})

describe('durable input and commit ordering', () => {
  it('rejects unsupported records, malformed model input, and forged order', () => {
    expect(() => recordSchema.parse({ version: 9, event: readyEvents()[0] })).toThrow()
    expect(() => briefSchema.parse({ ...brief, approved: true })).toThrow()
    expect(() => replay([{ version: 1, event: { type: 'implementation-started', runId: 'forged' } }])).toThrow()
  })
  it('restores approved and passed states from authoritative facts', () => {
    expect(replay(readyEvents().map(event => ({ version: 1, event })))).toEqual(atEvent(8))
  })
  it('does not publish state when durable append fails', async () => {
    const controller = new WorkflowController(async () => { throw new Error('Disk unavailable') })
    await expect(controller.apply(readyEvents()[0]!)).rejects.toThrow('Disk')
    expect(controller.state).toEqual(initialState())
  })
  it('rejects overlapping mutation and prevents caller mutation of state', async () => {
    const pending = Promise.withResolvers<void>()
    const controller = new WorkflowController(() => pending.promise)
    const first = controller.apply(readyEvents()[0]!)
    await expect(controller.apply(readyEvents()[0]!)).rejects.toThrow('progress')
    expect(controller.state.phase).toBe('Clarifying')
    pending.resolve()
    await first
    const copy = controller.state
    copy.phase = 'Completed'
    expect(controller.state.phase).toBe('Awaiting Approval')
  })
})
