/** Synthetic event mutations test rejection; genuine UI replies are covered by the Loader integration. */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PtcDispatchEventData } from '@deepseek-ai/dsh-tools/types'
import { buttonReceipt, confirmationQuestions, decisionCard, operationCard } from '../../src/workflow/interaction.js'
import { questionBinding } from '../../src/workflow/questions.js'
import type { DecisionQuestion } from '../../src/workflow/questions.js'
import { OperationRequestId, operationReceipt, requireOperationPermission } from '../../src/workflow/authorization.js'
import { recordSchema } from '../../src/workflow/types.js'
import { replay, transition, WorkflowController } from '../../src/workflow/controller.js'
import { atEvent, brief, snapshot, readyEvents } from '../fixtures/workflow.js'

const question = (): DecisionQuestion => ({ id: 'question', kind: 'approval', revision: 1, binding: questionBinding(atEvent(1)), phase: 'Awaiting Approval',
  askedAt: 1, afterSeq: -1, question: 'Approve exact scope?', detail: 'Allowed paths and exact checks; no commit or push.', options: [{ label: 'Approve' }, { label: 'Revise' }], status: 'pending' })
function make(options: { dispatch?: Partial<PtcDispatchEventData>; batch?: object; source?: UserMessage['source']; noCall?: boolean } = {}) {
  const session = Session.create(SessionId(randomUUID())), callId = ToolCallId(randomUUID()), card = decisionCard(question())
  const dispatch: PtcDispatchEventData = { rootCallId: ToolCallId('root'), parentCallId: ToolCallId('parent'), subCallId: callId, name: 'ask_user_question',
    arguments: { questions: card }, isError: false, content: [{ type: 'text', text: JSON.stringify({ pending: true, callId }) }], ...options.dispatch }
  if (!options.noCall) session.append('tool/ptc-dispatch', dispatch)
  const batch = { kind: 'answer_to_pending_question', tool: 'ask_user_question', callId,
    questions: card.map(({ multi_select, ...item }) => ({ ...item, multiSelect: multi_select })), answers: [{ id: card[0]!.id, selected: ['Approve'] }], ...options.batch }
  const reply = session.append('user/message', createUserMessage({ source: options.source ?? { kind: 'user-question-reply', callId, outcome: 'answered' },
    content: [{ type: 'text', text: JSON.stringify(batch) }] }), { surfaceOp: 'append' })
  return { session, card, reply, callId, dispatch, batch }
}

