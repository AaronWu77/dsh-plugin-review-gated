import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import { initialState, replay, transition, WorkflowController } from '../../src/workflow/controller.js'
import { recordSchema } from '../../src/workflow/types.js'
import type { WorkflowRecord, WorkflowState } from '../../src/workflow/types.js'
import { askDecisionQuestion, confirmationReceipt, confirmationSchema, questionBinding, questionSchema, requireDecisionReceipts } from '../../src/workflow/questions.js'
import type { DecisionQuestion } from '../../src/workflow/questions.js'
import { journalSchema } from '../../src/storage/journal.js'
import { decisionEvidence } from '../../src/workflow/decision-evidence.js'
import { atEvent, brief, readyEvents, snapshot } from '../fixtures/workflow.js'

const input = { question: 'Approve unchanged requirements?', detail: 'Revision 1, exact scope and budget.', options: [{ label: 'Approve' }, { label: 'Revise' }] }
const receipt = { seq: 1, source: 'session-user-message' as const, receivedAt: 10 }
function question(state = atEvent(1), id = 'decision-1', kind: DecisionQuestion['kind'] = 'approval'): DecisionQuestion {
  return { id, kind, revision: 1, binding: questionBinding(state), phase: state.phase, askedAt: 1, afterSeq: -1, ...input, status: 'pending' }
}
function returned(state = atEvent(1), q = question(state)): WorkflowState {
  return transition(transition(state, { type: 'question-opened', question: q }), { type: 'question-returned', questionId: q.id,
    serviceAnswer: { selected: 'Approve', source: 'user-questions-service-unattributed', receivedAt: 2 } })
}
function human(session: Session, text: string) {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}
const exact = (id = 'decision-1', selected = 'Approve') => JSON.stringify({ reviewGatedAnswer: { questionId: id, selected } })
const detached = () => Session.create(SessionId(randomUUID()))
const records = () => [{ version: 3 as const, event: readyEvents()[0]! }]

