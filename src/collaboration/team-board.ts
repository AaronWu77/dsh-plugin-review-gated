/** Explicitly composed, advisory Main-only Team task board; no role scheduling or approval authority. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team/types'
import type {} from '../security/permissions.js'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'

export const name = 'review-gated-team-board'
export const inject = ['tools', 'agents', 'sandboxPolicy', 'reviewGatedPermissions', 'agentTeams']
/** Bound the complete advisory response, including task descriptions. */
export interface Config { maxOutputBytes: number; pageSize: number }
export const Config: Schema<Config> = Schema.object({ pageSize: Schema.number().min(1).max(100).step(1).default(20), maxOutputBytes: Schema.number().min(1024).max(1048576).step(1).default(16384) })
const id = z.string().min(1)
const input = z.strictObject({
  operation: z.enum(['list', 'get', 'create', 'update']),
  taskId: id.optional(), expectedRevision: z.number().int().positive().optional(),
  action: z.enum(['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen']).optional(),
  subject: z.string().min(1).optional(), description: z.string().min(1).optional(),
  blockedBy: z.array(id).optional(), writeScopes: z.array(z.string().min(1)).optional(),
  cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional(),
})
/** Register only advisory task operations after checking the explicitly enabled dependency.
 * @param ctx Main preset context with role grants and optional Team service.
 * @param config Complete-response byte limit.
 */
export function apply(ctx: Context, config: Config): void {
  const team = ctx.agentTeams
  ctx.tools.register(defineTool({
    name: 'rg_team_board',
    description: 'Read or coordinate advisory Team tasks as Main. Board completion NEVER approves requirements, starts roles, changes budget, establishes Passed or authorizes handoff. No teammate creation, messaging, or role assignment. Read current revision before updating.',
    parameters: {
      operation: { type: 'string', required: true, description: 'Exactly list, get, create or update.' },
      taskId: { type: 'string', description: 'Task identity required by get/update.' },
      expectedRevision: { type: 'integer', description: 'Exact current revision required by update.' },
      action: { type: 'string', description: 'claim, release, edit, set_dependencies, complete or reopen; no reassign/delete.' },
      subject: { type: 'string' }, description: { type: 'string' },
      blockedBy: { type: 'array', items: { type: 'string' } }, writeScopes: { type: 'array', items: { type: 'string' } },
      cursor: { type: 'integer' }, limit: { type: 'integer' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (raw, exec) => {
      const actor = exec.agent
      const grant = actor && ctx.reviewGatedPermissions.of(actor.session)
      if (!actor || ctx.agents.get(actor.id) !== actor || !ctx.agents.roots().includes(actor) || grant?.role !== 'main')
        throw new Error('Only the exact live admitted Main Agent may coordinate advisory Team tasks')
      const policy = ctx.sandboxPolicy.resolve({ session: actor.session })
      if (policy.mode !== grant.policy.mode || policy.workspaceRoot !== grant.policy.workspaceRoot)
        throw new Error('Advisory Team board refuses changed managed file policy')
      exec.signal.throwIfAborted()
      const args = input.parse(raw)
      const tasks = (values: readonly string[]) => values.map(value => brandString<TeamTaskId>(value))
      let data: Awaited<ReturnType<typeof team.listTasks>> | Awaited<ReturnType<typeof team.getTask>>
      switch (args.operation) {
        case 'list': data = team.listTasks(actor).slice(args.cursor ?? 0, (args.cursor ?? 0) + (args.limit ?? config.pageSize)); break
        case 'get': data = await team.getTask(actor, brandString<TeamTaskId>(id.parse(args.taskId))); break
        case 'create': data = await team.createTask(actor, {
          subject: z.string().min(1).parse(args.subject), description: z.string().min(1).parse(args.description),
          ...(args.blockedBy === undefined ? {} : { blockedBy: tasks(args.blockedBy) }),
          ...(args.writeScopes === undefined ? {} : { writeScopes: args.writeScopes }),
        }); break
        case 'update': data = await team.updateTask(actor, {
          taskId: brandString<TeamTaskId>(id.parse(args.taskId)), expectedRevision: z.number().int().positive().parse(args.expectedRevision),
          action: z.enum(['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen']).parse(args.action),
          ...(args.subject === undefined ? {} : { subject: args.subject }), ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.blockedBy === undefined ? {} : { blockedBy: tasks(args.blockedBy) }), ...(args.writeScopes === undefined ? {} : { writeScopes: args.writeScopes }),
        }); break
      }
      const result = { advisory: true, data: Array.isArray(data) ? data.map(task => ({ ...task })) : { ...data } }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= config.maxOutputBytes) return result
      if (args.operation === 'create' || args.operation === 'update') {
        if (!('id' in data)) throw new Error('Mutating Team operation returned a page instead of a task')
        return { advisory: true, detailsOmitted: true, data: { id: data.id, revision: data.revision, status: data.status } }
      }
      throw new Error('Advisory Team response exceeds its byte limit; read a smaller page or increase the limit')
    },
  }))
}
