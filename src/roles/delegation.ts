/** Managed local one-shot preparation; reserved host launch identities admit role creation. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type { Role } from '../security/permissions.js'
import type {} from '../security/native.js'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/** Host-owned role identity and immutable composition selected after workflow admission. */
export interface ManagedLaunch {
  readonly parent: Agent
  readonly childId: SessionId
  readonly role: Exclude<Role, 'main'>
  readonly preset: string
  readonly cwd: string
  readonly maxDepth: number
  readonly prompt: ContentBlock[]
  readonly signal: AbortSignal
}

/** Register detached role preparation and return its private host launch operation.
 * @param ctx Host context with role permissions, native sandbox and Subagent services.
 * @param providerName Deployment-selected registry name; generic delegation cannot supply admission.
 * @returns Operation returning the manager-owned activation; callers always dispose it.
 */
export function managedDelegation(ctx: Context, providerName: string): (launch: ManagedLaunch) => Promise<SubagentActivation> {
  if (ctx.subagents.supportsLocalOneShot !== true)
    throw new Error('Review-Gated requires the alpha2 Host local-one-shot activation extension; stock alpha2 is unsupported')
  const pending = new Map<SessionId, ManagedLaunch>()
  ctx.subagents.registerProvider({
    name: providerName,
    inheritsParentContext: false,
    capabilities: { agentOptions: false, outputSchema: false, depthLimit: true, toolFilter: false, persona: false },
    prepareLocalOneShot: async (request, managedSignal) => {
      const launch = pending.get(request.sessionId)
      if (!launch || launch.parent !== request.parent || launch.signal !== request.signal || launch.maxDepth !== request.maxDepth || launch.cwd !== request.cwd)
        throw new Error('Managed Subagent provider requires host-prepared role admission')
      pending.delete(request.sessionId)
      managedSignal.throwIfAborted()
      const grant = ctx.reviewGatedPermissions.of(request.parent.session)
      if (grant?.role !== 'main' || ctx.agents.get(request.parent.id) !== request.parent)
        throw new Error('Managed Subagent provider requires the admitted live Main Agent')
      return {
        agentPreset: launch.preset,
        setup: async (childCtx, child) => {
          ctx.reviewGatedPermissions.authorize(child, launch.role)
          await ctx.agentPresets.mount(childCtx, launch.preset)
        },
        preflight: async (child, signal) => {
          signal.throwIfAborted()
          const policy = ctx.reviewGatedPermissions.of(child.session)!.policy
          await ctx.reviewGatedNativeSandbox.confine([process.execPath, '--version'], policy, signal)
          signal.throwIfAborted()
        },
      }
    },
  })
  return async launch => {
    if (pending.has(launch.childId)) throw new Error('Managed role child identity already has pending admission')
    pending.set(launch.childId, launch)
    try {
      return await ctx.subagents.startActivation({
        provider: providerName, lifecycle: 'one-shot', childId: launch.childId,
        label: 'Review-Gated ' + launch.role, delivery: 'caller', signal: launch.signal,
        request: { parent: launch.parent, cwd: launch.cwd, prompt: launch.prompt, maxDepth: launch.maxDepth },
      })
    } finally { pending.delete(launch.childId) }
  }
}
