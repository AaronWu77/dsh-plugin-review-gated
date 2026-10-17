/** Pure permission, replay and input-source regressions; these are not human identity authentication. */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { WorkflowController, replay, transition } from '../../src/workflow/controller.js'
import { OperationRequestId, operationMode, operationReceipt, operationEvidence, requireOperationPermission } from '../../src/workflow/authorization.js'
import type { OperationRequest } from '../../src/workflow/authorization.js'
import { recordSchema } from '../../src/workflow/types.js'
import type { WorkflowRecord } from '../../src/workflow/types.js'
import { operationBinding, PreflightId } from '../../src/workflow/preflight.js'
import { questionBinding } from '../../src/workflow/questions.js'
import { summarize } from '../../src/workflow/summary.js'
import { decisionEvidence } from '../../src/workflow/decision-evidence.js'
import { atEvent, readyEvents } from '../fixtures/workflow.js'

const session = () => Session.create(SessionId(randomUUID()))
const human = (s: Session, text: string) => s.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
const answer = (r: OperationRequest, selected = 'Authorize') => JSON.stringify({ reviewGatedOperation: { requestId: r.id, selected } })
function request(state = atEvent(2), kind: OperationRequest['kind'] = 'execution'): OperationRequest {
  const id=OperationRequestId(randomUUID()), proof={id:PreflightId(randomUUID()),repository:'/fixture/repository',head:'a'.repeat(40),treeId:'b'.repeat(40)}
  // Pure state-machine fixture; integration tests obtain these facts from real Git.
  state.repositoryPreflight={id:proof.id,requestId:id,kind,revision:state.brief!.revision,scopeBinding:questionBinding(state),status:'passed',startedAt:1,durationMs:1,baseline:{repository:proof.repository,head:proof.head,treeId:proof.treeId},limits:{commandTimeoutMs:1000,integrityTimeoutMs:1000,totalTimeoutMs:3000},issues:[]}
  return { id, kind, mode: operationMode(state, kind), revision: 1, binding: operationBinding(state,proof), preflight:proof, askedAt: 1, afterSeq: -1, status: 'pending' }
}
function grant() {
  const s = session(), before = atEvent(2), r = request(before), input = human(s, answer(r))
  let state = transition(before, { type: 'operation-requested', request: r })
  state = transition(state, { type: 'operation-confirmed', requestId: r.id, ...operationReceipt(s, r, input.seq) })
  return { s, r, state, input }
}

