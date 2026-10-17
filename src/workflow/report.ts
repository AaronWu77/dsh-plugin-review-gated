/** Six-part factual Main report; projections never upgrade a stored review or stale candidate. */
import type { WorkflowJournal } from '../storage/journal.js'
import { checksPassed, assertAcceptance } from './controller.js'
import { decisionEvidence } from './decision-evidence.js'
import { operationEvidence } from './authorization.js'
import { resolveExecutionIntent } from './execution-policy.js'
import type { Session } from '@deepseek-ai/dsh-session'

/** Snapshot currency checked by the host, separate from historical handoff completion. */
export type SnapshotCurrency = { status: 'current' | 'stale' | 'not-checked' | 'absent'; reason: string }
/** Build a pure JSON report from committed facts and a separately checked repository.
 * @param journal Current Session-associated workflow facts.
 * @param currency Host observation; absence of a check is not a successful check.
 * @param session Optional owning Session for current operation-input validation; absence does not establish current permission.
 * @returns The required completion, changes, problems, checks/review, limitations, and follow-up sections.
 */
export function buildReport(journal: Pick<WorkflowJournal, 'state' | 'baseCommit'> & { decisionEvidence?: ReturnType<typeof decisionEvidence> }, currency: SnapshotCurrency, session?: Session) {
  const state = journal.state
  const decisions = journal.decisionEvidence ?? decisionEvidence(state)
  const implementation = state.implementation
  const completed = implementation?.outcome === 'Completed' ? implementation : null
  const handoffCompleted = state.phase === 'Completed'
  let acceptanceComplete = false
  if (state.brief && state.review?.outcome === 'Passed') {
    try { assertAcceptance(state.brief, state.review); acceptanceComplete = true }
    catch (error) { /* Historical incomplete reports remain facts, not new acceptance evidence. */ }
  }
  const approvedChecksPassed = checksPassed(state)
  const independentReviewPassed = acceptanceComplete && approvedChecksPassed && state.review?.snapshotId === state.snapshot?.id && state.review?.treeId === state.snapshot?.treeId
  const requirementsAuthorizationComplete = !decisions.pending.length && state.hostOperation?.status !== 'Running'
    && state.approval?.approved === true && state.approval.revision === state.brief?.revision
    && decisions.approval.status === 'committed' && decisions.approval.receipt !== null
    && (!decisions.recovery.questionId || (decisions.recovery.status === 'committed' && decisions.recovery.receipt !== null))
  const operations = operationEvidence(state, session)
  const handoffPermissionRecorded = state.operationAuthorization?.kind === 'handoff' && state.operationAuthorization.status === 'consumed'
    && Boolean(state.operationAuthorization.receipt) && state.operationAuthorization.operationId === state.snapshot?.id && state.operationAuthorization.revision === state.brief?.revision
  const currentEvidence = requirementsAuthorizationComplete && independentReviewPassed && state.snapshot?.integrityVersion === 2 && state.snapshot.fileDigests !== undefined
  const followUpOptions = state.phase === 'Cancelled' ? ['Start a separate Session for a new task.']
    : state.hostOperation?.status === 'Running' ? ['Observe or cancel and drain the live host task. For a restored task, obtain logged quiescence confirmation through rg_recover. Do not start another execution or handoff.']
    : state.activeRunId || state.executionWindow ? ['Stop any surviving processes. Use rg_recover to confirm quiescence and reconcile the unknown runtime; do not restart an unresolved attempt.']
    : !requirementsAuthorizationComplete && state.approval?.approved ? ['Obtain logged user confirmation of unchanged requirements and any historical recovery. No revision or budget reset; execution remains blocked.']
    : state.phase === 'Ready for Handoff' ? ['Request distinct handoff permission using rg_request_operation(kind=handoff), obtain its exact new user-message authorization and confirm it before rg_handoff. Re-check the current candidate.']
    : state.phase === 'Paused' ? ['Use rg_recover for an explicit human decision. Resolve requirement questions with a revised brief and another approval.']
    : handoffCompleted ? ['Inspect the staged diff; commits and pushes require separate human authorization.']
    : state.phase === 'Approved' || state.phase === 'Implemented' || state.phase === 'Staged' || state.phase === 'Needs Changes' ? ['Request one-use execution permission using rg_request_operation(kind=execution); obtain its exact new user-message authorization and confirm it before execution. Requirements confirmation alone never executes.']
    : ['Clarify unresolved requirements, submit the exact next brief revision, and obtain approval through rg_approve.']
  return {
    completion: { phase: state.phase, executionIntent: state.brief ? resolveExecutionIntent(state.brief) : null, requirementsAuthorizationComplete, operationPermissionCurrent: operations.permissionCurrent ?? false, operationPermissionStatus: operations.request?.status ?? 'not-recorded', handoffPermissionRecorded, hostTaskStatus: state.hostOperation?.status ?? null, implementationCompleted: Boolean(completed), approvedChecksPassed, independentReviewPassed, handoffCompleted, currentDeliverableVerified: handoffCompleted && handoffPermissionRecorded && currency.status === 'current' && currentEvidence, snapshotCurrency: currency },
    changes: { summaryAuthority: 'implementation-role-reported; not host verification or independent review', summary: completed?.summary ?? '', changedPaths: state.snapshot?.changedPaths ?? [], executionIntent: state.brief ? resolveExecutionIntent(state.brief) : null, briefRevision: state.brief?.revision ?? null,
      baseCommit: journal.baseCommit, treeId: state.snapshot?.treeId ?? null, snapshotId: state.snapshot?.id ?? null },
    problems: { roleResultFailures: state.roleFailures ?? [], implementation: completed?.problems ?? [], findings: state.review?.findings ?? [], pauseReason: state.pauseReason,
      questions: implementation?.outcome === 'Needs Clarification' ? implementation.questions : state.brief?.questions ?? [],
      blockedReason: implementation?.outcome === 'Blocked' ? implementation.reason : null },
    verificationAndReview: { decisionEvidence: decisions, operationEvidence: operations, rejectedReviewAuthority: 'Rejected JSON, schema or semantic results are not an accepted Review. Positional issues and the linked role log may contain submitted evidence; never edit that output into Passed.', evidenceAuthority: 'Only snapshot-matched host checks satisfy required commands. Auxiliary checks and implementation claims cannot replace them. Program output is reported diagnostics, not authoritative failure classification.', acceptanceComplete, integrityVersion: state.snapshot?.integrityVersion ?? 1, checksPassed: checksPassed(state), verification: state.verification, recordedReview: state.review, checkOutcomes: state.verification?.checks.map(check => ({ command: check.command, outcome: check.timedOut ? 'timed-out' : check.exitCode === 0 && check.signal === null ? 'passed' : 'failed', failureCause: check.timedOut ? 'host-observed-timeout' : check.exitCode === 0 && check.signal === null ? null : 'unclassified; inspect recorded exit, signal and program diagnostics', effectiveTimeoutMs: check.effectiveTimeoutMs ?? null })) ?? [], reviewStatus: state.review?.outcome ?? 'not-recorded',
      acceptance: state.review?.acceptance ?? [], hostOperation: state.hostOperation ?? null,
      handoffRequires: 'Distinct current one-use logged handoff permission, requirements/recovery receipts, matching checks, SHA256-bound workspace contents and evidenced acceptance from a fresh Review. No commit or push.' },
    limitations: { reported: completed?.limitations ?? [], unchecked: state.review?.unchecked ?? [], executionMs: state.executionMs, executionWallMs: state.executionWallMs ?? null, executionWindow: state.executionWindow ?? null,
      executionBudgetMs: state.brief?.executionBudgetMs ?? null, repairRounds: state.repairRounds, maxRepairRounds: state.brief?.maxRepairRounds ?? null,
      filePolicy: 'Native partial enforcement is accepted, not full isolation. Windows ACL has hard-link and AppContainer-ACL limitations. File enforcement does not isolate reads, network, or process visibility; prompts and tool guards do not guarantee prevention of every bypass. Verification exports have no .git metadata.',
      reviewEvidence: 'Fresh Agent context is not evidence of a different model or provider. Scripted runs are not independent live-model review.',
      gitActions: 'The workflow stages but never commits, pushes, or merges.' },
    followUpOptions,
  }
}
export type MainReport = ReturnType<typeof buildReport>
/** Render the same six sections as Markdown without interpreting model-supplied strings as instructions.
 * @param report Host-built factual report.
 * @returns Stable headings and JSON-fenced section contents for the model and generic tool UI.
 */
export function formatReport(report: MainReport): string {
  const sections = [
    ['Completion', report.completion], ['Changes', report.changes], ['Problems', report.problems],
    ['Verification and review', report.verificationAndReview], ['Limitations', report.limitations], ['Follow-up options', report.followUpOptions],
  ] as const
  return sections.map(([heading, value]) => '## ' + heading + '\n\n```json\n' + JSON.stringify(value, null, 2) + '\n```').join('\n\n')
}
