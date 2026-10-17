/** Ordered transitions; callers append facts before publishing their derived state. */
import { recordSchema, stateSchema } from './types.js'
import { resolveExecutionIntent } from './execution-policy.js'
import { questionBinding } from './questions.js'
import { isDeepStrictEqual } from 'node:util'
import { operationBinding, sameBaseline } from './preflight.js'
import { operationMode } from './authorization.js'
import type { WorkflowState, WorkflowEvent, WorkflowRecord, RequirementsBrief, ReviewResult } from './types.js'

export type OperationMutation = Extract<WorkflowEvent, { type: 'question-confirmed' | 'operation-confirmed' | 'authorized-execution-started' | 'authorized-handoff-completed' }>
export type OperationMutationValidator = (state: WorkflowState, event: OperationMutation) => void

export function initialState(): WorkflowState {
  return { phase: 'Clarifying', brief: null, approval: null, implementation: null, snapshot: null,
    verification: null, review: null, activeRunId: null, repairRounds: 0, executionMs: 0,
    pauseReason: null, pausedFrom: null }
}

function requirePhase(state: WorkflowState, ...allowed: WorkflowState['phase'][]): void {
  if (!allowed.includes(state.phase)) throw new Error('Operation unavailable in phase ' + state.phase)
}

function requireApproval(state: WorkflowState): void {
  if (!state.brief || !state.approval?.approved || state.approval.revision !== state.brief.revision)
    throw new Error('Current requirements need explicit user approval')
  if (state.brief.questions.length) throw new Error('Resolve requirement questions before implementation')
  if (Math.max(state.executionMs, state.executionWallMs ?? 0) >= state.brief.executionBudgetMs) throw new Error('Execution budget exhausted')
}

export function checksPassed(state: WorkflowState): boolean {
  const evidence = state.verification
  const snapshot = state.snapshot
  if (!evidence || !snapshot || evidence.snapshotId !== snapshot.id || evidence.treeId !== snapshot.treeId || !state.brief) return false
  if (evidence.checks.length !== state.brief.verificationCommands.length) return false
  return evidence.checks.every((check, index) =>
    JSON.stringify(check.command) === JSON.stringify(state.brief?.verificationCommands[index])
      && check.exitCode === 0 && check.signal === null && !check.timedOut)
}

/** Rejects invalid order and stale identities without modifying the supplied state. */
export function transition(state: WorkflowState, event: WorkflowEvent): WorkflowState {
  return applyTransition(state, event, true, true, true, true, true)
}

/** Requires complete, uniquely identified acceptance results before a new handoff. */
export function assertAcceptance(brief: RequirementsBrief, review: ReviewResult): void {
  if (!review.acceptance) throw new Error('Structured acceptance evidence is required; legacy reports need a new review')
  const required = new Set(brief.acceptanceCriteria.map(item => item.id))
  const observed = new Set<string>()
  for (const item of review.acceptance) {
    if (!required.has(item.id) || observed.has(item.id)) throw new Error('Unknown or duplicate acceptance criterion: ' + item.id)
    observed.add(item.id)
    for (const evidence of item.evidence) {
      if (evidence.kind === 'verification' && evidence.checkIndex >= brief.verificationCommands.length) throw new Error('Acceptance cites an unknown verification check')
    }
    if (review.outcome === 'Passed' && (item.status !== 'Passed' || !item.evidence.length)) throw new Error('Passed requires evidenced verification of every acceptance criterion')
  }
  if (observed.size !== required.size) throw new Error('Acceptance coverage is incomplete')
  if (review.outcome === 'Passed' && review.unchecked.length) throw new Error('Passed cannot contain unchecked items')
  if (review.checked.some(item => review.unchecked.includes(item))) throw new Error('Contradictory checked and unchecked items')
}

