/** Bounded calls observe durable Main-owned operations; PTC cancellation never owns these tasks. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { askDecisionQuestion } from './questions.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '../storage/support.js'
import { HostOperationId } from './types.js'
import type { HostOperation } from './types.js'

type JsonValue = z.infer<ReturnType<typeof z.json>>

export interface Config { maxWaitMs: number; maxResultBytes: number; maxOperationMs: number }
export const Config: Schema<Config> = Schema.object({
  maxOperationMs: Schema.number().min(1).max(2147483647).step(1).default(1800000),
  maxWaitMs: Schema.number().min(1).max(60000).step(1).default(10000),
  maxResultBytes: Schema.number().min(1).step(1).default(256 * 1024),
})
/** Owns cancellation and settlement independently of the short calling program. */
export class HostTasks {
  private readonly shutdown = new AbortController()
  private readonly active = new Map<Agent, { id: HostOperationId; abort: AbortController; done: Promise<void> }>()
  private readonly observed = new WeakSet<Agent>()
  constructor(private readonly ctx: Context, private readonly config: Config) {}
  /** Persist a run identity before starting activity.
   * @param parent Admitted Main owner.
   * @param kind Workflow operation, not a role permission.
   * @param lifetime Main/preset lifetime, never the short PTC caller's signal.
   * @param run Host-owned operation with explicit cancellation.
   * @returns Durable run status for subsequent bounded observation.
   */
  async start(parent: Agent, kind: HostOperation['kind'], lifetime: AbortSignal, run: (signal: AbortSignal) => Promise<JsonValue>): Promise<HostOperation> {
    const journals = this.ctx.reviewGatedJournals
    const controller = journals.controller(parent.session)
    if (this.active.has(parent) || controller.state.hostOperation?.status === 'Running') throw new Error('An existing host task must finish or be recovered first')
    const operation: HostOperation = { id: HostOperationId(randomUUID()), kind, status: 'Running', result: null, error: null }
    await journals.operation(parent.session, () => controller.apply({ type: 'host-operation-started', operation }))
    const abort = new AbortController()
    const signal = AbortSignal.any([lifetime, abort.signal, this.shutdown.signal, journals.signal, AbortSignal.timeout(this.config.maxOperationMs)])
    const done = Promise.resolve().then(async () => {
      let finished: HostOperation
      try {
        signal.throwIfAborted()
        const result = await run(signal)
        signal.throwIfAborted()
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > this.config.maxResultBytes) throw new Error('Host task result byte limit exceeded')
        finished = { ...operation, status: 'Completed', result }
      } catch (error) {
        finished = { ...operation, status: signal.aborted ? 'Cancelled' : 'Failed', error: error instanceof Error ? error.message : 'Host operation failed' }
      }
      if (!journals.signal.aborted) await journals.operation(parent.session, () => controller.apply({ type: 'host-operation-finished', operation: finished }))
    }).finally(() => { if (this.active.get(parent)?.id === operation.id) this.active.delete(parent) })
    this.active.set(parent, { id: operation.id, abort, done })
    // The promise stays observed even when no model is waiting for its result.
    void done.catch(error => this.ctx.logger.warn('Host task could not persist settlement: ' + String(error)))
    if (!this.observed.has(parent)) {
      this.observed.add(parent)
      parent.ctx.effect(() => async () => { await this.cancel(parent, 'Main Agent disposed') })
    }
    return operation
  }
  /** Wait at most the configured bound; timeout or observer cancellation does not cancel the operation.
   * @param parent Main owner.
   * @param id Current durable run ID.
   * @param waitMs Requested finite wait; zero reads immediately.
   * @param signal Observer cancellation.
   * @returns Committed task status, including the retained result or failure.
   */
  async wait(parent: Agent, id: HostOperationId, waitMs: number, signal: AbortSignal): Promise<HostOperation> {
    signal.throwIfAborted()
    const current = this.ctx.reviewGatedJournals.controller(parent.session).state.hostOperation
    if (!current || current.id !== id) throw new Error('Task ID does not belong to this Main workflow')
    const active = this.active.get(parent)
    if (active?.id === id && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let rejectAbort: (() => void) | undefined
      try {
        await Promise.race([active.done, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(waitMs, this.config.maxWaitMs)); timer.unref() }),
          new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(signal.reason); signal.addEventListener('abort', rejectAbort, { once: true }); if (signal.aborted) rejectAbort() })])
      } finally { clearTimeout(timer); if (rejectAbort) signal.removeEventListener('abort', rejectAbort) }
    }
    signal.throwIfAborted()
    return this.ctx.reviewGatedJournals.controller(parent.session).state.hostOperation!
  }
  /** Cancel and drain this owner's live task without altering product files.
   * @param parent Main owner.
   * @param reason User-visible cancellation reason.
   */
  async cancel(parent: Agent, reason: string): Promise<void> {
    const active = this.active.get(parent)
    active?.abort.abort(new Error(reason))
    if (active) await active.done
  }
  /** Record an interrupted-host quiescence question; service responses cannot reconcile the task.
   * @param parent Main owner.
   * @param signal Recovery observer lifetime.
   * @returns True when an orphan was found; execution recovery remains a separate decision.
   */
  async recover(parent: Agent, signal: AbortSignal): Promise<boolean> {
    if (this.active.has(parent)) throw new Error('Cancel and drain the live host task before recovery')
    const journals = this.ctx.reviewGatedJournals, controller = journals.controller(parent.session)
    const operation = controller.state.hostOperation
    if (operation?.status !== 'Running') return false
    await journals.operation(parent.session, async () => {
      await askDecisionQuestion(controller, parent.session, 'host-recovery', {
        question: 'Can you confirm all processes belonging to this interrupted host task have stopped?',
        detail: journals.confirmationMode === 'buttons' ? 'Interrupted operation: ' + operation.kind + String.fromCharCode(10) + 'Status: ' + operation.status + String.fromCharCode(10) + 'Only confirm after every previous process has stopped. This decision resolves the host-task marker; it neither authorizes another execution nor resets scope or budget.' : JSON.stringify(operation), options: [{ label: 'Confirm previous processes stopped' }, { label: 'Leave unresolved' }],
      }, question => this.ctx.userQuestions.ask({ agent: parent, signal, questions: [question] }), signal, journals.confirmationMode)
    })
    return true
  }
  /** Whether this process still owns the persisted run.
   * @param parent Main owner.
   * @returns True only for a live operation, not a restored Running record.
   */
  running(parent: Agent): boolean { return this.active.has(parent) }
  /** Abort all owned activity and wait for settlement. */
  async close(): Promise<void> {
    this.shutdown.abort(new Error('Host task service disposed'))
    await Promise.allSettled([...this.active.values()].map(item => item.done))
  }
}
export const name = 'review-gated-host-tasks'
export const inject = ['reviewGatedJournals', 'userQuestions']
declare module '@deepseek-ai/cordis' { interface Context { reviewGatedTasks: HostTasks } }
export function apply(ctx: Context, config: Config): void {
  const tasks = new HostTasks(ctx, config)
  ctx.provide('reviewGatedTasks', tasks)
  ctx.effect(() => () => tasks.close())
}
