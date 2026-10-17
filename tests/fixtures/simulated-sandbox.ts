/** Host capability simulation, never evidence of OS isolation. Commands target private test-owned roots. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
export default class SimulatedSandbox extends SandboxProvider {
  static Config = Schema.object({ commandSimulation: Schema.boolean().default(false), mainPtcSimulation: Schema.boolean().default(false), rolePtcSimulation: Schema.boolean().default(false), unavailable: Schema.union(['never', 'all', 'checks']).default('never') })
  private readonly config: { commandSimulation: boolean; mainPtcSimulation: boolean; rolePtcSimulation: boolean; unavailable: 'never' | 'all' | 'checks' }
  constructor(ctx: Context, config: { commandSimulation: boolean; mainPtcSimulation: boolean; rolePtcSimulation: boolean; unavailable: 'never' | 'all' | 'checks' }) { super(ctx); this.config = config }
  override confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
    if (this.config.unavailable === 'all' || this.config.unavailable === 'checks' && policy.sessionId === undefined)
      throw new SandboxUnavailableError(policy.mode, 'Test-owned unavailable native backend')
    // Only fixed fixture Main programs and host-owned checks may run; this is never isolation evidence.
    const role = this.ctx.get('reviewGatedPermissions')?.byId(policy.sessionId)?.role
    const scripted = role === 'main' ? this.config.mainPtcSimulation : role !== undefined && this.config.rolePtcSimulation
    return Promise.resolve({ argv: scripted || this.config.commandSimulation && policy.sessionId === undefined ? [...argv] : [process.execPath, '-e', 'process.exit(126)'],
      enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
  }
}
