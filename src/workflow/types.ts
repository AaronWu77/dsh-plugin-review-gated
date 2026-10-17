/** Validated model inputs, review results, and durable workflow facts. */
import { z } from 'zod'
import { questionSchema, currentQuestionSchema } from './questions.js'
import { operationRequestSchema, currentOperationRequestSchema, boundOperationRequestSchema } from './authorization.js'
import { repositoryPreflightSchema } from './preflight.js'
import { executionIntentSchema } from './execution-policy.js'
export { executionIntentSchema } from './execution-policy.js'
export type { ExecutionIntent } from './execution-policy.js'

const text = z.string().trim().min(1)
const identifier = text.max(256)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const gitIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
export const commandSchema = z.strictObject({ executable: text, args: z.array(z.string()), timeoutMs: milliseconds.min(1).max(2147483647).optional() })
export const briefSchema = z.strictObject({
  id: identifier,
  revision,
  goal: text,
  nonGoals: z.array(text),
  allowedPaths: z.array(text).min(1),
  generatedPaths: z.array(text).optional(),
  constraints: z.array(text),
  acceptanceCriteria: z.array(z.strictObject({ id: identifier, description: text })).min(1),
  verificationCommands: z.array(commandSchema).min(1),
  maxRepairRounds: z.number().int().nonnegative().max(100),
  executionBudgetMs: milliseconds.min(1),
  questions: z.array(text),
  /** New briefs must select the execution path explicitly; released records may omit it and resolve to implementation. */
  executionIntent: executionIntentSchema.optional(),
})
const literalPath = text.refine(path => path === '.' || (!/^[A-Za-z]:|^[\\/]|[\\*?\[\]{}\x00-\x1f\x7f]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')), 'Use a literal repository-relative path, not a glob, absolute path or Git internals')
export const submittedBriefSchema = briefSchema.extend({
  allowedPaths: z.array(literalPath).min(1),
  generatedPaths: z.array(literalPath.refine(path => path !== '.', 'Do not exclude the complete repository from review')).optional(),
  verificationCommands: z.array(commandSchema.extend({ timeoutMs: milliseconds.min(1).max(2147483647) })).min(1),
  executionIntent: executionIntentSchema,
})
export type RequirementsBrief = z.infer<typeof briefSchema>
export const approvalSchema = z.strictObject({ questionId: identifier, revision, approved: z.boolean() })
export type ApprovalEvidence = z.infer<typeof approvalSchema>
export const implementationSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('Completed'), summary: text, problems: z.array(text), limitations: z.array(text) }),
  z.strictObject({ outcome: z.literal('Needs Clarification'), questions: z.array(text).min(1), summary: text }),
  z.strictObject({ outcome: z.literal('Blocked'), reason: text }),
])
export type ImplementationResult = z.infer<typeof implementationSchema>
export const snapshotSchema = z.strictObject({
  id: identifier, briefRevision: revision, baseCommit: gitIdSchema, treeId: gitIdSchema,
  repository: text, changedPaths: z.array(text),
  generatedPaths: z.array(text).optional(), integrityVersion: z.literal(2).optional(),
  fileDigests: z.array(z.strictObject({ path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/) })).optional(),
})
export type StagedSnapshot = z.infer<typeof snapshotSchema>
export const checkResultSchema = z.strictObject({
  command: commandSchema, exitCode: z.number().int().nullable(), signal: z.string().nullable(),
  effectiveTimeoutMs: milliseconds.min(1).max(2147483647).optional(), timedOut: z.boolean(), stdout: z.string(), stderr: z.string(), durationMs: milliseconds,
})
export type CheckResult = z.infer<typeof checkResultSchema>
export const verificationSchema = z.strictObject({ snapshotId: identifier, treeId: gitIdSchema, checks: z.array(checkResultSchema).min(1) })
export type VerificationEvidence = z.infer<typeof verificationSchema>
const findingSchema = z.strictObject({
  severity: z.enum(['blocking', 'non-blocking']), file: text, line: z.number().int().positive(),
  trigger: text, impact: text, evidence: text, suggestion: text,
})
export const acceptanceResultSchema = z.strictObject({
  id: identifier, status: z.enum(['Passed', 'Failed', 'Not Verified', 'Inconclusive']),
  evidence: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('verification'), checkIndex: z.number().int().nonnegative(), explanation: text }),
    z.strictObject({ kind: z.literal('source'), file: text, line: z.number().int().positive(), explanation: text }),
  ])),
})
export const reviewSchema = z.strictObject({
  outcome: z.enum(['Passed', 'Needs Changes', 'Inconclusive']), briefRevision: revision,
  snapshotId: identifier, treeId: gitIdSchema, findings: z.array(findingSchema),
  checked: z.array(text), unchecked: z.array(text), reason: z.string(),
  acceptance: z.array(acceptanceResultSchema).optional(),
})
export type ReviewResult = z.infer<typeof reviewSchema>
export const phaseSchema = z.enum([
  'Clarifying', 'Awaiting Approval', 'Approved', 'Implementing', 'Implemented', 'Staged',
  'Verifying', 'Reviewing', 'Needs Changes', 'Paused', 'Ready for Handoff', 'Completed', 'Cancelled',
])
export type WorkflowPhase = z.infer<typeof phaseSchema>
export type HostOperationId = import('@deepseek-ai/dsh-brand').Branded<'ReviewGatedHostOperationId'>
export const HostOperationId = (value: string): HostOperationId => value as HostOperationId
export const hostOperationSchema = z.strictObject({
  id: z.string().uuid().transform(HostOperationId), kind: z.enum(['approval', 'execution', 'diagnostic']),
  status: z.enum(['Running', 'Completed', 'Failed', 'Cancelled', 'Interrupted']),
  result: z.json().nullable(), error: z.string().nullable(),
})
export type HostOperation = z.infer<typeof hostOperationSchema>
export const diagnosticSchema = z.strictObject({
  summary: text,
  findings: z.array(z.strictObject({ file: text, line: z.number().int().positive(), message: text, evidence: text })),
  limitations: z.array(text),
})
export type DiagnosticResult = z.infer<typeof diagnosticSchema>
export const roleFailureSchema = z.strictObject({ role: z.enum(['implementation', 'review', 'diagnostic']), runId: identifier,
  kind: z.enum(['json-parse', 'schema-validation']), issueCount: z.number().int().nonnegative(),
  issues: z.array(z.strictObject({ code: z.string().max(64), path: z.array(z.union([z.string().max(80), z.number()])).max(8), message: z.string().max(160) })).max(8),
  logReference: z.strictObject({ sessionId: identifier }),
})
export const currentRoleFailureSchema = roleFailureSchema.extend({ kind: z.enum(['json-parse', 'schema-validation', 'semantic-validation']) })
const releasedStateSchema = z.strictObject({
  phase: phaseSchema, brief: briefSchema.nullable(), approval: approvalSchema.nullable(),
  implementation: implementationSchema.nullable(), snapshot: snapshotSchema.nullable(),
  verification: verificationSchema.nullable(), review: reviewSchema.nullable(),
  hostOperation: hostOperationSchema.optional(),
  executionWallMs: milliseconds.optional(),
  executionWindow: z.strictObject({ id: identifier }).optional(),
  activeRunId: identifier.nullable(), repairRounds: z.number().int().nonnegative(), executionMs: milliseconds,
  pauseReason: z.string().nullable(), pausedFrom: phaseSchema.nullable(),
  questions: z.array(currentQuestionSchema).optional(), roleFailures: z.array(currentRoleFailureSchema).optional(), operationAuthorization: currentOperationRequestSchema.optional(),
})
export const stateSchema = releasedStateSchema.extend({ operationAuthorization: boundOperationRequestSchema.optional(), repositoryPreflight: repositoryPreflightSchema.optional(), preflightMs: milliseconds.optional() })
export type WorkflowState = z.infer<typeof stateSchema>
const releasedEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('execution-budget-exhausted'), executionWallMs: milliseconds }),
  z.strictObject({ type: z.literal('execution-window-started'), id: identifier }),
  z.strictObject({ type: z.literal('execution-window-finished'), id: identifier, elapsedMs: milliseconds }),
  z.strictObject({ type: z.literal('host-operation-started'), operation: hostOperationSchema }),
  z.strictObject({ type: z.literal('host-operation-finished'), operation: hostOperationSchema }),
  z.strictObject({ type: z.literal('requirements-submitted'), brief: briefSchema }),
  z.strictObject({ type: z.literal('requirements-decided'), evidence: approvalSchema }),
  z.strictObject({ type: z.literal('implementation-started'), runId: identifier }),
  z.strictObject({ type: z.literal('implementation-finished'), runId: identifier, result: implementationSchema, elapsedMs: milliseconds }),
  z.strictObject({ type: z.literal('snapshot-created'), snapshot: snapshotSchema }),
  z.strictObject({ type: z.literal('verification-started'), runId: identifier }),
  z.strictObject({ type: z.literal('verification-recorded'), evidence: verificationSchema, runId: identifier.optional(), elapsedMs: milliseconds.optional() }),
  z.strictObject({ type: z.literal('review-started'), runId: identifier }),
  z.strictObject({ type: z.literal('review-finished'), runId: identifier, result: reviewSchema, elapsedMs: milliseconds }),
  z.strictObject({ type: z.literal('role-interrupted'), runId: identifier, reason: text, elapsedMs: milliseconds }),
  z.strictObject({ type: z.literal('paused'), reason: text }),
  z.strictObject({ type: z.literal('resumed') }),
  z.strictObject({ type: z.literal('recovery-decided'), questionId: identifier, runId: identifier.nullable(),
    action: z.enum(['recover-interrupted', 'retry', 'revise', 'leave-paused']), elapsedMs: milliseconds }),
  z.strictObject({ type: z.literal('handoff-completed'), snapshotId: identifier, treeId: gitIdSchema, briefRevision: revision }),
  z.strictObject({ type: z.literal('cancelled'), reason: text }),
])
const version4EventSchema = z.union([releasedEventSchema, z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('role-result-rejected'), failure: roleFailureSchema }),
  z.strictObject({ type: z.literal('question-opened'), question: questionSchema }),
  z.strictObject({ type: z.literal('question-returned'), questionId: identifier, serviceAnswer: questionSchema.shape.serviceAnswer.unwrap() }),
  z.strictObject({ type: z.literal('question-failed'), questionId: identifier, reason: text }),
  z.strictObject({ type: z.literal('question-confirmed'), questionId: identifier, selected: text, receipt: questionSchema.shape.receipt.unwrap() }),
])])
const version5EventSchema = z.union([version4EventSchema, z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('operation-requested'), request: operationRequestSchema }),
  z.strictObject({ type: z.literal('operation-confirmed'), requestId: operationRequestSchema.shape.id, selected: z.enum(['Authorize', 'Decline']), receipt: operationRequestSchema.shape.receipt.unwrap() }),
  z.strictObject({ type: z.literal('authorized-execution-started'), requestId: operationRequestSchema.shape.id, id: identifier }),
  z.strictObject({ type: z.literal('authorized-handoff-completed'), requestId: operationRequestSchema.shape.id, snapshotId: identifier, treeId: gitIdSchema, briefRevision: revision }),
  z.strictObject({ type: z.literal('review-result-rejected'), failure: currentRoleFailureSchema.extend({ role: z.literal('review'), kind: z.literal('semantic-validation') }) }),
])])
const version6EventSchema = z.union([version5EventSchema, z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('question-opened'), question: currentQuestionSchema }),
  z.strictObject({ type: z.literal('question-confirmed'), questionId: identifier, selected: text, receipt: currentQuestionSchema.shape.receipt.unwrap() }),
  z.strictObject({ type: z.literal('operation-requested'), request: currentOperationRequestSchema }),
  z.strictObject({ type: z.literal('operation-confirmed'), requestId: currentOperationRequestSchema.shape.id, selected: z.enum(['Authorize', 'Decline']), receipt: currentOperationRequestSchema.shape.receipt.unwrap() }),
])])
export const eventSchema = z.union([version6EventSchema, z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('repository-preflight-recorded'), preflight: repositoryPreflightSchema }),
  z.strictObject({ type: z.literal('operation-requested'), request: boundOperationRequestSchema }),
])])
export type WorkflowEvent = z.infer<typeof eventSchema>
export const recordSchema = z.union([
  z.strictObject({ version: z.union([z.literal(1), z.literal(2), z.literal(3)]), event: releasedEventSchema }),
  z.strictObject({ version: z.literal(4), event: version4EventSchema }),
  z.strictObject({ version: z.literal(5), event: version5EventSchema }),
  z.strictObject({ version: z.literal(6), event: version6EventSchema }),
  z.strictObject({ version: z.literal(7), event: version6EventSchema }),
  z.strictObject({ version: z.literal(8), event: eventSchema }),
]).superRefine((record, context) => {
  if (record.version < 3 && (record.event.type === 'execution-window-started' || record.event.type === 'execution-window-finished' || record.event.type === 'execution-budget-exhausted'))
    context.addIssue({ code: 'custom', message: 'Wall-clock execution events require record version 3' })
})
export type WorkflowRecord = z.infer<typeof recordSchema>
