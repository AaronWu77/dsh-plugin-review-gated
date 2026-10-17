import type { RequirementsBrief, WorkflowEvent, WorkflowState, ReviewResult, StagedSnapshot, VerificationEvidence } from '../../src/workflow/types.js'
import { initialState, transition } from '../../src/workflow/controller.js'

export const brief: RequirementsBrief = {
  id: 'task', revision: 1, goal: 'Add CSV export', nonGoals: ['No authentication changes'],
  allowedPaths: ['src', 'tests'], constraints: ['Do not publish'],
  acceptanceCriteria: [{ id: 'AC1', description: 'Export filtered records' }],
  verificationCommands: [{ executable: 'node', args: ['--version'], timeoutMs: 60000 }], maxRepairRounds: 2, executionBudgetMs: 1800000, questions: [], executionIntent: 'implementation',
}
export const snapshot: StagedSnapshot = {
  id: 'snapshot-1', briefRevision: 1, baseCommit: 'a'.repeat(40), treeId: 'b'.repeat(40),
  repository: '/project', changedPaths: ['src/export.ts'], integrityVersion: 2, fileDigests: [{ path: 'src/export.ts', sha256: 'c'.repeat(64) }],
}
export const verification: VerificationEvidence = {
  snapshotId: snapshot.id, treeId: snapshot.treeId,
  checks: [{ command: brief.verificationCommands[0]!, exitCode: 0, signal: null, timedOut: false, stdout: 'node version', stderr: '', durationMs: 2 }],
}
export const passed: ReviewResult = { outcome: 'Passed', briefRevision: 1, snapshotId: snapshot.id, treeId: snapshot.treeId,
  findings: [], checked: ['AC1', 'caller', 'test'], unchecked: [], reason: '',
  acceptance: [{ id: 'AC1', status: 'Passed', evidence: [{ kind: 'verification', checkIndex: 0, explanation: 'Required check passed' }] }] }
export const finding = { severity: 'blocking' as const, file: 'src/export.ts', line: 1,
  trigger: 'A filtered result', impact: 'Unfiltered records leak', evidence: 'Reproduce with a filter', suggestion: 'Respect the filter' }
export function readyEvents(): WorkflowEvent[] {
  return [
    { type: 'requirements-submitted', brief },
    { type: 'requirements-decided', evidence: { questionId: 'approval-1', revision: 1, approved: true } },
    { type: 'implementation-started', runId: 'worker-1' },
    { type: 'implementation-finished', runId: 'worker-1', result: { outcome: 'Completed', summary: 'CSV export', problems: [], limitations: [] }, elapsedMs: 10 },
    { type: 'snapshot-created', snapshot }, { type: 'verification-recorded', evidence: verification },
    { type: 'review-started', runId: 'review-1' },
    { type: 'review-finished', runId: 'review-1', result: passed, elapsedMs: 10 },
  ]
}
export function atEvent(count: number): WorkflowState {
  return readyEvents().slice(0, count).reduce(transition, initialState())
}