// The scripted question service supplies nondeterministic input, not real-human authentication.
describe('durable decision questions', () => {
  it('writes v8 questions while a service answer leaves approval and phase unchanged', async () => {
    const appended: WorkflowRecord[] = [], controller = new WorkflowController(async record => { appended.push(record) }, records())
    const session = detached(), before = controller.state
    const ask = vi.fn(async (q: { id: string }) => ({ answers: [{ id: q.id, selected: ['Approve'] }] }))
    const q = await askDecisionQuestion(controller, session, 'approval', input, ask, new AbortController().signal)
    expect(q).toMatchObject({ status: 'service-returned', serviceAnswer: { selected: 'Approve', source: 'user-questions-service-unattributed' } })
    expect(controller.state).toEqual({ ...before, questions: [q] })
    expect(appended.map(record => [record.version, record.event.type])).toEqual([[8, 'question-opened'], [8, 'question-returned']])
    expect(ask.mock.calls[0]![0]).toMatchObject({ id: q.id, multiSelect: false })
    expect(ask.mock.calls[0]![0]).toHaveProperty('detail', expect.stringContaining(q.id))
    expect(() => requireDecisionReceipts(controller.state, null)).toThrow('logged user confirmation')
  })

  it.each(['missing', 'wrong-id', 'duplicate-id', 'multiple', 'unknown', 'custom', 'natural-language'])('audits invalid service choices without guessing (%s)', async kind => {
    const controller = new WorkflowController(async () => {}, records())
    await expect(askDecisionQuestion(controller, detached(), 'approval', input, async q => {
      const item = { id: q.id, selected: ['Approve'] }
      const answer: AskUserQuestionAnswer = { answers: [item] }
      if (kind === 'missing') answer.answers = []
      if (kind === 'wrong-id') item.id = 'another-question'
      if (kind === 'duplicate-id') answer.answers.push({ ...item })
      if (kind === 'multiple') item.selected = ['Approve', 'Revise']
      if (kind === 'unknown') item.selected = ['Approve (Recommended)']
      if (kind === 'custom') answer.answers = [{ ...item, custom: 'I approve' }]
      if (kind === 'natural-language') item.selected = ['yes, go ahead']
      return answer
    }, new AbortController().signal)).rejects.toThrow('one exact current option')
    expect(controller.state).toMatchObject({ phase: 'Awaiting Approval', approval: null, questions: [{ status: 'failed', failure: expect.stringContaining('no decision committed') }] })
  })

  it('logs cancellation when a delayed answer arrives after abort and never approves', async () => {
    const controller = new WorkflowController(async () => {}, records()), signal = new AbortController()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const pending = askDecisionQuestion(controller, detached(), 'approval', input, async q => {
      entered.resolve(); await release.promise; return { answers: [{ id: q.id, selected: ['Approve'] }] }
    }, signal.signal)
    const rejected = expect(pending).rejects.toThrow('cancelled by test')
    await entered.promise
    signal.abort(new Error('cancelled by test')); release.resolve()
    await rejected
    expect(controller.state.questions).toMatchObject([{ status: 'failed', failure: 'Question cancelled; no decision committed' }])
    expect(controller.state.approval).toBeNull()
  })

  it('does not call the service or append when already cancelled', async () => {
    const append = vi.fn(async () => {}), ask = vi.fn(async () => ({ answers: [] })), signal = new AbortController()
    signal.abort(new Error('already cancelled'))
    await expect(askDecisionQuestion(new WorkflowController(append, records()), detached(), 'approval', input, ask, signal.signal)).rejects.toThrow('already cancelled')
    expect(append).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled()
  })

  it('keeps the pending record when returned/failure appends cannot commit', async () => {
    const appended: WorkflowRecord[] = []
    const controller = new WorkflowController(async record => {
      if (record.event.type !== 'question-opened') throw new Error('append unavailable')
      appended.push(record)
    }, records())
    await expect(askDecisionQuestion(controller, detached(), 'approval', input, async q => ({ answers: [{ id: q.id, selected: ['Approve'] }] }), new AbortController().signal)).rejects.toThrow('failure record could not be saved')
    expect(appended).toHaveLength(1)
    expect(controller.state.questions).toMatchObject([{ status: 'pending' }])
    expect(controller.state.approval).toBeNull()
  })

  it('publishes only after append and rejects concurrent mutations', async () => {
    const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const controller = new WorkflowController(async () => { entered.resolve(); await release.promise }, records())
    const before = controller.state, q = question(before)
    const pending = controller.apply({ type: 'question-opened', question: q })
    await entered.promise
    try {
      expect(controller.state).toEqual(before)
      await expect(controller.apply({ type: 'question-opened', question: question(before, 'conflict') })).rejects.toThrow('already in progress')
    } finally { release.resolve(); await pending }
    expect(controller.state.questions).toEqual([q])
  })

  it('rejects duplicate questions and duplicate or conflicting confirmed receipts', () => {
    const q = question(), state = returned()
    expect(() => transition(state, { type: 'question-opened', question: q })).toThrow()
    const committed = transition(state, { type: 'question-confirmed', questionId: q.id, selected: 'Approve', receipt })
    expect(committed).toMatchObject({ phase: 'Approved', approval: { questionId: q.id, revision: 1, approved: true }, questions: [{ status: 'committed', receipt }] })
    for (const selected of ['Approve', 'Revise']) expect(() => transition(committed, { type: 'question-confirmed', questionId: q.id, selected, receipt })).toThrow('uncommitted decision')
  })

  it('records a later exact user choice independently from an unattributed service choice', () => {
    const committed = transition(returned(), { type: 'question-confirmed', questionId: 'decision-1', selected: 'Revise', receipt })
    expect(committed).toMatchObject({ phase: 'Clarifying', approval: { approved: false }, questions: [{ serviceAnswer: { selected: 'Approve' }, confirmedSelection: 'Revise' }] })
  })

  it.each(['phase', 'brief', 'snapshot', 'executionMs', 'executionWallMs', 'repairRounds', 'executionWindow'])('rejects stale bound state (%s)', field => {
    const state = returned(), changed = { ...state }
    if (field === 'phase') changed.phase = 'Approved'
    if (field === 'brief') changed.brief = { ...brief, goal: 'Expanded scope' }
    if (field === 'snapshot') changed.snapshot = snapshot
    if (field === 'executionMs') changed.executionMs = 1
    if (field === 'executionWallMs') changed.executionWallMs = 1
    if (field === 'repairRounds') changed.repairRounds = 1
    if (field === 'executionWindow') changed.executionWindow = { id: 'active-attempt' }
    expect(questionBinding(changed)).not.toBe(questionBinding(state))
    expect(() => transition(changed, { type: 'question-confirmed', questionId: 'decision-1', selected: 'Approve', receipt })).toThrow('current uncommitted decision')
  })

  it.each([2, 5])('confirms unchanged historical Approved/Staged state without resetting scope or runtime (%s)', count => {
    const historical = atEvent(count), q = question(historical)
    const state = transition(returned(historical, q), { type: 'question-confirmed', questionId: q.id, selected: 'Approve', receipt })
    expect(state).toEqual({ ...historical, approval: { questionId: q.id, revision: 1, approved: true }, questions: [expect.objectContaining({ status: 'committed' })] })
    expect(() => requireDecisionReceipts(state, null)).not.toThrow()
  })

  it('requires both approval and recovery receipts and denies any unresolved question', () => {
    const approval = transition(returned(), { type: 'question-confirmed', questionId: 'decision-1', selected: 'Approve', receipt })
    expect(() => requireDecisionReceipts(atEvent(2), null)).toThrow('approval')
    expect(() => requireDecisionReceipts(approval, 'missing-recovery')).toThrow('recovery')
    const recovery = { ...question(approval, 'recovery-1', 'recovery'), status: 'committed' as const, receipt }
    const complete = { ...approval, questions: [...approval.questions!, recovery] }
    expect(() => requireDecisionReceipts(complete, recovery.id)).not.toThrow()
    expect(() => requireDecisionReceipts({ ...complete, questions: [...complete.questions, question(complete, 'pending')] }, recovery.id)).toThrow('awaits explicit')
  })
})

