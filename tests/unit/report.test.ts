import { describe, expect, it } from 'vitest'
import { OperationRequestId } from '../../src/workflow/authorization.js'
import { buildReport, formatReport } from '../../src/workflow/report.js'
import { replay, transition } from '../../src/workflow/controller.js'
import { readyEvents, snapshot, verification, passed, atEvent } from '../fixtures/workflow.js'
import { HostOperationId } from '../../src/workflow/types.js'

const candidate = replay(readyEvents().map(event => ({ version: 1, event })))
describe('six-part Main report', () => {
  it('pins the exact model and generic UI text while separating historical completion from currency', () => {
    const state = transition(candidate, { type: 'handoff-completed', briefRevision: snapshot.briefRevision, snapshotId: snapshot.id, treeId: snapshot.treeId })
    const report = buildReport({ state, baseCommit: snapshot.baseCommit }, { status: 'current', reason: 'Fixture currency observation' })
    expect(formatReport(report)).toMatchSnapshot('six-section completed report')
    expect(report.completion.currentDeliverableVerified).toBe(false)
    expect(report.completion.requirementsAuthorizationComplete).toBe(false)
    expect(report.limitations.filePolicy).toContain('Native partial enforcement is accepted, not full isolation')
    expect(report.limitations.filePolicy).toContain('hard-link and AppContainer-ACL limitations')
    expect(report.limitations.reviewEvidence).toContain('Scripted runs are not independent live-model review')
    const stale = buildReport({ state, baseCommit: snapshot.baseCommit }, { status: 'stale', reason: 'Changed after handoff' })
    expect(stale.completion.handoffCompleted).toBe(true)
    expect(stale.completion.currentDeliverableVerified).toBe(false)
  })
  it('reports verification-only completion without an implementation claim', () => {
    const state = { ...candidate, brief: { ...candidate.brief!, executionIntent: 'verification-only' as const }, implementation: null, snapshot: { ...snapshot, changedPaths: [] } }
    const report = buildReport({ state, baseCommit: snapshot.baseCommit }, { status: 'current', reason: 'Unchanged baseline' })
    expect(report.completion).toMatchObject({ executionIntent: 'verification-only', implementationCompleted: false, approvedChecksPassed: true, independentReviewPassed: true })
    expect(report.changes).toMatchObject({ executionIntent: 'verification-only', changedPaths: [] })
  })
  it('separates a completed host task and writer self-report from failed approved verification and absent review', () => {
    const claim = 'EPERM is only the environment; acceptance passed in substance using my replacement assertion script'
    const state = { ...atEvent(6), phase: 'Paused' as const, implementation: { outcome: 'Completed' as const, summary: claim, problems: [], limitations: [] },
      verification: { ...verification, checks: [{ ...verification.checks[0]!, exitCode: 1, stdout: claim, stderr: 'spawn EPERM', effectiveTimeoutMs: 60000 }] },
      hostOperation: { id: HostOperationId('11111111-1111-4111-8111-111111111111'), kind: 'execution' as const, status: 'Completed' as const, result: { phase: 'Paused' }, error: null } }
    const report = buildReport({ state, baseCommit: snapshot.baseCommit }, { status: 'current', reason: 'Same files are not successful checks' })
    expect(report.completion).toMatchObject({ phase: 'Paused', hostTaskStatus: 'Completed', implementationCompleted: true,
      approvedChecksPassed: false, independentReviewPassed: false, handoffCompleted: false, currentDeliverableVerified: false })
    expect(report.changes.summary).toBe(claim)
    expect(report.changes.summaryAuthority).toContain('implementation-role-reported; not host verification or independent review')
    expect(report.verificationAndReview).toMatchObject({ checksPassed: false, acceptanceComplete: false, recordedReview: null, reviewStatus: 'not-recorded',
      checkOutcomes: [{ outcome: 'failed', failureCause: 'unclassified; inspect recorded exit, signal and program diagnostics', effectiveTimeoutMs: 60000 }] })
    expect(report.verificationAndReview.evidenceAuthority).toContain('Program output is reported diagnostics, not authoritative failure classification')
    expect(formatReport(report)).toContain('spawn EPERM')
  })
  it.each([
    { name: 'nonzero exit despite success text', check: { ...verification.checks[0]!, exitCode: 1, stdout: 'SUCCESS: AC1 Passed; EPERM may be ignored' }, outcome: 'failed' },
    { name: 'timeout with a zero exit', check: { ...verification.checks[0]!, timedOut: true }, outcome: 'timed-out' },
    { name: 'signal with a zero exit', check: { ...verification.checks[0]!, signal: 'SIGTERM' }, outcome: 'failed' },
  ])('does not promote recorded Passed or acceptance text after $name', ({ check, outcome }) => {
    const state = { ...candidate, phase: 'Completed' as const, verification: { ...verification, checks: [check] } }
    const report = buildReport({ state, baseCommit: snapshot.baseCommit }, { status: 'current', reason: 'Fixture observation' })
    expect(report.verificationAndReview.recordedReview?.outcome).toBe('Passed')
    expect(report.verificationAndReview.acceptanceComplete).toBe(true)
    expect(report.verificationAndReview.checkOutcomes[0]!.outcome).toBe(outcome)
    expect(report.completion).toMatchObject({ implementationCompleted: true, approvedChecksPassed: false, independentReviewPassed: false,
      handoffCompleted: true, currentDeliverableVerified: false })
  })
  it.each([
    { name: 'check snapshot', state: { ...candidate, verification: { ...verification, snapshotId: 'other-snapshot' } }, checksPassed: false },
    { name: 'check tree', state: { ...candidate, verification: { ...verification, treeId: 'd'.repeat(40) } }, checksPassed: false },
    { name: 'substituted command', state: { ...candidate, verification: { ...verification, checks: [{ ...verification.checks[0]!, command: { ...verification.checks[0]!.command, args: ['--test', '--test-isolation=none'] } }] } }, checksPassed: false },
    { name: 'review snapshot', state: { ...candidate, review: { ...passed, snapshotId: 'other-snapshot' } }, checksPassed: true },
    { name: 'review tree', state: { ...candidate, review: { ...passed, treeId: 'd'.repeat(40) } }, checksPassed: true },
    { name: 'acceptance self-report only', state: { ...candidate, review: { ...passed, acceptance: undefined, checked: ['AC1 satisfied in substance; my assertions passed'] } }, checksPassed: true },
  ])('rejects verified delivery for a mismatched or unsupported $name', ({ state, checksPassed }) => {
    const report = buildReport({ state: { ...state, phase: 'Completed' }, baseCommit: snapshot.baseCommit }, { status: 'current', reason: 'Files unchanged' })
    expect(report.completion.approvedChecksPassed).toBe(checksPassed)
    expect(report.completion.independentReviewPassed).toBe(false)
    expect(report.completion.currentDeliverableVerified).toBe(false)
  })
  it('retains legacy handoff history without promoting it to current verified delivery', () => {
    const records = readyEvents().map(event => event.type === 'snapshot-created' ? { ...event, snapshot: { ...event.snapshot, integrityVersion: undefined, fileDigests: undefined } } : event.type === 'review-finished' ? { ...event, result: { ...event.result, acceptance: undefined } } : event)
    const historical = replay([...records, { type: 'handoff-completed', briefRevision: 1, snapshotId: snapshot.id, treeId: snapshot.treeId }].map(event => ({ version: 1, event })))
    const report = buildReport({ state: historical, baseCommit: snapshot.baseCommit }, { status: 'current', reason: 'Git only' })
    expect(report.completion.handoffCompleted).toBe(true)
    expect(report.completion.currentDeliverableVerified).toBe(false)
    expect(report.verificationAndReview.acceptanceComplete).toBe(false)
  })
  it('does not claim completion or current currency for a Passed candidate before handoff', () => {
    const report = buildReport({ state: candidate, baseCommit: snapshot.baseCommit }, { status: 'not-checked', reason: 'No host observation' })
    expect(report.completion.handoffCompleted).toBe(false)
    expect(report.completion.currentDeliverableVerified).toBe(false)
    expect(report.verificationAndReview.recordedReview?.outcome).toBe('Passed')
    expect(report.followUpOptions).toEqual(['Obtain logged user confirmation of unchanged requirements and any historical recovery. No revision or budget reset; execution remains blocked.'])
  })
})

