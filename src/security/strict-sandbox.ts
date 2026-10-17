/** A preset-local native sandbox that checks role admission without upgrading reported enforcement. */
import type { Context } from '@deepseek-ai/cordis'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from './native.js'
import type {} from './permissions.js'

export class StrictRoleSandbox extends SandboxProvider {
  static inject = ['reviewGatedNativeSandbox', 'reviewGatedPermissions']
  constructor(ctx: Context) { super(ctx) }
  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    this.ctx.reviewGatedPermissions.require(policy)
    const confined = await this.ctx.reviewGatedNativeSandbox.confine(argv, policy, signal)
    signal?.throwIfAborted()
    return confined
  }
}
export default StrictRoleSandbox
