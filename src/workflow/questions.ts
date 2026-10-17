/** Durable question records and exact confirmation from logged user messages; service replies alone do not attest their source. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionRequestEvent, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type { WorkflowState } from './types.js'
import type { WorkflowController } from './controller.js'
import { buttonReceipt, decisionCard, latestHumanInput } from './interaction.js'
import type { ConfirmationMode } from './interaction.js'

const text = z.string().min(1)
const legacyConfirmationNote = '\nThis service response does not record who answered. To commit this decision, send a new user message containing exactly: '
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const questionSchema = z.strictObject({
  id: text.max(256), kind: z.enum(['approval', 'recovery', 'host-recovery']), revision: count, hostOperationId: text.max(256).optional(),
  binding: z.string().regex(/^[a-f0-9]{64}$/), phase: text, askedAt: count, afterSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  question: text, detail: text, options: z.array(z.strictObject({ label: text, description: z.string().optional() })).min(1),
  intent: z.strictObject({ kind: z.literal('plan-review'), approve: text }).optional(),
  status: z.enum(['pending', 'service-returned', 'failed', 'committed']), confirmedSelection: text.optional(),
  serviceAnswer: z.strictObject({ selected: text, receivedAt: count, source: z.literal('user-questions-service-unattributed') }).optional(),
  receipt: z.strictObject({ seq: count, source: z.literal('session-user-message'), receivedAt: count }).optional(),
  failure: text.optional(),
})
/** V6 receipt reader; the released questionSchema remains unchanged for v4/v5 records. */
export const currentQuestionSchema = questionSchema.extend({ receipt: z.strictObject({ seq: count, source: z.enum(['session-user-message', 'session-user-question-reply']), receivedAt: count }).optional() })
export type DecisionQuestion = z.infer<typeof currentQuestionSchema>
export const confirmationSchema = z.strictObject({ reviewGatedAnswer: z.strictObject({ questionId: text.max(256), selected: text }) })

/** Bind a question to the complete requirements and current execution candidate, not later host-task status.
 * @param state Current replayed workflow.
 * @returns Digest invalidated by scope, phase, snapshot, budget or active-window changes.
 */
export function questionBinding(state: WorkflowState): string {
  return createHash('sha256').update(JSON.stringify({ brief: state.brief, phase: state.phase, approval: state.approval,
    implementation: state.implementation, verification: state.verification, review: state.review,
    snapshot: state.snapshot, activeRunId: state.activeRunId, executionWindow: state.executionWindow ?? null,
    executionMs: state.executionMs, executionWallMs: state.executionWallMs ?? 0, repairRounds: state.repairRounds,
    pauseReason: state.pauseReason, pausedFrom: state.pausedFrom })).digest('hex')
}

/** Return an exact user-authored confirmation; neither tool results nor assistant text can supply it.
 * @param session Owning Main session, read through the public event snapshot.
 * @param question Current pending decision.
 * @param seq Exact user-message sequence requested by Main.
 * @returns Selected option and the recorded user-message reference.
 */
export function confirmationReceipt(session: Session, question: DecisionQuestion, seq: number) {
  const events = session.snapshotEvents(), event = events.find(item => item.seq === seq)
  const latestUser = latestHumanInput(session)
  if (event?.type === 'user/message' && event.data.source.kind === 'user-question-reply') return buttonReceipt(session, decisionCard(question), question.afterSeq, seq)
  if (!event || event.type !== 'user/message' || event.data.source.kind !== 'user' || event.seq <= question.afterSeq || event.seq !== latestUser?.seq)
    throw new Error('Confirmation requires a new logged user message from this Main session')
  if (event.data.content.some(block => block.type !== 'text')) throw new Error('Confirmation requires one exact JSON text message')
  const content = event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch (error) { throw new Error('User confirmation is not the exact requested JSON') }
  const validation = confirmationSchema.safeParse(parsed)
  if (!validation.success) throw new Error('User confirmation does not match the exact requested JSON fields')
  const { reviewGatedAnswer: answer } = validation.data
  if (answer.questionId !== question.id || !question.options.some(option => option.label === answer.selected))
    throw new Error('User confirmation names a different question or unavailable option')
  return { selected: answer.selected, receipt: { seq: event.seq, source: 'session-user-message' as const,
    receivedAt: event.time } }
}

/** Identify a pending legacy-channel decision that needs a fresh button question, never a copied template.
 * @param question Current durable decision. @returns Whether button mode must replace rather than confirm it.
 */
export function needsQuestionRefresh(question: DecisionQuestion): boolean {
  const suffix = legacyConfirmationNote + JSON.stringify({ reviewGatedAnswer: { questionId: question.id, selected: '<one exact option label>' } })
  return question.status === 'service-returned' || (question.status === 'pending' && question.detail.endsWith(suffix))
}

