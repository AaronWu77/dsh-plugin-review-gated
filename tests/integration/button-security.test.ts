/** Public UI decisions, direct-entry denials and crash repair in private Loader-owned stores. */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import { workflowDomain, journalSchema } from '../../dist/storage/journal.js'
import { questionBinding } from '../../dist/workflow/questions.js'
import { OperationRequestId, operationReceipt, requireOperationPermission } from '../../dist/workflow/authorization.js'
import { confirmationQuestions } from '../../dist/workflow/interaction.js'
import { recordSchema, HostOperationId } from '../../dist/workflow/types.js'
import { replay } from '../../dist/workflow/controller.js'
import { buttonSetup } from '../fixtures/buttons.js'
import { fixture, main, call } from '../fixtures/runtime.js'
import { readyEvents, snapshot } from '../fixtures/workflow.js'

const start = async (f: Awaited<ReturnType<typeof buttonSetup>>) => {
  f.root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare the isolated task and ask with buttons.' }] }))
  await f.root.agent.whenIdle()
}
const card = (f: Awaited<ReturnType<typeof buttonSetup>>) => f.ctx.sessionProjections.stateOf(f.root.agent.session, 'userQuestions')!.questions.active.find(item => item.state === 'continued' && item.questions.some(question => question.id === confirmationQuestions(f.controller.state)[0]?.id))!
const answer = async (f: Awaited<ReturnType<typeof buttonSetup>>, selected: string) => {
  const current = card(f)
  expect(f.ctx.userQuestions.answer(f.root.agent, current.callId, { answers: [{ id: current.questions[0]!.id, selected: [selected] }] })).toBe(true)
  await f.root.agent.whenIdle()
}

describe('button decisions refuse alternate permission and late inputs', () => {
  it.each(['Reject and revise', 'Decline'])('does not execute after %s', async selected => {
    const f = await buttonSetup('native', false)
    await start(f)
    if (selected === 'Decline') await answer(f, 'Approve')
    await answer(f, selected)
    expect(f.order).toEqual([])
    expect(f.controller.state.implementation).toBeNull()
    expect(f.controller.state.operationAuthorization?.status ?? null).toBe(selected === 'Decline' ? 'declined' : null)
    expect(f.controller.state.phase).toBe(selected === 'Decline' ? 'Approved' : 'Clarifying')
  })
  it('rejects manual operation JSON through tools and direct controller mutations in button mode', async () => {
    const f = await buttonSetup('native', false)
    await start(f); await answer(f, 'Approve')
    const request = f.controller.state.operationAuthorization!
    f.root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({ reviewGatedOperation: { requestId: request.id, selected: 'Authorize' } }) }] }))
    await f.root.agent.whenIdle()
    const event = f.root.agent.session.snapshotEvents().findLast(item => item.type === 'user/message')!
    const result = await call(f.root.scoped, f.root.agent, 'rg_confirm_operation', { requestId: request.id, userMessageSeq: event.seq })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Button mode')
    await expect(f.controller.apply({ type: 'operation-confirmed', requestId: request.id, selected: 'Authorize', receipt: { seq: event.seq, receivedAt: event.time, source: 'session-user-message' } })).rejects.toThrow('Button mode')
    expect(f.controller.state.operationAuthorization?.status).toBe('pending')
    expect(f.order).toEqual([])
  })
  it('withdraws a granted button permission on later genuine input before starting a task', async () => {
    const f = await buttonSetup('native', false)
    await start(f); await answer(f, 'Approve'); await answer(f, 'Authorize')
    expect(f.controller.state.operationAuthorization?.status).toBe('granted')
    f.root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Stop; withdraw execution permission.' }] }))
    await f.root.agent.whenIdle()
    const before = f.controller.state.hostOperation
    expect((await call(f.root.scoped, f.root.agent, 'rg_start', { operation: 'execution' })).isError).toBe(true)
    expect(f.controller.state.hostOperation).toEqual(before)
    expect(f.controller.state.operationAuthorization?.status).toBe('granted')
    expect(f.order).toEqual([])
  })
  it('does not commit an approval reply arriving after workflow cancellation', async () => {
    const f = await buttonSetup('native', false)
    await start(f)
    const pending = card(f)
    expect((await call(f.root.scoped, f.root.agent, 'rg_cancel', { reason: 'Stop before approval' })).isError).toBe(false)
    expect(f.ctx.userQuestions.answer(f.root.agent, pending.callId, { answers: [{ id: pending.questions[0]!.id, selected: ['Approve'] }] })).toBe(true)
    await f.root.agent.whenIdle()
    const event = f.root.agent.session.snapshotEvents().findLast(item => item.type === 'user/message')!
    expect((await call(f.root.scoped, f.root.agent, 'rg_confirm_question', { questionId: pending.questions[0]!.id, userMessageSeq: event.seq })).isError).toBe(true)
    expect(f.controller.state.phase).toBe('Cancelled')
    expect(f.controller.state.approval).toBeNull()
    expect(f.order).toEqual([])
  })
})