function applyTransition(state: WorkflowState, event: WorkflowEvent, strict: boolean, current = false, audited = false, settledWindowRecovery = false, bound = false): WorkflowState {
  const hostQuestionEvent = event.type === 'question-opened' ? event.question.kind === 'host-recovery'
    : (event.type === 'question-returned' || event.type === 'question-failed' || event.type === 'question-confirmed')
      && state.questions?.some(question => question.id === event.questionId && question.kind === 'host-recovery')
  if ((state.phase === 'Completed' || state.phase === 'Cancelled') && event.type !== 'host-operation-finished' && !hostQuestionEvent) throw new Error('Workflow is terminal')
  switch (event.type) {
    case 'repository-preflight-recorded': {
      const observation = event.preflight
      if (!state.brief || observation.revision !== state.brief.revision || observation.scopeBinding !== questionBinding(state) || state.activeRunId || state.executionWindow) throw new Error('Preflight does not match inactive approved scope')
      const previous = state.repositoryPreflight
      if (observation.status !== 'running' && (!previous || previous.id !== observation.id || previous.status !== 'running' || previous.requestId !== observation.requestId)) throw new Error('Preflight settlement lacks its running observation')
      if (observation.status !== 'running' && previous) {
        const { status: priorStatus, durationMs: priorDuration, baseline: priorBaseline, issues: priorIssues, ...priorIdentity } = previous
        const { status, durationMs, baseline, issues, ...identity } = observation
        if (!isDeepStrictEqual(priorIdentity, identity)) throw new Error('Preflight settlement changed its original identity or limits')
      }
      return { ...state, repositoryPreflight: observation, preflightMs: (state.preflightMs ?? 0) + (observation.status === 'running' ? 0 : observation.durationMs) }
    }
    case 'operation-requested': {
      const request = event.request
      const proof = 'preflight' in request ? request.preflight : undefined
      if (bound && (!proof || state.repositoryPreflight?.status !== 'passed' || state.repositoryPreflight.requestId !== request.id || state.repositoryPreflight.id !== proof.id || !sameBaseline(state.repositoryPreflight.baseline!, proof))) throw new Error('A successful repository preflight is required before requesting permission')
      if (request.status !== 'pending' || request.receipt || request.operationId || request.binding !== operationBinding(state, 'preflight' in request ? request.preflight : undefined) || request.revision !== state.brief?.revision || request.mode !== operationMode(state, request.kind)) throw new Error('Operation request does not match current inactive approved work')
      if (state.questions?.some(question => question.status === 'pending' || question.status === 'service-returned')) throw new Error('Resolve pending decisions before requesting operation permission')
      if (state.operationAuthorization?.id === request.id) throw new Error('Operation request IDs cannot be reused')
      return { ...state, operationAuthorization: request }
    }
    case 'operation-confirmed': {
      const request = state.operationAuthorization
      if (!request || request.id !== event.requestId || request.status !== 'pending' || request.binding !== operationBinding(state, 'preflight' in request ? request.preflight : undefined) || event.receipt.seq <= request.afterSeq || request.mode !== operationMode(state, request.kind)) throw new Error('Operation confirmation is stale or already settled')
      if (bound && event.selected === 'Authorize' && (!request.preflight || state.repositoryPreflight?.status !== 'passed' || state.repositoryPreflight.requestId !== request.id || !sameBaseline(state.repositoryPreflight.baseline!, request.preflight))) throw new Error('Authorization requires a matching successful repository recheck')
      return { ...state, operationAuthorization: { ...request, status: event.selected === 'Authorize' ? 'granted' : 'declined', receipt: event.receipt } }
    }
    case 'authorized-execution-started':
    case 'authorized-handoff-completed': {
      const request = state.operationAuthorization, kind = event.type === 'authorized-execution-started' ? 'execution' : 'handoff'
      if (!request || request.id !== event.requestId || request.status !== 'granted' || !request.receipt || request.kind !== kind || request.binding !== operationBinding(state, 'preflight' in request ? request.preflight : undefined)) throw new Error('Operation lacks current unconsumed permission')
      if (bound && !request.preflight) throw new Error('Legacy permission needs a new repository-bound authorization')
      const next = { ...state, operationAuthorization: { ...request, status: 'consumed' as const, operationId: event.type === 'authorized-execution-started' ? event.id : event.snapshotId } }
      return applyTransition(next, event.type === 'authorized-execution-started' ? { type: 'execution-window-started', id: event.id }
        : { type: 'handoff-completed', snapshotId: event.snapshotId, treeId: event.treeId, briefRevision: event.briefRevision }, strict, current, audited, settledWindowRecovery, bound)
    }
    case 'review-result-rejected':
    case 'role-result-rejected': {
      const diagnostic = event.failure.role === 'diagnostic' && state.hostOperation?.kind === 'diagnostic' && state.hostOperation.status === 'Running'
      if (!diagnostic && (state.activeRunId !== event.failure.runId || event.failure.role !== (state.phase === 'Reviewing' ? 'review' : state.phase === 'Implementing' ? 'implementation' : null))) throw new Error('Rejected result targets another role run')
      return { ...state, roleFailures: [event.failure] }
    }
    case 'question-opened': {
      const question = event.question
      if (question.status !== 'pending' || question.receipt || question.serviceAnswer || question.failure || question.confirmedSelection
        || question.revision !== (state.brief?.revision ?? 0) || question.binding !== questionBinding(state)
        || state.questions?.some(item => item.id === question.id || (item.revision === question.revision && ['pending', 'service-returned'].includes(item.status))))
        throw new Error('Decision question must be unique and bound to the current inactive workflow')
      if (question.kind === 'approval') {
        requirePhase(state, 'Awaiting Approval', 'Approved', 'Implemented', 'Staged', 'Needs Changes', 'Paused', 'Ready for Handoff')
        if (state.activeRunId || state.executionWindow) throw new Error('Do not confirm requirements during active or unresolved execution')
      }
      if (question.kind === 'recovery') {
        if (state.phase !== 'Approved' || !state.executionWindow) requirePhase(state, 'Paused', 'Implementing', 'Reviewing', 'Verifying', 'Staged',
          ...(settledWindowRecovery && state.executionWindow ? ['Implemented', 'Needs Changes', 'Ready for Handoff'] as const : []))
        if (!state.brief || !state.approval?.approved) throw new Error('Recovery requires previously approved requirements')
      }
      if (question.kind === 'host-recovery' && (!state.hostOperation || state.hostOperation.status !== 'Running' || state.hostOperation.id !== question.hostOperationId)) throw new Error('Host recovery requires the exact interrupted operation')
      const committed = state.questions?.findLast(item => item.kind === question.kind && item.status === 'committed')
      return { ...state, questions: [...(state.questions ?? []).filter(item => item.kind !== question.kind || item.id === committed?.id), question] }
    }
    case 'question-returned': {
      const question = state.questions?.find(item => item.id === event.questionId)
      if (!question || question.status !== 'pending' || question.binding !== questionBinding(state)
        || !question.options.some(option => option.label === event.serviceAnswer.selected)) throw new Error('Service answer does not match a current question')
      return { ...state, questions: state.questions!.map(item => item.id === question.id ? { ...item, status: 'service-returned', serviceAnswer: event.serviceAnswer } : item) }
    }
    case 'question-failed': {
      const question = state.questions?.find(item => item.id === event.questionId)
      if (!question || !['pending', 'service-returned'].includes(question.status)) throw new Error('No unresolved question to fail')
      return { ...state, questions: state.questions!.map(item => item.id === question.id ? { ...item, status: 'failed', failure: event.reason } : item) }
    }
    case 'question-confirmed': {
      const question = state.questions?.find(item => item.id === event.questionId)
      if (!question || (question.status !== 'service-returned' && !(question.status === 'pending' && event.receipt.source === 'session-user-question-reply')) || question.binding !== questionBinding(state)
        || event.receipt.seq <= question.afterSeq || !question.options.some(option => option.label === event.selected))
        throw new Error('User confirmation does not match a current uncommitted decision')
      const next = { ...state, questions: state.questions!.filter(item => item.kind !== question.kind || item.id === question.id).map(item => item.id === question.id ? { ...item, status: 'committed' as const, confirmedSelection: event.selected, receipt: event.receipt } : item) }
      if (question.kind === 'host-recovery') {
        if (!state.hostOperation || state.hostOperation.id !== question.hostOperationId || state.hostOperation.status !== 'Running') throw new Error('Host recovery targets another operation')
        if (event.selected === 'Leave unresolved') return next
        if (event.selected !== 'Confirm previous processes stopped') throw new Error('Invalid host recovery choice')
        return applyTransition(next, { type: 'host-operation-finished', operation: { ...state.hostOperation, status: 'Interrupted', error: 'Logged user confirmed previous processes stopped; no result inferred' } }, strict, current)
      }
      if (question.kind === 'approval') {
        const approved = event.selected === 'Approve'
        const evidence = { questionId: question.id, revision: question.revision, approved }
        if (state.phase === 'Awaiting Approval') return applyTransition(next, { type: 'requirements-decided', evidence }, strict, current)
        if (approved) requireApproval(state)
        return approved ? { ...next, approval: evidence } : { ...next, approval: evidence, phase: 'Clarifying' }
      }
      const action = event.selected === 'Confirm previous processes stopped' ? 'recover-interrupted'
        : event.selected === 'Retry unchanged approved brief' ? 'retry' : event.selected === 'Revise requirements' ? 'revise' : 'leave-paused'
      if (state.phase === 'Staged' && action === 'retry' && !state.activeRunId && !state.executionWindow) { requireApproval(state); return next }
      const elapsedMs = action === 'recover-interrupted' ? Math.max(0, state.brief!.executionBudgetMs - Math.max(state.executionMs, state.executionWallMs ?? 0)) : 0
      const recoveryState = state.phase === 'Staged'
        ? applyTransition(next, { type: 'paused', reason: 'User requested a staged recovery decision' }, strict, current) : next
      return applyTransition(recoveryState, { type: 'recovery-decided', questionId: question.id, runId: state.activeRunId, action, elapsedMs }, strict, current)
    }
    case 'execution-budget-exhausted': {
      requirePhase(state, 'Approved', 'Implemented', 'Staged', 'Needs Changes', 'Ready for Handoff', 'Paused')
      if (!state.brief || state.activeRunId || state.executionWindow || event.executionWallMs < state.brief.executionBudgetMs || event.executionWallMs < (state.executionWallMs ?? 0))
        throw new Error('Budget exhaustion requires drained activity and monotonic exhausted wall time')
      return { ...state, executionWallMs: event.executionWallMs, phase: 'Paused',
        pausedFrom: state.phase === 'Paused' ? state.pausedFrom : state.phase === 'Ready for Handoff' ? 'Staged' : state.phase, pauseReason: 'Execution wall-clock budget exhausted' }
    }
    case 'execution-window-started': {
      requirePhase(state, 'Approved', 'Implemented', 'Staged', 'Needs Changes')
      requireApproval(state)
      if (state.executionWindow || state.activeRunId) throw new Error('Recover the unresolved execution window before another execution')
      return { ...state, executionWallMs: Math.max(state.executionMs, state.executionWallMs ?? 0), executionWindow: { id: event.id } }
    }
    case 'execution-window-finished': {
      if (state.executionWindow?.id !== event.id || state.activeRunId) throw new Error('Execution window finish requires its drained owned attempt')
      const { executionWindow, ...rest } = state
      const next = { ...rest, executionWallMs: (state.executionWallMs ?? 0) + event.elapsedMs }
      if (state.brief && Math.max(next.executionMs, next.executionWallMs) >= state.brief.executionBudgetMs && state.phase !== 'Paused')
        return { ...next, phase: 'Paused', pausedFrom: state.phase === 'Ready for Handoff' ? 'Staged' : state.phase, pauseReason: 'Execution wall-clock budget exhausted' }
      return next
    }
    case 'host-operation-started': {
      if (state.hostOperation?.status === 'Running' || event.operation.status !== 'Running' || event.operation.result !== null || event.operation.error !== null)
        throw new Error('Host task start requires an inactive workflow and empty results')
      return { ...state, hostOperation: event.operation }
    }
    case 'host-operation-finished': {
      if (state.hostOperation?.status !== 'Running' || state.hostOperation.id !== event.operation.id || state.hostOperation.kind !== event.operation.kind || event.operation.status === 'Running')
        throw new Error('Task settlement must match the durable live operation')
      return { ...state, hostOperation: event.operation }
    }
    case 'requirements-submitted': {
      requirePhase(state, 'Clarifying', 'Awaiting Approval', 'Approved', 'Paused', 'Needs Changes', 'Ready for Handoff')
      if (state.activeRunId || state.executionWindow || state.hostOperation?.status === 'Running') throw new Error('Stop active role or host task before revising requirements')
      if (current && event.brief.verificationCommands.some(command => command.timeoutMs === undefined)) throw new Error('Every submitted verification command requires an explicit timeoutMs')
      if (state.brief && event.brief.id !== state.brief.id) throw new Error('Requirement task identifier cannot change')
      if (state.brief && event.brief.revision !== state.brief.revision + 1) throw new Error('Requirement revision must increase by one')
      if (!state.brief && event.brief.revision !== 1) throw new Error('First requirement revision must be one')
      if (new Set(event.brief.acceptanceCriteria.map(item => item.id)).size !== event.brief.acceptanceCriteria.length)
        throw new Error('Acceptance criterion identifiers must be unique')
      return { ...initialState(), phase: 'Awaiting Approval', brief: event.brief, executionMs: state.executionMs, ...(state.preflightMs === undefined ? {} : { preflightMs: state.preflightMs }), ...state.executionWallMs === undefined ? {} : { executionWallMs: state.executionWallMs } }
    }
    case 'requirements-decided': {
      requirePhase(state, 'Awaiting Approval')
      if (event.evidence.revision !== state.brief?.revision) throw new Error('Approval targets stale requirements')
      if (event.evidence.approved && state.brief.questions.length) throw new Error('Unresolved requirement questions')
      return { ...state, approval: event.evidence, phase: event.evidence.approved ? 'Approved' : 'Clarifying' }
    }
    case 'implementation-started': {
      requirePhase(state, 'Approved', 'Needs Changes')
      requireApproval(state)
      if (resolveExecutionIntent(state.brief!) === 'verification-only') throw new Error('Verification-only brief cannot start implementation')
      if (state.phase === 'Needs Changes' && state.brief && state.repairRounds >= state.brief.maxRepairRounds)
        throw new Error('Repair round limit exhausted')
      return { ...state, phase: 'Implementing', activeRunId: event.runId,
        repairRounds: state.repairRounds + (state.phase === 'Needs Changes' ? 1 : 0),
        snapshot: null, verification: null, pauseReason: null, pausedFrom: null }
    }
    case 'implementation-finished': {
      requirePhase(state, 'Implementing')
      if (state.activeRunId !== event.runId) throw new Error('Result targets another implementation run')
      const next = { ...state, activeRunId: null, implementation: event.result, executionMs: state.executionMs + event.elapsedMs }
      if (event.result.outcome !== 'Completed') return { ...next, phase: 'Paused', pausedFrom: 'Implementing',
        pauseReason: event.result.outcome === 'Needs Clarification' ? event.result.questions.join('\n') : event.result.reason }
      if (state.brief && next.executionMs >= state.brief.executionBudgetMs)
        return { ...next, phase: 'Paused', pausedFrom: 'Implemented', pauseReason: 'Execution budget exhausted' }
      return { ...next, phase: 'Implemented' }
    }
    case 'snapshot-created': {
      requirePhase(state, 'Implemented', 'Approved')
      requireApproval(state)
      if (state.phase === 'Approved' && resolveExecutionIntent(state.brief!) !== 'verification-only') throw new Error('Approved snapshot requires verification-only execution intent')
      if (event.snapshot.briefRevision !== state.brief?.revision) throw new Error('Snapshot targets stale requirements')
      if (strict && (event.snapshot.integrityVersion !== 2 || event.snapshot.fileDigests === undefined)) throw new Error('Snapshot needs current workspace integrity checks')
      if (state.brief && resolveExecutionIntent(state.brief) === 'verification-only' && event.snapshot.changedPaths.length) throw new Error('Verification-only snapshot must have no changed paths')
      if (state.brief && resolveExecutionIntent(state.brief) === 'implementation' && strict && !event.snapshot.changedPaths.length) throw new Error('Implementation snapshot must contain changes')
      return { ...state, phase: 'Staged', snapshot: event.snapshot, verification: null, review: null }
    }
    case 'verification-started': {
      requirePhase(state, 'Staged')
      requireApproval(state)
      return { ...state, phase: 'Verifying', activeRunId: event.runId }
    }
    case 'verification-recorded': {
      requirePhase(state, 'Staged', 'Verifying')
      if (state.phase === 'Verifying' ? event.runId !== state.activeRunId : event.runId !== undefined) throw new Error('Verification targets another run')
      if (event.evidence.snapshotId !== state.snapshot?.id || event.evidence.treeId !== state.snapshot.treeId)
        throw new Error('Verification targets another snapshot')
      const commandMs = event.evidence.checks.reduce((sum, check) => sum + check.durationMs, 0)
      const elapsedMs = event.elapsedMs ?? commandMs
      if (elapsedMs < commandMs) throw new Error('Verification duration excludes executed commands')
      const next = { ...state, phase: 'Staged' as const, activeRunId: null, verification: event.evidence, executionMs: state.executionMs + elapsedMs }
      return state.brief && next.executionMs >= state.brief.executionBudgetMs
        ? { ...next, phase: 'Paused', pausedFrom: 'Staged', pauseReason: 'Execution budget exhausted' } : next
    }
    case 'review-started': {
      requirePhase(state, 'Staged')
      requireApproval(state)
      if (!checksPassed(state)) throw new Error('Required snapshot checks have not passed')
      return { ...state, phase: 'Reviewing', activeRunId: event.runId }
    }
    case 'review-finished': {
      requirePhase(state, 'Reviewing')
      if (event.runId !== state.activeRunId) throw new Error('Result targets another review run')
      const result = event.result
      if (result.briefRevision !== state.brief?.revision || result.snapshotId !== state.snapshot?.id || result.treeId !== state.snapshot.treeId)
        throw new Error('Review targets stale requirements or snapshot')
      if (strict) assertAcceptance(state.brief!, result)
      if (result.outcome === 'Passed' && result.findings.some(finding => finding.severity === 'blocking'))
        throw new Error('Passed report contains unresolved blocking findings')
      if (result.outcome === 'Needs Changes' && !result.findings.length) throw new Error('Needs Changes requires evidenced findings')
      const next = { ...state, activeRunId: null, review: result, executionMs: state.executionMs + event.elapsedMs }
      if (result.outcome === 'Inconclusive') return { ...next, phase: 'Paused', pausedFrom: 'Staged', pauseReason: result.reason || 'Review inconclusive' }
      if (state.brief && next.executionMs >= state.brief.executionBudgetMs)
        return { ...next, phase: 'Paused', pausedFrom: 'Staged', pauseReason: 'Execution budget exhausted' }
      if (result.outcome === 'Needs Changes') {
        if (state.brief && resolveExecutionIntent(state.brief) === 'verification-only')
          return { ...next, phase: 'Paused', pausedFrom: 'Staged', pauseReason: 'Verification-only execution cannot repair a review' }
        if (state.brief && state.repairRounds >= state.brief.maxRepairRounds)
          return { ...next, phase: 'Paused', pausedFrom: 'Needs Changes', pauseReason: 'Repair round limit exhausted' }
        return { ...next, phase: 'Needs Changes' }
      }
      return { ...next, phase: 'Ready for Handoff' }
    }
    case 'role-interrupted': {
      requirePhase(state, 'Implementing', 'Reviewing', 'Verifying')
      if (state.activeRunId !== event.runId) throw new Error('Interruption targets another role run')
      return { ...state, phase: 'Paused', activeRunId: null, pauseReason: event.reason,
        pausedFrom: state.phase === 'Reviewing' || state.phase === 'Verifying' ? 'Staged' : state.repairRounds ? 'Needs Changes' : 'Approved',
        executionMs: state.executionMs + event.elapsedMs }
    }
    case 'paused': {
      if (state.activeRunId) throw new Error('Await role termination before pausing')
      requirePhase(state, 'Approved', 'Implemented', 'Staged', 'Needs Changes', 'Ready for Handoff')
      return { ...state, phase: 'Paused', pausedFrom: state.phase, pauseReason: event.reason }
    }
    case 'resumed': {
      requirePhase(state, 'Paused')
      requireApproval(state)
      if (state.implementation?.outcome === 'Needs Clarification' || state.review?.outcome === 'Inconclusive')
        throw new Error('Resolve requirement uncertainty with a revised, newly approved brief')
      const from = state.pausedFrom
      if (!from || from === 'Implementing') throw new Error('Clarification or interrupted implementation needs revised approval')
      if (from === 'Needs Changes' && state.brief && state.repairRounds >= state.brief.maxRepairRounds)
        throw new Error('Repair round limit exhausted')
      return { ...state, phase: from === 'Ready for Handoff' ? 'Staged' : from, review: strict && from === 'Needs Changes' ? state.review : null,
        pauseReason: null, pausedFrom: null }
    }
    case 'recovery-decided': {
      if (!state.executionWindow) requirePhase(state, 'Paused', 'Implementing', 'Verifying', 'Reviewing')
      if (event.runId !== state.activeRunId) throw new Error('Recovery targets another run')
      if (state.executionWindow) {
        if (event.action === 'leave-paused' && event.elapsedMs === 0) return state
        const remaining = Math.max(0, (state.brief?.executionBudgetMs ?? 0) - Math.max(state.executionMs, state.executionWallMs ?? 0))
        if (event.action !== 'recover-interrupted' || event.elapsedMs !== remaining || state.hostOperation?.status === 'Running')
          throw new Error('Unresolved execution window needs confirmed quiescence and consumption of unknown remaining budget')
        const { executionWindow, ...rest } = state
        return { ...rest, phase: 'Paused', activeRunId: null, executionWallMs: Math.max(state.executionMs, state.executionWallMs ?? 0) + event.elapsedMs,
          pausedFrom: state.phase === 'Implementing' ? 'Approved' : state.phase === 'Reviewing' || state.phase === 'Verifying' ? 'Staged' : state.phase,
          pauseReason: 'User confirmed previous processes stopped. Unknown execution wall-clock runtime consumed the remaining budget; revise and reapprove requirements.' }
      }
      if (state.activeRunId) {
        if (event.action === 'leave-paused' && event.elapsedMs === 0) return state
        const remaining = Math.max(0, (state.brief?.executionBudgetMs ?? 0) - state.executionMs)
        if (event.action !== 'recover-interrupted' || event.elapsedMs !== remaining)
          throw new Error('Uncertain interrupted runtime must consume the entire remaining approved budget')
        return applyTransition(state, { type: 'role-interrupted', runId: state.activeRunId,
          reason: 'User confirmed previous processes stopped. Interrupted runtime is unknown; remaining budget consumed. Revise requirements and obtain new approval before more execution.', elapsedMs: event.elapsedMs }, strict)
      }
      if (event.elapsedMs !== 0 || event.action === 'recover-interrupted') throw new Error('No unresolved interruption to reconcile')
      if (event.action === 'retry') return applyTransition(state, { type: 'resumed' }, strict)
      if (event.action === 'revise') return { ...state, phase: 'Clarifying', approval: null, pausedFrom: null, pauseReason: 'User requested revised requirements' }
      return state
    }
    case 'handoff-completed': {
      requirePhase(state, 'Ready for Handoff')
      if (state.executionWindow || state.hostOperation?.status === 'Running' || (state.hostOperation?.kind === 'execution' && state.hostOperation.status !== 'Completed')) throw new Error('Host execution must settle successfully before handoff')
      requireApproval(state)
      if (state.review?.outcome !== 'Passed' || !checksPassed(state)) throw new Error('No complete independent Passed review')
      if (strict) {
        assertAcceptance(state.brief!, state.review!)
        if (state.snapshot?.integrityVersion !== 2 || state.snapshot.fileDigests === undefined) throw new Error('Legacy snapshot needs new integrity verification')
      }
      if (event.snapshotId !== state.snapshot?.id || event.treeId !== state.snapshot.treeId || event.briefRevision !== state.brief?.revision)
        throw new Error('Handoff targets stale contents')
      return { ...state, phase: 'Completed' }
    }
    case 'cancelled':
      if (state.activeRunId || state.executionWindow || (audited && state.hostOperation?.status === 'Running')) throw new Error('Await role, execution window and host task termination before cancellation')
      return { ...state, phase: 'Cancelled', pauseReason: event.reason }
    default: {
      const neverEvent: never = event
      throw new Error('Unknown workflow event ' + String(neverEvent))
    }
  }
}

