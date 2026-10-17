/** Pure presentation, channel replacement and generation-specific recovery transitions. */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { WorkflowController, replay } from '../../src/workflow/controller.js'
import { askDecisionQuestion, confirmationReceipt, questionBinding, needsQuestionRefresh } from '../../src/workflow/questions.js'
import { briefDetails, decisionCard, operationCard, confirmationQuestions } from '../../src/workflow/interaction.js'
import { OperationRequestId } from '../../src/workflow/authorization.js'
import type { WorkflowRecord } from '../../src/workflow/types.js'
import { recordSchema } from '../../src/workflow/types.js'
import { atEvent, brief, readyEvents, passed, finding } from '../fixtures/workflow.js'

const input = { question: 'Approve this exact brief?', detail: briefDetails(brief), options: [{ label: 'Approve', description: 'Approve requirements only.' }, { label: 'Reject and revise', description: 'Return to clarification.' }] }
const signal = () => new AbortController().signal

describe('scrollable confirmation facts', () => {
  it('keeps a long approval out of the non-scrolling title without dropping facts or choices', () => {
    const details = briefDetails({ ...brief, goal: 'Approved long goal. '.repeat(200) })
    const [card] = decisionCard({ ...input, detail: details, id: 'approval', kind: 'approval', revision: 1, binding: 'binding', phase: 'Awaiting Approval', askedAt: 1, afterSeq: -1, status: 'pending' })
    expect(card!.question).toBe(input.question)
    expect(card!.options[0]!.description).toBe(input.options[0]!.description + '\n\n' + details)
    expect(card!.options[1]).toEqual(input.options[1])
    expect(card!.multi_select).toBe(false)
  })
  it.each(['execution', 'handoff'] as const)('keeps complete %s facts in the scrollable choice description', kind => {
    const state = kind === 'handoff' ? atEvent(8) : atEvent(2)
    const request = { id: OperationRequestId(randomUUID()), kind, mode: kind === 'handoff' ? 'handoff' as const : 'implement-verify-review' as const, revision: 1, binding: questionBinding(state), askedAt: 1, afterSeq: -1, status: 'pending' as const }
    const [card] = operationCard(request, brief, 1234, state)
    expect(card!.question).toBe(kind === 'handoff' ? 'Authorize handoff of this reviewed candidate?' : 'Authorize this execution?')
    expect(card!.options.map(option => option.label)).toEqual(['Authorize', 'Decline'])
    expect(card!.options[0]!.description).toContain(briefDetails(brief))
    expect(card!.options[0]!.description).toContain('Remaining execution budget: 1234 ms')
    if (kind === 'handoff') expect(card!.options[0]!.description).toContain(state.snapshot!.treeId)
  })
})