describe('genuine recovery and separate handoff cards', () => {
  it.each(['Retry unchanged approved brief', 'Leave paused'])('records recovery without execution or budget reset (%s)', async selected => {
    const f = await buttonSetup('native', false)
    await start(f); await answer(f, 'Approve')
    await f.controller.apply({ type: 'paused', reason: 'Explicit test-owned pause before execution' })
    const before = f.controller.state
    expect((await call(f.root.scoped, f.root.agent, 'rg_recover', {})).isError).toBe(false)
    f.root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Show the current recovery card only.' }] }))
    await f.root.agent.whenIdle()
    expect(card(f).questions[0]!.options![0]!.description).toContain('This decision confirms recovery only')
    await answer(f, selected)
    expect(f.controller.state.phase).toBe(selected === 'Leave paused' ? 'Paused' : 'Approved')
    expect(f.controller.state.questions!.find(item => item.kind === 'recovery')).toMatchObject({ status: 'committed', receipt: { source: 'session-user-question-reply' } })
    expect(f.controller.state.executionMs).toBe(before.executionMs)
    expect(f.controller.state.repairRounds).toBe(before.repairRounds)
    expect(f.controller.state.implementation).toBeNull()
    expect(f.order).toEqual([])
  })
  it('records host-quiescence confirmation without starting the interrupted task or clearing another window', async () => {
    const f = await buttonSetup('native', false)
    await start(f); await answer(f, 'Approve')
    await f.controller.apply({ type: 'host-operation-started', operation: { id: HostOperationId(randomUUID()), kind: 'diagnostic', status: 'Running', result: null, error: null } })
    const before = f.controller.state
    expect((await call(f.root.scoped, f.root.agent, 'rg_recover', {})).isError).toBe(false)
    f.root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Show the interrupted host-task confirmation card.' }] }))
    await f.root.agent.whenIdle()
    expect(card(f).questions[0]!.options![0]!.description).toContain('Interrupted operation: diagnostic')
    await answer(f, 'Confirm previous processes stopped')
    expect(f.controller.state.hostOperation?.status).toBe('Interrupted')
    expect(f.controller.state.phase).toBe(before.phase)
    expect(f.controller.state.executionWindow).toEqual(before.executionWindow)
    expect(f.controller.state.executionMs).toBe(before.executionMs)
    expect(f.controller.state.questions!.find(item => item.kind === 'host-recovery')).toMatchObject({ status: 'committed', receipt: { source: 'session-user-question-reply' } })
    expect(f.order).toEqual([])
  })
  it('requires and consumes a separate handoff card once for the exact Passed candidate', async () => {
    const f = await buttonSetup('native')
    await start(f); await answer(f, 'Approve'); await answer(f, 'Authorize')
    expect(f.controller.state.phase).toBe('Ready for Handoff')
    const candidate = f.controller.state.snapshot!, elapsed = f.controller.state.executionMs
    expect((await call(f.root.scoped, f.root.agent, 'rg_handoff', {})).isError).toBe(true)
    expect((await call(f.root.scoped, f.root.agent, 'rg_request_operation', { kind: 'handoff' })).isError).toBe(false)
    f.root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Show only the separately requested handoff card.' }] }))
    await f.root.agent.whenIdle()
    expect(card(f).questions[0]!.options![0]!.description).toContain(candidate.treeId)
    await answer(f, 'Authorize')
    expect(f.controller.state.phase).toBe('Ready for Handoff')
    expect((await call(f.root.scoped, f.root.agent, 'rg_handoff', {})).isError).toBe(false)
    expect(f.controller.state.phase).toBe('Completed')
    expect(f.controller.state.operationAuthorization).toMatchObject({ kind: 'handoff', status: 'consumed', receipt: { source: 'session-user-question-reply' } })
    expect(f.controller.state.snapshot).toEqual(candidate)
    expect(f.controller.state.executionMs).toBe(elapsed)
    expect((await call(f.root.scoped, f.root.agent, 'rg_handoff', {})).isError).toBe(true)
    expect(f.order).toEqual(['implementation', 'review'])
  })
})

