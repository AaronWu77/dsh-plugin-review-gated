/** Main orchestration over durable facts, Git snapshots, existing AgentLoop roles, and real checks. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from './tasks.js'
import { buildReport } from './report.js'
import type { MainReport, SnapshotCurrency } from './report.js'
import { transition } from './controller.js'
import { askDecisionQuestion, confirmationReceipt, requireDecisionReceipts, questionBinding } from './questions.js'
import { RoleResultError } from '../roles/output.js'
import { recoveryDetails } from './interaction.js'
import { operationMode, operationReceipt, requireOperationPermission, operationEvidence } from './authorization.js'
import type { OperationRequest } from './authorization.js'
import { OperationRequestId } from './authorization.js'
import { validateReviewResult } from './review-result.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '../roles/runner.js'
import type {} from '../verification/runner.js'
import type {} from '../storage/support.js'
import type {} from '../security/permissions.js'
import type {} from '../security/host-world.js'
import { GitSnapshots, GitFailure, resolveGitLimits } from '../git/snapshots.js'
import type { GitLimits, ResolvedGitLimits } from '../git/snapshots.js'
import { checksPassed } from './controller.js'
import type { WorkflowState } from './types.js'
import { operationBinding, sameBaseline, PreflightId } from './preflight.js'
import type { PreflightProof, RepositoryPreflight } from './preflight.js'
import { resolveExecutionIntent } from './execution-policy.js'

export interface Config extends GitLimits { snapshotParent: string; preflightTimeoutMs?: number }
export const Config: Schema<Config> = Schema.object({
  gitExecutable: Schema.string().default('git'),
  integrityTimeoutMs: Schema.number().min(1).max(2147483647).step(1).default(120000),
  preflightTimeoutMs: Schema.number().min(1).max(2147483647).step(1).default(180000),
  timeoutMs: Schema.number().min(1).step(1).default(10000), maxOutputBytes: Schema.number().min(1).step(1).default(1024 * 1024),
  maxFileBytes: Schema.number().min(1).step(1).default(16 * 1024 * 1024), maxTreeEntries: Schema.number().min(1).step(1).default(10000),
  maxMetadataEntries: Schema.number().min(1).step(1).default(100000),
  maxTreeBytes: Schema.number().min(1).step(1).default(64 * 1024 * 1024),
  snapshotParent: Schema.string().default(tmpdir()),
})
/** Holds a repository reservation until roles, checks, and temporary exports are all settled. */
export class WorkflowExecution {
  private readonly shutdown = new AbortController()
  private readonly repositories = new Map<string, Promise<unknown>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly active = new Map<Agent, { abort: AbortController; promise: Promise<WorkflowState> }>()
  private readonly gitLimits: ResolvedGitLimits
  private readonly preflightTimeoutMs: number
  constructor(private readonly ctx: Context, private readonly config: Config) {
    const { gitExecutable, timeoutMs, maxOutputBytes, maxFileBytes, maxTreeEntries, maxTreeBytes, maxMetadataEntries } = config
    this.gitLimits = resolveGitLimits({ gitExecutable, timeoutMs, ...(config.integrityTimeoutMs === undefined ? {} : { integrityTimeoutMs: config.integrityTimeoutMs }), maxOutputBytes, maxFileBytes, maxTreeEntries, maxTreeBytes, maxMetadataEntries })
    this.preflightTimeoutMs = config.preflightTimeoutMs ?? 180000
  }
  private async openGit(repository: string, signal?: AbortSignal): Promise<GitSnapshots> {
    const gitExecutable = await this.ctx.reviewGatedHostWorld.resolveExecutable(this.config.gitExecutable, undefined, signal)
    return GitSnapshots.open(repository, { ...this.gitLimits, gitExecutable }, signal)
  }
  private requireMain(parent: Agent): void {
    this.shutdown.signal.throwIfAborted()
    if (this.ctx.agents.get(parent.id) !== parent || !this.ctx.agents.roots().includes(parent) || this.ctx.reviewGatedPermissions.of(parent.session)?.role !== 'main')
      throw new Error('Execution requires the admitted live Main root')
  }
  private operation<T>(parent: Agent, run: () => Promise<T>): Promise<T> {
    this.requireMain(parent)
    const task = this.ctx.reviewGatedJournals.operation(parent.session, run)
    this.operations.add(task)
    return task.finally(() => this.operations.delete(task))
  }
  /** Run approved implementation/check/review cycles; successful execution stops before handoff.
   * @param parent Main Agent owning the workflow.
   * @param cancellation Main tool and Agent lifecycle signal.
   * @returns Current durable state, including pauses and review outcome.
   */
  async execute(parent: Agent, cancellation: AbortSignal): Promise<WorkflowState> {
    this.requireMain(parent)
    if (this.active.has(parent)) throw new Error('Main already owns an execution')
    const abort = new AbortController()
    const lifetime = AbortSignal.any([cancellation, abort.signal, this.shutdown.signal, this.ctx.reviewGatedJournals.signal])
    const promise = this.operation(parent, async () => {
      const controller = this.ctx.reviewGatedJournals.controller(parent.session)
      const initial = controller.state
      requireDecisionReceipts(initial, this.ctx.reviewGatedJournals.view(parent.session).decisionEvidence.recovery.questionId)
      if (initial.hostOperation?.status === 'Running' && (initial.hostOperation.kind !== 'execution' || !this.ctx.get('reviewGatedTasks')?.running(parent))) throw new Error('Recover or drain the existing host task before execution')
      const permission = requireOperationPermission(initial, parent.session, 'execution', this.ctx.reviewGatedJournals.confirmationMode)
      if (!['Approved', 'Implemented', 'Staged', 'Needs Changes'].includes(initial.phase) || !initial.brief || !initial.approval?.approved || initial.approval.revision !== initial.brief.revision || initial.activeRunId || initial.executionWindow)
        throw new Error('Execute only an approved inactive workflow; recover unresolved attempts first')
      if (initial.brief.verificationCommands.some(command => command.timeoutMs === undefined))
        throw new Error('Legacy brief needs a revised, newly approved explicit command timeoutMs before execution')
      const remaining = initial.brief.executionBudgetMs - Math.max(initial.executionMs, initial.executionWallMs ?? 0)
      if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 2147483647) throw new Error('Unsupported or exhausted execution wall-clock budget')
      lifetime.throwIfAborted()
      const key = await realpath(parent.session.header.cwd!)
      if (this.repositories.has(key)) throw new Error('Another workflow owns this repository')
      const lease = Promise.withResolvers<void>()
      this.repositories.set(key, lease.promise)
      const id = randomUUID(), deadline = new AbortController()
      const signal = AbortSignal.any([lifetime, deadline.signal])
      let started: number | undefined, timer: ReturnType<typeof setTimeout> | undefined
      let primaryError: unknown
      try {
        requireOperationPermission(controller.state, parent.session, 'execution', this.ctx.reviewGatedJournals.confirmationMode)
        const observation = await this.inspectRepository(parent, permission.id, 'execution', signal, permission.preflight)
        if (observation.status !== 'passed') throw new Error('Repository preflight blocked execution: ' + observation.issues.map(issue => issue.message).join('; '))
        requireOperationPermission(controller.state, parent.session, 'execution', this.ctx.reviewGatedJournals.confirmationMode)
        this.requireMain(parent)
        signal.throwIfAborted()
        const windowStarted = performance.now()
        started = windowStarted
        timer = setTimeout(() => deadline.abort(new Error('Execution wall-clock budget exhausted')), remaining)
        timer.unref()
        await controller.apply({ type: 'authorized-execution-started', requestId: permission.id, id })
        signal.throwIfAborted()
        await this.drive(parent, signal, () => remaining - Math.ceil(performance.now() - windowStarted))
        signal.throwIfAborted()
      } catch (error) {
        primaryError = error
        const state = controller.state
        if (state.executionWindow?.id === id && !state.activeRunId && ['Approved', 'Implemented', 'Staged', 'Needs Changes', 'Ready for Handoff'].includes(state.phase))
          await controller.apply({ type: 'paused', reason: error instanceof Error ? error.message : 'Execution failed' })
        throw error
      } finally {
        try {
          if (started !== undefined && controller.state.executionWindow?.id === id) await controller.apply({ type: 'execution-window-finished', id, elapsedMs: Math.ceil(performance.now() - started) })
          const elapsedMs = started === undefined ? 0 : Math.ceil(performance.now() - started)
          if (elapsedMs >= remaining && Math.max(controller.state.executionMs, controller.state.executionWallMs ?? 0) < initial.brief.executionBudgetMs)
            await controller.apply({ type: 'execution-budget-exhausted', executionWallMs: Math.max(initial.executionMs, initial.executionWallMs ?? 0) + elapsedMs })
        } catch (settlementError) {
          if (primaryError !== undefined) throw new AggregateError([primaryError, settlementError], 'Execution failed and its window settlement could not be saved')
          throw settlementError
        } finally { clearTimeout(timer); if (this.repositories.get(key) === lease.promise) this.repositories.delete(key); lease.resolve() }
      }
      if (signal.aborted) {
        if (['Approved', 'Implemented', 'Staged', 'Needs Changes', 'Ready for Handoff'].includes(controller.state.phase))
          await controller.apply({ type: 'paused', reason: signal.reason instanceof Error ? signal.reason.message : 'Execution cancelled' })
        signal.throwIfAborted()
      }
      return controller.state
    })
    this.active.set(parent, { abort, promise })
    try { return await promise } finally { if (this.active.get(parent)?.promise === promise) this.active.delete(parent) }
  }
  private async drive(parent: Agent, signal: AbortSignal, remainingMs: () => number): Promise<WorkflowState> {
    const journals = this.ctx.reviewGatedJournals
    const controller = journals.controller(parent.session)
    let activityStarted = performance.now()
    const initial = controller.state
    const authorization = initial.operationAuthorization
    if (authorization?.status !== 'consumed' || authorization.kind !== 'execution' || authorization.operationId !== initial.executionWindow?.id) throw new Error('Execution has no consumed permission for its current window')
    requireDecisionReceipts(initial, journals.view(parent.session).decisionEvidence.recovery.questionId)
    if (!['Approved', 'Implemented', 'Staged', 'Needs Changes'].includes(initial.phase) || !initial.brief || !initial.approval?.approved)
      throw new Error('Execute only an approved, inactive workflow; paused or interrupted runs require explicit recovery')
    try {
      const git = await this.openGit(parent.session.header.cwd!, signal)
      let base = journals.view(parent.session).baseCommit
      if (!base) {
        if (initial.phase !== 'Approved') throw new Error('Existing workflow has no approved Git baseline')
        const proof = authorization.preflight
        if (!proof) throw new Error('Execution lacks its approved repository baseline')
        const observed = await git.inspectBaseline(initial.brief)
        if (!sameBaseline(observed, proof)) throw new Error('Repository moved after authorization; never select a replacement baseline')
        base = proof.head
        await journals.bindBase(parent.session, base, proof.repository)
      }
      const snapshotParent = await realpath(this.config.snapshotParent)
      for (;;) {
        signal.throwIfAborted()
        let state = controller.state
        const brief = state.brief!
        if (state.phase === 'Approved' || state.phase === 'Needs Changes') {
          if (resolveExecutionIntent(brief) === 'verification-only') {
            if (state.phase !== 'Approved') throw new Error('Verification-only execution cannot repair a review')
            await controller.apply({ type: 'snapshot-created', snapshot: await git.capture(brief, base) })
            state = controller.state
          } else {
            if (authorization.mode === 'verify-review') return state
            await git.assertWithinScope(brief, base)
            if (state.phase === 'Needs Changes' && state.snapshot) await git.assertCurrent(state.snapshot)
            const repair = state.phase === 'Needs Changes' ? state.review : null
            if (state.phase === 'Needs Changes' && repair?.outcome !== 'Needs Changes') throw new Error('Repair feedback is missing; revise or restore the original review before retrying')
            const runId = randomUUID()
            await controller.apply({ type: 'implementation-started', runId })
            activityStarted = performance.now()
            const result = await this.ctx.reviewGatedRoles.run({ role: 'implementation', parent, runId, cwd: git.repository, brief, repair, signal })
            if (result.role !== 'implementation') throw new Error('Wrong role returned implementation output')
            await controller.apply({ type: 'implementation-finished', runId, result: result.result, elapsedMs: result.elapsedMs })
            state = controller.state
          }
        }
        if (state.phase === 'Paused') return state
        if (state.phase === 'Implemented') {
          signal.throwIfAborted()
          await controller.apply({ type: 'snapshot-created', snapshot: await git.stage(brief, base) })
          state = controller.state
        }
        if (state.phase !== 'Staged' || !state.snapshot) return state
        const snapshot = state.snapshot
        await git.assertCurrent(snapshot)
        const exportForChecks = await git.materialize(snapshot, snapshotParent)
        try {
          const runId = randomUUID()
          await controller.apply({ type: 'verification-started', runId })
          activityStarted = performance.now()
          const checked = await this.ctx.reviewGatedVerification.run({ parent, runId, git, brief, snapshot, directory: exportForChecks.directory, signal, remainingMs: remainingMs() })
          await controller.apply({ type: 'verification-recorded', runId, evidence: checked.evidence, elapsedMs: checked.elapsedMs })
        } finally { await exportForChecks.dispose() }
        state = controller.state
        if (state.phase === 'Paused') return state
        if (!checksPassed(state)) return controller.apply({ type: 'paused', reason: 'Required snapshot verification commands failed; ask the user before changing requirements or retrying' })
        signal.throwIfAborted()
        await git.assertCurrent(snapshot)
        const diff = await git.diff(snapshot)
        const exportForReview = await git.materialize(snapshot, snapshotParent)
        try {
          await git.assertWithinScope(brief, base)
          await git.assertMaterialized(snapshot, exportForReview.directory)
          const hostObservations = { snapshotId: snapshot.id, treeId: snapshot.treeId, sourceIntegrity: 'checked' as const, allowedScope: 'checked' as const, checkedAt: Date.now(), scopeBaseCommit: base }
          const runId = randomUUID()
          await controller.apply({ type: 'review-started', runId })
          activityStarted = performance.now()
          const reviewed = await this.ctx.reviewGatedRoles.run({ role: 'review', parent, runId, cwd: exportForReview.directory, brief, snapshot, verification: state.verification!, diff, hostObservations, signal })
          if (reviewed.role !== 'review') throw new Error('Wrong role returned review output')
          validateReviewResult({ brief, snapshot, verification: state.verification! }, reviewed.result, runId)
          await git.assertMaterialized(snapshot, exportForReview.directory)
          await git.assertReviewEvidence(snapshot, reviewed.result, exportForReview.directory, runId)
          await git.assertCurrent(snapshot)
          await controller.apply({ type: 'review-finished', runId, result: reviewed.result, elapsedMs: reviewed.elapsedMs })
        } finally { await exportForReview.dispose() }
        state = controller.state
        if (state.phase !== 'Needs Changes') return state
      }
    } catch (error) {
      const state = controller.state
      const failures: unknown[] = [error]
      if (error instanceof RoleResultError) {
        const failure = { role: error.role, runId: error.runId, issues: error.issues, issueCount: error.issueCount, logReference: { sessionId: error.runId } }
        try {
          if (error.kind === 'semantic-validation') await controller.apply({ type: 'review-result-rejected', failure: { ...failure, role: 'review', kind: error.kind } })
          else await controller.apply({ type: 'role-result-rejected', failure: { ...failure, kind: error.kind } })
        } catch (auditError) { failures.push(auditError) }
      }
      const reason = error instanceof Error ? error.message : 'Workflow execution failed'
      let settled = false
      try {
        if (state.activeRunId) { await controller.apply({ type: 'role-interrupted', runId: state.activeRunId, reason, elapsedMs: Math.ceil(performance.now() - activityStarted) }); settled = true }
        else if (['Approved', 'Implemented', 'Staged', 'Needs Changes', 'Ready for Handoff'].includes(state.phase)) { await controller.apply({ type: 'paused', reason }); settled = true }
      } catch (settlementError) { throw new AggregateError([...failures, settlementError], 'Role failure settlement could not be saved; continuation is not authorized') }
      if (failures.length > 1) throw new AggregateError(failures, 'Rejected role output was not audited; the settled role was interrupted and continuation is not authorized')
      if (settled) return controller.state
      throw error
    }
  }
  /** Re-check the exact real repository before declaring completion; never commit or push.
   * @param parent Main Agent owning a Passed candidate.
   * @param signal Caller cancellation.
   * @returns The durable terminal state.
   */
  async handoff(parent: Agent, signal: AbortSignal): Promise<WorkflowState> {
    this.requireMain(parent)
    return this.operation(parent, async () => {
      const control = AbortSignal.any([signal, this.shutdown.signal, this.ctx.reviewGatedJournals.signal])
      control.throwIfAborted()
      const controller = this.ctx.reviewGatedJournals.controller(parent.session)
      const state = controller.state
      requireDecisionReceipts(state, this.ctx.reviewGatedJournals.view(parent.session).decisionEvidence.recovery.questionId)
      if (state.hostOperation?.status === 'Running') throw new Error('Recover or drain the existing host task before handoff')
      const permission = requireOperationPermission(state, parent.session, 'handoff', this.ctx.reviewGatedJournals.confirmationMode)
      if (state.phase !== 'Ready for Handoff' || !state.snapshot || !state.brief) throw new Error('No reviewed snapshot is ready for handoff')
      const snapshot = state.snapshot, brief = state.brief
      const key = await realpath(parent.session.header.cwd!)
      this.requireMain(parent)
      if (this.repositories.has(key)) throw new Error('Another workflow owns this repository')
      control.throwIfAborted()
      const pending = (async () => {
        const git = await this.openGit(parent.session.header.cwd!, control)
        control.throwIfAborted()
        try { await git.assertCurrent(snapshot) } catch (error) {
          await controller.apply({ type: 'paused', reason: error instanceof Error ? error.message : 'Stale snapshot' })
          throw error
        }
        control.throwIfAborted()
        this.requireMain(parent)
        requireOperationPermission(controller.state, parent.session, 'handoff', this.ctx.reviewGatedJournals.confirmationMode)
        return controller.apply({ type: 'authorized-handoff-completed', requestId: permission.id, snapshotId: snapshot.id, treeId: snapshot.treeId, briefRevision: brief.revision })
      })()
      this.repositories.set(key, pending)
      try { return await pending } finally { if (this.repositories.get(key) === pending) this.repositories.delete(key) }
    })
  }
  /** Commit a bound decision only from an exact logged user confirmation, after repository revalidation.
   * @param parent Admitted live Main root.
   * @param questionId Current recorded question.
   * @param userMessageSeq Sequence of the exact new user confirmation.
   * @param cancellation Tool and Agent lifetime.
   * @returns Committed workflow; never starts execution or handoff.
   */
  async confirmQuestion(parent: Agent, questionId: string, userMessageSeq: number, cancellation: AbortSignal): Promise<WorkflowState> {
    this.requireMain(parent)
    if (this.active.has(parent) || this.ctx.get('reviewGatedTasks')?.running(parent)) throw new Error('Do not confirm decisions during live execution or host operations')
    return this.operation(parent, async () => {
      const signal = AbortSignal.any([cancellation, this.shutdown.signal, this.ctx.reviewGatedJournals.signal])
      const journals = this.ctx.reviewGatedJournals, controller = journals.controller(parent.session), state = controller.state
      const question = state.questions?.find(item => item.id === questionId)
      if (!question || !['pending', 'service-returned'].includes(question.status) || question.binding !== questionBinding(state)) throw new Error('No current question can be confirmed')
      const confirmed = confirmationReceipt(parent.session, question, userMessageSeq)
      const key = await realpath(parent.session.header.cwd!)
      this.requireMain(parent)
      if (this.repositories.has(key)) throw new Error('Another workflow owns this repository')
      const pending = (async () => {
        if (question.kind !== 'host-recovery' && (question.kind === 'recovery' || state.snapshot || journals.view(parent.session).baseCommit)) {
          const git = await this.openGit(key, signal), view = journals.view(parent.session)
          if (view.baseCommit && await git.head() !== view.baseCommit) throw new Error('Approved Git baseline moved while awaiting confirmation')
          if (state.snapshot && ((question.kind === 'approval' && confirmed.selected === 'Approve') || confirmed.selected === 'Retry unchanged approved brief')) await git.assertCurrent(state.snapshot)
        }
        if (state.activeRunId && this.ctx.agents.get(SessionId(state.activeRunId))) throw new Error('Previous role is still registered; stop and drain it first')
        signal.throwIfAborted()
        this.requireMain(parent)
        if (this.active.has(parent) || this.ctx.get('reviewGatedTasks')?.running(parent)) throw new Error('Do not confirm decisions during live execution or host operations')
        const currentConfirmation = confirmationReceipt(parent.session, question, userMessageSeq)
        return controller.apply({ type: 'question-confirmed', questionId, ...currentConfirmation })
      })()
      this.repositories.set(key, pending)
      try { return await pending } finally { if (this.repositories.get(key) === pending) this.repositories.delete(key) }
    })
  }

  /** Inspect a repository under a separately bounded, durable budget; never grants permission. */
  private async inspectRepository(parent: Agent, requestId: OperationRequestId, kind: OperationRequest['kind'], cancellation: AbortSignal, expected?: PreflightProof, observedConfirmation?: RepositoryPreflight['observedConfirmation']): Promise<RepositoryPreflight> {
    const journals = this.ctx.reviewGatedJournals, controller = journals.controller(parent.session), state = controller.state
    const deadline = new AbortController(), started = performance.now()
    const totalTimeoutMs = this.preflightTimeoutMs
    const signal = AbortSignal.any([cancellation, this.shutdown.signal, journals.signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(new Error('Repository preflight total budget exhausted')), totalTimeoutMs)
    timer.unref()
    const running: RepositoryPreflight = { id: PreflightId(randomUUID()), requestId, kind, revision: state.brief!.revision, scopeBinding: questionBinding(state), status: 'running', startedAt: Date.now(), durationMs: 0, baseline: null,
      limits: { commandTimeoutMs: this.gitLimits.timeoutMs, integrityTimeoutMs: this.gitLimits.integrityTimeoutMs, totalTimeoutMs }, issues: [], ...(observedConfirmation ? { observedConfirmation } : {}) }
    try {
      if (state.repositoryPreflight?.status === 'running') {
        const interrupted = state.repositoryPreflight
        await controller.apply({ type: 'repository-preflight-recorded', preflight: { ...interrupted, status: 'blocked', durationMs: interrupted.limits.totalTimeoutMs, issues: [{ code: 'preflight-interrupted', message: 'Previous preflight did not settle; its complete total budget is conservatively recorded. No permission or successful observation is inferred.' }] } })
      }
      await controller.apply({ type: 'repository-preflight-recorded', preflight: running })
      let baseline: RepositoryPreflight['baseline'] = null
      const issues: RepositoryPreflight['issues'] = []
      try {
        const git = await this.openGit(parent.session.header.cwd!, signal)
        const base = journals.view(parent.session).baseCommit
        if (state.snapshot) { await git.assertCurrent(state.snapshot); baseline = { repository: git.repository, head: await git.head(), treeId: state.snapshot.treeId } }
        else {
          try { baseline = await git.inspectBaseline(state.brief!) }
          catch (error) {
            if (state.phase === 'Implemented') throw new Error('An Implemented candidate without a staged snapshot requires a clean supported baseline before a new operation. Existing implementation files are preserved; do not reset or discard them.', { cause: error })
            throw error
          }
        }
        if (base && baseline.head !== base) throw new Error('Approved Git baseline moved; request revised authorization after reconciling the repository')
        if (expected && !sameBaseline(baseline, expected)) throw new Error('Repository baseline changed after the permission card; obtain a fresh preflight and authorization')
        signal.throwIfAborted()
        this.requireMain(parent)
      } catch (error) {
        baseline = null
        const message = error instanceof Error ? error.message : String(error)
        issues.push({ code: deadline.signal.aborted ? 'preflight-total-timeout' : error instanceof GitFailure ? error.diagnostic.kind : 'repository-incompatible', message: message.slice(0, 8192),
          ...(error instanceof GitFailure ? { diagnostic: { ...error.diagnostic, args: [...error.diagnostic.args] } } : {}) })
      }
      const finished: RepositoryPreflight = { ...running, status: baseline ? 'passed' : 'blocked', baseline, issues, durationMs: Math.max(0, Math.floor(performance.now() - started)) }
      await controller.apply({ type: 'repository-preflight-recorded', preflight: finished })
      return finished
    } finally { clearTimeout(timer) }
  }

  /** Persist an exact operation request only after repository preflight succeeds.
   * @param parent Live Main owner. @param kind Execution or distinct handoff. @param cancellation Caller lifetime.
   * @returns Current request and available logged reply; manual templates only in explicit legacy mode.
   */
  async requestOperation(parent: Agent, kind: OperationRequest['kind'], cancellation: AbortSignal) {
    this.requireMain(parent)
    return this.operation(parent, async () => {
      cancellation.throwIfAborted()
      const journals = this.ctx.reviewGatedJournals, controller = journals.controller(parent.session), state = controller.state
      requireDecisionReceipts(state, journals.view(parent.session).decisionEvidence.recovery.questionId)
      if (this.active.has(parent) || this.ctx.get('reviewGatedTasks')?.running(parent)) throw new Error('Do not request operations during live execution')
      const mode = operationMode(state, kind), id = OperationRequestId(randomUUID())
      const key = await realpath(parent.session.header.cwd!)
      if (this.repositories.has(key)) throw new Error('Another workflow owns this repository')
      const pending = (async () => {
        const observation = await this.inspectRepository(parent, id, kind, cancellation)
        if (observation.status !== 'passed' || !observation.baseline) return controller.state
        const proof: PreflightProof = { id: observation.id, ...observation.baseline }
        const events = parent.session.snapshotEvents()
        await controller.apply({ type: 'operation-requested', request: { id, kind, mode, preflight: proof,
          revision: state.brief!.revision, binding: operationBinding(controller.state, proof), askedAt: Date.now(), afterSeq: events.at(-1)?.seq ?? -1, status: 'pending' } })
        return controller.state
      })()
      this.repositories.set(key, pending)
      try { await pending } finally { if (this.repositories.get(key) === pending) this.repositories.delete(key) }
      return operationEvidence(controller.state, parent.session, this.ctx.reviewGatedJournals.confirmationMode)
    })
  }
  /** Record permission from exact later input, with repository preflight and a final input recheck.
   * @param parent Live Main owner. @param requestId Current request. @param userMessageSeq Actual user input sequence.
   * @param cancellation Caller lifetime. @returns Unadvanced workflow; authorization alone starts nothing.
   */
  async confirmOperation(parent: Agent, requestId: OperationRequestId, userMessageSeq: number, cancellation: AbortSignal): Promise<WorkflowState> {
    this.requireMain(parent)
    return this.operation(parent, async () => {
      const journals = this.ctx.reviewGatedJournals, controller = journals.controller(parent.session), state = controller.state
      const signal = AbortSignal.any([cancellation, this.shutdown.signal, journals.signal])
      const request = state.operationAuthorization
      if (!request || request.id !== requestId || request.status !== 'pending' || request.binding !== operationBinding(state, request.preflight)) throw new Error('No current operation request can be confirmed')
      operationMode(state, request.kind)
      requireDecisionReceipts(state, journals.view(parent.session).decisionEvidence.recovery.questionId)
      const answer = operationReceipt(parent.session, request, userMessageSeq, controller.state)
      if (this.active.has(parent) || this.ctx.get('reviewGatedTasks')?.running(parent)) throw new Error('Do not authorize during live execution')
      const key = await realpath(parent.session.header.cwd!)
      if (this.repositories.has(key)) throw new Error('Another workflow owns this repository')
      const pending = (async () => {
        if (answer.selected === 'Authorize') {
          if (!request.preflight) throw new Error('Legacy request needs a fresh repository preflight and authorization card')
          const observation = await this.inspectRepository(parent, request.id, request.kind, signal, request.preflight, { ...answer.receipt, selected: answer.selected })
          if (observation.status !== 'passed') throw new Error('Repository preflight blocked authorization: ' + observation.issues.map(issue => issue.code + ': ' + issue.message).join('; '))
        }
        signal.throwIfAborted()
        this.requireMain(parent)
        if (this.active.has(parent) || this.ctx.get('reviewGatedTasks')?.running(parent)) throw new Error('Do not authorize during live execution')
        return controller.apply({ type: 'operation-confirmed', requestId, ...operationReceipt(parent.session, request, userMessageSeq, controller.state) })
      })()
      this.repositories.set(key, pending)
      try { return await pending } finally { if (this.repositories.get(key) === pending) this.repositories.delete(key) }
    })
  }

  /** Cancel owned execution before recording terminal cancellation; unknown old processes require recovery.
   * @param parent Admitted live Main root.
   * @param reason Main-supplied explanation, not human approval evidence.
   * @param signal Tool and Agent lifetime.
   * @returns Quiescent terminal cancellation state.
   */
  async cancel(parent: Agent, reason: string, signal: AbortSignal): Promise<WorkflowState> {
    this.requireMain(parent)
    await this.ctx.get('reviewGatedTasks')?.cancel(parent, reason)
    const owned = this.active.get(parent)
    if (owned) {
      owned.abort.abort(new Error('Main requested cancellation: ' + reason))
      await Promise.allSettled([owned.promise])
    }
    return this.operation(parent, async () => {
      signal.throwIfAborted()
      this.requireMain(parent)
      const controller = this.ctx.reviewGatedJournals.controller(parent.session)
      if (controller.state.activeRunId || controller.state.hostOperation?.status === 'Running') throw new Error('Confirm previous process quiescence through rg_recover before cancellation')
      return controller.apply({ type: 'cancelled', reason: 'Main requested cancellation: ' + reason })
    })
  }
  /** Record a recovery question and its unattributed service response; exact logged confirmation is a separate operation.
   * @param parent Admitted live Main root.
   * @param cancellation Tool and Agent lifetime.
   * @returns Pending confirmation and unchanged execution phase; does not execute.
   */
  async recover(parent: Agent, cancellation: AbortSignal) {
    this.requireMain(parent)
    if (this.active.has(parent)) throw new Error('Cancel or await the live owned execution before recovery')
    return this.operation(parent, async () => {
      const signal = AbortSignal.any([cancellation, this.shutdown.signal, this.ctx.reviewGatedJournals.signal])
      signal.throwIfAborted()
      const controller = this.ctx.reviewGatedJournals.controller(parent.session)
      const state = controller.state
      if (!state.executionWindow && !['Paused', 'Implementing', 'Reviewing', 'Verifying', 'Staged'].includes(state.phase)) throw new Error('No paused or unresolved active attempt to recover')
      if (state.executionWindow && state.hostOperation?.status === 'Running') throw new Error('Reconcile the restored host task before recovering its unresolved execution window')
      const key = await realpath(parent.session.header.cwd!)
      this.requireMain(parent)
      if (this.repositories.has(key)) throw new Error('Another workflow owns this repository')
      if (state.activeRunId && this.ctx.agents.get(SessionId(state.activeRunId))) throw new Error('A previous role is still registered; stop and drain it before recovery')
      const git = await this.openGit(key, signal)
      const view = this.ctx.reviewGatedJournals.view(parent.session)
      if (view.baseCommit && await git.head() !== view.baseCommit) throw new Error('Approved Git baseline moved; recovery cannot rebase or replace it')
      const options = state.activeRunId || state.executionWindow
        ? [{ label: 'Confirm previous processes stopped', description: 'I have verified all old role and command processes stopped. Invalidate this attempt and consume its unknown remaining budget; another approved revision is required.' }, { label: 'Leave unresolved', description: 'Do not restart, discard the interruption, or claim process quiescence.' }]
        : [{ label: 'Revise requirements', description: 'Return to clarification; submit the next complete brief revision and obtain new approval.' }, { label: 'Leave paused', description: 'Do not restart work.' }]
      let canRetry = false
      if (!state.activeRunId && !state.executionWindow) {
        try { transition(state.phase === 'Staged' ? { ...state, phase: 'Paused', pausedFrom: 'Staged' } : state, { type: 'resumed' }); if (state.snapshot) await git.assertCurrent(state.snapshot); canRetry = true }
        catch (error) { /* An exhausted limit, uncertainty, or stale snapshot requires a new approved brief. */ if (!(error instanceof Error)) throw error }
        if (canRetry) options.unshift({ label: 'Retry unchanged approved brief', description: 'Resume the exact approved scope and limits; rerun required checks and fresh review. Does not execute until rg_execute is called.' })
      }
      signal.throwIfAborted()
      await askDecisionQuestion(controller, parent.session, 'recovery', {
        question: state.activeRunId || state.executionWindow ? 'Can you confirm all previous processes stopped before reconciling this interrupted attempt?' : 'How should this paused approved task proceed?',
        detail: this.ctx.reviewGatedJournals.confirmationMode === 'buttons' ? recoveryDetails(state, view.baseCommit) : JSON.stringify({ brief: state.brief, phase: state.phase, activeRunId: state.activeRunId, pauseReason: state.pauseReason, implementation: state.implementation, review: state.review, executionMs: state.executionMs, baseCommit: view.baseCommit }, null, 2),
        options,
      }, question => this.ctx.userQuestions.ask({ agent: parent, signal, questions: [question] }), signal, this.ctx.reviewGatedJournals.confirmationMode)
      return { decision: 'awaiting-user-confirmation', needsConfirmation: true, ...this.ctx.reviewGatedJournals.view(parent.session) }
    })
  }
  /** Re-check snapshot currency for a six-part report without changing historical completion.
   * @param parent Admitted live Main root.
   * @param cancellation Tool and Agent lifetime.
   * @returns Factual report separating recorded completion from current repository contents.
   */
  async report(parent: Agent, cancellation: AbortSignal): Promise<MainReport> {
    this.requireMain(parent)
    return this.operation(parent, async () => {
      const signal = AbortSignal.any([cancellation, this.shutdown.signal, this.ctx.reviewGatedJournals.signal])
      signal.throwIfAborted()
      const view = this.ctx.reviewGatedJournals.view(parent.session)
      let currency: SnapshotCurrency = { status: 'absent', reason: 'No staged snapshot recorded.' }
      if (view.state.snapshot) {
        try {
          const key = await realpath(parent.session.header.cwd!)
          if (this.repositories.has(key)) currency = { status: 'not-checked', reason: 'Another workflow owns the repository.' }
          else {
            const git = await this.openGit(key, signal)
            await git.assertCurrent(view.state.snapshot)
            currency = { status: 'current', reason: 'HEAD, index, tracked contents and Git-visible untracked files match the recorded snapshot.' }
          }
        } catch (error) { currency = { status: 'stale', reason: error instanceof Error ? error.message : 'Could not establish current snapshot identity.' } }
      }
      signal.throwIfAborted()
      return buildReport(view, currency, parent.session)
    })
  }
  /** Abort and drain all workflow operations, including human recovery waits, on plugin disposal. */
  async close(): Promise<void> {
    this.shutdown.abort(new Error('Workflow execution disposed'))
    await Promise.allSettled([...this.operations])
  }
}
declare module '@deepseek-ai/cordis' { interface Context { reviewGatedExecution: WorkflowExecution } }
export const name = 'review-gated-execution'
export const inject = ['agents', 'reviewGatedJournals', 'reviewGatedPermissions', 'reviewGatedRoles', 'reviewGatedVerification', 'userQuestions', 'reviewGatedHostWorld']
export function apply(ctx: Context, config: Config): void {
  const execution = new WorkflowExecution(ctx, config)
  ctx.provide('reviewGatedExecution', execution)
  ctx.effect(() => () => execution.close())
}