/** Restores only supported, ordered, schema-valid durable facts. */
export function replay(records: readonly unknown[]): WorkflowState {
  let version = 1
  return records.reduce<WorkflowState>((state, raw) => {
    const record = recordSchema.parse(raw)
    if (record.version < version) throw new Error('Workflow record versions cannot regress')
    version = record.version
    return stateSchema.parse(applyTransition(state, record.event, record.version >= 2, record.version >= 3, record.version >= 4, record.version >= 7, record.version >= 8))
  }, initialState())
}

/** One controller owns one session; concurrent mutations fail instead of racing. */
export class WorkflowController {
  private current: WorkflowState
  private committing = false
  constructor(private readonly append: (record: WorkflowRecord) => Promise<void>, records: readonly unknown[] = [], private readonly validateOperationMutation?: OperationMutationValidator) {
    this.current = replay(records)
  }
  get state(): WorkflowState { return structuredClone(this.current) }
  async apply(event: WorkflowEvent): Promise<WorkflowState> {
    if (this.committing) throw new Error('Workflow mutation already in progress')
    this.committing = true
    try {
      const record = recordSchema.parse({ version: 8, event })
      if (record.event.type === 'question-confirmed') {
        if (record.event.receipt.source === 'session-user-question-reply' && !this.validateOperationMutation) throw new Error('Button confirmation requires Session-bound logged reply validation')
        this.validateOperationMutation?.(this.current, record.event)
      }
      if (record.event.type === 'operation-confirmed' || record.event.type === 'authorized-execution-started' || record.event.type === 'authorized-handoff-completed') {
        if (!this.validateOperationMutation) throw new Error('Durable operation mutation requires Session-bound logged permission validation')
        this.validateOperationMutation(this.current, record.event)
      }
      const next = stateSchema.parse(transition(this.current, record.event))
      await this.append(record)
      this.current = next
      return this.state
    } finally { this.committing = false }
  }
}
