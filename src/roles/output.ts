/** Text-only role results; reasoning metadata is not part of the returned JSON. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { z } from 'zod'
import type { Role } from '../security/permissions.js'

/** Host identity attached to a rejected model result. */
export interface RoleResultContext { role: Exclude<Role, 'main'>; runId: string }

/** Bounded validation issue summary; no input value or nested union errors are retained. */
export interface RoleResultIssue { code: string; path: (string | number)[]; message: string }

/** JSON, schema or semantic rejection for host persistence/reporting, without the raw result or parser cause.
 * Issues retain at most eight entries, eight path segments per entry, 80 characters per segment,
 * 64 characters per code and 160 characters per message. issueCount records the full issue count.
 */
export class RoleResultError extends Error {
  override readonly name = 'RoleResultError'
  readonly role: RoleResultContext['role']
  readonly runId: string
  readonly kind: 'json-parse' | 'schema-validation' | 'semantic-validation'
  readonly issues: RoleResultIssue[]
  readonly issueCount: number

  constructor(context: RoleResultContext, kind: RoleResultError['kind'], issues: readonly { code: string; path: readonly PropertyKey[]; message: string }[] = []) {
    super(kind === 'json-parse' ? `Role ${context.role} result is not valid JSON` : `Role ${context.role} result failed ${kind === 'semantic-validation' ? 'semantic' : 'schema'} validation`)
    this.role = context.role
    this.runId = context.runId
    this.kind = kind
    this.issueCount = issues.length
    this.issues = issues.slice(0, 8).map(issue => ({
      code: issue.code.slice(0, 64),
      path: issue.path.slice(0, 8).map(segment => typeof segment === 'number' ? segment : String(segment).slice(0, 80)),
      message: issue.message.slice(0, 160),
    }))
  }
}

/** Create a classified rejection using the same bounded summaries for every validation stage.
 * @param context Host-assigned role and run identity.
 * @param kind JSON, schema or semantic rejection category.
 * @param issues Safe diagnostic summaries, without raw result values or causes.
 * @returns Error retaining at most eight bounded issues and the full issue count.
 */
export function boundedRoleResultError(context: RoleResultContext, kind: RoleResultError['kind'], issues: readonly { code: string; path: readonly PropertyKey[]; message: string }[] = []): RoleResultError {
  return new RoleResultError(context, kind, issues)
}

/** Parse a complete result once, without stripping fields, repairing JSON or retrying.
 * @param text Complete final JSON text after roleOutputText byte checks.
 * @param schema The role's strict, unmodified Zod validator.
 * @param context Host-assigned role and run identity for failures.
 * @returns Validated result; throws RoleResultError for JSON or schema rejection.
 */
export function parseRoleResult<T>(text: string, schema: z.ZodType<T>, context: RoleResultContext): T {
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) {
    // JSON parser diagnostics may quote model output; neither that message nor its cause is retained.
    throw new RoleResultError(context, 'json-parse')
  }
  const result = schema.safeParse(value)
  if (!result.success) throw new RoleResultError(context, 'schema-validation', result.error.issues)
  return result.data
}

/** Select complete final text without accepting other non-text output.
 * @param blocks Final assistant message after a normally completed role turn.
 * @param maxBytes UTF-8 limit on the complete JSON text.
 * @returns Text for strict JSON and role-schema parsing.
 */
export function roleOutputText(blocks: readonly ContentBlock[] | undefined, maxBytes: number): string {
  if (!blocks?.length) throw new Error('Role final answer is missing JSON text')
  if (blocks.some(block => block.type !== 'text' && block.type !== 'reasoning')) throw new Error('Role final answer contains an unsupported output block')
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
  if (!text.trim()) throw new Error('Role final answer is missing JSON text')
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Role final answer exceeds the configured byte limit')
  return text
}
