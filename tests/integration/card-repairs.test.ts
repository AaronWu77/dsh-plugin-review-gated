/** Synthetic released histories restore through real Loader stores; subsequent decisions use the public continued-UI reply path. */
import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { workflowDomain, journalSchema } from '../../dist/storage/journal.js'
import { recordSchema } from '../../dist/workflow/types.js'
import type { WorkflowRecord } from '../../dist/workflow/types.js'
import { replay } from '../../dist/workflow/controller.js'
import { questionBinding, needsQuestionRefresh } from '../../dist/workflow/questions.js'
import { confirmationQuestions } from '../../dist/workflow/interaction.js'
import { fixture, main, call } from '../fixtures/runtime.js'
import { git } from '../fixtures/buttons.js'
import { brief, readyEvents, passed, finding } from '../fixtures/workflow.js'

async function restore(mode: 'native' | 'ptc', build: (repository: string, base: string, tree: string) => WorkflowRecord[], historicalInput: string, candidate = false) {
  const f = await fixture(undefined, undefined, true, { bundle: true, confirmationMode: 'buttons', mainPtcSimulation: true, commandSimulation: true })
  const repository = join(f.root, 'repository')
  await mkdir(join(repository, 'src'), { recursive: true })
  await writeFile(join(repository, 'src/export.txt'), 'baseline')
  await git(repository, 'init', '--quiet'); await git(repository, 'add', '--', 'src/export.txt')
  await git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture baseline')
  const base = (await git(repository, 'rev-parse', 'HEAD')).stdout.trim()
  if (candidate) { await writeFile(join(repository, 'src/export.txt'), 'candidate'); await git(repository, 'add', '--', 'src/export.txt') }
  const tree = (await git(repository, 'write-tree')).stdout.trim()
  const initial = await f.start(), old = await main(initial, repository, randomUUID(), 'review-gated', false, { provider: 'scripted', model: 'fixture' })
  const input = old.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: historicalInput }] }), { surfaceOp: 'append' })
  const records = build(repository, base, tree), state = replay(records), table = initial.storageDomain.get(workflowDomain.name)!.table('sessions')
  await table.put(old.agent.id, journalSchema.parse({ ...journalSchema.parse(table.get(old.agent.id)), records, state, baseCommit: state.snapshot?.baseCommit ?? null, repository: state.snapshot?.repository ?? null }))
  await initial.sessions.flush(old.agent.session); await initial.fiber.dispose()
  const ctx = await f.start(), created: string[] = []
  ctx.on('agent/created', ({ agent }) => { created.push(agent.id); return undefined })
  const root = await main(ctx, repository, old.agent.id, 'review-gated', true, { provider: 'scripted', model: 'fixture' })
  root.scoped.tools.presentAs(mode)
  const controller = ctx.reviewGatedJournals.controller(root.agent.session)
  let steps = 0
  ctx.llm.registerAdapter(['scripted'], new class extends LlmAdapter {
    override async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
      if (++steps > 30) throw new Error('Card-only scripted Main failed to stop at the current decision')
      const state = controller.state, view = ctx.reviewGatedJournals.view(root.agent.session)
      const confirmation = view.decisionEvidence.pending.find(item => item.availableUserConfirmation)
      const legacy = state.questions?.find(question => needsQuestionRefresh(question)), questions = confirmationQuestions(state)
      let action: { name: string; arguments: string } | undefined
      if (state.hostOperation?.status === 'Running' && ctx.reviewGatedTasks.running(root.agent)) action = { name: 'rg_wait', arguments: JSON.stringify({ id: state.hostOperation.id, waitMs: 10000 }) }
      else if (confirmation?.availableUserConfirmation) action = { name: 'rg_confirm_question', arguments: JSON.stringify({ questionId: confirmation.questionId, userMessageSeq: confirmation.availableUserConfirmation.userMessageSeq }) }
      else if (legacy) action = { name: legacy.kind === 'approval' ? 'rg_start' : 'rg_recover', arguments: JSON.stringify(legacy.kind === 'approval' ? { operation: 'approval', revision: legacy.revision } : {}) }
      else if (questions.length && !ctx.sessionProjections.stateOf(root.agent.session, 'userQuestions')!.questions.active.some(card => card.state === 'continued' && isDeepStrictEqual(card.questions, questions.map(({ multi_select, ...item }) => ({ ...item, multiSelect: multi_select }))))) action = { name: 'ask_user_question', arguments: JSON.stringify({ questions }) }
      if (action) {
        const actual = mode === 'native' ? action : { name: 'run_code', arguments: JSON.stringify({ code: 'return await tools.' + action.name + '(' + action.arguments + ')', description: 'Show or record the requested recovery decision only' }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), ...actual } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Waiting for the current card or stopped without further work.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  })
  const show = async () => {
    root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Show only the current decision card; do not execute or hand off.' }] }))
    await root.agent.whenIdle()
    return ctx.sessionProjections.stateOf(root.agent.session, 'userQuestions')!.questions.active.find(card => card.state === 'continued' && isDeepStrictEqual(card.questions, confirmationQuestions(controller.state).map(({ multi_select, ...question }) => ({ ...question, multiSelect: multi_select }))))!
  }
  const answer = async (selected: string) => {
    const card = ctx.sessionProjections.stateOf(root.agent.session, 'userQuestions')!.questions.active.find(item => item.state === 'continued' && isDeepStrictEqual(item.questions, confirmationQuestions(controller.state).map(({ multi_select, ...question }) => ({ ...question, multiSelect: multi_select }))))!
    expect(ctx.userQuestions.answer(root.agent, card.callId, { answers: [{ id: card.questions[0]!.id, selected: [selected] }] })).toBe(true)
    await root.agent.whenIdle()
  }
  const invoke = (name: string, args: object) => mode === 'native' ? call(root.scoped, root.agent, name, args)
    : call(root.scoped, root.agent, 'run_code', { code: 'return await tools.' + name + '(' + JSON.stringify(args) + ')', description: 'Operate only the explicitly requested private fixture decision' })
  return { ctx, root, repository, controller, records, input, created, show, answer, invoke }
}

