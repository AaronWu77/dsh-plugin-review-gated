/** Read-only decision summaries; historical IDs never supply missing answer sources. */
import type { WorkflowState, WorkflowRecord } from './types.js'
import type { Session } from '@deepseek-ai/dsh-session'
import { confirmationReceipt, needsQuestionRefresh, questionBinding } from './questions.js'
import type { ConfirmationMode } from './interaction.js'
import { latestHumanInput } from './interaction.js'

/** Project current approval and recovery evidence without rewriting historical records.
 * @param state Replayed facts, including current question receipts.
 * @param records Original versioned history when available.
 * @param session Optional owning session for exact latest-user confirmation sequence discovery.
 * @param mode Owning deployment channel; button views never advertise manual JSON.
 * @returns Question references, answers, available source evidence and pending confirmation templates.
 */
export function decisionEvidence(state: WorkflowState, records: readonly WorkflowRecord[] = [], session?: Session, mode: ConfirmationMode = 'legacy-json') {
  let revision: number | null = null
  let recoveryId: string | null = null
  let historicalRecoveryAction: string | null = null
  for (const { event } of records) {
    if (event.type === 'requirements-submitted') { revision = event.brief.revision; recoveryId = null; historicalRecoveryAction = null }
    if (event.type === 'recovery-decided' && revision === state.brief?.revision) { recoveryId = event.questionId; historicalRecoveryAction = event.action }
    if (event.type === 'question-confirmed') {
      const question = state.questions?.find(item => item.id === event.questionId)
      if (question?.kind === 'recovery' && question.revision === state.brief?.revision) { recoveryId = question.id; historicalRecoveryAction = null }
    }
  }
  if (!records.length) recoveryId = state.questions?.find(question => question.kind === 'recovery' && question.status === 'committed' && question.revision === state.brief?.revision)?.id ?? null
  const summarize = (id: string | null, kind: 'approval' | 'recovery' | 'host-recovery') => {
    const question = state.questions?.find(item => item.id === id)
    return { questionId: id, kind, status: question?.status ?? (id ? 'historical-unattributed' : 'not-recorded'),
      question: question?.question ?? null, detail: question?.detail ?? null, options: question?.options ?? null,
      serviceAnswer: question?.serviceAnswer ?? null, confirmedSelection: question?.confirmedSelection ?? null,
      receipt: question?.receipt ?? null, failure: question?.failure ?? null,
      source: question?.receipt?.source ?? (id ? 'unknown' : 'not-recorded'),
      missingSourceNote: id && !question?.receipt ? 'No linked logged user confirmation; question IDs and service answers alone do not identify who answered.' : null }
  }
  const latestUser = session ? latestHumanInput(session) : undefined
  const available = (question: NonNullable<WorkflowState['questions']>[number]) => {
    if (!session || !latestUser || question.binding !== questionBinding(state) || !['pending', 'service-returned'].includes(question.status) || (mode === 'buttons' && needsQuestionRefresh(question))) return null
    try { const answer = confirmationReceipt(session, question, latestUser.seq); return mode === 'buttons' && answer.receipt.source !== 'session-user-question-reply' ? null : { userMessageSeq: latestUser.seq, selected: answer.selected } }
    catch (error) { return null /* Only exact current user input can advertise a confirmable sequence. */ }
  }
  return { approval: summarize(state.approval?.questionId ?? null, 'approval'), recovery: { ...summarize(recoveryId, 'recovery'), historicalAction: historicalRecoveryAction },
    pending: (state.questions ?? []).filter(question => question.revision === (state.brief?.revision ?? 0) && ['pending', 'service-returned'].includes(question.status)).map(question => ({
      ...summarize(question.id, question.kind), bindingCurrent: question.binding === questionBinding(state), availableUserConfirmation: available(question), confirmationTemplates: mode === 'legacy-json' ? question.options.map(option => ({ reviewGatedAnswer: { questionId: question.id, selected: option.label } })) : [],
      nextStep: mode === 'buttons' && needsQuestionRefresh(question) ? 'Reopen this uncommitted legacy decision with rg_start(operation=approval, revision) or rg_recover; no user JSON is accepted in button mode and work/limits are preserved.' : mode === 'buttons' ? 'Show uiConfirmation.questions unchanged in ask_user_question and wait for its genuine user reply; Main then records availableUserConfirmation with rg_confirm_question. No service-only answer authorizes a decision.' : 'The user sends one exact confirmation JSON as a new message. Main then calls rg_confirm_question with that message sequence. No decision or execution is authorized by a service-only response.' })),
    sourceLimit: 'A logged user-message reference identifies the recorded user-input channel, not independent natural-person identity authentication.' }
}
