/** Continued question cards bind the authenticated user-input channel to the exact logged decision. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { RequirementsBrief, WorkflowState } from './types.js'
import { operationBinding, sameBaseline } from './preflight.js'
import { questionBinding, needsQuestionRefresh } from './questions.js'
import type { DecisionQuestion } from './questions.js'
import type { OperationRequest } from './authorization.js'

/** Human decision channel selected by the deployment; button mode never falls back to manual JSON. */
export type ConfirmationMode = 'buttons' | 'legacy-json'
/** Exact native arguments; the first choice description carries complete facts in the existing scrollable body. */
export interface ConfirmationQuestion { id: string; question: string; options: { label: string; description?: string }[]; multi_select: false }

/** Format the complete approved requirements without user-facing JSON. @param brief Submitted requirements. @returns Readable requirement details. */
export function briefDetails(brief: RequirementsBrief): string {
  const nl = String.fromCharCode(10)
  return [
    'Task: ' + brief.id, 'Goal: ' + brief.goal, 'Revision: ' + brief.revision, 'Execution intent: ' + (brief.executionIntent ?? 'implementation'),
    'Non-goals:' + nl + brief.nonGoals.map(item => '- ' + item).join(nl),
    'Allowed paths:' + nl + brief.allowedPaths.map(item => '- ' + item).join(nl),
    'Generated paths:' + nl + (brief.generatedPaths ?? []).map(item => '- ' + item).join(nl),
    'Constraints:' + nl + brief.constraints.map(item => '- ' + item).join(nl),
    'Acceptance criteria:' + nl + brief.acceptanceCriteria.map(item => '- ' + item.id + ': ' + item.description).join(nl),
    'Exact verification commands:' + nl + brief.verificationCommands.map(item => '- ' + item.executable + ' ' + item.args.map(arg => JSON.stringify(arg)).join(' ') + ' (timeout ' + item.timeoutMs + ' ms)').join(nl),
    'Repair-round limit: ' + brief.maxRepairRounds, 'Execution budget: ' + brief.executionBudgetMs + ' ms',
    'Unresolved questions:' + nl + brief.questions.map(item => '- ' + item).join(nl),
  ].join(nl + nl)
}

function readableCard(id: string, question: string, detail: string, options: DecisionQuestion['options']): ConfirmationQuestion[] {
  return [{ id, question, options: options.map((option, index) => ({ label: option.label,
    ...(index === 0 ? { description: [option.description, detail].filter(value => value !== undefined).join(String.fromCharCode(10, 10)) }
      : option.description === undefined ? {} : { description: option.description }) })), multi_select: false }]
}

/** Build the exact displayed question for an approval or recovery. @param question Current durable question. @returns Native question-card arguments. */
export function decisionCard(question: DecisionQuestion): ConfirmationQuestion[] {
  return readableCard(question.id, question.question, question.detail, question.options)
}

/** Build an operation card that exposes scope and limits, not user JSON templates. @param request Current one-use request. @param brief Approved requirements. @param remainingMs Unspent budget. @param state Current candidate and consumed repair rounds. @returns Native question-card arguments. */
export function operationCard(request: OperationRequest, brief: RequirementsBrief, remainingMs: number, state: Pick<WorkflowState, 'snapshot' | 'repairRounds'>): ConfirmationQuestion[] {
  const nl = String.fromCharCode(10)
  const title = request.kind === 'execution' ? 'Authorize this execution?' : 'Authorize handoff of this reviewed candidate?'
  const detail = 'Mode: ' + request.mode + nl + 'Remaining execution budget: ' + remainingMs + ' ms' + nl
    + 'Remaining repair rounds: ' + Math.max(0, brief.maxRepairRounds - state.repairRounds) + nl
    + (request.kind === 'handoff' ? 'Complete only the exact current reviewed candidate. No implementation or verification rerun. No commit or push.'
      : (request.mode === 'verify-review' ? 'No implementation or repair writes. ' : 'Implementation and repair writes are limited to the exact approved paths and remaining limits. ') + 'No commit or push. Execution stops at Ready for Handoff and does not include handoff.')
    + nl + (state.snapshot ? 'Candidate tree: ' + state.snapshot.treeId + nl + 'Baseline commit: ' + state.snapshot.baseCommit + nl + 'Candidate paths: ' + (state.snapshot.changedPaths.length ? state.snapshot.changedPaths.join(', ') : '(no changes)') : 'Candidate: current clean approved baseline; host preflight must pass before execution.')
    + (request.preflight ? nl + 'Preflight: ' + request.preflight.id + nl + 'Repository: ' + request.preflight.repository + nl + 'Authorized baseline HEAD: ' + request.preflight.head + nl + 'Authorized tree: ' + request.preflight.treeId : nl + 'Legacy request: a new repository preflight and card are required.')
    + nl + nl + briefDetails(brief)
  return readableCard(request.id, title, detail, [{ label: 'Authorize' }, { label: 'Decline' }])
}

