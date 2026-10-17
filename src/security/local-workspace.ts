/** Refuse managed execution when the workspace filesystem has no path in the native host process world. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from './permissions.js'

export const name = 'review-gated-local-workspace'
export const inject = ['fs', 'tools', 'reviewGatedPermissions']

/** Protect all admitted roles, including restored agents, before model requests and managed tool execution.
 * @param ctx Host context with the model-facing filesystem and native role grants.
 */
export function apply(ctx: Context): void {
  const fs = ctx.fs
  const problem = (agent: Agent): string | undefined => {
    const grant = ctx.reviewGatedPermissions.of(agent.session)
    if (grant && fs.processPathFromHostPath(grant.policy.workspaceRoot) === undefined)
      return 'Review-Gated requires a local workspace in the native host process world; routed remote workspaces are unsupported'
    return undefined
  }
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    const reason = problem(agent)
    if (reason) throw new Error(reason)
    return decision
  })
  ctx.tools.guard(exec => exec.agent ? problem(exec.agent) : undefined)
}
