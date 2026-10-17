/** Real Git and real command checks; scripted roles and simulated confinement are not live review. */
import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { GitSnapshots } from '../../dist/git/snapshots.js'
import { snapshotSchema } from '../../src/workflow/types.js'
import { fixture, main, call, confirm, permission } from '../fixtures/runtime.js'
import { brief, finding } from '../fixtures/workflow.js'
import type {} from '../../src/workflow/execution.js'

const exec = promisify(execFile)
async function git(directory: string, ...args: string[]) {
  return exec('git', ['-c', 'core.autocrlf=false', ...args], { cwd: directory, timeout: 10000 })
}
interface Options { preflightTimeoutMs?: number; verificationOnly?: boolean; nodeTest?: 'default' | 'none' | 'failure'; failChecks?: boolean; mutateSnapshot?: boolean; reviews?: ('Passed' | 'Needs Changes' | 'Inconclusive')[]; clarify?: boolean; outsideScope?: boolean; hold?: (signal: AbortSignal) => Promise<void>; native?: boolean; unavailable?: 'all' | 'checks'; commandTimeoutMs?: number; maxEvidenceBytes?: number; command?: string; approvedTimeoutMs?: number; executionBudgetMs?: number }
async function confirmCurrent(f: Awaited<ReturnType<typeof setup>>, selected: string) {
  const question = f.controller.state.questions!.find(item => item.status === 'service-returned')
  if (!question) throw new Error('No service-returned decision question')
  return confirm(f.root.scoped, f.root.agent, question.id, selected)
}

async function setup(options: Options = {}) {
  const f = await fixture(undefined, 'main', !options.native, { commandSimulation: true, ...(options.preflightTimeoutMs === undefined ? {} : { preflightTimeoutMs: options.preflightTimeoutMs }), ...options.unavailable === undefined ? {} : { unavailable: options.unavailable }, ...options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }, ...options.maxEvidenceBytes === undefined ? {} : { maxEvidenceBytes: options.maxEvidenceBytes } })
  const repository = join(f.root, 'repository')
  await mkdir(join(repository, 'src'), { recursive: true })
  await writeFile(join(repository, 'src', 'export.txt'), 'base')
  if (options.nodeTest) {
    await mkdir(join(repository, 'test'))
    await writeFile(join(repository, 'test/check.test.js'), 'const test=require("node:test"), assert=require("node:assert/strict"); test("snapshot body executes",()=>{assert.match(require("node:fs").readFileSync("src/export.txt","utf8"), /^candidate/); assert.equal(1,' + (options.nodeTest === 'failure' ? '2' : '1') + ');});\n')
  }
  await git(repository, 'init', '--quiet')
  await git(repository, 'add', '--', 'src/export.txt', ...options.nodeTest ? ['test/check.test.js'] : [])
  await git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture baseline')
  const ctx = await f.start()
  const order: string[] = []
  let implementationCount = 0, reviewCount = 0
  const adapter = new class extends LlmAdapter {
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      const text = request.messages.filter(message => message.role === 'user').flatMap(message => message.content).filter(block => block.type === 'text' && block.text.startsWith('Execute only the approved ')).map(block => block.type === 'text' ? block.text : '').join('')
      const role = text.includes('approved implementation task') ? 'implementation' : 'review'
      order.push(role)
      if (options.hold) await options.hold(request.signal!)
      let answer
      if (role === 'implementation') {
        implementationCount++
        if (options.clarify) answer = { outcome: 'Needs Clarification', questions: ['Which export columns are required?'], summary: 'Need a requirement decision' }
        else {
          await writeFile(join(repository, options.outsideScope ? 'unapproved.txt' : 'src/export.txt'), 'candidate ' + implementationCount)
          answer = { outcome: 'Completed', summary: 'scripted implementation ' + implementationCount, problems: [], limitations: ['scripted fixture'] }
        }
      } else {
        reviewCount++
        const payload = JSON.parse(text.split('Task inputs:\n').at(-1)!)
        const snapshot = snapshotSchema.parse(payload.snapshot)
        const outcome = options.reviews?.[reviewCount - 1] ?? 'Passed'
        answer = { outcome, briefRevision: snapshot.briefRevision, snapshotId: snapshot.id, treeId: snapshot.treeId,
          findings: outcome === 'Needs Changes' ? [finding] : [], acceptance: [{ id: 'AC1', status: outcome === 'Passed' ? 'Passed' : 'Inconclusive', evidence: [{ kind: 'verification', checkIndex: 0, explanation: 'Snapshot check result' }] }], checked: ['AC1'], unchecked: outcome === 'Inconclusive' ? ['edge case'] : [], reason: outcome === 'Inconclusive' ? 'Cannot decide this requirement' : '' }
      }
      const output = JSON.stringify(answer)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: output }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['scripted'], adapter)
  const root = await main(ctx, repository, randomUUID(), 'review-gated', false, { provider: 'scripted', model: 'fixture' })
  root.scoped.tools.presentAs('native')
  const human = { choice: 'Leave paused', custom: undefined as string | undefined, shown: [] as string[] }
  const questions = ctx.on('user-questions/request', async request => {
    human.shown = request.questions[0]!.options!.map(option => option.label)
    return { answers: [{ id: request.questions[0]!.id, selected: [human.shown.includes('Approve') ? 'Approve' : human.choice], ...human.custom === undefined ? {} : { custom: human.custom } }] }
  })
  const command = options.command ?? (options.mutateSnapshot ? 'require("node:fs").writeFileSync("src/export.txt", "changed by test")' : options.failChecks ? 'process.exit(3)' : 'if (!require("node:fs").readFileSync("src/export.txt", "utf8").startsWith("candidate")) process.exit(2); console.log("verified snapshot")')
  const requirements = { ...brief, executionIntent: options.verificationOnly ? 'verification-only' as const : 'implementation' as const, verificationCommands: [{ executable: process.execPath, args: options.nodeTest ? ['--test', ...options.nodeTest === 'default' ? [] : ['--test-isolation=none'], 'test/check.test.js'] : ['-e', command], timeoutMs: options.approvedTimeoutMs ?? 60000 }], ...options.executionBudgetMs === undefined ? {} : { executionBudgetMs: options.executionBudgetMs } }
  expect((await call(root.scoped, root.agent, 'rg_submit_brief', { brief: requirements })).isError).toBe(false)
  const approval = await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
  expect(approval.isError).toBe(false)
  expect(approval.value).toMatchObject({ needsConfirmation: true, state: { phase: 'Awaiting Approval', approval: null } })
  const controller = ctx.reviewGatedJournals.controller(root.agent.session), approvalQuestion = controller.state.questions!.at(-1)!
  const confirmation = await confirm(root.scoped, root.agent, approvalQuestion.id, 'Approve')
  expect(confirmation.result.isError).toBe(false)
  return { f, ctx, root, repository, order, controller, human, adapter, questions }
}

