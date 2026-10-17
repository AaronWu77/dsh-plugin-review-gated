/** Anchor presets to the installed package; keep owned subpaths out of client discovery. */
import PresetDeclaration from '@deepseek-ai/dsh-agent-preset'
import type { Config } from '@deepseek-ai/dsh-agent-preset'
import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'

function anchor(plugins: Config['plugins']): Config['plugins'] {
  return plugins.map(entry => ({
    ...entry,
    name: entry.name.startsWith('.') ? new URL(entry.name, new URL('../', import.meta.url)).href
      : entry.name.startsWith('@aaronwu/dsh-review-gated/') || entry.name.includes(':') || isAbsolute(entry.name) ? entry.name : import.meta.resolve(entry.name),
    ...entry.group && Array.isArray(entry.config) ? { config: anchor(entry.config) } : {},
  }))
}

/** Standard DSH declaration lifecycle with package-relative bare provider resolution. */
export default class ReviewGatedPreset extends PresetDeclaration {
  constructor(ctx: Context, config: Config) {
    super(ctx.extend({ baseUrl: new URL('../', import.meta.url).href }), { ...config, plugins: anchor(config.plugins) })
  }
}