describe('one-use operation permissions', () => {
  it('does not treat requirement approval or a service response as execution permission', () => {
    expect(() => requireOperationPermission(atEvent(2), session(), 'execution')).toThrow('separate current logged')
  })
  it('a real later input grants permission without changing phase, elapsed time, rounds or snapshot', () => {
    const { s, state, r, input } = grant()
    expect(state).toMatchObject({ phase: 'Approved', executionMs: 0, repairRounds: 0, snapshot: null, operationAuthorization: { status: 'granted', receipt: { seq: input.seq, source: 'session-user-message' } } })
    expect(requireOperationPermission(state, s, 'execution').id).toBe(r.id)
  })
  it('atomically consumes permission with the window, and cannot consume again', () => {
    const { s, state, r } = grant()
    const event = { type: 'authorized-execution-started' as const, requestId: r.id, id: 'window-1' }
    const running = transition(state, event)
    expect(running).toMatchObject({ executionWindow: { id: 'window-1' }, operationAuthorization: { status: 'consumed', operationId: 'window-1' } })
    expect(() => requireOperationPermission(running, s, 'execution')).toThrow()
    expect(() => transition(running, event)).toThrow('unconsumed')
  })
  it('decline is a recorded decision, not cancellation or permission', () => {
    const state = atEvent(2), r = request(state), s = session(), input = human(s, answer(r, 'Decline'))
    const next = transition(transition(state, { type: 'operation-requested', request: r }), { type: 'operation-confirmed', requestId: r.id, ...operationReceipt(s, r, input.seq) })
    expect(next).toMatchObject({ phase: 'Approved', operationAuthorization: { status: 'declined' } })
    expect(() => requireOperationPermission(next, s, 'execution')).toThrow()
  })
  it('other sessions, new unrelated user input and invented sequence cannot authorize', () => {
    const { s, r, state, input } = grant()
    expect(() => requireOperationPermission(state, session(), 'execution')).toThrow()
    expect(() => operationReceipt(s, r, input.seq + 10)).toThrow()
    human(s, 'Stop; do not execute')
    expect(() => requireOperationPermission(state, s, 'execution')).toThrow('latest')
  })
  it.each(['yes', 'run now', 'Authorize', '{', '{}', JSON.stringify({ reviewGatedAnswer: { questionId: 'approval', selected: 'Approve' } })])('does not infer an operation from other text (%s)', text => {
    const s = session(), r = request(), input = human(s, text)
    expect(() => operationReceipt(s, r, input.seq)).toThrow()
  })
  it.each(['extra-root', 'extra-answer', 'wrong-id', 'wrong-case', 'array'])('rejects nonexact operation JSON (%s)', variant => {
    const s = session(), r = request(), object = { reviewGatedOperation: { requestId: r.id, selected: 'Authorize' } }
    const value = variant === 'extra-root' ? { ...object, extra: true } : variant === 'extra-answer' ? { reviewGatedOperation: { ...object.reviewGatedOperation, extra: true } }
      : variant === 'wrong-id' ? { reviewGatedOperation: { requestId: randomUUID(), selected: 'Authorize' } }
      : variant === 'wrong-case' ? { reviewGatedOperation: { requestId: r.id, selected: 'authorize' } } : [object]
    const input = human(s, JSON.stringify(value)); expect(() => operationReceipt(s, r, input.seq)).toThrow()
  })
  it('rejects synthetic model/system-prompt input and mixed content', () => {
    for (const source of [{ kind: 'system-prompt' as const }, { kind: 'model' as const, provider: 'fixture', model: 'not-human' }]) {
      const s = session(), r = request(), input = s.append('user/message', createUserMessage({ source, content: [{ type: 'text', text: answer(r) }] }), { surfaceOp: 'append' })
      expect(() => operationReceipt(s, r, input.seq)).toThrow('logged user')
    }
    const s = session(), r = request(), input = s.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: answer(r) }, { type: 'reasoning', text: 'extra' }] }), { surfaceOp: 'append' })
    expect(() => operationReceipt(s, r, input.seq)).toThrow()
  })
  it('requires a later message than the request', () => {
    const s = session(), r = request(), input = human(s, answer(r))
    expect(() => operationReceipt(s, { ...r, afterSeq: input.seq }, input.seq)).toThrow()
  })
  it.each(['revision', 'snapshot', 'budget', 'phase'] as const)('invalidates a grant when its bound state changes (%s)', kind => {
    const { s, state } = grant(), changed = structuredClone(state)
    if (kind === 'revision') changed.brief!.revision++
    if (kind === 'snapshot') changed.snapshot = atEvent(5).snapshot
    if (kind === 'budget') changed.executionMs++
    if (kind === 'phase') changed.phase = 'Paused'
    expect(() => requireOperationPermission(changed, s, 'execution')).toThrow('current')
  })
  it('execution permission does not permit handoff or a different request', () => {
    const { s, state } = grant()
    expect(() => requireOperationPermission(state, s, 'handoff')).toThrow()
    expect(() => transition(state, { type: 'authorized-execution-started', requestId: OperationRequestId(randomUUID()), id: 'w' })).toThrow()
  })
  it('selects fresh checks and Review only for an existing inactive candidate', () => {
    expect(operationMode(atEvent(4), 'execution')).toBe('verify-review')
    expect(operationMode(atEvent(5), 'execution')).toBe('verify-review')
    expect(operationMode(atEvent(8), 'handoff')).toBe('handoff')
    expect(() => operationMode(atEvent(8), 'execution')).toThrow()
    expect(() => operationMode(atEvent(2), 'handoff')).toThrow()
  })
  it('selects verification-only mode and advertises no implementation writes', () => {
    const current = atEvent(2), state = { ...current, brief: { ...current.brief!, executionIntent: 'verification-only' as const } }
    expect(operationMode(state, 'execution')).toBe('verify-review')
    const pending = transition(state, { type: 'operation-requested', request: request(state) })
    const evidence = operationEvidence(pending)
    expect(evidence.scope).toContain('verification-only')
    expect(evidence.scope).toContain('no implementation or repair writes')
  })
  it('denies active, terminal, unresolved and exhausted states before a request', () => {
    for (const changed of [{ ...atEvent(2), activeRunId: 'running' }, { ...atEvent(2), executionWindow: { id: 'old-window' } }, { ...atEvent(2), executionMs: atEvent(2).brief!.executionBudgetMs }, { ...atEvent(2), phase: 'Cancelled' as const }]) expect(() => operationMode(changed, 'execution')).toThrow()
  })
  it('advertises only an exact latest logged operation input', () => {
    const before = atEvent(2), r = request(before), state = transition(before, { type: 'operation-requested', request: r }), s = session()
    expect(operationEvidence(state, s).availableUserConfirmation).toBeNull()
    const input = human(s, answer(r))
    expect(operationEvidence(state, s).availableUserConfirmation).toEqual({ userMessageSeq: input.seq, selected: 'Authorize' })
    human(s, 'Different followup'); expect(operationEvidence(state, s).availableUserConfirmation).toBeNull()
  })
  it('writes only v8 successor facts and preserves v4 history without granting permission', async () => {
    const old = readyEvents().slice(0, 2).map(event => recordSchema.parse({ version: 4, event })), original = JSON.stringify(old), appended: WorkflowRecord[] = []
    const controller = new WorkflowController(async record => { appended.push(record) }, old), before=controller.state, r = request(before)
    const preflight=before.repositoryPreflight!
    await controller.apply({type:'repository-preflight-recorded',preflight:{...preflight,status:'running',durationMs:0,baseline:null}})
    await controller.apply({type:'repository-preflight-recorded',preflight})
    await controller.apply({ type: 'operation-requested', request: r })
    expect(appended[0]!.version).toBe(8)
    expect(() => recordSchema.parse({ version: 4, event: appended[0]!.event })).toThrow()
    expect(JSON.stringify(old)).toBe(original)
    expect(replay([...old, ...appended])).toEqual(controller.state)
    expect(() => replay([...old, ...appended, old[0]])).toThrow('regress')
    expect(() => requireOperationPermission(replay(old), session(), 'execution')).toThrow()
  })
  it('rejects direct durable confirmation without a Session-bound validator', async () => {
    const controller = new WorkflowController(async () => {}, readyEvents().slice(0, 2).map(event => ({ version: 4 as const, event }))), before=controller.state, r = request(before)
    const preflight=before.repositoryPreflight!
    await controller.apply({type:'repository-preflight-recorded',preflight:{...preflight,status:'running',durationMs:0,baseline:null}})
    await controller.apply({type:'repository-preflight-recorded',preflight})
    await controller.apply({ type: 'operation-requested', request: r })
    await expect(controller.apply({ type: 'operation-confirmed', requestId: r.id, selected: 'Authorize', receipt: { seq: 1, receivedAt: 1, source: 'session-user-message' } })).rejects.toThrow('Session-bound')
  })
  it('does not publish or consume permission when a durable append fails', async () => {
    const { s, state, r } = grant(), history = readyEvents().slice(0, 2).map(event => ({ version: 4, event }))
    const opened = { type: 'operation-requested' as const, request: r }, confirmed = { type: 'operation-confirmed' as const, requestId: r.id, selected: 'Authorize' as const, receipt: state.operationAuthorization!.receipt! }
    const controller = new WorkflowController(async () => { throw new Error('storage unavailable') }, [...history, {version:8,event:{type:'repository-preflight-recorded',preflight:{...state.repositoryPreflight!,status:'running',durationMs:0,baseline:null}}}, {version:8,event:{type:'repository-preflight-recorded',preflight:state.repositoryPreflight!}}, { version: 8, event: opened }, { version: 8, event: confirmed }], () => undefined)
    await expect(controller.apply({ type: 'authorized-execution-started', requestId: r.id, id: 'w' })).rejects.toThrow('storage unavailable')
    expect(controller.state.executionWindow).toBeUndefined()
    expect(requireOperationPermission(controller.state, s, 'execution').status).toBe('granted')
  })
  it('compact discovery omits huge original details and raw output without deleting authoritative facts', () => {
    const state = atEvent(8); state.brief!.goal = 'G'.repeat(100000); state.verification!.checks[0]!.stdout = 'O'.repeat(100000)
    const raw = { state, baseCommit: null, recordCount: 8, decisionEvidence: decisionEvidence(state) }
    const result = summarize(raw, undefined, { summaryTextChars: 128, summaryItems: 2 })
    expect(JSON.stringify(result).length).toBeLessThan(5000)
    expect(state.brief!.goal.length).toBe(100000); expect(state.verification!.checks[0]!.stdout.length).toBe(100000)
    expect(result.state.brief!.goal.length).toBe(129)
    expect(JSON.stringify(result)).not.toContain('O'.repeat(100))
  })
})
