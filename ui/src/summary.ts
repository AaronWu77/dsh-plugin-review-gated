/** JSON readers for logged Review-Gated summaries, not the workflow journal. */
import { z } from 'zod'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = z.string().min(1)
const gitId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
export const phaseSchema = z.enum(['Clarifying', 'Awaiting Approval', 'Approved', 'Implementing', 'Implemented', 'Staged', 'Verifying', 'Reviewing', 'Needs Changes', 'Paused', 'Ready for Handoff', 'Completed', 'Cancelled'])
const list = z.union([z.array(z.string()), z.object({ count, items: z.array(z.string()) }).refine(v => v.items.length <= v.count)])
const brief = z.object({ id: text, revision: count.min(1), goal: text, executionBudgetMs: count.min(1), maxRepairRounds: count,
  executionIntent: z.enum(['implementation', 'verification-only']).optional() })
const approval = z.object({ questionId: text, revision: count.min(1), approved: z.boolean() })
const snapshot = z.object({ id: text, briefRevision: count.min(1), treeId: gitId, baseCommit: gitId })
const finding = z.object({ severity: z.enum(['blocking', 'non-blocking']), file: text, line: count.min(1), trigger: text, impact: text })
const verification = z.union([
  z.object({ snapshotId: text, treeId: gitId, checkCount: count, passedCount: count }).refine(v => v.passedCount <= v.checkCount),
  z.object({ snapshotId: text, treeId: gitId, checks: z.array(z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable(), timedOut: z.boolean() })) })
    .transform(v => ({ snapshotId: v.snapshotId, treeId: v.treeId, checkCount: v.checks.length,
      passedCount: v.checks.filter(c => c.exitCode === 0 && c.signal === null && !c.timedOut).length })),
])
const review = z.object({ outcome: z.enum(['Passed', 'Needs Changes', 'Inconclusive']), unchecked: list,
  findings: z.array(finding).optional(), reason: z.string().optional(), findingCount: count.optional(),
  blockingFindingCount: count.optional(), blockingFindings: list.optional() }).refine(v =>
    v.findingCount === undefined || v.blockingFindingCount === undefined || v.blockingFindingCount <= v.findingCount)
const stateSchema = z.object({ phase: phaseSchema, brief: brief.nullable(), approval: approval.nullable(), snapshot: snapshot.nullable(),
  verification: verification.nullable(), review: review.nullable(), activeRunId: text.nullable(), repairRounds: count,
  hostOperation: z.object({ id: text, kind: z.enum(['approval', 'execution', 'diagnostic']), status: z.enum(['Running', 'Completed', 'Failed', 'Cancelled', 'Interrupted']), error: z.string().nullable() }).nullable().optional(),
  executionMs: count, executionWallMs: count.optional(), remainingExecutionMs: count.nullable().optional(), pauseReason: z.string().nullable() })
const summarySchema = z.object({ state: stateSchema, recordCount: count })

/** Validate the selected display fields; detailed results use the same subset.
 * @param value Decoded tool JSON. @returns A detached display summary, or null for malformed values.
 */
export function readSummary(value: unknown) {
  const parsed = summarySchema.safeParse(value)
  return parsed.success ? normalizeSummary(parsed.data) : null
}

function normalizeSummary({ state, recordCount }: z.infer<typeof summarySchema>) {
  return { recordCount, state: { ...state, remainingExecutionMs: state.remainingExecutionMs === undefined
    ? state.brief ? Math.max(0, state.brief.executionBudgetMs - Math.max(state.executionMs, state.executionWallMs ?? 0)) : null
    : state.remainingExecutionMs } }
}

/** Validated projection value; all facts describe the logged observation only. */
export const observationSchema = z.object({ seq: count, time: count.max(8640000000000000), tool: text, callId: text,
  transport: z.enum(['native', 'ptc']), summary: summarySchema.transform(normalizeSummary) })
export type Observation = z.infer<typeof observationSchema>
export type Phase = z.infer<typeof phaseSchema>