/** Find the latest admitted human-input channel, including continued UI replies. @param session Owning Main Session. @returns Latest logged human input, if any. */
export function latestHumanInput(session: Session) {
  return session.snapshotEvents().findLast(event => event.type === 'user/message' && (event.data.source.kind === 'user' || event.data.source.kind === 'user-question-reply'))
}

/** Return the current bound card, or none when no human decision is pending. @param state Authoritative workflow. @returns Exact native question batch. */
export function confirmationQuestions(state: WorkflowState): ConfirmationQuestion[] {
  const binding = questionBinding(state)
  const question = state.questions?.find(item => ['pending', 'service-returned'].includes(item.status) && item.binding === binding)
  if (question) return needsQuestionRefresh(question) ? [] : decisionCard(question)
  const request = state.operationAuthorization
  const preflight = state.repositoryPreflight
  return request?.status === 'pending' && request.preflight && request.binding === operationBinding(state, request.preflight) && state.brief
    && preflight?.status === 'passed' && preflight.requestId === request.id && sameBaseline(preflight.baseline!, request.preflight)
    ? operationCard(request, state.brief, Math.max(0, state.brief.executionBudgetMs - Math.max(state.executionMs, state.executionWallMs ?? 0)), state) : []
}

/** Describe recovery facts without JSON templates. @param state Interrupted workflow. @param baseCommit Approved baseline, if known. @returns Complete readable scope and uncertainty. */
export function recoveryDetails(state: WorkflowState, baseCommit: string | null): string {
  const nl = String.fromCharCode(10)
  return ['Current phase: ' + state.phase, 'Pause reason: ' + (state.pauseReason ?? '(none recorded)'),
    'Active role: ' + (state.activeRunId ?? '(none recorded)'), 'Unresolved execution window: ' + (state.executionWindow ? 'yes; unaccounted time consumes remaining budget' : 'no'),
    'Host task: ' + (state.hostOperation ? state.hostOperation.kind + ' / ' + state.hostOperation.status : '(none recorded)'),
    'Baseline commit: ' + (baseCommit ?? '(not yet bound)'), 'Candidate tree: ' + (state.snapshot?.treeId ?? '(no accepted snapshot)'),
    'Implementation: ' + (state.implementation?.outcome ?? '(no accepted result)'), 'Review: ' + (state.review?.outcome ?? '(no accepted result)'),
    'Consumed execution time: ' + Math.max(state.executionMs, state.executionWallMs ?? 0) + ' ms', 'Consumed repair rounds: ' + state.repairRounds,
    'This decision confirms recovery only. A retry needs a separate new execution authorization; scope and limits do not reset.',
    ...(state.brief ? [briefDetails(state.brief)] : [])].join(nl + nl)
}

