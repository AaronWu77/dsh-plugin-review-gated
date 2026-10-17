import { describe, expect, it } from 'vitest'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { HostTasks } from '../../src/workflow/tasks.js'
import { roleInstructions } from '../../src/roles/instructions.js'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence-jsonl'
import { HostOperationId } from '../../src/workflow/types.js'
import { brief, readyEvents, snapshot } from '../fixtures/workflow.js'
import { fixture, main, call, confirm } from '../fixtures/runtime.js'
const lifetime = () => new AbortController()
async function setup() {
  const f = await fixture(undefined, undefined, false, { bundle: true }), ctx = await f.start(), root = await main(ctx, f.root)
  root.scoped.tools.presentAs('native')
  return { f, ctx, root, tasks: ctx.reviewGatedTasks, controller: ctx.reviewGatedJournals.controller(root.agent.session) }
}
describe('bounded host tasks in the real shipped Loader composition', () => {
  it('returns approval identity before the human answers and completes through bounded observation', async () => {
    const { ctx, root, tasks, controller } = await setup()
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    const shown = Promise.withResolvers<void>(), answer = Promise.withResolvers<void>()
    ctx.on('user-questions/request', async request => { shown.resolve(); await answer.promise; return { answers: [{ id: request.questions[0]!.id, selected: ['Approve'] }] } })
    const started = await call(root.scoped, root.agent, 'rg_start', { operation: 'approval', revision: 1 })
    expect(started.isError).toBe(false)
    const { z } = await import('zod')
    const summary = z.object({ workflow: z.object({ state: z.object({ phase: z.literal('Awaiting Approval'), approval: z.null() }), recordCount: z.number() }) }).parse(started.value)
    expect(summary.workflow.recordCount).toBeGreaterThan(0)
    const id = controller.state.hostOperation!.id
    const observed = await call(root.scoped, root.agent, 'rg_wait', { id, waitMs: 0 })
    expect(observed.isError).toBe(false)
    z.object({ workflow: z.object({ state: z.object({ phase: z.literal('Awaiting Approval') }) }) }).parse(observed.value)
    try {
      await shown.promise
      expect(controller.state.phase).toBe('Awaiting Approval')
      expect((await tasks.wait(root.agent, id, 0, lifetime().signal)).status).toBe('Running')
      answer.resolve()
      const result = await tasks.wait(root.agent, id, 10000, lifetime().signal)
      expect(result).toMatchObject({ status: 'Completed', result: { needsConfirmation: true } })
      expect(controller.state.phase).toBe('Awaiting Approval')
      const question = controller.state.questions!.at(-1)!
      expect((await confirm(root.scoped, root.agent, question.id, 'Approve')).result.isError).toBe(false)
      expect(controller.state.phase).toBe('Approved')
    } finally { answer.resolve(); await tasks.cancel(root.agent, 'fixture cleanup') }
  })
  it('cancels an observer without cancelling the Main-owned operation and rejects another owner', async () => {
    const { ctx, f, root, tasks, controller } = await setup(), release = Promise.withResolvers<string>()
    const operation = await tasks.start(root.agent, 'diagnostic', lifetime().signal, () => release.promise)
    try {
      const observer = lifetime(), waited = tasks.wait(root.agent, operation.id, 10000, observer.signal)
      observer.abort(new Error('observer stopped'))
      await expect(waited).rejects.toThrow('observer stopped')
      expect(tasks.running(root.agent)).toBe(true)
      const other = await main(ctx, f.root)
      await expect(tasks.wait(other.agent, operation.id, 0, lifetime().signal)).rejects.toThrow('does not belong')
      await expect(tasks.start(root.agent, 'diagnostic', lifetime().signal, async () => null)).rejects.toThrow('existing host task')
      release.resolve('retained result')
      expect(await tasks.wait(root.agent, operation.id, 10000, lifetime().signal)).toMatchObject({ status: 'Completed', result: 'retained result' })
      expect(controller.state.hostOperation!.id).toBe(operation.id)
    } finally { release.resolve('cleanup'); await tasks.cancel(root.agent, 'cleanup') }
  })
  it('explicit cancellation waits for underlying activity to settle and persists cancellation', async () => {
    const { root, tasks, controller } = await setup(), entered = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>()
    const operation = await tasks.start(root.agent, 'diagnostic', lifetime().signal, async signal => {
      entered.resolve()
      await new Promise<void>((resolve, reject) => signal.addEventListener('abort', () => { drained.resolve(); reject(signal.reason) }, { once: true }))
      return null
    })
    await entered.promise
    await tasks.cancel(root.agent, 'human cancel')
    await drained.promise
    expect(tasks.running(root.agent)).toBe(false)
    expect(await tasks.wait(root.agent, operation.id, 0, lifetime().signal)).toMatchObject({ status: 'Cancelled', error: 'human cancel' })
    expect(controller.state.hostOperation!.status).toBe('Cancelled')
  })
  it('aborts and drains on Main disposal without depending on effect ordering', async () => {
    const { root, tasks, controller } = await setup(), entered = Promise.withResolvers<void>()
    await tasks.start(root.agent, 'diagnostic', lifetime().signal, async signal => {
      entered.resolve(); await new Promise<void>((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return null
    })
    await entered.promise
    await root.handle.dispose()
    expect(tasks.running(root.agent)).toBe(false)
    expect(controller.state.hostOperation!.status).toBe('Cancelled')
  })
  it('bounds the complete multibyte result and persists a failure instead of a partial value', async () => {
    const { ctx, root, controller } = await setup()
    const tasks = new HostTasks(ctx, { maxWaitMs: 1000, maxResultBytes: 5, maxOperationMs: 10000 })
    try {
      const operation = await tasks.start(root.agent, 'diagnostic', lifetime().signal, async () => '汉汉')
      expect(await tasks.wait(root.agent, operation.id, 1000, lifetime().signal)).toMatchObject({ status: 'Failed', result: null, error: 'Host task result byte limit exceeded' })
      expect(controller.state.hostOperation!.result).toBeNull()
    } finally { await tasks.close() }
  })
  it('never resumes a restored Running task and requires an exact human quiescence choice', async () => {
    const { ctx, root, tasks, controller } = await setup()
    const id = HostOperationId('11111111-1111-4111-8111-111111111111')
    await controller.apply({ type: 'host-operation-started', operation: { id, kind: 'approval', status: 'Running', result: null, error: null } })
    expect(tasks.running(root.agent)).toBe(false)
    expect((await tasks.wait(root.agent, id, 0, lifetime().signal)).status).toBe('Running')
    const leave = ctx.on('user-questions/request', async request => ({ answers: [{ id: request.questions[0]!.id, selected: ['Leave unresolved'] }] }))
    await tasks.recover(root.agent, lifetime().signal)
    expect(controller.state.hostOperation!.status).toBe('Running')
    const leaveQuestion = controller.state.questions!.find(item => item.status === 'service-returned')!
    expect((await confirm(root.scoped, root.agent, leaveQuestion.id, 'Leave unresolved')).result.isError).toBe(false)
    leave()
    const invalid = ctx.on('user-questions/request', async request => ({ answers: [{ id: request.questions[0]!.id, selected: ['Confirm previous processes stopped'], custom: 'perhaps' }] }))
    await expect(tasks.recover(root.agent, lifetime().signal)).rejects.toThrow('one exact current option'); invalid()
    ctx.on('user-questions/request', async request => ({ answers: [{ id: request.questions[0]!.id, selected: ['Confirm previous processes stopped'] }] }))
    expect((await tasks.recover(root.agent, lifetime().signal))).toBe(true)
    const recoveryQuestion = controller.state.questions!.find(item => item.status === 'service-returned')!
    expect((await confirm(root.scoped, root.agent, recoveryQuestion.id, 'Confirm previous processes stopped')).result.isError).toBe(false)
    expect(controller.state.hostOperation).toMatchObject({ id, status: 'Interrupted', result: null })
    expect(controller.state.phase).toBe('Clarifying')
  })
  it('creates a host-only diagnostic child with read-only authority and structured findings', async () => {
    const { ctx, root, tasks, controller } = await setup()
    const finding = { summary: 'Read-only fixture investigation', findings: [{ file: 'src/example.ts', line: 1, message: 'Observed fixture issue', evidence: 'Recorded source observation' }], limitations: ['Scripted model'] }
    class DiagnosticAdapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        expect(JSON.stringify(options.messages)).toContain('read-only diagnostic task')
        expect(JSON.stringify(options.messages)).toContain(roleInstructions('diagnostic'))
        yield { type: 'block-start', index: 1, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 1, text: 'fixture metadata' }
        yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'fixture metadata' } }
        const text = JSON.stringify(finding)
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['diagnostic-fixture'], new DiagnosticAdapter())
    const diagnosticRoot = await main(ctx, root.agent.session.header.cwd!, undefined, 'review-gated', false, { provider: 'diagnostic-fixture', model: 'fixture' })
    diagnosticRoot.scoped.tools.presentAs('native')
    let childId: SessionId | undefined
    ctx.on('agent/created', async ({ agent }) => {
      if (agent.session.header.agentPreset !== 'review-gated-diagnostic') return
      childId = agent.id
      expect(ctx.reviewGatedPermissions.of(agent.session)?.policy.mode).toBe('read-only')
      agent.ctx.tools.presentAs('native')
      const denied = await call(agent.ctx, agent, 'write', { file_path: 'outside', content: 'forbidden' })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).toContain('not available')
    })
    await expect(ctx.reviewGatedRoles.diagnose({ parent: root.agent, question: 'unowned', budgetMs: 1000, signal: lifetime().signal })).rejects.toThrow('durable Main-owned')
    expect((await call(diagnosticRoot.scoped, diagnosticRoot.agent, 'rg_start', { operation: 'diagnostic', question: 'Investigate without changing files' })).isError).toBe(false)
    const operation = ctx.reviewGatedJournals.controller(diagnosticRoot.agent.session).state.hostOperation!
    const result = await tasks.wait(diagnosticRoot.agent, operation.id, 10000, lifetime().signal)
    expect(result).toMatchObject({ status: 'Completed', result: finding })
    expect(childId).toBeDefined()
    if (!childId) throw new Error('Diagnostic child was not published')
    expect(ctx.agents.get(childId)).toBeUndefined()
    const persisted = await ctx.sessionPersistence.open(childId, 'read')
    try {
      const log = await persisted.read()
      const input = log.events.find(event => event.type === 'user/message')
      expect(input?.type).toBe('user/message')
      if (input?.type === 'user/message') {
        expect(JSON.stringify(input.data.content)).toContain(roleInstructions('diagnostic'))
        expect(JSON.stringify(input.data.content)).toContain('including pwsh')
      }
    } finally { await persisted.close() }
    expect(controller.state.phase).toBe('Clarifying')
    expect(ctx.reviewGatedJournals.controller(diagnosticRoot.agent.session).state.phase).toBe('Clarifying')
  })
  it('refuses handoff when the host execution remains running or failed', async () => {
    const { controller, ctx, root } = await setup()
    await ctx.reviewGatedJournals.bindBase(root.agent.session, snapshot.baseCommit, snapshot.repository)
    for (const event of readyEvents()) await controller.apply(event)
    const operation = { id: HostOperationId('22222222-2222-4222-8222-222222222222'), kind: 'execution' as const, status: 'Running' as const, result: null, error: null }
    await controller.apply({ type: 'host-operation-started', operation })
    const handoff = { type: 'handoff-completed' as const, snapshotId: snapshot.id, treeId: snapshot.treeId, briefRevision: 1 }
    await expect(controller.apply(handoff)).rejects.toThrow('settle successfully')
    await controller.apply({ type: 'host-operation-finished', operation: { ...operation, status: 'Failed', error: 'failed' } })
    await expect(controller.apply(handoff)).rejects.toThrow('settle successfully')
  })
})
