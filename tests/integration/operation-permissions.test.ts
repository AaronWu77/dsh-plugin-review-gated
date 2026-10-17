/** Built YAML composition, scripted role outputs and genuine public input events; not live-model acceptance. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { fixture, main, call, confirm, permission } from '../fixtures/runtime.js'
import { brief } from '../fixtures/workflow.js'
import { journalSchema, workflowDomain } from '../../dist/storage/journal.js'
import { OperationRequestId } from '../../src/workflow/authorization.js'
const signal = () => new AbortController().signal
const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-c', 'core.autocrlf=false', ...args], { cwd, timeout: 10000, env: { ...process.env, GIT_CONFIG_GLOBAL: '', GIT_CONFIG_SYSTEM: '' } })
const human = (session: Session, text: string) => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
const exact = (requestId: string, selected = 'Authorize') => JSON.stringify({ reviewGatedOperation: { requestId, selected } })
async function setup(configure?: (ctx: Context, repository: string) => void) {
  const f = await fixture(undefined, 'main', true, { commandSimulation: true }), repository = join(f.root, 'repository')
  await mkdir(join(repository, 'src'), { recursive: true }); await writeFile(join(repository, 'src/export.txt'), 'base\n')
  await git(repository, 'init', '--quiet'); await git(repository, 'add', '--', 'src/export.txt')
  await git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'private baseline')
  const ctx = await f.start()
  configure?.(ctx, repository)
  const root = await main(ctx, repository, randomUUID(), 'review-gated', false, configure ? { provider: 'scripted-review', model: 'fixture' } : undefined)
  root.scoped.tools.presentAs('native')
  ctx.on('user-questions/request', async request => ({ answers: [{ id: request.questions[0]!.id, selected: ['Approve'] }] }))
  expect((await call(root.scoped, root.agent, 'rg_submit_brief', { brief })).isError).toBe(false)
  expect((await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })).isError).toBe(false)
  const controller = ctx.reviewGatedJournals.controller(root.agent.session)
  expect((await confirm(root.scoped, root.agent, controller.state.questions![0]!.id, 'Approve')).result.isError).toBe(false)
  return { f, repository, ctx, root, controller }
}

describe('one-use permission through real Loader and direct services', () => {
  it('approval-only confirmation blocks all execution entries before a host task or role starts', async () => {
    const { ctx, root, controller } = await setup(), before = controller.state
    const roles = vi.spyOn(ctx.reviewGatedRoles, 'run'), checks = vi.spyOn(ctx.reviewGatedVerification, 'run')
    expect((await call(root.scoped, root.agent, 'rg_start', { operation: 'execution' })).isError).toBe(true)
    expect((await call(root.scoped, root.agent, 'rg_execute', {})).isError).toBe(true)
    await expect(ctx.reviewGatedExecution.execute(root.agent, signal())).rejects.toThrow('separate current logged')
    expect(controller.state).toEqual(before); expect(controller.state.phase).toBe('Approved')
    expect(roles).not.toHaveBeenCalled(); expect(checks).not.toHaveBeenCalled()
    expect(controller.state.executionWindow).toBeUndefined(); expect(controller.state.hostOperation).toBeUndefined()
  })
  it('request and confirmation only record permission, never start roles or checks', async () => {
    const { ctx, root, controller } = await setup(), before = controller.state
    const roles = vi.spyOn(ctx.reviewGatedRoles, 'run'), checks = vi.spyOn(ctx.reviewGatedVerification, 'run')
    expect((await call(root.scoped, root.agent, 'rg_request_operation', { kind: 'execution' })).isError).toBe(false)
    const request = controller.state.operationAuthorization!
    expect(request).toMatchObject({ status: 'pending', mode: 'implement-verify-review' })
    expect((await call(root.scoped, root.agent, 'rg_start', { operation: 'execution' })).isError).toBe(true)
    const input = human(root.agent.session, exact(request.id))
    expect((await call(root.scoped, root.agent, 'rg_confirm_operation', { requestId: request.id, userMessageSeq: input.seq })).isError).toBe(false)
    expect(controller.state).toMatchObject({ phase: 'Approved', executionMs: before.executionMs, repairRounds: before.repairRounds, operationAuthorization: { status: 'granted', receipt: { seq: input.seq } } })
    expect(roles).not.toHaveBeenCalled(); expect(checks).not.toHaveBeenCalled()
  })
  it('does not infer permission from user text, invented sequence, model input or a requirements JSON', async () => {
    const { ctx, root, controller } = await setup()
    await ctx.reviewGatedExecution.requestOperation(root.agent, 'execution', signal())
    const request = controller.state.operationAuthorization!, before = controller.state
    for (const text of ['execute', 'yes', JSON.stringify({ reviewGatedAnswer: { questionId: request.id, selected: 'Approve' } }), exact(randomUUID())]) {
      const input = human(root.agent.session, text)
      await expect(ctx.reviewGatedExecution.confirmOperation(root.agent, request.id, input.seq, signal())).rejects.toThrow()
    }
    const modelInput = root.agent.session.append('user/message', createUserMessage({ source: { kind: 'model', provider: 'fixture', model: 'not-human' }, content: [{ type: 'text', text: exact(request.id) }] }), { surfaceOp: 'append' })
    await expect(ctx.reviewGatedExecution.confirmOperation(root.agent, request.id, modelInput.seq, signal())).rejects.toThrow()
    const input = human(root.agent.session, exact(request.id))
    await expect(ctx.reviewGatedExecution.confirmOperation(root.agent, request.id, input.seq + 100, signal())).rejects.toThrow()
    expect(controller.state).toEqual(before)
  })
  it('rechecks real latest input after the awaited authorization Git preflight', async () => {
    const { ctx, root, controller } = await setup()
    await ctx.reviewGatedExecution.requestOperation(root.agent, 'execution', signal())
    const request = controller.state.operationAuthorization!, input = human(root.agent.session, exact(request.id))
    const imported = await ctx.loader.import(new URL('../../dist/git/snapshots.js', import.meta.url).href) as typeof import('../../dist/git/snapshots.js')
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), original = imported.GitSnapshots.prototype.assertCleanBase
    const spy = vi.spyOn(imported.GitSnapshots.prototype, 'assertCleanBase').mockImplementation(async function (this: import('../../dist/git/snapshots.js').GitSnapshots, approved) {
      entered.resolve(); await release.promise; return original.call(this, approved)
    })
    const pending = ctx.reviewGatedExecution.confirmOperation(root.agent, request.id, input.seq, signal())
    const rejected = expect(pending).rejects.toThrow('latest')
    try { await entered.promise; human(root.agent.session, 'Do not execute'); release.resolve(); await rejected } finally { release.resolve(); spy.mockRestore() }
    expect(controller.state.operationAuthorization!.status).toBe('pending'); expect(controller.state.executionWindow).toBeUndefined()
  })
  it('decline closes the request without cancelling or opening Git', async () => {
    const { ctx, root, controller } = await setup()
    await ctx.reviewGatedExecution.requestOperation(root.agent, 'execution', signal())
    const request = controller.state.operationAuthorization!, input = human(root.agent.session, exact(request.id, 'Decline'))
    const imported = await ctx.loader.import(new URL('../../dist/git/snapshots.js', import.meta.url).href) as typeof import('../../dist/git/snapshots.js')
    const spy = vi.spyOn(imported.GitSnapshots, 'open')
    await ctx.reviewGatedExecution.confirmOperation(root.agent, request.id, input.seq, signal())
    expect(controller.state).toMatchObject({ phase: 'Approved', operationAuthorization: { status: 'declined' } }); expect(spy).not.toHaveBeenCalled()
  })
  it('a later user message withdraws a granted request before any execution starts', async () => {
    const { ctx, root, controller } = await setup()
    await permission(root.scoped, root.agent, 'execution')
    const before = controller.state; human(root.agent.session, 'Stop here')
    expect((await call(root.scoped, root.agent, 'rg_start', { operation: 'execution' })).isError).toBe(true)
    await expect(ctx.reviewGatedExecution.execute(root.agent, signal())).rejects.toThrow('latest')
    expect(controller.state).toEqual(before)
  })
  it('confirmation shutdown does not grant or launch an operation', async () => {
    const { ctx, root, controller } = await setup()
    await ctx.reviewGatedExecution.requestOperation(root.agent, 'execution', signal())
    const request = controller.state.operationAuthorization!, input = human(root.agent.session, exact(request.id)), cancelled = new AbortController()
    cancelled.abort(new Error('cancel authorization'))
    await expect(ctx.reviewGatedExecution.confirmOperation(root.agent, request.id, input.seq, cancelled.signal)).rejects.toThrow()
    expect(controller.state.operationAuthorization!.status).toBe('pending'); expect(controller.state.executionWindow).toBeUndefined()
  })
})

it.each(['unchecked', 'line', 'passed'] as const)('logs real pre-Review host observations and %s result without promoting rejected evidence', async outcome => {
  const observations: unknown[] = []
  const { ctx, root, controller } = await setup((ctx, repository) => {
  ctx.llm.registerAdapter(['scripted-review'], new class extends LlmAdapter {
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      const user = request.messages.filter(message => message.role === 'user').flatMap(message => message.content).find(block => block.type === 'text' && block.text.includes('Task inputs:\n'))
      if (!user || user.type !== 'text') throw new Error('Missing logged role task')
      const input = JSON.parse(user.text.split('Task inputs:\n').at(-1)!)
      let answer: string
      if (!input.snapshot) { await writeFile(join(repository, 'src/export.txt'), 'candidate\n'); answer = JSON.stringify({ outcome: 'Completed', summary: 'Fixture candidate', problems: [], limitations: ['Scripted fixture'] }) }
      else {
        observations.push(input.hostObservations)
        answer = JSON.stringify({ outcome: 'Passed', briefRevision: input.brief.revision, snapshotId: input.snapshot.id, treeId: input.snapshot.treeId,
          findings: [], checked: ['AC1 verified against supplied input'], unchecked: outcome === 'unchecked' ? ['No independent hash process', 'No other Node versions'] : [], reason: 'Scope-specific fixture review',
          acceptance: [{ id: 'AC1', status: 'Passed', evidence: [{ kind: 'source', file: 'src/export.txt', line: outcome === 'line' ? 99999 : 1, explanation: 'Fixture source reference' }] }] })
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }())
  })
  await permission(root.scoped, root.agent, 'execution')
  const result = await call(root.scoped, root.agent, 'rg_start', { operation: 'execution' }); expect(result.isError).toBe(false)
  const id = controller.state.hostOperation!.id
  while (controller.state.hostOperation!.status === 'Running') expect((await call(root.scoped, root.agent, 'rg_wait', { id, waitMs: 10000 })).isError).toBe(false)
  expect(observations).toHaveLength(1)
  expect(observations[0]).toMatchObject({ snapshotId: controller.state.snapshot!.id, treeId: controller.state.snapshot!.treeId, scopeBaseCommit: controller.state.snapshot!.baseCommit, sourceIntegrity: 'checked', allowedScope: 'checked', checkedAt: expect.any(Number) })
  expect(controller.state.operationAuthorization!.status).toBe('consumed')
  if (outcome === 'passed') {
    expect(controller.state.phase).toBe('Ready for Handoff')
    await expect(ctx.reviewGatedExecution.execute(root.agent, signal())).rejects.toThrow('separate current logged')
    await expect(ctx.reviewGatedExecution.handoff(root.agent, signal())).rejects.toThrow('separate current logged')
    await permission(root.scoped, root.agent, 'handoff'); await ctx.reviewGatedExecution.handoff(root.agent, signal())
    expect(controller.state.phase).toBe('Completed'); expect(controller.state.operationAuthorization).toMatchObject({ kind: 'handoff', status: 'consumed' })
  } else {
    expect(controller.state).toMatchObject({ phase: 'Paused', review: null, repairRounds: 0, roleFailures: [{ role: 'review', kind: 'semantic-validation', issues: expect.any(Array) }] })
    const journal = journalSchema.parse(ctx.storageDomain.get(workflowDomain.name)!.table('sessions').get(root.agent.session.id))
    expect(journal.records).toContainEqual({ version: 8, event: { type: 'review-result-rejected', failure: controller.state.roleFailures![0] } })
    const report = await ctx.reviewGatedExecution.report(root.agent, signal())
    expect(report.verificationAndReview.reviewStatus).toBe('not-recorded'); expect(report.problems.roleResultFailures[0]!.kind).toBe('semantic-validation')
    expect(report.completion.currentDeliverableVerified).toBe(false)
  }
})