describe('bound button receipt validation', () => {
  it('returns only the exact logged reply reference and fixed selection', () => {
    const f = make()
    expect(buttonReceipt(f.session, f.card, -1, f.reply.seq)).toEqual({ selected: 'Approve', receipt: { seq: f.reply.seq, receivedAt: f.reply.time, source: 'session-user-question-reply' } })
  })
  it.each([
    { noCall: true }, { dispatch: { name: 'another_tool' } }, { dispatch: { isError: true } }, { dispatch: { content: [{ type: 'text' as const, text: '{"pending":false}' }] } },
    { dispatch: { arguments: { questions: [] } } }, { batch: { callId: 'another-call' } }, { batch: { tool: 'other' } }, { batch: { questions: [] } },
    { batch: { answers: [{ id: 'wrong-question', selected: ['Approve'] }] } }, { batch: { answers: [{ id: 'question', selected: ['Not offered'] }] } },
    { batch: { answers: [{ id: 'question', selected: ['Approve', 'Revise'] }] } }, { batch: { answers: [{ id: 'question', selected: ['Approve'], custom: 'different scope' }] } },
    { batch: { additional: 'untrusted' } }, { source: { kind: 'user' as const } },
  ])('rejects mismatched call, displayed facts, options or input channel (%j)', options => {
    const f = make(options)
    expect(() => buttonReceipt(f.session, f.card, -1, f.reply.seq)).toThrow()
  })
  it('rejects latest input replacement, wrong sequence and pre-question input', () => {
    const f = make()
    expect(() => buttonReceipt(f.session, f.card, -1, f.reply.seq + 1)).toThrow()
    expect(() => buttonReceipt(f.session, f.card, f.reply.seq, f.reply.seq)).toThrow()
    f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Stop instead' }] }), { surfaceOp: 'append' })
    expect(() => buttonReceipt(f.session, f.card, -1, f.reply.seq)).toThrow()
  })
  it('rejects a call copied from a different Session or a changed current card', () => {
    const f = make(), another = Session.create(SessionId(randomUUID()))
    const copied = another.append('user/message', f.reply.data, { surfaceOp: 'append' })
    expect(() => buttonReceipt(another, f.card, -1, copied.seq)).toThrow()
    expect(() => buttonReceipt(f.session, [{ ...f.card[0]!, question: 'Authorize a wider path' }], -1, f.reply.seq)).toThrow()
  })
  it('rejects custom plaintext masquerading as a UI answer batch', () => {
    const f = make()
    const reply = f.session.append('user/message', createUserMessage({ source: { kind: 'user-question-reply', callId: f.callId, outcome: 'answered' },
      content: [{ type: 'text', text: JSON.stringify({ reviewGatedAnswer: { questionId: 'question', selected: 'Approve' } }) }] }), { surfaceOp: 'append' })
    expect(() => buttonReceipt(f.session, f.card, -1, reply.seq)).toThrow()
  })
  it('does not expose a stale decision after requirements or phase changes', () => {
    const state = { ...atEvent(1), questions: [question()] }
    expect(confirmationQuestions(state)).toEqual(decisionCard(question()))
    expect(confirmationQuestions({ ...state, brief: { ...brief, goal: 'Different scope' } })).toEqual([])
    expect(confirmationQuestions(transition(state, { type: 'cancelled', reason: 'Stopped' }))).toEqual([])
  })
  it('shows exact candidate and distinct handoff scope without execution wording', () => {
    const state = atEvent(8), request = { id: OperationRequestId('handoff'), kind: 'handoff' as const, mode: 'handoff' as const, revision: 1, binding: questionBinding(state), askedAt: 1, afterSeq: -1, status: 'pending' as const }
    const card = operationCard(request, brief, 1000, state)[0]!
    expect(card.options[0]!.description).toContain(snapshot.treeId)
    expect(card.options[0]!.description).toContain(snapshot.baseCommit)
    expect(card.options[0]!.description).toContain('Remaining repair rounds: 2')
    expect(card.options[0]!.description).toContain('No implementation or verification rerun')
    expect(card.question).not.toContain('does not include handoff')
    expect(card.question).not.toContain('reviewGatedOperation')
  })
  it('refuses old card and manual operation replies after a Session generation is restored', () => {
    const f = make(), restoredCard = Session.create(f.session.id, f.session.snapshotEvents(), f.session.header)
    expect(restoredCard.firstLiveSeq).toBeGreaterThan(f.reply.seq)
    expect(() => buttonReceipt(restoredCard, f.card, -1, f.reply.seq)).toThrow()
    const session = Session.create(SessionId(randomUUID())), state = atEvent(2)
    const request = { id: OperationRequestId(randomUUID()), kind: 'execution' as const, mode: 'implement-verify-review' as const, revision: 1, binding: questionBinding(state), askedAt: 0, afterSeq: -1, status: 'pending' as const }
    const human = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({ reviewGatedOperation: { requestId: request.id, selected: 'Authorize' } }) }] }), { surfaceOp: 'append' })
    const granted = replay([...readyEvents().slice(0,2).map(event=>({version:4,event})),{version:5,event:{type:'operation-requested',request}},{version:5,event:{type:'operation-confirmed',requestId:request.id,...operationReceipt(session,request,human.seq)}}])
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(() => requireOperationPermission(granted, restored, 'execution', 'legacy-json')).toThrow('Legacy permission')
    expect(() => requireOperationPermission(granted, restored, 'execution', 'buttons')).toThrow('Legacy permission')
  })
  it('refuses button facts through a controller lacking Session validation', async () => {
    const records = [recordSchema.parse({ version: 5, event: readyEvents()[0] })], controller = new WorkflowController(async () => {}, records)
    await controller.apply({ type: 'question-opened', question: question() })
    await expect(controller.apply({ type: 'question-confirmed', questionId: 'question', selected: 'Approve', receipt: { seq: 1, receivedAt: 1, source: 'session-user-question-reply' } })).rejects.toThrow('Session-bound')
    expect(controller.state.phase).toBe('Awaiting Approval')
  })
  it('preserves every released generation and refuses new source or downgrade in v1-v5', () => {
    const old = readyEvents().map((event, index) => recordSchema.parse({ version: index < 2 ? 1 : index < 4 ? 2 : index < 6 ? 3 : index < 7 ? 4 : 5, event }))
    const before = JSON.stringify(old)
    expect(replay(old).phase).toBe('Ready for Handoff')
    expect(JSON.stringify(old)).toBe(before)
    const current = { type: 'question-confirmed', questionId: 'question', selected: 'Approve', receipt: { seq: 1, receivedAt: 1, source: 'session-user-question-reply' } }
    expect(recordSchema.parse({ version: 6, event: current }).version).toBe(6)
    for (const version of [1, 2, 3, 4, 5]) expect(() => recordSchema.parse({ version, event: current })).toThrow()
    expect(() => replay([{ version: 6, event: readyEvents()[0] }, { version: 5, event: readyEvents()[1] }])).toThrow('regress')
  })
})
