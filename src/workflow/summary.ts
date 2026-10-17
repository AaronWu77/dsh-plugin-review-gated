/** Compact model views; complete authoritative records remain available through explicit queries. */
import type { ConfirmationMode } from './interaction.js'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WorkflowJournals } from '../storage/journal.js'
import { operationEvidence } from './authorization.js'
import { resolveExecutionIntent } from './execution-policy.js'

/** Deployment limits for repeated workflow text. */
export interface SummaryLimits { summaryTextChars: number; summaryItems: number }
/** Emit a bounded discovery view without copying question details, command output or review prose.
 * @param view Full authoritative journal view. @param session Optional Session for genuine input discovery.
 * @param limits Validated deployment text/item limits. @param mode Owning human channel. @returns Compact state, sources, counts and exact confirmation templates.
 */
export function summarize(view: ReturnType<WorkflowJournals['view']>, session: Session | undefined, limits: SummaryLimits, mode: ConfirmationMode = 'legacy-json') {
  const state = view.state
  const text = (value: string) => value.length > limits.summaryTextChars ? value.slice(0, limits.summaryTextChars) + '…' : value
  const list = (values: readonly string[]) => ({ count: values.length, items: values.slice(0, limits.summaryItems).map(text) })
  const decision = (item: typeof view.decisionEvidence.approval) => ({ questionId: item.questionId, kind: item.kind, status: item.status, source: item.source,
    confirmedSelection: item.confirmedSelection, receipt: item.receipt, failure: item.failure ? text(item.failure) : null })
  return { state: { phase: state.phase, brief: state.brief ? { id: state.brief.id, revision: state.brief.revision, goal: text(state.brief.goal),
    allowedPaths: list(state.brief.allowedPaths), acceptanceCount: state.brief.acceptanceCriteria.length, commandCount: state.brief.verificationCommands.length,
    unresolvedQuestionCount: state.brief.questions.length, executionIntent: resolveExecutionIntent(state.brief), executionBudgetMs: state.brief.executionBudgetMs, maxRepairRounds: state.brief.maxRepairRounds } : null,
    approval: state.approval, implementation: state.implementation ? { outcome: state.implementation.outcome } : null,
    snapshot: state.snapshot ? { id: state.snapshot.id, briefRevision: state.snapshot.briefRevision, treeId: state.snapshot.treeId, baseCommit: state.snapshot.baseCommit, changedPaths: list(state.snapshot.changedPaths), integrityVersion: state.snapshot.integrityVersion ?? 1 } : null,
    verification: state.verification ? { snapshotId: state.verification.snapshotId, treeId: state.verification.treeId, checkCount: state.verification.checks.length,
      passedCount: state.verification.checks.filter(check => check.exitCode === 0 && check.signal === null && !check.timedOut).length } : null,
    review: state.review ? { outcome: state.review.outcome, acceptanceCount: state.review.acceptance?.length ?? 0, unchecked: list(state.review.unchecked),
      findingCount: state.review.findings.length, blockingFindingCount: state.review.findings.filter(item => item.severity === 'blocking').length,
      blockingFindings: list(state.review.findings.filter(item => item.severity === 'blocking').map(item => item.file + ':' + item.line + ': ' + item.impact)) } : null,
    hostOperation: state.hostOperation ? { id: state.hostOperation.id, kind: state.hostOperation.kind, status: state.hostOperation.status, error: state.hostOperation.error ? text(state.hostOperation.error) : null } : null,
    activeRunId: state.activeRunId, executionWindow: state.executionWindow ?? null, executionMs: state.executionMs, executionWallMs: state.executionWallMs ?? 0,
    repositoryPreflight: state.repositoryPreflight ?? null, preflightMs: state.preflightMs ?? 0,
    repairRounds: state.repairRounds, pauseReason: state.pauseReason ? text(state.pauseReason) : null, pausedFrom: state.pausedFrom,
    roleFailures: (state.roleFailures ?? []).map(failure => ({ ...failure, issues: failure.issues })),
    remainingExecutionMs: state.brief ? Math.max(0, state.brief.executionBudgetMs - Math.max(state.executionMs, state.executionWallMs ?? 0)) : null },
    baseCommit: view.baseCommit, recordCount: view.recordCount,
    decisionEvidence: { approval: decision(view.decisionEvidence.approval), recovery: decision(view.decisionEvidence.recovery),
      pending: view.decisionEvidence.pending.map(item => ({ questionId: item.questionId, kind: item.kind, status: item.status, question: text(item.question ?? ''),
        revision: state.questions?.find(question => question.id === item.questionId)?.revision ?? null, bindingCurrent: item.bindingCurrent, serviceAnswer: item.serviceAnswer, availableUserConfirmation: item.availableUserConfirmation,
        confirmationTemplates: item.confirmationTemplates, nextStep: item.nextStep })), sourceLimit: view.decisionEvidence.sourceLimit },
    operationEvidence: operationEvidence(state, session, mode),
    details: 'rg_brief returns the complete brief. rg_question(questionId) returns original question/detail/options and linked receipt. rg_status(detail=true) returns the full journal view; raw records remain authoritative.' }
}