for (const mode of ['native', 'ptc'] as const) describe('restored cards (' + mode + ')', () => {
  it.each(['pending', 'service-returned'] as const)('replaces a frozen v5 %s proposal and accepts only a fresh card choice', async status => {
    const legacyId = randomUUID()
    const f = await restore(mode, () => {
      const records = [recordSchema.parse({ version: 3, event: { type: 'requirements-submitted', brief } })]
      const question = { id: legacyId, kind: 'approval', revision: 1, phase: 'Awaiting Approval', binding: questionBinding(replay(records)), askedAt: 0, afterSeq: -1,
        question: 'Approve this exact development brief?', detail: JSON.stringify(brief) + '\nThis service response does not record who answered. To commit this decision, send a new user message containing exactly: ' + JSON.stringify({ reviewGatedAnswer: { questionId: legacyId, selected: '<one exact option label>' } }), options: [{ label: 'Approve' }, { label: 'Reject and revise' }], status: 'pending' }
      records.push(recordSchema.parse({ version: 5, event: { type: 'question-opened', question } }))
      if (status === 'service-returned') records.push(recordSchema.parse({ version: 5, event: { type: 'question-returned', questionId: legacyId, serviceAnswer: { selected: 'Approve', receivedAt: 0, source: 'user-questions-service-unattributed' } } }))
      return records
    }, JSON.stringify({ reviewGatedAnswer: { questionId: legacyId, selected: 'Approve' } }))
    const before = f.controller.state
    expect(f.root.agent.session.firstLiveSeq).toBeGreaterThan(f.input.seq)
    { const denied = await f.invoke('rg_confirm_question', { questionId: legacyId, userMessageSeq: f.input.seq }); expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).toContain('Button mode') }
    const card = await f.show()
    expect(card.questions[0]!.id).not.toBe(legacyId)
    expect(JSON.stringify(card.questions)).not.toContain('reviewGatedAnswer')
    expect(card.questions[0]!.options![0]!.description).toContain('Execution budget:')
    await f.answer('Approve')
    expect(f.controller.state.phase).toBe('Approved')
    expect(f.controller.state.questions!.find(question => question.status === 'committed')!.receipt!.source).toBe('session-user-question-reply')
    expect(f.controller.state.questions!.find(question => question.status === 'committed')!.receipt!.seq).toBeGreaterThanOrEqual(f.root.agent.session.firstLiveSeq)
    expect(f.controller.state.executionMs).toBe(before.executionMs)
    expect(f.controller.state.repairRounds).toBe(before.repairRounds)
    expect(f.controller.state.implementation).toBeNull()
    expect(f.created).toEqual([f.root.agent.id])
    const stored = journalSchema.parse(f.ctx.storageDomain.get(workflowDomain.name)!.table('sessions').get(f.root.agent.id)).records
    expect(stored.slice(0, f.records.length)).toEqual(f.records)
    expect(stored.slice(f.records.length).every(record => record.version === 8)).toBe(true)
  })
  it('approves new readable facts that quote the obsolete legacy prompt without a refresh loop', async () => {
    const goal = 'Remove this old instruction:\nThis service response does not record who answered. To commit this decision, send a new user message containing exactly: ' + JSON.stringify({ reviewGatedAnswer: { questionId: 'quoted-old-id', selected: '<one exact option label>' } })
    const f = await restore(mode, () => [recordSchema.parse({ version: 6, event: { type: 'requirements-submitted', brief: { ...brief, goal } } })], 'Historical clarification only.')
    expect((await f.invoke('rg_start', { operation: 'approval', revision: 1 })).isError).toBe(false)
    expect((await f.show()).questions[0]!.options![0]!.description).toContain(goal)
    await f.answer('Approve')
    expect(f.controller.state.phase).toBe('Approved')
    expect(f.controller.state.questions!.filter(question => question.kind === 'approval')).toHaveLength(1)
    expect(f.created).toEqual([f.root.agent.id])
  })
  it('opens the current card beside an older same-ID layout and refuses only the obsolete display', async () => {
    const f = await restore(mode, () => [recordSchema.parse({ version: 6, event: { type: 'requirements-submitted', brief } })], 'Historical clarification only.')
    expect((await f.invoke('rg_start', { operation: 'approval', revision: 1 })).isError).toBe(false)
    if (f.controller.state.hostOperation?.status === 'Running') await f.ctx.reviewGatedTasks.wait(f.root.agent, f.controller.state.hostOperation.id, 10000, new AbortController().signal)
    const current = confirmationQuestions(f.controller.state)[0]!, callId = ToolCallId(randomUUID())
    const older = { ...current, question: current.question + '\n\n' + current.options[0]!.description, options: current.options.map(({ description, ...option }) => option) }
    f.root.agent.session.append('tool/ptc-dispatch', { rootCallId: ToolCallId(randomUUID()), parentCallId: ToolCallId(randomUUID()), subCallId: callId, name: 'ask_user_question', arguments: { questions: [older] }, isError: false, content: [{ type: 'text', text: JSON.stringify({ pending: true, callId }) }] })
    const replacement = await f.show()
    expect(replacement.callId).not.toBe(callId)
    expect(replacement.questions[0]!.question).toBe(current.question)
    expect(f.ctx.userQuestions.answer(f.root.agent, callId, { answers: [{ id: current.id, selected: ['Approve'] }] })).toBe(true)
    await f.root.agent.whenIdle()
    expect(f.controller.state.phase).toBe('Awaiting Approval')
    expect(f.controller.state.approval).toBeNull()
    await f.answer('Approve')
    expect(f.controller.state.phase).toBe('Approved')
    expect(f.controller.state.questions![0]!.receipt!.source).toBe('session-user-question-reply')
    expect(f.created).toEqual([f.root.agent.id])
  })
  it.each(['Implemented', 'Needs Changes', 'Ready for Handoff'] as const)('reconciles host then window after restore at %s without restarting or refunding time', async phase => {
    const f = await restore(mode, (repository, base, tree) => {
      const events = structuredClone(readyEvents().slice(0, phase === 'Implemented' ? 4 : 8))
      if (phase === 'Needs Changes') events[events.length - 1] = { type: 'review-finished', runId: 'review-1', result: { ...passed, outcome: 'Needs Changes', findings: [finding] }, elapsedMs: 10 }
      for (const event of events) if (event.type === 'snapshot-created') event.snapshot = { ...event.snapshot, repository, baseCommit: base, treeId: tree, changedPaths: ['src/export.txt'], fileDigests: [{ path: 'src/export.txt', sha256: createHash('sha256').update('candidate').digest('hex') }] }
      for (const event of events) if (event.type === 'verification-recorded') event.evidence.treeId = tree
      for (const event of events) if (event.type === 'review-finished') event.result.treeId = tree
      events.splice(2, 0, { type: 'execution-window-started', id: 'old-execution' })
      return [...events.map(event => recordSchema.parse({ version: 6, event })), recordSchema.parse({ version: 6, event: { type: 'host-operation-started', operation: { id: randomUUID(), kind: 'execution', status: 'Running', result: null, error: null } } })]
    }, 'Historical task was interrupted; no new execution was requested.', true)
    const before = f.controller.state
    { const result = await f.invoke( 'rg_recover', {}); expect(result.isError, JSON.stringify(result)).toBe(false) }
    expect((await f.show()).questions[0]!.options![0]!.description).toContain('resolves the host-task marker')
    await f.answer('Confirm previous processes stopped')
    expect(f.controller.state.hostOperation?.status).toBe('Interrupted')
    expect(f.controller.state.phase).toBe(phase)
    expect(f.controller.state.executionWindow).toEqual(before.executionWindow)
    { const result = await f.invoke( 'rg_recover', {}); expect(result.isError, JSON.stringify(result)).toBe(false) }
    expect((await f.show()).questions[0]!.options![0]!.description).toContain('unaccounted time consumes remaining budget')
    await f.answer('Confirm previous processes stopped')
    const state = f.controller.state
    expect(state.phase).toBe('Paused')
    expect(state.executionWindow).toBeUndefined()
    expect(state.executionWallMs).toBe(brief.executionBudgetMs)
    expect(state.executionMs).toBe(before.executionMs)
    expect(state.repairRounds).toBe(before.repairRounds)
    expect(state.snapshot).toEqual(before.snapshot)
    expect(state.review).toEqual(before.review)
    expect(f.created).toEqual([f.root.agent.id])
    expect((await f.invoke( 'rg_execute', {})).isError).toBe(true)
    expect((await f.invoke( 'rg_handoff', {})).isError).toBe(true)
    expect((await git(f.repository, 'status', '--short')).stdout.trim()).toBe('M  src/export.txt')
    expect(journalSchema.parse(f.ctx.storageDomain.get(workflowDomain.name)!.table('sessions').get(f.root.agent.id)).records.slice(0, f.records.length)).toEqual(f.records)
    expect((await f.invoke( 'rg_cancel', { reason: 'Finish only this private recovered fixture' })).isError).toBe(false)
    expect(f.controller.state.phase).toBe('Cancelled')
  })
})