const batchSchema = z.strictObject({ kind: z.literal('answer_to_pending_question'), tool: z.literal('ask_user_question'), callId: z.string().min(1),
  questions: z.array(z.object({ id: z.string(), question: z.string(), options: z.array(z.object({ label: z.string(), description: z.string().optional() }).strict()), multiSelect: z.boolean() }).strict()).length(1),
  answers: z.array(z.strictObject({ id: z.string(), selected: z.array(z.string()).length(1), custom: z.string().optional() })).length(1),
})
function pendingResult(content: readonly { type: string; text?: string }[], callId: string): boolean {
  const text = content.find(block => block.type === 'text')?.text
  if (text === undefined) return false
  try { const parsed = z.object({ pending: z.literal(true), callId: z.literal(callId) }).passthrough().safeParse(JSON.parse(text)); return parsed.success }
  catch (error) { return false /* Non-JSON output does not open a button confirmation. */ }
}

/** Validate a reply produced by the public userQuestions.answer UI method against the actual pending tool call. @param session Owning Main. @param questions Exact current displayed questions. @param afterSeq Durable decision watermark. @param seq Claimed reply sequence. @returns Selected option and attributed input receipt. */
export function buttonReceipt(session: Session, questions: ConfirmationQuestion[], afterSeq: number, seq: number) {
  const events = session.snapshotEvents(), event = latestHumanInput(session)
  if (!event || event.type !== 'user/message' || event.seq !== seq || event.seq < session.firstLiveSeq || event.seq <= afterSeq || event.data.source.kind !== 'user-question-reply' || event.data.source.outcome !== 'answered')
    throw new Error('Button confirmation requires the latest admitted user-question reply from this Main session')
  const callId = event.data.source.callId
  if (event.data.content.some(block => block.type !== 'text')) throw new Error('Button reply must contain the exact answer batch')
  let parsed: unknown
  try { parsed = JSON.parse(event.data.content.map(block => block.type === 'text' ? block.text : '').join('')) }
  catch (error) { throw new Error('Button reply is not a recorded answer batch') }
  const reply = batchSchema.parse(parsed)
  const expected = questions.map(({ multi_select, ...item }) => ({ ...item, multiSelect: multi_select }))
  if (reply.callId !== callId || !isDeepStrictEqual(reply.questions, expected) || reply.answers[0]!.id !== questions[0]!.id || reply.answers[0]!.custom?.trim()
    || !questions[0]!.options.some(option => option.label === reply.answers[0]!.selected[0])) throw new Error('Button reply does not match the exact current decision')
  const call = events.findLast(item => item.seq > afterSeq && item.seq < event.seq && ((item.type === 'tool/ptc-dispatch' && item.data.subCallId === callId)
    || (item.type === 'tool/call' && item.data.callId === callId)))
  let argumentsValue: unknown
  if (call?.type === 'tool/ptc-dispatch') {
    if (call.data.name !== 'ask_user_question' || call.data.isError || !pendingResult(call.data.content, callId)) throw new Error('Button reply lacks a successful continued question call')
    argumentsValue = call.data.arguments
  } else if (call?.type === 'tool/call') {
    if (call.data.name !== 'ask_user_question') throw new Error('Button reply targets another tool')
    const result = events.find(item => item.seq > call.seq && item.seq < event.seq && item.type === 'tool/result' && item.data.message.toolCallId === callId)
    if (!result || result.type !== 'tool/result') throw new Error('Button reply lacks a continued question result')
    // Public crash repair continues the exact logged card; only a fresh attributed UI reply can confirm it.
    if (result.data.error?.code !== TOOL_OUTCOME_UNKNOWN && (result.data.error || result.data.message.isError || !pendingResult(result.data.message.content, callId))) throw new Error('Button reply lacks a continued question result')
    try { argumentsValue = JSON.parse(call.data.arguments) } catch (error) { throw new Error('Button question arguments are not valid JSON') }
  } else throw new Error('Button reply names no logged question call from this Main session')
  const args = z.object({ questions: z.unknown() }).passthrough().parse(argumentsValue)
  if (!isDeepStrictEqual(args.questions, questions)) throw new Error('Displayed button question differs from the current approved decision')
  return { selected: reply.answers[0]!.selected[0]!, receipt: { seq: event.seq, receivedAt: event.time, source: 'session-user-question-reply' as const } }
}