/** Open a durable decision without treating an unattributed service answer as human authorization.
 * @param controller Owner of the workflow transaction.
 * @param session Main session used for the question's sequence watermark.
 * @param kind Approval or recovery.
 * @param input Exact question shown through the public question service.
 * @param ask Scoped public question-service call, captured by the operation owner.
 * @param signal Operation lifetime; cancellation never commits a decision.
 * @param mode Owning deployment channel; buttons replaces pending legacy decisions and returns a card without an unattributed wait.
 * @returns Current pending decision, or legacy service response awaiting logged user confirmation.
 */
export async function askDecisionQuestion(controller: WorkflowController, session: Session, kind: DecisionQuestion['kind'],
  input: Pick<AskUserQuestionRequestEvent['questions'][number], 'question' | 'detail' | 'options' | 'intent'>,
  ask: (question: AskUserQuestionRequestEvent['questions'][number]) => Promise<AskUserQuestionAnswer>, signal: AbortSignal, mode: ConfirmationMode = 'legacy-json'): Promise<DecisionQuestion> {
  signal.throwIfAborted()
  const state = controller.state
  const previous = state.questions?.find(item => ['pending', 'service-returned'].includes(item.status) && item.revision === (state.brief?.revision ?? 0))
  if (previous && (mode === 'buttons' ? !needsQuestionRefresh(previous) : previous.status === 'service-returned') && previous.binding === questionBinding(state)) {
    if (previous.kind !== kind) throw new Error('Confirm the current pending decision before requesting another kind of question')
    return previous
  }
  if (previous) await controller.apply({ type: 'question-failed', questionId: previous.id, reason: 'Question superseded by an explicit new request after interruption or state change; no decision committed' })
  if (!state.brief && kind !== 'host-recovery') throw new Error('Decision requires current requirements')
  const id = randomUUID()
  const detail = mode === 'buttons' ? input.detail : input.detail + legacyConfirmationNote
    + JSON.stringify({ reviewGatedAnswer: { questionId: id, selected: '<one exact option label>' } })
  const question = questionSchema.parse({ id, kind, revision: state.brief?.revision ?? 0, ...(kind === 'host-recovery' ? { hostOperationId: state.hostOperation?.id } : {}), binding: questionBinding(state),
    phase: state.phase, askedAt: Date.now(), afterSeq: session.snapshotEvents().at(-1)?.seq ?? -1,
    question: input.question, detail, options: input.options, ...(input.intent ? { intent: input.intent } : {}), status: 'pending' })
  await controller.apply({ type: 'question-opened', question })
  if (mode === 'buttons') return question
  try {
    const answer = await ask({ id: question.id, question: question.question,
      detail: question.detail, options: question.options.map(option => ({ label: option.label, ...(option.description !== undefined ? { description: option.description } : {}) })), ...(question.intent ? { intent: question.intent } : {}), multiSelect: false })
    signal.throwIfAborted()
    const answers = answer.answers.filter(item => item.id === question.id)
    if (answers.length !== 1 || answers[0]!.selected.length !== 1 || answers[0]!.custom?.trim()
      || !question.options.some(option => option.label === answers[0]!.selected[0])) throw new Error('Decision response requires one exact current option without free text')
    const serviceAnswer = { selected: answers[0]!.selected[0]!, receivedAt: Date.now(), source: 'user-questions-service-unattributed' as const }
    await controller.apply({ type: 'question-returned', questionId: question.id, serviceAnswer })
    return { ...question, status: 'service-returned', serviceAnswer }
  } catch (error) {
    try { await controller.apply({ type: 'question-failed', questionId: question.id, reason: signal.aborted ? 'Question cancelled; no decision committed' : 'Question service or response validation failed; no decision committed' }) }
    catch (appendError) { throw new AggregateError([error, appendError], 'Question failed and its failure record could not be saved; no decision committed') }
    throw error
  }
}

/** Reject execution/handoff lacking a current logged approval and, when present, recovery confirmation.
 * @param state Current workflow.
 * @param recoveryQuestionId Latest recovery in this revision, including historical records.
 */
export function requireDecisionReceipts(state: WorkflowState, recoveryQuestionId: string | null): void {
  const approval = state.questions?.find(question => question.id === state.approval?.questionId && question.status === 'committed' && question.receipt && question.kind === 'approval' && question.revision === state.brief?.revision)
  if (!approval) throw new Error('Current approval lacks a logged user confirmation; confirm unchanged requirements without resetting the revision or budget')
  if (recoveryQuestionId && !state.questions?.some(question => question.id === recoveryQuestionId && question.status === 'committed' && question.receipt && question.kind === 'recovery' && question.revision === state.brief?.revision))
    throw new Error('Current recovery lacks a logged user confirmation; confirm the unchanged recovery without starting execution')
  if (state.questions?.some(question => question.revision === state.brief?.revision && (question.status === 'pending' || question.status === 'service-returned')))
    throw new Error('A current decision question still awaits explicit user confirmation')
}
