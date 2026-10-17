/** Approved argv-only checks in exported snapshots, with native confinement and managed-range teardown. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { isDeepStrictEqual } from 'node:util'
import { performance } from 'node:perf_hooks'
import { classifyRunnerFailure } from '@deepseek-ai/dsh-sandbox'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '../security/native.js'
import type {} from '../security/host-world.js'
import type {} from '../security/permissions.js'
import type {} from '../storage/support.js'
import { verificationCompatibility } from './compatibility.js'
import type { GitSnapshots } from '../git/snapshots.js'
import type { RequirementsBrief, StagedSnapshot, CheckResult, VerificationEvidence } from '../workflow/types.js'
import { resolveExecutionIntent } from '../workflow/execution-policy.js'

export interface Config { commandTimeoutMs: number; graceMs: number; maxEvidenceBytes: number }
export const Config: Schema<Config> = Schema.object({
  commandTimeoutMs: Schema.number().min(1).max(2147483647).step(1).default(120000),
  graceMs: Schema.number().min(1).max(2147483647).step(1).default(1000),
  maxEvidenceBytes: Schema.number().min(1).step(1).default(1024 * 1024),
})
export interface VerificationRequest { parent: Agent; runId: string; git: GitSnapshots; brief: RequirementsBrief; snapshot: StagedSnapshot; directory: string; signal: AbortSignal; remainingMs?: number }
/** Owns deadlines and exit accounting; the public subprocess provider owns process termination. */
export class VerificationRunner {
  private readonly shutdown = new AbortController()
  private readonly active = new Set<Promise<{ evidence: VerificationEvidence; elapsedMs: number }>>()
  constructor(private readonly ctx: Context, private readonly config: Config) {}
  /** Report approved command limits capped by this deployment; active remaining time can only shorten them.
   * @param brief Current durable requirements, including historical optional deadlines.
   * @returns Explicit deadlines and configured caps; observed checks also record their actual effective timeout.
   */
  limitsFor(brief: RequirementsBrief | null) {
    return { commandTimeoutMs: this.config.commandTimeoutMs, compatibility: verificationCompatibility(brief), commands: brief?.verificationCommands.map(command => ({
      executable: command.executable, args: command.args, approvedTimeoutMs: command.timeoutMs ?? null,
      effectiveCapMs: Math.min(command.timeoutMs ?? this.config.commandTimeoutMs, this.config.commandTimeoutMs),
    })) ?? [] }
  }
  /** Execute the exact approved commands against unchanged exported source.
   * @param request Active durable verification and its separate writable export.
   * @returns Snapshot-bound command evidence and total verification runtime.
   */
  async run(request: VerificationRequest): Promise<{ evidence: VerificationEvidence; elapsedMs: number }> {
    this.shutdown.signal.throwIfAborted()
    const pending = this.drive(request)
    this.active.add(pending)
    try { return await pending } finally { this.active.delete(pending) }
  }
  private async drive(request: VerificationRequest): Promise<{ evidence: VerificationEvidence; elapsedMs: number }> {
    const requirePermission = () => {
      const current = this.ctx.reviewGatedJournals.view(request.parent.session).state
      const grant = this.ctx.reviewGatedPermissions.of(request.parent.session), authorization = current.operationAuthorization
      if (!grant || grant.role !== 'main' || this.ctx.agents.get(request.parent.id) !== request.parent)
        throw new Error('Verification requires the admitted live Main Agent')
      if (!authorization || authorization.kind !== 'execution' || authorization.status !== 'consumed' || !authorization.receipt ||
          authorization.receipt.seq < request.parent.session.firstLiveSeq || !current.executionWindow || authorization.operationId !== current.executionWindow.id ||
          (resolveExecutionIntent(request.brief) === 'verification-only' && authorization.mode !== 'verify-review'))
        throw new Error('Verification requires current consumed operation permission for its live window and mode')
      if (current.phase !== 'Verifying' || current.activeRunId !== request.runId || !current.approval?.approved ||
          !isDeepStrictEqual(current.brief, request.brief) || !isDeepStrictEqual(current.snapshot, request.snapshot))
        throw new Error('Checks must match the active approved verification run')
      return current
    }
    const state = requirePermission()
    const remaining = Math.min(request.brief.executionBudgetMs - Math.max(state.executionMs, state.executionWallMs ?? 0), request.remainingMs ?? Infinity)
    if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 2147483647) throw new Error('Verification budget exhausted or unsupported')
    const started = performance.now()
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error('Verification execution budget exhausted')), remaining)
    timer.unref()
    const signal = AbortSignal.any([request.signal, deadline.signal, this.shutdown.signal])
    const checks: CheckResult[] = []
    try {
      for (const command of request.brief.verificationCommands) {
        signal.throwIfAborted()
        await request.git.assertMaterialized(request.snapshot, request.directory)
        requirePermission()
        const commandStarted = performance.now()
        const timeout = new AbortController()
        const effectiveTimeoutMs = Math.min(command.timeoutMs ?? this.config.commandTimeoutMs, this.config.commandTimeoutMs, remaining - Math.ceil(performance.now() - started))
        if (effectiveTimeoutMs <= 0) throw new Error('Verification execution budget exhausted')
        const commandTimer = setTimeout(() => timeout.abort(new Error('Verification command timed out')), effectiveTimeoutMs)
        commandTimer.unref()
        const commandSignal = AbortSignal.any([signal, timeout.signal])
        try {
          const executable = await this.ctx.reviewGatedHostWorld.resolveExecutable(command.executable, undefined, commandSignal)
          const confined = await this.ctx.reviewGatedNativeSandbox.confine([executable, ...command.args], { mode: 'workspace-write', workspaceRoot: request.directory }, commandSignal)
          commandSignal.throwIfAborted()
          requirePermission()
          const handle = this.ctx.reviewGatedHostWorld.spawn({ argv: confined.argv, cwd: request.directory,
            stdio: { stdin: 'ignore', stdout: { maxBytes: this.config.maxEvidenceBytes }, stderr: { maxBytes: this.config.maxEvidenceBytes } },
            graceMs: this.config.graceMs, signal: commandSignal })
          let outcome
          try { outcome = await handle.done } finally {
            handle.terminate()
            await handle.waitForExit()
          }
          const stdout = handle.collected.stdout!.readFrom(0), stderr = handle.collected.stderr!.readFrom(0)
          if (stdout.lossy || stderr.lossy) throw new Error('Verification diagnostics exceeded their complete-output limit')
          const runnerFailure = classifyRunnerFailure(outcome.exitCode, stderr.text, confined.runnerFailureRules)
          if (runnerFailure) throw new Error('Verification sandbox runner failed before command execution: ' + stderr.text)
          await request.git.assertMaterialized(request.snapshot, request.directory)
          requirePermission()
          const check: CheckResult = { command, effectiveTimeoutMs, ...outcome, stdout: stdout.text, stderr: stderr.text,
            timedOut: timeout.signal.aborted || deadline.signal.aborted, durationMs: Math.ceil(performance.now() - commandStarted) }
          checks.push(check)
          const evidence = { snapshotId: request.snapshot.id, treeId: request.snapshot.treeId, checks }
          if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > this.config.maxEvidenceBytes) throw new Error('Verification evidence exceeds the complete serialized byte limit')
          signal.throwIfAborted()
          if (check.exitCode !== 0 || check.signal !== null || check.timedOut) break
        } finally { clearTimeout(commandTimer) }
      }
      signal.throwIfAborted()
      return { evidence: { snapshotId: request.snapshot.id, treeId: request.snapshot.treeId, checks }, elapsedMs: Math.max(Math.ceil(performance.now() - started), checks.reduce((sum, check) => sum + check.durationMs, 0)) }
    } finally { clearTimeout(timer) }
  }
  /** Stop all verification commands and await their managed ranges. */
  async close(): Promise<void> {
    this.shutdown.abort(new Error('Verification runner disposed'))
    await Promise.allSettled([...this.active])
  }
}
declare module '@deepseek-ai/cordis' { interface Context { reviewGatedVerification: VerificationRunner } }
export const name = 'review-gated-verification'
export const inject = ['agents', 'reviewGatedHostWorld', 'reviewGatedNativeSandbox', 'reviewGatedJournals', 'reviewGatedPermissions']
export function apply(ctx: Context, config: Config): void {
  const runner = new VerificationRunner(ctx, config)
  ctx.provide('reviewGatedVerification', runner)
  ctx.effect(() => () => runner.close())
}