describe('approved execution through the actual YAML and Main tools', () => {
  it.skipIf(process.platform !== 'win32').each(['default', 'none', 'failure'] as const)('keeps exact approved Node test argv under native Windows confinement: %s', async nodeTest => {
    const f = await setup({ native: true, nodeTest })
    const expected = f.controller.state.brief!.verificationCommands[0]!
    await permission(f.root.scoped, f.root.agent, 'execution')
    const result = await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    expect(result.isError).toBe(false)
    const check = f.controller.state.verification!.checks[0]!
    expect(check.command).toEqual(expected)
    expect(check.effectiveTimeoutMs).toBe(60000)
    expect(check.timedOut).toBe(false)
    if (nodeTest === 'none') {
      expect(check.exitCode).toBe(0)
      expect(check.stdout).toContain('snapshot body executes')
      expect(f.controller.state.phase).toBe('Ready for Handoff')
      expect(f.order).toEqual(['implementation', 'review'])
    } else {
      expect(check.exitCode).not.toBe(0)
      expect(f.controller.state.phase).toBe('Paused')
      expect(f.controller.state.review).toBeNull()
      expect(f.order).toEqual(['implementation'])
      if (nodeTest === 'default') expect(check.stdout + check.stderr).toContain('EPERM')
      else expect(check.stdout + check.stderr).toContain('snapshot body executes')
    }
  }, 30000)

  it.each(['handoff', 'recover', 'report'] as const)('aborts %s Git preflight when the execution service closes', async operation => {
    const f = await setup()
    await permission(f.root.scoped, f.root.agent, 'execution')
    expect((await call(f.root.scoped, f.root.agent, 'rg_execute', {})).isError).toBe(false)
    if (operation === 'handoff') await permission(f.root.scoped, f.root.agent, 'handoff')
    if (operation === 'recover') await f.controller.apply({ type: 'paused', reason: 'fixture pause' })
    const module = await f.ctx.loader.import(new URL('../../dist/git/snapshots.js', import.meta.url).href)
    const runtimeGit: typeof GitSnapshots = module.GitSnapshots
    const original = runtimeGit.open.bind(runtimeGit), entered = Promise.withResolvers<AbortSignal>()
    const spy = vi.spyOn(runtimeGit, 'open').mockImplementation(async (directory, limits, signal) => {
      if (directory !== f.repository) return original(directory, limits, signal)
      entered.resolve(signal!)
      await new Promise<void>((_resolve, reject) => {
        if (signal!.aborted) reject(signal!.reason)
        else signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
      throw new Error('unreachable Git preflight')
    })
    try {
      const pending = call(f.root.scoped, f.root.agent, 'rg_' + operation, {})
      const signal = await entered.promise
      await f.ctx.reviewGatedExecution.close()
      expect(signal.aborted).toBe(true)
      expect((await pending).isError).toBe(true)
    } finally { spy.mockRestore() }
  })
  it.each(['review cleanup', 'window settlement'] as const)('reconciles cancellation during %s without reporting Ready for Handoff', async boundary => {
    const f = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), abort = new AbortController()
    const module = await f.ctx.loader.import(new URL('../../dist/git/snapshots.js', import.meta.url).href)
    const runtimeGit: typeof GitSnapshots = module.GitSnapshots
    const originalMaterialize = runtimeGit.prototype.materialize
    let count = 0
    const materialize = vi.spyOn(runtimeGit.prototype, 'materialize').mockImplementation(async function (this: GitSnapshots, ...args) {
      const exported = await originalMaterialize.apply(this, args)
      if (boundary !== 'review cleanup' || ++count !== 2) return exported
      return { ...exported, dispose: async () => { entered.resolve(); await release.promise; await exported.dispose() } }
    })
    const originalApply = f.controller.apply.bind(f.controller)
    const apply = vi.spyOn(f.controller, 'apply').mockImplementation(async event => {
      if (boundary === 'window settlement' && event.type === 'execution-window-finished') { entered.resolve(); await release.promise }
      return originalApply(event)
    })
    try {
      await permission(f.root.scoped, f.root.agent, 'execution')
      const pending = call(f.root.scoped, f.root.agent, 'rg_execute', {}, abort.signal)
      await entered.promise
      abort.abort(new Error('cancelled during ' + boundary))
      release.resolve()
      expect((await pending).isError).toBe(true)
      expect(f.controller.state.phase).toBe('Paused')
      expect(f.controller.state.review?.outcome).toBe('Passed')
      expect(f.controller.state.executionWindow).toBeUndefined()
      expect((await call(f.root.scoped, f.root.agent, 'rg_handoff', {})).isError).toBe(true)
      f.human.choice = 'Retry unchanged approved brief'
      const recovery = await call(f.root.scoped, f.root.agent, 'rg_recover', {})
      expect(recovery).toMatchObject({ isError: false, value: { decision: 'awaiting-user-confirmation', needsConfirmation: true } })
      expect((await confirmCurrent(f, 'Retry unchanged approved brief')).result.isError).toBe(false)
      expect(f.controller.state.phase).toBe('Staged')
    } finally { release.resolve(); materialize.mockRestore(); apply.mockRestore() }
  })
  it('enforces the approved command deadline below the deployment cap and records it', async () => {
    const f = await setup({ command: 'setInterval(() => {}, 1000)', approvedTimeoutMs: 250, commandTimeoutMs: 3000 })
    const status = await call(f.root.scoped, f.root.agent, 'rg_status', { detail: true })
    expect(JSON.stringify(status)).toContain('effectiveCapMs')
    await permission(f.root.scoped, f.root.agent, 'execution')
    await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    expect(f.controller.state.phase).toBe('Paused')
    expect(f.controller.state.verification?.checks[0]).toMatchObject({ timedOut: true, effectiveTimeoutMs: 250 })
    expect(f.controller.state.executionWindow).toBeUndefined()
    expect(f.controller.state.executionWallMs).toBeGreaterThanOrEqual(f.controller.state.executionMs)
    expect(f.order).toEqual(['implementation'])
  })
  it('bounds final Git preflight separately without consuming execution permission or its budget', async () => {
    const f = await setup({ executionBudgetMs: 2000, preflightTimeoutMs: 5000 })
    await permission(f.root.scoped, f.root.agent, 'execution')
    const runtimeModule = await f.ctx.loader.import(new URL('../../dist/git/snapshots.js', import.meta.url).href)
    const runtimeGit: typeof GitSnapshots = runtimeModule.GitSnapshots
    const open = runtimeGit.open.bind(runtimeGit)
    let entered = false
    const spy = vi.spyOn(runtimeGit, 'open').mockImplementation(async (directory, limits, signal) => {
      if (directory !== f.repository) return open(directory, limits, signal)
      entered = true
      await new Promise<void>((_resolve, reject) => {
        if (signal!.aborted) reject(signal!.reason)
        else signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
      throw new Error('unreachable preflight')
    })
    try {
      await call(f.root.scoped, f.root.agent, 'rg_execute', {})
      expect(entered).toBe(true)
      expect(f.controller.state.phase).toBe('Approved')
      expect(f.controller.state.repositoryPreflight).toMatchObject({status:'blocked',issues:[{code:'preflight-total-timeout'}]})
      expect(f.controller.state.operationAuthorization?.status).toBe('granted')
      expect(f.controller.state.preflightMs).toBeGreaterThanOrEqual(5000)
      expect(f.controller.state.executionWallMs ?? 0).toBe(0)
      expect(f.controller.state.executionMs).toBe(0)
      expect(f.controller.state.executionWindow).toBeUndefined()
      expect(f.order).toEqual([])
    } finally { spy.mockRestore() }
  })
  it('requires human reconciliation of a restored pre-role execution window without refunding time', async () => {
    const f = await setup()
    await f.controller.apply({ type: 'execution-window-started', id: 'unknown-preflight' })
    expect((await call(f.root.scoped, f.root.agent, 'rg_execute', {})).isError).toBe(true)
    f.human.choice = 'Confirm previous processes stopped'
    const recovery = await call(f.root.scoped, f.root.agent, 'rg_recover', {})
    expect(recovery.isError, JSON.stringify(recovery.content)).toBe(false)
    expect(recovery.value).toMatchObject({ decision: 'awaiting-user-confirmation', needsConfirmation: true })
    expect((await confirmCurrent(f, 'Confirm previous processes stopped')).result.isError).toBe(false)
    expect(f.controller.state.phase).toBe('Paused')
    expect(f.controller.state.executionWindow).toBeUndefined()
    expect(f.controller.state.executionWallMs).toBe(f.controller.state.brief!.executionBudgetMs)
    expect(f.order).toEqual([])
    f.human.choice = 'Retry unchanged approved brief'
    expect((await call(f.root.scoped, f.root.agent, 'rg_recover', {})).isError).toBe(true)
  })
  it('verification-only execution skips implementation and preserves the clean workspace', async () => {
    const f = await setup({ verificationOnly: true, command: 'console.log("verified clean baseline")' })
    await permission(f.root.scoped, f.root.agent, 'execution')
    expect((await call(f.root.scoped, f.root.agent, 'rg_execute', {})).isError).toBe(false)
    expect(f.order).toEqual(['review'])
    expect(f.controller.state.phase).toBe('Ready for Handoff')
    expect(f.controller.state.snapshot?.changedPaths).toEqual([])
    expect((await git(f.repository, 'status', '--short')).stdout.trim()).toBe('')
    expect((await git(f.repository, 'diff', '--cached', '--name-only')).stdout.trim()).toBe('')
    expect(f.controller.state.review?.outcome).toBe('Passed')
  })

  it('stages, verifies, independently reviews and re-checks handoff without a project commit', async () => {
    const f = await setup()
    await permission(f.root.scoped, f.root.agent, 'execution')
    expect((await call(f.root.scoped, f.root.agent, 'rg_execute', {})).isError).toBe(false)
    expect(f.order).toEqual(['implementation', 'review'])
    expect(f.controller.state.phase).toBe('Ready for Handoff')
    expect(f.controller.state.verification?.checks[0]?.stdout).toContain('verified snapshot')
    expect(f.controller.state.executionMs).toBeGreaterThan(0)
    await permission(f.root.scoped, f.root.agent, 'handoff')
    const handoff = await call(f.root.scoped, f.root.agent, 'rg_handoff', {})
    expect(handoff.isError).toBe(false)
    expect(f.controller.state.phase).toBe('Completed')
    const state = f.controller.state
    expect(state.verification?.snapshotId).toBe(state.snapshot?.id)
    expect(state.review?.snapshotId).toBe(state.snapshot?.id)
    expect(state.review?.treeId).toBe(state.snapshot?.treeId)
    const journal = JSON.parse(await readFile(join(f.f.root, 'storage', 'aaronwu_review_gated.json'), 'utf8'))
    expect({ events: journal.tables.sessions[f.root.agent.id].records.map((record: { event: { type: string } }) => record.event.type),
      phase: state.phase, review: state.review?.outcome, verification: state.verification?.checks.map(check => ({ exitCode: check.exitCode, signal: check.signal, timedOut: check.timedOut, stdout: check.stdout })) }).toEqual({
      events: ['requirements-submitted', 'question-opened', 'question-returned', 'question-confirmed', 'repository-preflight-recorded', 'repository-preflight-recorded', 'operation-requested', 'repository-preflight-recorded', 'repository-preflight-recorded', 'operation-confirmed', 'repository-preflight-recorded', 'repository-preflight-recorded', 'authorized-execution-started',
        'implementation-started', 'implementation-finished', 'snapshot-created', 'verification-started', 'verification-recorded',
        'review-started', 'review-finished', 'execution-window-finished', 'repository-preflight-recorded', 'repository-preflight-recorded', 'operation-requested', 'repository-preflight-recorded', 'repository-preflight-recorded', 'operation-confirmed', 'authorized-handoff-completed'],
      phase: 'Completed', review: 'Passed', verification: [{ exitCode: 0, signal: null, timedOut: false, stdout: 'verified snapshot\n' }],
    })
    expect((await git(f.repository, 'rev-list', '--count', 'HEAD')).stdout.trim()).toBe('1')
    expect((await git(f.repository, 'diff', '--cached', '--name-only')).stdout.trim()).toBe('src/export.txt')
    expect((await readdir(f.f.root)).some(path => path.startsWith('review-gated-snapshot-'))).toBe(false)
  })
  it('repairs only after Needs Changes and binds the new review to a different staged tree', async () => {
    const f = await setup({ reviews: ['Needs Changes', 'Passed'] })
    await permission(f.root.scoped, f.root.agent, 'execution')
    await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    expect(f.order).toEqual(['implementation', 'review', 'implementation', 'review'])
    expect(f.controller.state.phase).toBe('Ready for Handoff')
    expect(f.controller.state.repairRounds).toBe(1)
    expect(await readFile(join(f.repository, 'src', 'export.txt'), 'utf8')).toBe('candidate 2')
    const journal = JSON.parse(await readFile(join(f.f.root, 'storage', 'aaronwu_review_gated.json'), 'utf8'))
    const snapshots = journal.tables.sessions[f.root.agent.id].records.filter((record: { event: { type: string } }) => record.event.type === 'snapshot-created').map((record: { event: { snapshot: { treeId: string } } }) => record.event.snapshot.treeId)
    expect(new Set(snapshots).size).toBe(2)
  })
  it('stops after the explicitly approved repair count', async () => {
    const f = await setup({ reviews: ['Needs Changes', 'Needs Changes', 'Needs Changes'] })
    await permission(f.root.scoped, f.root.agent, 'execution')
    await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    expect(f.order).toHaveLength(6)
    expect(f.controller.state.phase).toBe('Paused')
    expect(f.controller.state.pauseReason).toContain('Repair round limit')
    expect((await call(f.root.scoped, f.root.agent, 'rg_handoff', {})).isError).toBe(true)
  })
  it.each([{ failChecks: true, reason: 'commands failed' }, { mutateSnapshot: true, reason: 'Snapshot source changed' }, { outsideScope: true, reason: 'approved scope' }, { clarify: true, reason: 'columns' }])('pauses before review on failed evidence or requirements: $reason', async ({ reason, ...options }) => {
    const f = await setup(options)
    await permission(f.root.scoped, f.root.agent, 'execution')
    await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    expect(f.controller.state.phase).toBe('Paused')
    expect(f.controller.state.pauseReason).toContain(reason)
    expect(f.order).toEqual(['implementation'])
    expect(f.controller.state.review).toBeNull()
  })
  it('does not hand off Inconclusive or a candidate changed after Passed', async () => {
    const f = await setup({ reviews: ['Inconclusive'] })
    await permission(f.root.scoped, f.root.agent, 'execution')
    await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    expect(f.controller.state.phase).toBe('Paused')
    expect(f.controller.state.pauseReason).toContain('Cannot decide')
    expect((await call(f.root.scoped, f.root.agent, 'rg_handoff', {})).isError).toBe(true)
  })
  it('refuses stale contents at final handoff', async () => {
    const f = await setup()
    await permission(f.root.scoped, f.root.agent, 'execution')
    await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    expect(f.controller.state.phase).toBe('Ready for Handoff')
    await permission(f.root.scoped, f.root.agent, 'handoff')
    await writeFile(join(f.repository, 'src', 'export.txt'), 'changed after review')
    expect((await call(f.root.scoped, f.root.agent, 'rg_handoff', {})).isError).toBe(true)
    expect(f.controller.state.phase).toBe('Paused')
  })
  it('records command timeout without permitting review or handoff', async () => {
    const f = await setup({ command: 'setInterval(() => {}, 1000)', commandTimeoutMs: 200 })
    await permission(f.root.scoped, f.root.agent, 'execution')
    await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    expect(f.controller.state.phase).toBe('Paused')
    expect(f.controller.state.activeRunId).toBeNull()
    expect(f.controller.state.verification?.checks[0]?.timedOut ?? f.controller.state.pauseReason?.includes('timed out')).toBe(true)
    expect(f.order).toEqual(['implementation'])
  })
  it('rejects oversized complete command evidence', async () => {
    const f = await setup({ command: 'console.log("oversized")', maxEvidenceBytes: 1 })
    await permission(f.root.scoped, f.root.agent, 'execution')
    await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    expect(f.controller.state.phase).toBe('Paused')
    expect(f.controller.state.pauseReason).toContain('limit')
    expect(f.controller.state.verification).toBeNull()
    expect(f.order).toEqual(['implementation'])
  })
  it('persists cancellation after the Main and child become quiescent', async () => {
    const entered = Promise.withResolvers<void>()
    const f = await setup({ hold: signal => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      entered.resolve()
    }) })
    const abort = new AbortController()
    await permission(f.root.scoped, f.root.agent, 'execution')
    const pending = call(f.root.scoped, f.root.agent, 'rg_execute', {}, abort.signal)
    await entered.promise
    abort.abort(new Error('user cancelled execution'))
    await pending
    expect(f.controller.state.phase).toBe('Paused')
    expect(f.controller.state.activeRunId).toBeNull()
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
    const journal = JSON.parse(await readFile(join(f.f.root, 'storage', 'aaronwu_review_gated.json'), 'utf8'))
    expect(journal.tables.sessions[f.root.agent.id].state.activeRunId).toBeNull()
  })
  it('finishes durable interruption accounting before journal shutdown', async () => {
    const entered = Promise.withResolvers<void>()
    const f = await setup({ hold: signal => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      entered.resolve()
    }) })
    await permission(f.root.scoped, f.root.agent, 'execution')
    const pending = call(f.root.scoped, f.root.agent, 'rg_execute', {})
    await entered.promise
    await f.ctx.reviewGatedJournals.close()
    await pending
    const journal = JSON.parse(await readFile(join(f.f.root, 'storage', 'aaronwu_review_gated.json'), 'utf8'))
    expect(journal.tables.sessions[f.root.agent.id].state.phase).toBe('Paused')
    expect(journal.tables.sessions[f.root.agent.id].state.activeRunId).toBeNull()
  })
  it('asks the human before retrying the unchanged approved brief', async () => {
    const f = await setup()
    await f.controller.apply({ type: 'paused', reason: 'Temporary operational pause before implementation' })
    f.human.choice = 'Retry unchanged approved brief'
    const recovery = await call(f.root.scoped, f.root.agent, 'rg_recover', {})
    expect(recovery).toMatchObject({ isError: false, value: { decision: 'awaiting-user-confirmation', needsConfirmation: true } })
    expect((await confirmCurrent(f, 'Retry unchanged approved brief')).result.isError).toBe(false)
    expect(f.controller.state.phase).toBe('Approved')
    expect(f.order).toEqual([])
    expect(f.human.shown).toContain('Retry unchanged approved brief')
    const journal = JSON.parse(await readFile(join(f.f.root, 'storage', 'aaronwu_review_gated.json'), 'utf8'))
    expect(journal.tables.sessions[f.root.agent.id].records.at(-1).event).toMatchObject({ type: 'question-confirmed', selected: 'Retry unchanged approved brief', receipt: { source: 'session-user-message' } })
    await permission(f.root.scoped, f.root.agent, 'execution')
    await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    expect(f.controller.state.phase).toBe('Ready for Handoff')
  })
  it('requires clarification and reapproval after an uncertain implementation', async () => {
    const f = await setup({ clarify: true })
    await permission(f.root.scoped, f.root.agent, 'execution')
    await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    f.human.choice = 'Retry unchanged approved brief'
    expect((await call(f.root.scoped, f.root.agent, 'rg_recover', {})).isError).toBe(true)
    expect(f.human.shown).not.toContain('Retry unchanged approved brief')
    expect(f.controller.state.phase).toBe('Paused')
    f.human.choice = 'Revise requirements'
    const recovery = await call(f.root.scoped, f.root.agent, 'rg_recover', {})
    expect(recovery).toMatchObject({ isError: false, value: { decision: 'awaiting-user-confirmation', needsConfirmation: true } })
    expect((await confirmCurrent(f, 'Revise requirements')).result.isError).toBe(false)
    expect(f.controller.state.phase).toBe('Clarifying')
    expect(f.controller.state.approval).toBeNull()
    expect((await call(f.root.scoped, f.root.agent, 'rg_execute', {})).isError).toBe(true)
  })
  it('rejects free-text recovery rather than treating it as unchanged approval', async () => {
    const f = await setup()
    await f.controller.apply({ type: 'paused', reason: 'Need a user decision' })
    f.human.choice = 'Retry unchanged approved brief'
    f.human.custom = 'Also change authentication'
    expect((await call(f.root.scoped, f.root.agent, 'rg_recover', {})).isError).toBe(true)
    expect(f.controller.state.phase).toBe('Paused')
    expect(f.order).toEqual([])
  })
  it.each(['Implementing', 'Verifying', 'Reviewing'] as const)('recovers a persisted unresolved %s attempt only after human process confirmation', async phase => {
    const f = await setup()
    await f.ctx.agentPresets.select(f.root.agent, 'review-gated')
    await f.ctx.sessions.flush(f.root.agent.session)
    await f.ctx.reviewGatedJournals.bindBase(f.root.agent.session, (await git(f.repository, 'rev-parse', 'HEAD')).stdout.trim(), f.repository)
    const implementationId = randomUUID()
    await f.controller.apply({ type: 'implementation-started', runId: implementationId })
    if (phase !== 'Implementing') {
      await f.controller.apply({ type: 'implementation-finished', runId: implementationId, result: { outcome: 'Completed', summary: 'Interrupted fixture', problems: [], limitations: [] }, elapsedMs: 0 })
      await writeFile(join(f.repository, 'src/export.txt'), 'interrupted candidate')
      const { GitSnapshots } = await import('../../src/git/snapshots.js')
      const candidate = await (await GitSnapshots.open(f.repository, { gitExecutable: await f.ctx.reviewGatedHostWorld.resolveExecutable('git'), timeoutMs: 10000, maxOutputBytes: 1024 * 1024, maxFileBytes: 512 * 1024, maxTreeEntries: 100, maxTreeBytes: 1024 * 1024, maxMetadataEntries: 1000 })).stage(brief, (await git(f.repository, 'rev-parse', 'HEAD')).stdout.trim())
      await f.controller.apply({ type: 'snapshot-created', snapshot: candidate })
      const verificationId = randomUUID()
      await f.controller.apply({ type: 'verification-started', runId: verificationId })
      if (phase === 'Reviewing') {
        await f.controller.apply({ type: 'verification-recorded', runId: verificationId, elapsedMs: 1, evidence: { snapshotId: candidate.id, treeId: candidate.treeId, checks: [{ command: f.controller.state.brief!.verificationCommands[0]!, exitCode: 0, signal: null, timedOut: false, stdout: 'fixture', stderr: '', durationMs: 1 }] } })
        await f.controller.apply({ type: 'review-started', runId: randomUUID() })
      }
    }
    const id = f.root.agent.id
    await f.root.handle.dispose()
    await f.ctx.fiber.dispose()
    const ctx = await f.f.start()
    ctx.llm.registerAdapter(['scripted'], f.adapter)
    const resumed = await main(ctx, f.repository, id, 'review-gated', true, { provider: 'scripted', model: 'fixture' })
    resumed.scoped.tools.presentAs('native')
    let choice = 'Leave unresolved'
    ctx.on('user-questions/request', async request => ({ answers: [{ id: request.questions[0]!.id, selected: [choice] }] }))
    const controller = ctx.reviewGatedJournals.controller(resumed.agent.session)
    expect(controller.state.phase).toBe(phase)
    expect((await call(resumed.scoped, resumed.agent, 'rg_execute', {})).isError).toBe(true)
    expect((await call(resumed.scoped, resumed.agent, 'rg_cancel', { reason: 'No observed old process exit' })).isError).toBe(true)
    const unresolved = await call(resumed.scoped, resumed.agent, 'rg_recover', {})
    expect(unresolved).toMatchObject({ isError: false, value: { decision: 'awaiting-user-confirmation', needsConfirmation: true } })
    const unresolvedQuestion = controller.state.questions!.find(item => item.status === 'service-returned')!
    expect((await confirm(resumed.scoped, resumed.agent, unresolvedQuestion.id, 'Leave unresolved')).result.isError).toBe(false)
    expect(controller.state.phase).toBe(phase)
    choice = 'Confirm previous processes stopped'
    const recovered = await call(resumed.scoped, resumed.agent, 'rg_recover', {})
    expect(recovered).toMatchObject({ isError: false, value: { decision: 'awaiting-user-confirmation', needsConfirmation: true } })
    const recoveryQuestion = controller.state.questions!.find(item => item.status === 'service-returned')!
    expect((await confirm(resumed.scoped, resumed.agent, recoveryQuestion.id, 'Confirm previous processes stopped')).result.isError).toBe(false)
    expect(controller.state.phase).toBe('Paused')
    expect(controller.state.activeRunId).toBeNull()
    expect(controller.state.executionMs).toBe(brief.executionBudgetMs)
    expect((await call(resumed.scoped, resumed.agent, 'rg_execute', {})).isError).toBe(true)
    await call(resumed.scoped, resumed.agent, 'rg_submit_brief', { brief: { ...brief, revision: 2, executionBudgetMs: brief.executionBudgetMs + 1000 } })
    expect(controller.state.executionMs).toBe(brief.executionBudgetMs)
    expect(controller.state.approval).toBeNull()
  })
  it('cancels an owned role and commits cancellation only after it settles', async () => {
    const entered = Promise.withResolvers<void>()
    const f = await setup({ hold: signal => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      entered.resolve()
    }) })
    await permission(f.root.scoped, f.root.agent, 'execution')
    const pending = call(f.root.scoped, f.root.agent, 'rg_execute', {})
    await entered.promise
    expect((await call(f.root.scoped, f.root.agent, 'rg_cancel', { reason: 'Stop this task' })).isError).toBe(false)
    await pending
    expect(f.controller.state.phase).toBe('Cancelled')
    expect(f.controller.state.activeRunId).toBeNull()
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
    expect((await call(f.root.scoped, f.root.agent, 'rg_execute', {})).isError).toBe(true)
  })
  it('reports six sections and does not equate historical completion with stale contents', async () => {
    const f = await setup()
    await permission(f.root.scoped, f.root.agent, 'execution')
    await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    await permission(f.root.scoped, f.root.agent, 'handoff')
    await call(f.root.scoped, f.root.agent, 'rg_handoff', {})
    const reported = await call(f.root.scoped, f.root.agent, 'rg_report', {})
    expect(reported.isError).toBe(false)
    expect(reported.value).toMatchObject({ completion: { phase: 'Completed', handoffCompleted: true, currentDeliverableVerified: true, snapshotCurrency: { status: 'current' } }, verificationAndReview: { checksPassed: true, recordedReview: { outcome: 'Passed' } } })
    expect(Object.keys(reported.value!)).toEqual(['completion', 'changes', 'problems', 'verificationAndReview', 'limitations', 'followUpOptions'])
    await writeFile(join(f.repository, 'src', 'export.txt'), 'Changed after completion')
    const stale = await call(f.root.scoped, f.root.agent, 'rg_report', {})
    expect(stale.value).toMatchObject({ completion: { phase: 'Completed', handoffCompleted: true, currentDeliverableVerified: false, snapshotCurrency: { status: 'stale' } } })
    expect(f.controller.state.phase).toBe('Completed')
  })
  it('drains a human recovery wait when the execution service closes', async () => {
    const f = await setup()
    await f.controller.apply({ type: 'paused', reason: 'Wait for recovery decision' })
    const entered = Promise.withResolvers<void>()
    const { ctx, root, controller } = f
    f.questions()
    ctx.on('user-questions/request', request => new Promise((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true })
      entered.resolve()
    }))
    const pending = call(root.scoped, root.agent, 'rg_recover', {})
    await entered.promise
    await ctx.reviewGatedExecution.close()
    expect((await pending).isError).toBe(true)
    expect(controller.state.phase).toBe('Paused')
  })
  it.each(['all', 'checks'] as const)('persists an unavailable %s backend refusal without proceeding to review', async unavailable => {
    const f = await setup({ unavailable })
    await permission(f.root.scoped, f.root.agent, 'execution')
    await call(f.root.scoped, f.root.agent, 'rg_execute', {})
    expect(f.order).toEqual(unavailable === 'all' ? [] : ['implementation'])
    expect(f.controller.state.phase).toBe('Paused')
    expect(f.controller.state.activeRunId).toBeNull()
    expect(f.controller.state.pauseReason).toContain('Test-owned unavailable native backend')
  })
})
