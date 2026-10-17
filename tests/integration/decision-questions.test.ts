/** Built-plugin Loader evidence with scripted service replies and public Session user-input events, not natural-person authentication. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '../../src/workflow/execution.js'
import { workflowDomain, journalSchema } from '../../dist/storage/journal.js'
import { replay } from '../../dist/workflow/controller.js'
import { recordSchema } from '../../src/workflow/types.js'
import { GitSnapshots } from '../../dist/git/snapshots.js'
import type { WorkflowEvent, WorkflowRecord } from '../../src/workflow/types.js'
import { brief, readyEvents, snapshot } from '../fixtures/workflow.js'
import { call, fixture, main } from '../fixtures/runtime.js'

const signal = () => new AbortController().signal
const exact = (questionId: string, selected = 'Approve') => JSON.stringify({ reviewGatedAnswer: { questionId, selected } })
function human(session: Session, text: string) {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}
async function setup(admitted = false, maxBytes?: number) {
  const f = await fixture(maxBytes, admitted ? 'main' : undefined, admitted)
  const ctx = await f.start(), root = await main(ctx, f.root)
  root.scoped.tools.presentAs('native')
  return { f, ctx, root }
}
function scripted(ctx: Context, selected = 'Approve') {
  return ctx.on('user-questions/request', async request => ({ answers: [{ id: request.questions[0]!.id, selected: [selected] }] }))
}
async function confirm(root: Awaited<ReturnType<typeof main>>, questionId: string, selected = 'Approve') {
  const event = human(root.agent.session, exact(questionId, selected))
  return { event, result: await call(root.scoped, root.agent, 'rg_confirm_question', { questionId, userMessageSeq: event.seq }) }
}
async function historical(ctx: Context, session: Session, events: WorkflowEvent[], candidate = snapshot) {
  const domain = ctx.storageDomain.get(workflowDomain.name)
  if (!domain) throw new Error('Workflow storage is unavailable')
  const table = domain.table('sessions')
  const empty = table.get(session.id)
  if (!empty) throw new Error('Loader did not initialize fixture journal')
  const records: WorkflowRecord[] = events.map((event, index) => recordSchema.parse({ version: index < 2 ? 1 : index < 4 ? 2 : 3, event }))
  const state = replay(records)
  await table.put(session.id, { ...empty, records, state, baseCommit: state.snapshot ? candidate.baseCommit : null, repository: state.snapshot ? candidate.repository : null })
  return { records, state }
}
const exec = promisify(execFile)
async function git(cwd: string, ...args: string[]) {
  return exec('git', ['-c', 'core.autocrlf=false', ...args], { cwd, timeout: 10000 })
}
async function repositorySetup() {
  const f = await fixture(undefined, 'main', true), repository = join(f.root, 'repository')
  await mkdir(join(repository, 'src'), { recursive: true })
  await writeFile(join(repository, 'src/export.txt'), 'baseline\n')
  await git(repository, 'init', '--quiet')
  await git(repository, 'add', '--', 'src/export.txt')
  await git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture baseline')
  const ctx = await f.start(), root = await main(ctx, repository)
  root.scoped.tools.presentAs('native')
  return { f, ctx, root, repository }
}

describe('decision receipts through real YAML Loader and built plugin', () => {
  it('keeps rg_approve service output pending until an exact new public Session user message commits', async () => {
    const { ctx, root } = await setup()
    scripted(ctx)
    expect((await call(root.scoped, root.agent, 'rg_submit_brief', { brief })).isError).toBe(false)
    const answer = await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
    expect(answer.isError).toBe(false)
    expect(answer.value).toMatchObject({ needsConfirmation: true, state: { phase: 'Awaiting Approval', approval: null } })
    const controller = ctx.reviewGatedJournals.controller(root.agent.session), q = controller.state.questions!.at(-1)!
    expect(q).toMatchObject({ status: 'service-returned', kind: 'approval', serviceAnswer: { selected: 'Approve', source: 'user-questions-service-unattributed' } })
    expect(ctx.reviewGatedJournals.view(root.agent.session).decisionEvidence.pending).toMatchObject([{ questionId: q.id, detail: expect.stringContaining(brief.goal), source: 'unknown', missingSourceNote: expect.stringContaining('No linked logged user') }])
    const { event, result } = await confirm(root, q.id)
    expect(result.isError).toBe(false)
    expect(controller.state).toMatchObject({ phase: 'Approved', approval: { questionId: q.id, revision: 1, approved: true }, questions: [{ status: 'committed', receipt: { seq: event.seq, source: 'session-user-message', receivedAt: event.time } }] })
    expect(ctx.reviewGatedJournals.view(root.agent.session).decisionEvidence.approval).toMatchObject({ questionId: q.id, status: 'committed', source: 'session-user-message', missingSourceNote: null })
    for (const selected of ['Approve', 'Reject and revise']) {
      const duplicate = await confirm(root, q.id, selected)
      expect(duplicate.result.isError).toBe(true)
      expect(controller.state.phase).toBe('Approved')
    }
  })

  it('completes rg_start approval observation without approving or launching a role', async () => {
    const { ctx, root } = await setup()
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    ctx.on('user-questions/request', async request => { entered.resolve(); await release.promise; return { answers: [{ id: request.questions[0]!.id, selected: ['Approve'] }] } })
    const start = await call(root.scoped, root.agent, 'rg_start', { operation: 'approval', revision: 1 })
    expect(start.isError).toBe(false)
    const controller = ctx.reviewGatedJournals.controller(root.agent.session), id = controller.state.hostOperation!.id
    try {
      await entered.promise
      expect(controller.state.approval).toBeNull()
      expect((await ctx.reviewGatedTasks.wait(root.agent, id, 0, signal())).status).toBe('Running')
      release.resolve()
      expect(await ctx.reviewGatedTasks.wait(root.agent, id, 10000, signal())).toMatchObject({ status: 'Completed', result: { needsConfirmation: true } })
      expect(controller.state).toMatchObject({ phase: 'Awaiting Approval', approval: null, activeRunId: null, implementation: null, questions: [{ status: 'service-returned' }] })
      expect(ctx.agents.roots()).toEqual([root.agent])
      const q = controller.state.questions![0]!
      expect((await confirm(root, q.id)).result.isError).toBe(false)
    } finally { release.resolve(); await ctx.reviewGatedTasks.cancel(root.agent, 'fixture cleanup') }
  })

  it('rejects raw tool arguments, wrong session/ID/choice, stale sequence and untrusted sources without guessing', async () => {
    const { ctx, root, f } = await setup(), old = human(root.agent.session, 'Approve')
    scripted(ctx)
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
    const controller = ctx.reviewGatedJournals.controller(root.agent.session), q = controller.state.questions![0]!, before = controller.state
    expect((await call(root.scoped, root.agent, 'rg_confirm_question', { questionId: q.id, userMessageSeq: old.seq, reviewGatedAnswer: { questionId: q.id, selected: 'Approve' } })).isError).toBe(true)
    for (const text of ['yes, go ahead', exact('wrong-id'), exact(q.id, 'Approve (Recommended)'), JSON.stringify({ reviewGatedAnswer: { questionId: q.id, selected: 'Approve', extra: true } })]) {
      const event = human(root.agent.session, text)
      expect((await call(root.scoped, root.agent, 'rg_confirm_question', { questionId: q.id, userMessageSeq: event.seq })).isError).toBe(true)
    }
    const other = await main(ctx, f.root), elsewhere = human(other.agent.session, exact(q.id))
    expect((await call(other.scoped, other.agent, 'rg_confirm_question', { questionId: q.id, userMessageSeq: elsewhere.seq })).isError).toBe(true)
    for (const source of [{ kind: 'model' as const, provider: 'scripted', model: 'fixture' }, { kind: 'tool' as const, callId: ToolCallId(randomUUID()) }]) {
      const event = root.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: exact(q.id) }], source }), { surfaceOp: 'append' })
      expect((await call(root.scoped, root.agent, 'rg_confirm_question', { questionId: q.id, userMessageSeq: event.seq })).isError).toBe(true)
    }
    expect(controller.state).toEqual(before)
    expect((await confirm(root, q.id)).result.isError).toBe(false)
  })

  it('rejects a receipt after the bound phase changes, preserving audit but not approval', async () => {
    const { ctx, root } = await setup()
    scripted(ctx)
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
    const controller = ctx.reviewGatedJournals.controller(root.agent.session), q = controller.state.questions![0]!
    await controller.apply({ type: 'requirements-submitted', brief: { ...brief, revision: 2 } })
    const before = controller.state
    expect((await confirm(root, q.id)).result.isError).toBe(true)
    expect(controller.state).toEqual(before)
  })

  it('persists a failed audit when the question service rejects rather than inferring an answer', async () => {
    const { ctx, root } = await setup()
    ctx.on('user-questions/request', async () => { throw new Error('scripted question service unavailable') })
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    expect((await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })).isError).toBe(true)
    const state = ctx.reviewGatedJournals.controller(root.agent.session).state
    expect(state).toMatchObject({ phase: 'Awaiting Approval', approval: null, questions: [{ status: 'failed', failure: expect.stringContaining('no decision committed') }] })
  })

  it.each(['Approved'] as const)('reconfirms unchanged historical %s without a new revision or runtime reset', async phase => {
    const { ctx, root } = await setup()
    const events = readyEvents().slice(0, phase === 'Approved' ? 2 : 5)

    const history = await historical(ctx, root.agent.session, events), before = history.state
    scripted(ctx)
    expect((await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })).isError).toBe(false)
    const controller = ctx.reviewGatedJournals.controller(root.agent.session), q = controller.state.questions![0]!
    expect(controller.state.phase).toBe(phase)
    expect((await confirm(root, q.id)).result.isError).toBe(false)
    expect(controller.state).toEqual({ ...before, approval: { questionId: q.id, revision: 1, approved: true }, questions: [expect.objectContaining({ status: 'committed' })] })
    const domain = ctx.storageDomain.get(workflowDomain.name)!
    expect(journalSchema.parse(domain.table('sessions').get(root.agent.session.id)).records.slice(0, history.records.length)).toEqual(history.records)
  })

  it.each(['execute', 'handoff'] as const)('denies missing approval receipt through direct %s service and tool paths', async action => {
    const { ctx, root } = await setup(true)
    await historical(ctx, root.agent.session, readyEvents().slice(0, action === 'execute' ? 2 : 8))
    const controller = ctx.reviewGatedJournals.controller(root.agent.session), before = controller.state
    await expect(ctx.reviewGatedExecution[action](root.agent, signal())).rejects.toThrow('logged user confirmation')
    expect(controller.state).toEqual(before)
    expect((await call(root.scoped, root.agent, 'rg_' + action, {})).isError).toBe(true)
    expect(controller.state).toEqual(before)
  })

  it('keeps a recovery service answer paused until a logged retry receipt, with no execution or rechecks', async () => {
    const { ctx, root, repository } = await repositorySetup()
    const old = readyEvents().slice(0, 2)
    old.push({ type: 'paused', reason: 'Historical explicit pause' })
    await historical(ctx, root.agent.session, old)
    let remove = scripted(ctx)
    await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
    const controller = ctx.reviewGatedJournals.controller(root.agent.session), approval = controller.state.questions![0]!
    expect((await confirm(root, approval.id)).result.isError).toBe(false)
    remove(); remove = scripted(ctx, 'Retry unchanged approved brief')
    const before = controller.state, result = await call(root.scoped, root.agent, 'rg_recover', {})
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ needsConfirmation: true })
    expect(controller.state.phase).toBe('Paused')
    const q = controller.state.questions!.at(-1)!
    expect(q).toMatchObject({ kind: 'recovery', status: 'service-returned', serviceAnswer: { source: 'user-questions-service-unattributed' } })
    expect(controller.state.executionMs).toBe(before.executionMs)
    expect((await confirm(root, q.id, 'Retry unchanged approved brief')).result.isError).toBe(false)
    expect(controller.state).toMatchObject({ phase: 'Approved', implementation: null, verification: null, activeRunId: null, brief: before.brief, executionMs: before.executionMs })
    expect(await readFile(join(repository, 'src/export.txt'), 'utf8')).toBe('baseline\n')
    expect(ctx.reviewGatedJournals.view(root.agent.session).decisionEvidence.recovery).toMatchObject({ questionId: q.id, status: 'committed', source: 'session-user-message', missingSourceNote: null })
    remove()
  })

  it('reconfirms a historical unchanged Staged recovery without implementation, checks or review', async () => {
    const { ctx, root, repository } = await repositorySetup()
    await writeFile(join(repository, 'src/export.txt'), 'staged candidate\n')
    const gitExecutable = await ctx.reviewGatedHostWorld.resolveExecutable('git')
    const snapshots = await GitSnapshots.open(repository, { gitExecutable, timeoutMs: 10000, maxOutputBytes: 1024 * 1024, maxFileBytes: 512 * 1024, maxTreeEntries: 100, maxTreeBytes: 1024 * 1024, maxMetadataEntries: 1000 })
    const base = (await git(repository, 'rev-parse', 'HEAD')).stdout.trim(), candidate = await snapshots.stage(brief, base)
    const old = readyEvents().slice(0, 5).map(event => event.type === 'snapshot-created' ? { ...event, snapshot: candidate } : event)
    const history = await historical(ctx, root.agent.session, old, candidate)
    let remove = scripted(ctx)
    await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
    const controller = ctx.reviewGatedJournals.controller(root.agent.session), approval = controller.state.questions![0]!
    expect((await confirm(root, approval.id)).result.isError).toBe(false)
    remove(); remove = scripted(ctx, 'Retry unchanged approved brief')
    const result = await call(root.scoped, root.agent, 'rg_recover', {})
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ needsConfirmation: true })
    const q = controller.state.questions!.at(-1)!
    expect((await confirm(root, q.id, 'Retry unchanged approved brief')).result.isError).toBe(false)
    expect(controller.state).toMatchObject({ phase: 'Staged', snapshot: candidate, implementation: history.state.implementation, verification: null, review: null, activeRunId: null, repairRounds: history.state.repairRounds, executionMs: history.state.executionMs })
    await snapshots.assertCurrent(candidate)
    expect(await readFile(join(repository, 'src/export.txt'), 'utf8')).toBe('staged candidate\n')
    remove()
  })

  it('reports historical question IDs as unattributed in status and the same six-section report', async () => {
    const { ctx, root } = await setup()
    const old = readyEvents().slice(0, 2)
    old.push({ type: 'paused', reason: 'Historical pause' }, { type: 'recovery-decided', questionId: 'historical-recovery', runId: null, action: 'retry', elapsedMs: 0 })
    await historical(ctx, root.agent.session, old)
    const view = ctx.reviewGatedJournals.view(root.agent.session), status = await call(root.scoped, root.agent, 'rg_status', { detail: true })
    expect(status.isError).toBe(false)
    expect(status.value).toMatchObject({ decisionEvidence: view.decisionEvidence })
    expect(view.decisionEvidence).toMatchObject({ approval: { questionId: 'approval-1', status: 'historical-unattributed', source: 'unknown', missingSourceNote: expect.stringContaining('No linked logged user') }, recovery: { questionId: 'historical-recovery', status: 'historical-unattributed', source: 'unknown', historicalAction: 'retry' } })
    const report = await call(root.scoped, root.agent, 'rg_report', {})
    expect(report.isError).toBe(false)
    expect(Object.keys(report.value!)).toEqual(['completion', 'changes', 'problems', 'verificationAndReview', 'limitations', 'followUpOptions'])
    expect(report.value).toMatchObject({ verificationAndReview: { decisionEvidence: view.decisionEvidence } })
    const rendered = report.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('')
    expect(rendered.match(/^## /gm)).toHaveLength(6)
    expect(rendered).toContain('historical-recovery')
    expect(rendered).toContain('No linked logged user confirmation')
  })

  it('denies an oversized audit append without publishing a partial question', async () => {
    const { ctx, root } = await setup(false, 8192)
    scripted(ctx)
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief: { ...brief, goal: '界'.repeat(1000) } })
    const controller = ctx.reviewGatedJournals.controller(root.agent.session), before = controller.state
    expect(before.phase).toBe('Awaiting Approval')
    expect((await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })).isError).toBe(true)
    expect(controller.state).toEqual(before)
    expect(controller.state).not.toHaveProperty('questions')
  })
})

it('requires a separate exact logged host-quiescence receipt and does not resume execution', async () => {
  const { ctx, root } = await setup(true), controller = ctx.reviewGatedJournals.controller(root.agent.session)
  const { HostOperationId } = await import('../../dist/workflow/types.js')
  await controller.apply({ type: 'host-operation-started', operation: { id: HostOperationId(randomUUID()), kind: 'diagnostic', status: 'Running', result: null, error: null } })
  scripted(ctx, 'Confirm previous processes stopped')
  expect((await call(root.scoped, root.agent, 'rg_recover', {})).isError).toBe(false)
  expect(controller.state.hostOperation?.status).toBe('Running')
  const question = controller.state.questions![0]!
  expect(question.kind).toBe('host-recovery')
  expect((await confirm(root, question.id, 'Confirm previous processes stopped')).result.isError).toBe(false)
  expect(controller.state.hostOperation?.status).toBe('Interrupted')
  expect(controller.state.phase).toBe('Clarifying')
  expect(controller.state.executionMs).toBe(0)
  expect(ctx.agents.roots()).toEqual([root.agent])
})

it('rechecks latest logged user input after asynchronous Git preflight before decision commit', async () => {
  const { ctx, root, repository } = await repositorySetup()
  await historical(ctx, root.agent.session, readyEvents().slice(0, 2))
  const baseline = (await git(repository, 'rev-parse', 'HEAD')).stdout.trim()
  await ctx.reviewGatedJournals.bindBase(root.agent.session, baseline, repository)
  scripted(ctx); await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
  const controller = ctx.reviewGatedJournals.controller(root.agent.session), before = controller.state, q = before.questions![0]!
  const event = human(root.agent.session, exact(q.id)), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const runtimeModule = await ctx.loader.import(new URL('../../dist/git/snapshots.js', import.meta.url).href), runtimeGit: typeof GitSnapshots = runtimeModule.GitSnapshots
  const original = runtimeGit.prototype.head, spy = vi.spyOn(runtimeGit.prototype, 'head').mockImplementationOnce(async function (this: GitSnapshots) {
    entered.resolve(); await release.promise; return original.call(this)
  })
  const pending = ctx.reviewGatedExecution.confirmQuestion(root.agent, q.id, event.seq, signal())
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Confirmation did not reach the preflight barrier') })])
    human(root.agent.session, 'Do not proceed')
    release.resolve()
    await expect(pending).rejects.toThrow('new logged user message')
    expect(controller.state).toEqual(before)
    expect(journalSchema.parse(ctx.storageDomain.get(workflowDomain.name)!.table('sessions').get(root.agent.session.id)).records.some(record => record.event.type === 'question-confirmed')).toBe(false)
  } finally { release.resolve(); await Promise.allSettled([pending]); spy.mockRestore() }
})

it.each(['Revise requirements', 'Leave paused'])('commits offered stale Staged choice %s without changing files or consumed runtime', async selected => {
  const { ctx, root, repository } = await repositorySetup(), base = (await git(repository, 'rev-parse', 'HEAD')).stdout.trim()
  await writeFile(join(repository, 'src/export.txt'), 'candidate\n')
  const staged = await (await GitSnapshots.open(repository, { gitExecutable: await ctx.reviewGatedHostWorld.resolveExecutable('git'), timeoutMs: 10000, maxOutputBytes: 1024 * 1024, maxFileBytes: 512 * 1024, maxTreeEntries: 100, maxTreeBytes: 1024 * 1024, maxMetadataEntries: 1000 })).stage(brief, base)
  const history = await historical(ctx, root.agent.session, [...readyEvents().slice(0, 4), { type: 'snapshot-created', snapshot: staged }, { type: 'execution-window-started', id: 'fixture-consumed-window' }, { type: 'execution-window-finished', id: 'fixture-consumed-window', elapsedMs: 321 }], staged)
  await writeFile(join(repository, 'src/export.txt'), 'stale candidate deliberately preserved\n')
  const body = await readFile(join(repository, 'src/export.txt'), 'utf8')
  scripted(ctx, selected)
  expect((await call(root.scoped, root.agent, 'rg_recover', {})).isError).toBe(false)
  const controller = ctx.reviewGatedJournals.controller(root.agent.session), q = controller.state.questions![0]!
  expect(q.options.map(option => option.label)).not.toContain('Retry unchanged approved brief')
  expect((await confirm(root, q.id, selected)).result.isError).toBe(false)
  const after = controller.state
  expect(after.phase).toBe(selected === 'Revise requirements' ? 'Clarifying' : 'Paused')
  expect(after.snapshot).toEqual(staged); expect(after.brief).toEqual(history.state.brief)
  expect(after.executionMs).toBe(history.state.executionMs); expect(after.executionWallMs).toBe(history.state.executionWallMs); expect(after.repairRounds).toBe(history.state.repairRounds)
  expect(await readFile(join(repository, 'src/export.txt'), 'utf8')).toBe(body)
  expect(ctx.agents.roots()).toEqual([root.agent]); expect(after.activeRunId).toBeNull()
  const appended = journalSchema.parse(ctx.storageDomain.get(workflowDomain.name)!.table('sessions').get(root.agent.session.id)).records.slice(history.records.length)
  expect(appended.map(record => record.event.type)).toEqual(['question-opened', 'question-returned', 'question-confirmed'])
})

it.each(['execute', 'handoff'] as const)('denies direct %s with a restored Running host task even after current logged approval', async action => {
  const { ctx, root, repository } = await repositorySetup(), base = (await git(repository, 'rev-parse', 'HEAD')).stdout.trim()
  await writeFile(join(repository, 'src/export.txt'), 'candidate\n')
  const staged = await (await GitSnapshots.open(repository, { gitExecutable: await ctx.reviewGatedHostWorld.resolveExecutable('git'), timeoutMs: 10000, maxOutputBytes: 1024 * 1024, maxFileBytes: 512 * 1024, maxTreeEntries: 100, maxTreeBytes: 1024 * 1024, maxMetadataEntries: 1000 })).stage(brief, base)
  const events = readyEvents().slice(0, action === 'execute' ? 5 : 8).map(event => event.type === 'snapshot-created' ? { ...event, snapshot: staged } : event.type === 'verification-recorded' ? { ...event, evidence: { ...event.evidence, snapshotId: staged.id, treeId: staged.treeId } } : event.type === 'review-finished' ? { ...event, result: { ...event.result, snapshotId: staged.id, treeId: staged.treeId } } : event)
  await historical(ctx, root.agent.session, events, staged)
  scripted(ctx); await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
  const controller = ctx.reviewGatedJournals.controller(root.agent.session), q = controller.state.questions![0]!
  expect((await confirm(root, q.id)).result.isError).toBe(false)
  const { HostOperationId } = await import('../../dist/workflow/types.js')
  await controller.apply({ type: 'host-operation-started', operation: { id: HostOperationId(randomUUID()), kind: 'execution', status: 'Running', result: null, error: null } })
  const before = controller.state
  await expect(ctx.reviewGatedExecution[action](root.agent, signal())).rejects.toThrow('existing host task')
  expect(controller.state).toEqual(before)
  expect((await call(root.scoped, root.agent, 'rg_' + action, {})).isError).toBe(true)
  expect(controller.state).toEqual(before)
})

it.each(['stale snapshot', 'exhausted budget'])('commits logged Reject and revise with %s without accepting approval or changing contents', async condition => {
  const { ctx, root, repository } = await repositorySetup(), base = (await git(repository, 'rev-parse', 'HEAD')).stdout.trim()
  await writeFile(join(repository, 'src/export.txt'), 'candidate\n')
  const staged = await (await GitSnapshots.open(repository, { gitExecutable: await ctx.reviewGatedHostWorld.resolveExecutable('git'), timeoutMs: 10000, maxOutputBytes: 1024 * 1024, maxFileBytes: 512 * 1024, maxTreeEntries: 100, maxTreeBytes: 1024 * 1024, maxMetadataEntries: 1000 })).stage(brief, base)
  const events: WorkflowEvent[] = [...readyEvents().slice(0, 4), { type: 'snapshot-created', snapshot: staged }]
  if (condition === 'exhausted budget') events.push({ type: 'execution-budget-exhausted', executionWallMs: brief.executionBudgetMs })
  const before = await historical(ctx, root.agent.session, events, staged)
  if (condition === 'stale snapshot') await writeFile(join(repository, 'src/export.txt'), 'stale content stays untouched\n')
  const body = await readFile(join(repository, 'src/export.txt'), 'utf8')
  scripted(ctx, 'Reject and revise')
  expect((await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })).isError).toBe(false)
  const controller = ctx.reviewGatedJournals.controller(root.agent.session), q = controller.state.questions![0]!
  expect((await confirm(root, q.id, 'Reject and revise')).result.isError).toBe(false)
  expect(controller.state.phase).toBe('Clarifying'); expect(controller.state.approval?.approved).toBe(false)
  expect(controller.state.brief).toEqual(before.state.brief); expect(controller.state.snapshot).toEqual(staged)
  expect(controller.state.executionMs).toBe(before.state.executionMs); expect(controller.state.executionWallMs).toBe(before.state.executionWallMs)
  expect(await readFile(join(repository, 'src/export.txt'), 'utf8')).toBe(body)
  expect((await call(root.scoped, root.agent, 'rg_report', {})).value).toMatchObject({ completion: { requirementsAuthorizationComplete: false, currentDeliverableVerified: false } })
  expect(ctx.agents.roots()).toEqual([root.agent])
})

it.each(['approval', 'diagnostic', 'execution'] as const)('denies restored Running %s cancellation through direct service and tool until logged quiescence', async kind => {
  const { ctx, root } = await setup(true), controller = ctx.reviewGatedJournals.controller(root.agent.session), { HostOperationId } = await import('../../dist/workflow/types.js')
  await controller.apply({ type: 'host-operation-started', operation: { id: HostOperationId(randomUUID()), kind, status: 'Running', result: null, error: null } })
  const before = controller.state
  await expect(ctx.reviewGatedExecution.cancel(root.agent, 'Private fixture cancellation', signal())).rejects.toThrow('quiescence')
  expect((await call(root.scoped, root.agent, 'rg_cancel', { reason: 'Private fixture cancellation' })).isError).toBe(true)
  expect(controller.state).toEqual(before)
  scripted(ctx, 'Confirm previous processes stopped')
  expect((await call(root.scoped, root.agent, 'rg_recover', {})).isError).toBe(false)
  const q = controller.state.questions![0]!
  expect((await confirm(root, q.id, 'Confirm previous processes stopped')).result.isError).toBe(false)
  expect(controller.state.hostOperation?.status).toBe('Interrupted')
  expect((await call(root.scoped, root.agent, 'rg_cancel', { reason: 'Cancel only after explicit logged quiescence' })).isError).toBe(false)
  expect(controller.state.phase).toBe('Cancelled'); expect(controller.state.executionMs).toBe(0)
})

it('audits host-only quiescence in an archived terminal workflow without resuming it', async () => {
  const { ctx, root } = await setup(true), { HostOperationId } = await import('../../dist/workflow/types.js')
  await historical(ctx, root.agent.session, [{ type: 'host-operation-started', operation: { id: HostOperationId(randomUUID()), kind: 'diagnostic', status: 'Running', result: null, error: null } }, { type: 'cancelled', reason: 'Released terminal state without source-attested host stopping' }])
  scripted(ctx, 'Confirm previous processes stopped')
  expect((await call(root.scoped, root.agent, 'rg_recover', {})).isError).toBe(false)
  const controller = ctx.reviewGatedJournals.controller(root.agent.session), q = controller.state.questions![0]!
  expect(controller.state.phase).toBe('Cancelled')
  expect((await confirm(root, q.id, 'Confirm previous processes stopped')).result.isError).toBe(false)
  expect(controller.state.phase).toBe('Cancelled'); expect(controller.state.hostOperation?.status).toBe('Interrupted')
  expect(controller.state.brief).toBeNull(); expect(controller.state.executionMs).toBe(0)
})
