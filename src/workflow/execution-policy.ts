/** Durable execution intent resolution for new briefs and released history. */
import { z } from 'zod'
import type { RequirementsBrief } from './types.js'

export const executionIntentSchema = z.enum(['implementation', 'verification-only'])
export type ExecutionIntent = z.infer<typeof executionIntentSchema>

/** Resolve the persisted execution path without changing released brief semantics.
 * @param brief Requirements brief, including a possibly omitted field from released history.
 * @returns Explicit execution intent for current orchestration.
 */
export function resolveExecutionIntent(brief: Pick<RequirementsBrief, 'executionIntent'>): ExecutionIntent {
  return brief.executionIntent ?? 'implementation'
}