describe('exact public Session user receipts', () => {
  it('accepts only the exact later user message and keeps its recorded sequence/time', () => {
    const session = detached(), q = question(), event = human(session, exact())
    expect(confirmationReceipt(session, q, event.seq)).toEqual({ selected: 'Approve', receipt: { seq: event.seq, source: 'session-user-message', receivedAt: event.time } })
    expect(() => confirmationReceipt(session, { ...q, afterSeq: event.seq }, event.seq)).toThrow('new logged user')
    expect(() => confirmationReceipt(detached(), q, event.seq)).toThrow('this Main session')
    expect(() => confirmationReceipt(session, q, event.seq + 100)).toThrow()
  })

  it.each(['yes', 'Approve', 'Please proceed', exact('wrong-id'), exact('decision-1', 'approve'), JSON.stringify({ reviewGatedAnswer: { questionId: 'decision-1', selected: 'Approve', explanation: 'yes' } }), JSON.stringify({ reviewGatedAnswer: { questionId: 'decision-1', selected: 'Approve' }, extra: true })])('never guesses approval from other text (%s)', text => {
    const session = detached(), event = human(session, text)
    expect(() => confirmationReceipt(session, question(), event.seq)).toThrow()
  })

  it('rejects injected model/system-prompt user-role messages even with exact JSON', () => {
    for (const source of [{ kind: 'system-prompt' as const }, { kind: 'model' as const, provider: 'scripted', model: 'not-human' }]) {
      const session = detached(), event = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: exact() }], source }), { surfaceOp: 'append' })
      expect(() => confirmationReceipt(session, question(), event.seq)).toThrow('logged user message')
    }
  })

  it('rejects non-message events and mixed nontext content', () => {
    const session = detached(), event = session.append('session/end-seed', {})
    expect(() => confirmationReceipt(session, question(), event.seq)).toThrow('logged user message')
    const image = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: exact() }, { type: 'reasoning', text: 'not a user choice' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect(() => confirmationReceipt(session, question(), image.seq)).toThrow('exact JSON text')
  })

  it('bounds identifiers and rejects unknown confirmation/receipt sources at parsing', () => {
    expect(confirmationSchema.parse(JSON.parse(exact('x'.repeat(256))))).toBeDefined()
    expect(() => confirmationSchema.parse(JSON.parse(exact('x'.repeat(257))))).toThrow()
    for (const patch of [{ afterSeq: -2 }, { receipt: { ...receipt, seq: -1 } }, { receipt: { ...receipt, source: 'tool' } }, { id: 'x'.repeat(257) }, { options: [] }]) expect(() => questionSchema.parse({ ...question(), ...patch })).toThrow()
  })
})

