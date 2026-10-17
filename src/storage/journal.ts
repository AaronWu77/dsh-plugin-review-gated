/** Session-associated, durable workflow records; never writes unknown required Session events. */
import { isDeepStrictEqual } from 'node:util'
import { decisionEvidence } from '../workflow/decision-evidence.js'
import { confirmationReceipt, needsQuestionRefresh } from '../workflow/questions.js'
import type { ConfirmationMode } from '../workflow/interaction.js'
import { operationReceipt } from '../workflow/authorization.js'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { WorkflowController, initialState, replay, transition } from '../workflow/controller.js'
import type { OperationMutation } from '../workflow/controller.js'
import { recordSchema, stateSchema, gitIdSchema } from '../workflow/types.js'
import type { WorkflowRecord, WorkflowState } from '../workflow/types.js'

export const journalSchema = z.strictObject({
  version: z.literal(1), sessionId: z.string().min(1).max(256).transform(SessionId), cwd: z.string().min(1), createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  baseCommit: gitIdSchema.nullable(), repository: z.string().min(1).nullable(), records: z.array(recordSchema), state: stateSchema,
}).superRefine((journal, context) => {
  try {
    if ((journal.baseCommit === null) !== (journal.repository === null)) context.addIssue({ code: 'custom', message: 'Incomplete repository binding' })
    if (journal.state.snapshot && (journal.state.snapshot.baseCommit !== journal.baseCommit || journal.state.snapshot.repository !== journal.repository))
      context.addIssue({ code: 'custom', message: 'Snapshot disagrees with the bound repository or base' })
    if (!isDeepStrictEqual(journal.state, replay(journal.records))) context.addIssue({ code: 'custom', message: 'Stored workflow state disagrees with its records' })
  } catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid workflow records' }) }
})
export type WorkflowJournal = z.infer<typeof journalSchema>

function validateOperationMutation(session: Session, state: WorkflowState, event: OperationMutation, mode: ConfirmationMode): void {
  if ((event.type === 'question-confirmed' || event.type === 'operation-confirmed') && mode === 'buttons' && event.receipt.source !== 'session-user-question-reply') throw new Error('Button mode requires a genuine continued question-card reply; manual JSON does not authorize a decision')
  if (event.type === 'question-confirmed') {
    const question = state.questions?.find(item => item.id === event.questionId)
    if (!question) throw new Error('Button confirmation names no current decision')
    if (mode === 'buttons' && needsQuestionRefresh(question)) throw new Error('Reopen the legacy decision as a fresh button question before confirming it')
    const actual = confirmationReceipt(session, question, event.receipt.seq)
    if (actual.selected !== event.selected || !isDeepStrictEqual(actual.receipt, event.receipt)) throw new Error('Button confirmation does not match the logged user reply')
    return
  }
  const request = state.operationAuthorization
  if (!request || request.id !== event.requestId) throw new Error('Durable operation mutation names no current request')
  if (event.type === 'operation-confirmed') {
    const actual = operationReceipt(session, request, event.receipt.seq, state)
    if (actual.selected !== event.selected || !isDeepStrictEqual(actual.receipt, event.receipt)) throw new Error('Durable operation confirmation does not match the logged user message')
    return
  }
  if (!request.receipt) throw new Error('Durable operation mutation has no logged authorization receipt')
  if (mode === 'buttons' && request.receipt.source !== 'session-user-question-reply') throw new Error('Button mode cannot consume a legacy operation grant; obtain a new question-card authorization')
  const actual = operationReceipt(session, request, request.receipt.seq, state)
  if (actual.selected !== 'Authorize' || !isDeepStrictEqual(actual.receipt, request.receipt)) throw new Error('Durable operation mutation lacks the current logged authorization')
}
export const workflowDomain = defineDomain({ name: 'aaronwu_review_gated', version: 1, tables: { sessions: domainTable<SessionId, WorkflowJournal>(journalSchema) } })
export interface JournalLimits { maxRecords: number; maxBytes: number }

