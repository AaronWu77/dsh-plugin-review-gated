/** One-use operation requests bound to real later input in the owning Main Session. */
import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WorkflowState } from './types.js'
import { resolveExecutionIntent } from './execution-policy.js'
import { questionBinding } from './questions.js'
import { operationBinding, preflightProofSchema, sameBaseline } from './preflight.js'
import type { ConfirmationMode } from './interaction.js'
import { buttonReceipt, latestHumanInput, operationCard } from './interaction.js'

/** Cross-tool identifier of a durable operation request. */
export type OperationRequestId = import('@deepseek-ai/dsh-brand').Branded<'ReviewGatedOperationRequestId'>
/** Brand an already validated request identifier. @param value Identifier. @returns Branded identifier. */
export const OperationRequestId = (value: string): OperationRequestId => value as OperationRequestId
const id = z.string().uuid().transform(OperationRequestId)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const operationRequestSchema = z.strictObject({
  id, kind: z.enum(['execution', 'handoff']), mode: z.enum(['implement-verify-review', 'verify-review', 'handoff']),
  revision: count.min(1), binding: z.string().regex(/^[a-f0-9]{64}$/), askedAt: count,
  afterSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER), status: z.enum(['pending', 'granted', 'declined', 'consumed']),
  receipt: z.strictObject({ seq: count, receivedAt: count, source: z.literal('session-user-message') }).optional(),
  operationId: z.string().min(1).max(256).optional(),
})
/** V6 receipt reader; the released operationRequestSchema remains unchanged for v5 records. */
export const currentOperationRequestSchema = operationRequestSchema.extend({ receipt: z.strictObject({ seq: count, receivedAt: count, source: z.enum(['session-user-message', 'session-user-question-reply']) }).optional() })
/** V8 requests include the repository identity displayed before the user decides. */
export const boundOperationRequestSchema = currentOperationRequestSchema.extend({ preflight: preflightProofSchema.optional() })
export type OperationRequest = z.infer<typeof boundOperationRequestSchema>
export const operationAnswerSchema = z.strictObject({ reviewGatedOperation: z.strictObject({ requestId: id, selected: z.enum(['Authorize', 'Decline']) }) })

/** Derive the permitted work; requests never allow commit, push or implicit handoff.
 * @param state Current inactive state. @param kind Requested operation. @returns Exact operation mode.
 */
export function operationMode(state: WorkflowState, kind: OperationRequest['kind']): OperationRequest['mode'] {
  if (state.activeRunId || state.executionWindow || state.hostOperation?.status === 'Running') throw new Error('Drain or recover current activity before requesting permission')
  if (!state.brief || !state.approval?.approved || state.approval.revision !== state.brief.revision) throw new Error('Current approved requirements are required')
  if (kind === 'handoff') {
    if (state.phase !== 'Ready for Handoff') throw new Error('Handoff permission requires Ready for Handoff')
    return 'handoff'
  }
  if (!['Approved', 'Implemented', 'Staged', 'Needs Changes'].includes(state.phase)) throw new Error('Execution permission requires an inactive executable phase')
  if (state.brief.questions.length || state.brief.verificationCommands.some(command => command.timeoutMs === undefined)) throw new Error('Resolve requirements and explicit command timeouts first')
  if (Math.max(state.executionMs, state.executionWallMs ?? 0) >= state.brief.executionBudgetMs) throw new Error('Execution budget exhausted')
  const intent = resolveExecutionIntent(state.brief)
  if (intent === 'verification-only' && state.phase === 'Needs Changes') throw new Error('Verification-only execution cannot repair a review')
  return intent === 'verification-only' || state.phase === 'Implemented' || state.phase === 'Staged' ? 'verify-review' : 'implement-verify-review'
}

/** Match exact latest recorded user input, not model-supplied selections or service responses.
 * @param session Owning Session. @param request Persisted request. @param seq Actual message sequence.
 * @param state Current approved scope/candidate required for exact button validation.
 * @returns Selection and its recorded input-channel receipt.
 */
export function operationReceipt(session: Session, request: OperationRequest, seq: number, state?: WorkflowState) {
  const event = latestHumanInput(session)
  if (event?.type === 'user/message' && event.data.source.kind === 'user-question-reply') {
    if (!state?.brief) throw new Error('Button operation permission requires current approved requirements')
    const card = operationCard(request, state.brief, Math.max(0, state.brief.executionBudgetMs - Math.max(state.executionMs, state.executionWallMs ?? 0)), state)
    const answer = buttonReceipt(session, card, request.afterSeq, seq)
    return { ...answer, selected: z.enum(['Authorize', 'Decline']).parse(answer.selected) }
  }
  if (!event || event.type !== 'user/message' || event.seq !== seq || event.seq < session.firstLiveSeq || event.seq <= request.afterSeq || event.data.content.some(block => block.type !== 'text')) throw new Error('Operation permission requires the exact latest new logged user message from this Main session')
  const text = event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (error) { throw new Error('Operation permission requires the exact requested JSON') }
  const answer = operationAnswerSchema.safeParse(parsed)
  if (!answer.success || answer.data.reviewGatedOperation.requestId !== request.id) throw new Error('Operation permission names different or invalid request fields')
  return { selected: answer.data.reviewGatedOperation.selected, receipt: { seq: event.seq, receivedAt: event.time, source: 'session-user-message' as const } }
}