describe('v5 permissions and native continued-card restoration', () => {
  it.each(['execution', 'handoff'] as const)('refuses a same-live v5 legacy grant at every %s consumption entry in buttons mode', async kind => {
    const f = await fixture(undefined, 'main', true, { confirmationMode: 'buttons' }), ctx = await f.start(), root = await main(ctx, f.root)
    root.scoped.tools.presentAs('native')
    const records = [recordSchema.parse({ version: 5, event: readyEvents()[0] })]
    const approval = { id: 'approval-1', kind: 'approval', revision: 1, binding: questionBinding(replay(records)), phase: 'Awaiting Approval', askedAt: 0, afterSeq: -1,
      question: 'Historical approval', detail: 'Exact previous scope', options: [{ label: 'Approve' }], status: 'pending' }
    const approvalInput = root.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({ reviewGatedAnswer: { questionId: 'approval-1', selected: 'Approve' } }) }] }), { surfaceOp: 'append' })
    records.push(recordSchema.parse({ version: 5, event: { type: 'question-opened', question: approval } }), recordSchema.parse({ version: 5, event: { type: 'question-returned', questionId: 'approval-1', serviceAnswer: { selected: 'Approve', source: 'user-questions-service-unattributed', receivedAt: 0 } } }), recordSchema.parse({ version: 5, event: { type: 'question-confirmed', questionId: 'approval-1', selected: 'Approve', receipt: { seq: approvalInput.seq, receivedAt: approvalInput.time, source: 'session-user-message' } } }))
    if (kind === 'handoff') records.push(...readyEvents().slice(2).map(event => recordSchema.parse({ version: 5, event })))
    const initial = replay(records), request = { id: OperationRequestId(randomUUID()), kind, mode: kind === 'handoff' ? 'handoff' as const : 'implement-verify-review' as const,
      revision: 1, binding: questionBinding(initial), askedAt: 0, afterSeq: approvalInput.seq, status: 'pending' as const }
    const human = root.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({ reviewGatedOperation: { requestId: request.id, selected: 'Authorize' } }) }] }), { surfaceOp: 'append' })
    records.push(recordSchema.parse({ version: 5, event: { type: 'operation-requested', request } }), recordSchema.parse({ version: 5, event: { type: 'operation-confirmed', requestId: request.id, ...operationReceipt(root.agent.session, request, human.seq) } }))
    const state = replay(records), domain = ctx.storageDomain.get(workflowDomain.name)!, table = domain.table('sessions'), empty = journalSchema.parse(table.get(root.agent.id))
    await table.put(root.agent.id, journalSchema.parse({ ...empty, records, state, baseCommit: state.snapshot?.baseCommit ?? null, repository: state.snapshot?.repository ?? null }))
    const controller = ctx.reviewGatedJournals.controller(root.agent.session)
    expect(() => requireOperationPermission(controller.state, root.agent.session, kind, 'buttons')).toThrow('Legacy permission')
    const operation = kind === 'handoff' ? ctx.reviewGatedExecution.handoff(root.agent, new AbortController().signal) : ctx.reviewGatedExecution.execute(root.agent, new AbortController().signal)
    await expect(operation).rejects.toThrow('Legacy permission')
    const mutation = kind === 'handoff' ? { type: 'authorized-handoff-completed' as const, requestId: request.id, snapshotId: snapshot.id, treeId: snapshot.treeId, briefRevision: 1 }
      : { type: 'authorized-execution-started' as const, requestId: request.id, id: 'blocked-host-task' }
    await expect(controller.apply(mutation)).rejects.toThrow('Button mode')
    expect(controller.state.phase).toBe(kind === 'handoff' ? 'Ready for Handoff' : 'Approved')
    expect(controller.state.operationAuthorization?.status).toBe('granted')
  })
  it('accepts only a fresh public UI reply to the exact native card after real Session crash repair', async () => {
    const f = await buttonSetup('native', false)
    await start(f)
    const pending = card(f), callEvent = f.root.agent.session.snapshotEvents().findLast(event => event.type === 'tool/call' && event.data.callId === pending.callId)!
    await f.ctx.sessions.flush(f.root.agent.session)
    await f.ctx.fiber.dispose()
    const sessions = join(f.f.root, 'sessions'), paths = await readdir(sessions, { recursive: true })
    const log = paths.find(path => path.includes(f.root.agent.id) && path.endsWith('.jsonl'))!
    expect(log).toBeDefined()
    const absolute = resolve(sessions, log)
    expect(relative(sessions, absolute).startsWith('..')).toBe(false)
    const lines = (await readFile(absolute, 'utf8')).trimEnd().split(String.fromCharCode(10))
    const index = lines.findIndex(line => { const event = JSON.parse(line); return event.type === 'tool/call' && event.seq === callEvent.seq })
    expect(index).toBeGreaterThan(0)
    await writeFile(absolute, lines.slice(0, index + 1).join(String.fromCharCode(10)) + String.fromCharCode(10))
    const restarted = await f.f.start(), restored = await main(restarted, f.repository, f.root.agent.id, 'review-gated', true, { provider: 'scripted', model: 'fixture' })
    restored.scoped.tools.presentAs('native')
    const repaired = restored.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === pending.callId)
    expect(repaired?.type === 'tool/result' && repaired.data.error?.code).toBe(TOOL_OUTCOME_UNKNOWN)
    const continued = restarted.sessionProjections.stateOf(restored.agent.session, 'userQuestions')!.questions.active.find(item => item.callId === pending.callId)!
    expect(continued.state).toBe('continued')
    let invoked = false
    restarted.llm.registerAdapter(['scripted'], new class extends LlmAdapter {
      override async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
        if (!invoked) {
          invoked = true
          const reply = restarted.reviewGatedJournals.view(restored.agent.session).decisionEvidence.pending[0]!.availableUserConfirmation!
          expect(reply).not.toBeNull()
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'rg_confirm_question', arguments: JSON.stringify({ questionId: continued.questions[0]!.id, userMessageSeq: reply.userMessageSeq }) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Requirements approved; no execution authorized.' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    })
    expect(restarted.userQuestions.answer(restored.agent, pending.callId, { answers: [{ id: continued.questions[0]!.id, selected: ['Approve'] }] })).toBe(true)
    await restored.agent.whenIdle()
    const state = restarted.reviewGatedJournals.view(restored.agent.session).state
    expect(state.phase).toBe('Approved')
    expect(state.questions![0]!.receipt!.seq).toBeGreaterThanOrEqual(restored.agent.session.firstLiveSeq)
    expect(state.questions![0]!.receipt!.source).toBe('session-user-question-reply')
    expect(state.operationAuthorization).toBeUndefined()
    expect(state.implementation).toBeNull()
  })
})