/** Owns one in-memory controller per Session, backed by one durable whole-record replacement. */
export class WorkflowJournals {
  private readonly controllers = new Map<SessionId, WorkflowController>()
  private readonly initializations = new WeakMap<Session, Promise<void>>()
  private readonly operations = new Map<SessionId, Promise<unknown>>()
  private readonly commits = new Set<Promise<void>>()
  private readonly shutdown = new AbortController()
  private closed = false
  private closingStarted = false
  private closing: Promise<void> | undefined
  get signal(): AbortSignal { return this.shutdown.signal }
  /**
   * @param domain Authoritative workflow table.
   * @param limits Per-journal write limits.
   * @param canInitialize Trusted history check for absent rows; the default admits only fresh Sessions.
   * @param confirmationMode Deployment channel, enforced for live confirmation and permission consumption.
   */
  constructor(private readonly domain: Domain<typeof workflowDomain>, private readonly limits: JournalLimits, private readonly canInitialize: (session: Session) => boolean = session => session.firstLiveSeq === 0, readonly confirmationMode: ConfirmationMode = 'buttons') {
    for (const value of [limits.maxRecords, limits.maxBytes]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid workflow journal limit')
  }
  private stored(session: Session): WorkflowJournal {
    if (this.closed || (this.closingStarted && !this.operations.has(session.id))) throw new Error('Workflow journal is closed')
    if (!session.header.cwd) throw new Error('Review-Gated requires a Session workspace')
    const found = this.domain.table('sessions').get(session.id)
    if (!found) {
      if (session.header.isSeeded || !this.canInitialize(session)) throw new Error('Restored or seeded Session has no authoritative workflow journal; restore both stores or create a new empty Session after confirming old processes stopped')
      return { version: 1, sessionId: session.id, cwd: session.header.cwd, createdAt: session.header.createdAt, baseCommit: null, repository: null, records: [], state: initialState() }
    }
    if (found.sessionId !== session.id || found.cwd !== session.header.cwd || found.createdAt !== session.header.createdAt) throw new Error('Workflow journal belongs to another Session or workspace')
    return found
  }
  /** Persist fresh empty Main state before any prompt, tool call, or later resume.
   * @param session Unseeded Main Session; absent rows require no turns or prior managed history.
   * @returns After the authoritative initial row commits; existing rows retain their records.
   */
  initialize(session: Session): Promise<void> {
    const active = this.initializations.get(session)
    if (active) return active
    const value = this.stored(session)
    if (this.domain.table('sessions').get(session.id)) return Promise.resolve()
    const pending = this.operation(session, () => this.put(value)).finally(() => { this.initializations.delete(session) })
    this.initializations.set(session, pending)
    return pending
  }
  private async put(value: WorkflowJournal): Promise<void> {
    const validated = journalSchema.parse(value)
    if (validated.records.length > this.limits.maxRecords || Buffer.byteLength(JSON.stringify(validated), 'utf8') > this.limits.maxBytes)
      throw new Error('Workflow journal storage limit exceeded')
    await this.domain.table('sessions').put(validated.sessionId, validated)
  }
  controller(session: Session): WorkflowController {
    const stored = this.stored(session)
    let controller = this.controllers.get(session.id)
    if (!controller) {
      controller = new WorkflowController(async (record: WorkflowRecord) => {
        const previous = this.stored(session)
        const pending = this.put({ ...previous, records: [...previous.records, record], state: transition(previous.state, record.event) })
        this.commits.add(pending)
        void pending.then(() => this.commits.delete(pending), () => this.commits.delete(pending))
        await pending
      }, stored.records, (state, event) => validateOperationMutation(session, state, event, this.confirmationMode))
      this.controllers.set(session.id, controller)
    }
    return controller
  }
  /** Complete data emitted in tool results and logged prompt contexts. */
  view(session: Session): { state: WorkflowState; baseCommit: string | null; recordCount: number; decisionEvidence: ReturnType<typeof decisionEvidence> } {
    const stored = this.stored(session)
    return { state: structuredClone(stored.state), baseCommit: stored.baseCommit, recordCount: stored.records.length, decisionEvidence: decisionEvidence(stored.state, stored.records, session, this.confirmationMode) }
  }
  /** Serializes user waits and host mutations, not merely the final durable append. */
  async operation<T>(session: Session, run: () => Promise<T>): Promise<T> {
    this.shutdown.signal.throwIfAborted()
    this.stored(session)
    if (this.operations.has(session.id)) throw new Error('Another workflow operation is in progress')
    const pending = Promise.resolve().then(run)
    this.operations.set(session.id, pending)
    try { return await pending } finally { this.operations.delete(session.id) }
  }
  /** Called only by trusted implementation preflight after Git has proven a clean base. */
  async bindBase(session: Session, baseCommit: string, repository: string): Promise<void> {
    gitIdSchema.parse(baseCommit)
    const stored = this.stored(session)
    if (stored.baseCommit && (stored.baseCommit !== baseCommit || stored.repository !== repository)) throw new Error('Approved repository or base commit cannot change')
    await this.put({ ...stored, baseCommit, repository })
  }
  close(): Promise<void> {
    this.closingStarted = true
    this.shutdown.abort(new Error('Workflow journal is closing'))
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.operations.values()])
      while (this.commits.size) await Promise.allSettled([...this.commits])
      this.closed = true
      this.controllers.clear()
      await this.domain.close()
    })()
  }
}