describe('released workflow journal reads and v8 writes', () => {
  it.each([1, 2, 3, 'mixed'] as const)('reads complete historical lifecycle unchanged (%s)', version => {
    const history = [...readyEvents(), { type: 'handoff-completed' as const, snapshotId: snapshot.id, treeId: snapshot.treeId, briefRevision: 1 }]
    const old = history.map((event, index) => ({ version: version === 'mixed' ? index < 2 ? 1 : index < 6 ? 2 : 3 : version, event }))
    const before = JSON.stringify(old), state = replay(old)
    expect(state.phase).toBe('Completed')
    expect(Object.hasOwn(state, 'questions')).toBe(false)
    const journal = { version: 1, sessionId: SessionId('historical'), cwd: snapshot.repository, createdAt: 0, baseCommit: snapshot.baseCommit, repository: snapshot.repository, records: old, state }
    expect(journalSchema.parse(journal)).toEqual(journal)
    expect(JSON.stringify(old)).toBe(before)
  })

  it('appends v8 to older history, rejects generation regression and forbids question events in v1/2/3', async () => {
    const old = records(), appended: WorkflowRecord[] = [], controller = new WorkflowController(async record => { appended.push(record) }, old)
    await controller.apply({ type: 'question-opened', question: question() })
    expect(appended[0]!.version).toBe(8)
    expect(replay([...old, ...appended])).toEqual(controller.state)
    for (const version of [1, 2, 3]) expect(() => recordSchema.parse({ version, event: appended[0]!.event })).toThrow()
    expect(() => replay([...old, ...appended, { version: 3, event: { type: 'paused', reason: 'regressed' } }])).toThrow('cannot regress')
    expect(() => recordSchema.parse({ version: 9, event: readyEvents()[0] })).toThrow()
    expect(initialState()).not.toHaveProperty('questions')
  })
})
describe('question source visibility and interrupted waits', () => {
  it('advertises only a matching latest user confirmation sequence', () => {
    const session = detached(), state = returned(), q = state.questions![0]!
    expect(decisionEvidence(state, [], session).pending[0]!.availableUserConfirmation).toBeNull()
    const event = human(session, exact(q.id))
    expect(decisionEvidence(state, [], session).pending[0]!.availableUserConfirmation).toEqual({ userMessageSeq: event.seq, selected: 'Approve' })
    human(session, 'Unrelated later user input')
    expect(decisionEvidence(state, [], session).pending[0]!.availableUserConfirmation).toBeNull()
  })
  it('reuses a returned current question without calling the service again', async () => {
    const controller = new WorkflowController(async () => {}, records()), session = detached()
    const ask = vi.fn(async (q: { id: string }) => ({ answers: [{ id: q.id, selected: ['Approve'] }] }))
    const first = await askDecisionQuestion(controller, session, 'approval', input, ask, new AbortController().signal)
    const second = await askDecisionQuestion(controller, session, 'approval', input, ask, new AbortController().signal)
    expect(second).toEqual(first); expect(ask).toHaveBeenCalledTimes(1)
  })
  it('replaces an interrupted pending question only on a new explicit request', async () => {
    const controller = new WorkflowController(async () => {}, records()), session = detached()
    await controller.apply({ type: 'question-opened', question: question(controller.state) })
    const q = await askDecisionQuestion(controller, session, 'approval', input, async item => ({ answers: [{ id: item.id, selected: ['Approve'] }] }), new AbortController().signal)
    expect(q.id).not.toBe('decision-1'); expect(controller.state.phase).toBe('Awaiting Approval'); expect(controller.state.approval).toBeNull()
  })
  it('records and confirms orphan diagnostic host quiescence even without a requirements brief', async () => {
    const controller = new WorkflowController(async () => {})
    const operation = { id: randomUUID(), kind: 'diagnostic' as const, status: 'Running' as const, result: null, error: null }
    const { HostOperationId } = await import('../../src/workflow/types.js')
    await controller.apply({ type: 'host-operation-started', operation: { ...operation, id: HostOperationId(operation.id) } })
    const session = detached(), q = await askDecisionQuestion(controller, session, 'host-recovery', { question: 'Stopped?', detail: 'No inferred result', options: [{ label: 'Confirm previous processes stopped' }, { label: 'Leave unresolved' }] },
      async item => ({ answers: [{ id: item.id, selected: ['Confirm previous processes stopped'] }] }), new AbortController().signal)
    expect(controller.state.hostOperation?.status).toBe('Running')
    const event = human(session, exact(q.id, 'Confirm previous processes stopped'))
    await controller.apply({ type: 'question-confirmed', questionId: q.id, ...confirmationReceipt(session, q, event.seq) })
    expect(controller.state.hostOperation?.status).toBe('Interrupted'); expect(controller.state.brief).toBeNull(); expect(controller.state.executionMs).toBe(0)
  })
  it('keeps rejected Review format evidence separate from review completion', () => {
    const state = atEvent(7)
    const failure = { role: 'review' as const, runId: state.activeRunId!, kind: 'schema-validation' as const, issueCount: 1,
      issues: [{ code: 'unrecognized_keys', path: [], message: 'Unrecognized key: "$schema"' }], logReference: { sessionId: state.activeRunId! } }
    const rejected = transition(state, { type: 'role-result-rejected', failure })
    expect(rejected.review).toBeNull(); expect(rejected.roleFailures).toEqual([failure])
    expect(() => recordSchema.parse({ version: 3, event: { type: 'role-result-rejected', failure } })).toThrow()
    expect(() => transition(state, { type: 'role-result-rejected', failure: { ...failure, runId: 'another-run' } })).toThrow()
  })
})

