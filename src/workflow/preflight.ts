/** Durable repository observations; observations never constitute human authorization. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { OperationRequestId } from './authorization.js'
import { questionBinding } from './questions.js'
import type { WorkflowState } from './types.js'
/** Durable identity of one repository observation. */
export type PreflightId = Branded<'ReviewGatedPreflightId'>
/** Brand a host-allocated or parsed identity. @param value UUID. @returns Observation identity. */
export const PreflightId = (value: string): PreflightId => value as PreflightId
const preflightId = z.string().uuid().transform(PreflightId)
const requestId = z.string().uuid().transform(value => value as OperationRequestId)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
export const repositoryBaselineSchema = z.strictObject({ repository: z.string().min(1), head: hash, treeId: hash })
export const preflightProofSchema = repositoryBaselineSchema.extend({ id: preflightId })
const gitDiagnosticSchema = z.strictObject({ args: z.array(z.string().max(256)).max(64), stdout: z.string().max(8192), stderr: z.string().max(8192), exitCode: z.number().int().nullable(), signal: z.string().nullable(), timedOut: z.boolean(), aborted: z.boolean(), elapsedMs: z.number().nonnegative(), kind: z.enum(['timeout', 'aborted', 'output-limit', 'spawn', 'exit']) })
export const repositoryPreflightSchema = z.strictObject({
  id: preflightId, requestId, kind: z.enum(['execution', 'handoff']), revision: count.min(1),
  scopeBinding: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(['running', 'passed', 'blocked']),
  startedAt: count, durationMs: count, baseline: repositoryBaselineSchema.nullable(),
  limits: z.strictObject({ commandTimeoutMs: count.min(1), integrityTimeoutMs: count.min(1), totalTimeoutMs: count.min(1) }),
  issues: z.array(z.strictObject({ code: z.string().min(1).max(80), message: z.string().min(1).max(8192), diagnostic: gitDiagnosticSchema.optional() })).max(16),
  observedConfirmation: z.strictObject({ seq: count, receivedAt: count, source: z.enum(['session-user-message', 'session-user-question-reply']), selected: z.enum(['Authorize', 'Decline']) }).optional(),
}).superRefine((value, ctx) => {
  if ((value.status === 'passed') !== (value.baseline !== null)) ctx.addIssue({ code: 'custom', message: 'Only a passed preflight carries a baseline' })
  if (value.status === 'passed' && value.issues.length || value.status === 'blocked' && !value.issues.length) ctx.addIssue({ code: 'custom', message: 'Preflight status and diagnostics disagree' })
})
export type RepositoryBaseline = z.infer<typeof repositoryBaselineSchema>
export type PreflightProof = z.infer<typeof preflightProofSchema>
export type RepositoryPreflight = z.infer<typeof repositoryPreflightSchema>
/** Bind permission to both replayed scope and the exact repository observed before the card. */
export function operationBinding(state: WorkflowState, proof?: PreflightProof): string {
  return proof ? createHash('sha256').update(JSON.stringify({ workflow: questionBinding(state), repository: { id: proof.id, repository: proof.repository, head: proof.head, treeId: proof.treeId } })).digest('hex') : questionBinding(state)
}
/** Exact repository equality, without choosing a replacement baseline after authorization. */
export function sameBaseline(left: RepositoryBaseline, right: RepositoryBaseline): boolean {
  return left.repository === right.repository && left.head === right.head && left.treeId === right.treeId
}