/** Refuse missing, stale or already-used permission before any new execution task.
 * @param state Current state. @param session Owning Session. @param kind Intended operation. @param mode Owning journal channel; buttons refuses legacy grants. @returns Matching one-use request.
 */
export function requireOperationPermission(state: WorkflowState, session: Session, kind: OperationRequest['kind'], mode: ConfirmationMode = 'legacy-json'): OperationRequest {
  const request = state.operationAuthorization
  if (!request || request.status !== 'granted' || request.kind !== kind || request.binding !== operationBinding(state, request.preflight) || request.revision !== state.brief?.revision || !request.receipt) throw new Error('A separate current logged one-use ' + kind + ' permission is required')
  if (!request.preflight) throw new Error('Legacy permission needs a new repository preflight and authorization')
  if (state.repositoryPreflight?.status !== 'passed' || state.repositoryPreflight.requestId !== request.id || !sameBaseline(state.repositoryPreflight.baseline!, request.preflight)) throw new Error('Repository preflight is blocked, missing or stale')
  if (mode === 'buttons' && request.receipt.source !== 'session-user-question-reply') throw new Error('Button mode requires a current question-card authorization; a legacy grant cannot authorize execution or handoff')
  const current = operationReceipt(session, request, request.receipt.seq, state)
  if (current.selected !== 'Authorize' || current.receipt.receivedAt !== request.receipt.receivedAt || current.receipt.source !== request.receipt.source) throw new Error('Operation authorization no longer matches current user input')
  return request
}

/** Compact discovery of pending templates and an available genuine input reference.
 * @param state Current workflow. @param session Optional owning Session. @param mode Owning channel controls templates and available input. @returns Bounded request fields, templates and input source limitation.
 */
export function operationEvidence(state: WorkflowState, session?: Session, mode: ConfirmationMode = 'legacy-json') {
  const request = state.operationAuthorization
  const preflight = state.repositoryPreflight ?? null
  if (!request) return { request: null, templates: [], availableUserConfirmation: null, preflight, nextStep: preflight?.status === 'blocked' ? 'Resolve the reported preflight issues, then request permission again; do not click an old card.' : preflight?.status === 'running' ? 'Preflight has not settled; it grants no permission. Observe the active request or explicitly retry an interrupted request.' : ['Completed', 'Cancelled'].includes(state.phase) ? 'The workflow is terminal; no further operation permission is available.' : !state.approval?.approved ? 'Submit and approve the complete requirements before requesting operation permission.' : 'Request an operation to run repository preflight before a card is shown.' }
  const bindingCurrent = request.binding === operationBinding(state, request.preflight)
  const preflightCurrent = !!request.preflight && preflight?.status === 'passed' && preflight.requestId === request.id && sameBaseline(preflight.baseline!, request.preflight)
  let availableUserConfirmation: { userMessageSeq: number; selected: 'Authorize' | 'Decline' } | null = null
  if (session && request.status === 'pending' && bindingCurrent && preflightCurrent) {
    const last = latestHumanInput(session)
    if (last) try { const answer = operationReceipt(session, request, last.seq, state); if (mode === 'legacy-json' || answer.receipt.source === 'session-user-question-reply') availableUserConfirmation = { userMessageSeq: last.seq, selected: answer.selected } } catch (error) { /* Unrelated user input does not authorize any operation. */ }
  }
  let permissionCurrent: boolean | null = request.status === 'granted' && !session ? null : false
  if (session && request.status === 'granted') {
    try { requireOperationPermission(state, session, request.kind, mode); permissionCurrent = true } catch (error) { /* Stale permission remains recorded but cannot authorize an operation. */ }
  }
  const nextStep = request.status === 'declined' ? 'The user declined; nothing will run. Do not request permission again unless the user explicitly asks.'
    : request.status === 'consumed' ? 'This permission was consumed. Inspect the workflow result; handoff requires its own separate request.'
    : !preflightCurrent || !bindingCurrent ? 'Repository preflight is missing, blocked or stale. Inspect preflight; request a new operation after resolving its issues, not another click on this card.'
    : availableUserConfirmation ? 'Confirm this exact current reply; authorization alone starts no execution.'
    : request.status === 'pending' ? 'Show the exact current card. A later ordinary user message requires a fresh card reply, not an old sequence.'
    : request.status === 'granted' && !permissionCurrent ? 'New input invalidated the grant. Request a fresh authorization; never reuse the old receipt.' : 'Only the current one-use permission can proceed.'
  return { request: { ...request, bindingCurrent }, permissionCurrent, preflight, preflightCurrent, nextStep,
    templates: mode === 'legacy-json' && request.status === 'pending' && preflightCurrent && bindingCurrent ? ['Authorize', 'Decline'].map(selected => ({ reviewGatedOperation: { requestId: request.id, selected } })) : [], availableUserConfirmation,
    scope: request.kind === 'execution'
      ? resolveExecutionIntent(state.brief!) === 'verification-only'
        ? 'Exact approved checks and fresh Review against the current clean baseline; verification-only, no implementation or repair writes; stop at Ready for Handoff. No handoff, commit or push.'
        : 'Exact approved checks and fresh Review; allowed implementation/repair only within this mode and remaining approved limits; stop at Ready for Handoff. No handoff, commit or push.'
      : 'Complete handoff of the exact current verified candidate; no commit or push.',
    sourceLimit: 'The receipt identifies the logged user-input channel, not independent natural-person identity.' }
}