it('cannot choose an older favorable confirmation after a newer user message', () => {
  const session = detached(), state = returned(), q = state.questions![0]!, first = human(session, exact(q.id))
  human(session, 'Do not proceed')
  expect(() => confirmationReceipt(session, q, first.seq)).toThrow('logged user message')
})

it('does not expose a Staged retry after exhausting the same cumulative budget', () => {
  const state = { ...atEvent(5), executionWallMs: brief.executionBudgetMs }, q = { ...question(state, 'exhausted-retry', 'recovery'), options: [{ label: 'Retry unchanged approved brief' }] }
  const pending = transition(transition(state, { type: 'question-opened', question: q }), { type: 'question-returned', questionId: q.id, serviceAnswer: { selected: q.options[0]!.label, source: 'user-questions-service-unattributed', receivedAt: 2 } })
  expect(() => transition(pending, { type: 'question-confirmed', questionId: q.id, selected: q.options[0]!.label, receipt })).toThrow('budget')
})

it('persists Diagnostic schema failure without inventing Review or approval', async () => {
  const { HostOperationId } = await import('../../src/workflow/types.js'), controller = new WorkflowController(async () => {})
  await controller.apply({ type: 'host-operation-started', operation: { id: HostOperationId(randomUUID()), kind: 'diagnostic', status: 'Running', result: null, error: null } })
  const failure = { role: 'diagnostic' as const, runId: 'diagnostic-role-session', kind: 'schema-validation' as const, issueCount: 1,
    issues: [{ code: 'unrecognized_keys', path: [], message: 'Unknown result metadata' }], logReference: { sessionId: 'diagnostic-role-session' } }
  await controller.apply({ type: 'role-result-rejected', failure })
  expect(controller.state.phase).toBe('Clarifying'); expect(controller.state.review).toBeNull(); expect(controller.state.approval).toBeNull()
  expect(controller.state.roleFailures).toEqual([failure]); expect(controller.state.hostOperation?.status).toBe('Running')
})

it('invalidates decision binding when displayed implementation/check/review evidence changes', () => {
  const state = atEvent(5), digest = questionBinding(state)
  expect(questionBinding({ ...state, implementation: { outcome: 'Completed', summary: 'Changed candidate account', problems: [], limitations: [] } })).not.toBe(digest)
  expect(questionBinding({ ...state, verification: { snapshotId: snapshot.id, treeId: snapshot.treeId, checks: [] } })).not.toBe(digest)
  expect(questionBinding({ ...state, review: { outcome: 'Inconclusive', briefRevision: brief.revision, snapshotId: snapshot.id, treeId: snapshot.treeId, findings: [], checked: [], unchecked: ['AC1'], reason: 'No conclusion', acceptance: [] } })).not.toBe(digest)
})

it('keeps the accepted current receipt through failed re-questioning and bounds same-kind summaries', () => {
  let state = transition(returned(), { type: 'question-confirmed', questionId: 'decision-1', selected: 'Approve', receipt })
  for (let index = 0; index < 12; index++) {
    const q = question(state, 'approval-repeat-' + index), pending = transition(state, { type: 'question-opened', question: q })
    expect(() => requireDecisionReceipts(pending, null)).toThrow()
    const failed = transition(pending, { type: 'question-failed', questionId: q.id, reason: 'Cancelled; no new decision' })
    expect(() => requireDecisionReceipts(failed, null)).not.toThrow()
    expect(decisionEvidence(failed).approval).toMatchObject({ status: 'committed', receipt: { source: 'session-user-message' } })
    const next = question(failed, 'approval-confirm-' + index)
    state = transition(returned(failed, next), { type: 'question-confirmed', questionId: next.id, selected: 'Approve', receipt: { ...receipt, seq: index + 2 } })
    expect(state.questions).toHaveLength(1)
  }
})