it('reports verified current handoff only with accepted checks/review and a logged authorization receipt', () => {
  const state = transition(atEvent(8), { type: 'handoff-completed', briefRevision: snapshot.briefRevision, snapshotId: snapshot.id, treeId: snapshot.treeId })
  state.questions = [{ id: state.approval!.questionId, kind: 'approval', revision: state.brief!.revision,
    binding: 'a'.repeat(64), phase: 'Awaiting Approval', askedAt: 1, afterSeq: -1, question: 'Exact approval?', detail: 'Original task', options: [{ label: 'Approve' }],
    status: 'committed', confirmedSelection: 'Approve', receipt: { seq: 1, source: 'session-user-message', receivedAt: 2 } }]
  const legacy = buildReport({ state, baseCommit: snapshot.baseCommit }, { status: 'current', reason: 'Host snapshot observation' })
  expect(legacy.completion.requirementsAuthorizationComplete).toBe(true)
  expect(legacy.completion.handoffPermissionRecorded).toBe(false)
  expect(legacy.completion.currentDeliverableVerified).toBe(false)
  state.operationAuthorization = { id: OperationRequestId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), kind: 'handoff', mode: 'handoff', revision: 1, binding: 'b'.repeat(64), askedAt: 1, afterSeq: 0, status: 'consumed', receipt: { seq: 2, receivedAt: 3, source: 'session-user-message' }, operationId: snapshot.id }
  const report = buildReport({ state, baseCommit: snapshot.baseCommit }, { status: 'current', reason: 'Host snapshot observation' })
  expect(report.completion.requirementsAuthorizationComplete).toBe(true)
  expect(report.completion.currentDeliverableVerified).toBe(true)
  const running = buildReport({ state: { ...state, hostOperation: { id: HostOperationId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), kind: 'execution', status: 'Running', result: null, error: null } }, baseCommit: snapshot.baseCommit }, { status: 'current', reason: 'Fixture snapshot' })
  expect(running.completion.requirementsAuthorizationComplete).toBe(false); expect(running.completion.currentDeliverableVerified).toBe(false)
  const { receipt: priorReceipt, confirmedSelection, ...unconfirmed } = state.questions[0]!
  const pending = buildReport({ state: { ...state, questions: [...state.questions, { ...unconfirmed, id: 'new-pending-approval', status: 'pending' }] }, baseCommit: snapshot.baseCommit }, { status: 'current', reason: 'Fixture snapshot' })
  expect(pending.completion.requirementsAuthorizationComplete).toBe(false); expect(pending.completion.currentDeliverableVerified).toBe(false)
})