describe('legacy decision channel replacement', () => {
  it('does not classify quoted legacy instructions in a new brief as a legacy channel', async () => {
    const quoted = '\nThis service response does not record who answered. To commit this decision, send a new user message containing exactly: ' + JSON.stringify({ reviewGatedAnswer: { questionId: 'quoted-old-id', selected: '<one exact option label>' } })
    const requirements = { ...brief, goal: 'Replace this obsolete prompt:' + quoted }
    const records: WorkflowRecord[] = [recordSchema.parse({ version: 3, event: { type: 'requirements-submitted', brief: requirements } })]
    const controller = new WorkflowController(async record => { records.push(record) }, records), session = Session.create(SessionId(randomUUID()))
    const facts = { ...input, detail: briefDetails(requirements) }
    const ask = async () => { throw new Error('A current button question never invokes the unattributed service') }
    const question = await askDecisionQuestion(controller, session, 'approval', facts, ask, signal(), 'buttons')
    expect(needsQuestionRefresh(question)).toBe(false)
    expect(confirmationQuestions(controller.state)).toHaveLength(1)
    expect(confirmationQuestions(controller.state)[0]!.options[0]!.description).toContain(quoted)
    expect((await askDecisionQuestion(controller, session, 'approval', facts, ask, signal(), 'buttons')).id).toBe(question.id)
    expect(records.map(record => record.event.type)).toEqual(['requirements-submitted', 'question-opened'])
  })
  it.each(['pending', 'service-returned'] as const)('replaces a frozen v5 %s decision without rewriting history or resetting work', async status => {
    const original: WorkflowRecord[] = [recordSchema.parse({ version: 3, event: readyEvents()[0]! })]
    const first = new WorkflowController(async record => { original.push(record) }, original)
    const session = Session.create(SessionId(randomUUID()))
    const old = await askDecisionQuestion(first, session, 'approval', { ...input, detail: JSON.stringify(brief) }, async question => ({ answers: [{ id: question.id, selected: ['Approve'] }] }), signal(), 'legacy-json')
    const records = original.filter(record => status === 'service-returned' || record.event.type !== 'question-returned').map(record => recordSchema.parse({ ...record, version: record.version === 3 ? 3 : 5 }))
    const frozen = JSON.stringify(records), appended: WorkflowRecord[] = []
    const controller = new WorkflowController(async record => { appended.push(record) }, records)
    const before = controller.state
    const obsolete = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({ reviewGatedAnswer: { questionId: old.id, selected: 'Approve' } }) }] }), { surfaceOp: 'append' })
    const fresh = await askDecisionQuestion(controller, session, 'approval', input, async () => { throw new Error('Buttons must not invoke the unattributed service') }, signal(), 'buttons')
    expect(fresh.id).not.toBe(old.id)
    expect(fresh.status).toBe('pending')
    expect(fresh.detail).toBe(input.detail)
    expect(JSON.stringify(decisionCard(fresh))).not.toContain('reviewGatedAnswer')
    expect(appended.map(record => record.event.type)).toEqual(['question-failed', 'question-opened'])
    expect(controller.state.phase).toBe(before.phase)
    expect(controller.state.brief).toEqual(before.brief)
    expect(controller.state.executionMs).toBe(before.executionMs)
    expect(controller.state.repairRounds).toBe(before.repairRounds)
    expect(controller.state.approval).toBeNull()
    expect(() => confirmationReceipt(session, fresh, obsolete.seq)).toThrow()
    expect(JSON.stringify(records)).toBe(frozen)
    expect(replay([...records, ...appended])).toEqual(controller.state)
  })
})

describe('settled-role crash window recovery', () => {
  it.each(['Implemented', 'Needs Changes', 'Ready for Handoff'] as const)('reconciles %s only in the successor generation and consumes unknown remaining budget', async phase => {
    const events = readyEvents().slice(0, phase === 'Implemented' ? 4 : 8)
    if (phase === 'Needs Changes') events[events.length - 1] = { type: 'review-finished', runId: 'review-1', result: { ...passed, outcome: 'Needs Changes', findings: [finding] }, elapsedMs: 10 }
    events.splice(2, 0, { type: 'execution-window-started', id: 'interrupted-window' })
    const old = events.map(event => ({ version: 6 as const, event }))
    const before = replay(old), appended: WorkflowRecord[] = []
    expect(before.phase).toBe(phase)
    const question = { id: 'recovery', kind: 'recovery' as const, revision: 1, binding: questionBinding(before), phase, askedAt: 1, afterSeq: -1, question: 'Have all old processes stopped?', detail: 'Reconcile the unresolved window only.', options: [{ label: 'Confirm previous processes stopped' }, { label: 'Leave unresolved' }], status: 'pending' as const }
    for (const version of [4, 5, 6]) expect(() => replay([...old.map(record => ({ ...record, version })), { version, event: { type: 'question-opened', question } }])).toThrow('Operation unavailable in phase')
    const controller = new WorkflowController(async record => { appended.push(record) }, old, () => {})
    await controller.apply({ type: 'question-opened', question })
    await controller.apply({ type: 'question-confirmed', questionId: question.id, selected: 'Confirm previous processes stopped', receipt: { seq: 1, receivedAt: 1, source: 'session-user-question-reply' } })
    expect(controller.state.phase).toBe('Paused')
    expect(controller.state.executionWindow).toBeUndefined()
    expect(controller.state.activeRunId).toBeNull()
    expect(controller.state.executionWallMs).toBe(brief.executionBudgetMs)
    expect(controller.state.executionMs).toBe(before.executionMs)
    expect(controller.state.repairRounds).toBe(before.repairRounds)
    expect(controller.state.snapshot).toEqual(before.snapshot)
    expect(controller.state.review).toEqual(before.review)
    expect(appended.every(record => record.version === 8)).toBe(true)
    expect(replay([...old, ...appended])).toEqual(controller.state)
    await expect(controller.apply({ type: 'resumed' })).rejects.toThrow('Execution budget exhausted')
  })
})