it.each(['Revise requirements', 'Leave paused'])('commits the offered inactive Staged choice %s without execution or budget reset', selected => {
  const state = { ...atEvent(5), executionMs: 123, executionWallMs: 321, repairRounds: 1 }, q = { ...question(state, 'staged-choice', 'recovery'), options: [{ label: selected }] }
  const pending = transition(transition(state, { type: 'question-opened', question: q }), { type: 'question-returned', questionId: q.id, serviceAnswer: { selected, source: 'user-questions-service-unattributed', receivedAt: 2 } })
  const result = transition(pending, { type: 'question-confirmed', questionId: q.id, selected, receipt })
  expect(result.phase).toBe(selected === 'Revise requirements' ? 'Clarifying' : 'Paused')
  expect(result.snapshot).toEqual(state.snapshot); expect(result.brief).toEqual(state.brief)
  expect(result.executionMs).toBe(123); expect(result.executionWallMs).toBe(321); expect(result.repairRounds).toBe(1)
  expect(result.activeRunId).toBeNull(); expect(result.questions).toMatchObject([{ status: 'committed', confirmedSelection: selected }])
  if (selected === 'Revise requirements') expect(result.approval).toBeNull()
  else { expect(result.approval).toEqual(state.approval); expect(result.pausedFrom).toBe('Staged') }
})

it('accepts an exact negative reconfirmation without requiring unspent execution budget', () => {
  const state = { ...atEvent(5), executionWallMs: brief.executionBudgetMs }, q = { ...question(state, 'budget-rejection'), options: [{ label: 'Reject and revise' }] }
  const pending = transition(transition(state, { type: 'question-opened', question: q }), { type: 'question-returned', questionId: q.id, serviceAnswer: { selected: 'Reject and revise', source: 'user-questions-service-unattributed', receivedAt: 2 } })
  const after = transition(pending, { type: 'question-confirmed', questionId: q.id, selected: 'Reject and revise', receipt })
  expect(after.phase).toBe('Clarifying'); expect(after.approval?.approved).toBe(false)
  expect(after.snapshot).toEqual(state.snapshot); expect(after.executionWallMs).toBe(brief.executionBudgetMs)
})

it('retains released terminal Running history but forbids new unaudited cancellation and allows host-only terminal reconciliation', async () => {
  const { HostOperationId } = await import('../../src/workflow/types.js'), operation = { id: HostOperationId(randomUUID()), kind: 'diagnostic' as const, status: 'Running' as const, result: null, error: null }
  const historical = [{ version: 3, event: { type: 'host-operation-started', operation } }, { version: 3, event: { type: 'cancelled', reason: 'Released cancellation without host quiescence' } }]
  const running = replay(historical.slice(0, 1)), archived = replay(historical)
  expect(archived.phase).toBe('Cancelled'); expect(archived.hostOperation?.status).toBe('Running')
  expect(() => transition(running, { type: 'cancelled', reason: 'No inferred quiescence' })).toThrow('host task')
  expect(() => replay([...historical.slice(0, 1), { version: 4, event: { type: 'cancelled', reason: 'No inferred quiescence' } }])).toThrow('host task')
  const q = { ...question(archived, 'terminal-host', 'host-recovery'), revision: 0, hostOperationId: operation.id, options: [{ label: 'Confirm previous processes stopped' }] }
  const awaiting = transition(transition(archived, { type: 'question-opened', question: q }), { type: 'question-returned', questionId: q.id, serviceAnswer: { selected: q.options[0]!.label, source: 'user-questions-service-unattributed', receivedAt: 2 } })
  const after = transition(awaiting, { type: 'question-confirmed', questionId: q.id, selected: q.options[0]!.label, receipt })
  expect(after.phase).toBe('Cancelled'); expect(after.hostOperation?.status).toBe('Interrupted'); expect(after.executionMs).toBe(0)
})
