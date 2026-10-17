/** Public selection roster for Review-Gated profiles; host role dispatch retains the complete registry. */
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { Config as RegistryConfig } from '@deepseek-ai/dsh-agent-preset-registry'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Registry settings plus the preset identities reserved for host dispatch. */
export interface Config extends RegistryConfig {
  hostOnlyPresets: string[]
}

/** Filters browser selection without removing host-owned role compositions or their admission guards. */
export default class ReviewGatedRegistry extends AgentPresetRegistry {
  static override Config = z.object({
    default: z.string().required(),
    selectedDefault: z.string().volatile(),
    hostOnlyPresets: z.array(z.string()).default(['review-gated-implementation', 'review-gated-review', 'review-gated-diagnostic']),
  })

  constructor(ctx: Context, public override config: Config) { super(ctx, config) }

  /** Read user-selectable presets; the base class retains the Remote list export.
   * @returns The public roster with its existing default and activation diagnostics.
   */
  override async remoteExportList(): Promise<AgentPresetRoster> {
    const roster = await super.remoteExportList()
    return { presets: roster.presets.filter(preset => !this.config.hostOnlyPresets.includes(preset.id)) }
  }
}
