/** Host-owned, lifetime-bound role admission; model inputs never create grants. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

export type Role = 'main' | 'implementation' | 'review' | 'diagnostic'
export interface RoleGrant { readonly agent: Agent; readonly role: Role; readonly policy: SandboxPolicy }

/** Shares admitted identities with the process sandbox and executor guard. */
export class RolePermissions {
  private readonly grants = new Map<SessionId, RoleGrant>()
  private closed = false
  constructor(private readonly isLocal: (path: string) => boolean) {}
  /** Bind an unpublished host-created role or a live Main root to its immutable workspace.
   * @param agent Exact Agent being composed.
   * @param role Host-selected role, never a tool argument.
   * @returns The grant retained until explicit preset release or Agent disposal.
   */
  authorize(agent: Agent, role: Role): RoleGrant {
    if (this.closed) throw new Error('Role permissions are closed')
    if (!agent.session.header.cwd) throw new Error('Review-Gated requires an explicit workspace')
    if (!this.isLocal(agent.session.header.cwd)) throw new Error('Review-Gated requires a local workspace in the native host process world')
    if (this.grants.has(agent.id)) throw new Error('Agent already has a Review-Gated role')
    const grant: RoleGrant = Object.freeze({ agent, role, policy: Object.freeze({
      mode: role === 'implementation' ? 'workspace-write' : 'read-only',
      workspaceRoot: agent.session.header.cwd, sessionId: agent.id,
    }) })
    this.grants.set(agent.id, grant)
    agent.ctx.effect(() => () => { if (this.grants.get(agent.id) === grant) this.grants.delete(agent.id) })
    return grant
  }
  /** Release only the exact grant owned by a departing preset; later admissions are unaffected.
   * @param grant Admission to revoke.
   */
  release(grant: RoleGrant): void {
    if (this.grants.get(grant.agent.id) === grant) this.grants.delete(grant.agent.id)
  }
  /** Read an exact live Session's admission; matching IDs alone are insufficient.
   * @param session Session owned by the caller.
   * @returns Its admission, if the exact Session is authorized.
   */
  of(session: Session): RoleGrant | undefined {
    const grant = this.grants.get(session.id)
    return grant?.agent.session === session ? grant : undefined
  }
  /** Read host-managed admission by opaque execution Session identity.
   * @param id Optional identity carried by the process call.
   * @returns Admission when the Session is managed.
   */
  byId(id: SessionId | undefined): RoleGrant | undefined { return id === undefined ? undefined : this.grants.get(id) }
  /** Resolve authority for the native process consumer.
   * @param policy Fully resolved per-call sandbox policy.
   * @returns Its admission; rejects agentless, foreign, or widened policies.
   */
  require(policy: SandboxPolicy): RoleGrant {
    const grant = policy.sessionId === undefined ? undefined : this.grants.get(policy.sessionId)
    if (this.closed || !grant || policy.mode !== grant.policy.mode || policy.workspaceRoot !== grant.policy.workspaceRoot)
      throw new Error('Review-Gated native execution requires an admitted role and its unchanged file policy')
    return grant
  }
  /** Revoke all grants when the support plugin is disposed. */
  close(): void { this.closed = true; this.grants.clear() }
}

declare module '@deepseek-ai/cordis' { interface Context { reviewGatedPermissions: RolePermissions } }
export const name = 'review-gated-permissions'
export const inject = ['fs']
export function apply(ctx: Context): void {
  const fs = ctx.fs
  const permissions = new RolePermissions(path => fs.processPathFromHostPath(path) !== undefined)
  ctx.provide('reviewGatedPermissions', permissions)
  ctx.effect(() => () => permissions.close())
}
