/** Local providers owned by one managed preset; never replaces the deployment PTC runtime. */
import type { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { stat } from 'node:fs/promises'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import type { Config as NodeOptions } from '@deepseek-ai/dsh-ptc-runtime-node'
import LocalFs from '@deepseek-ai/dsh-fs-sandbox'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { StrictRoleSandbox } from './strict-sandbox.js'

export const name = 'review-gated-native-runtime'
export const inject = ['sandboxPolicy', 'reviewGatedPermissions', 'reviewGatedNativeSandbox']
export type Config = NodeOptions
export const Config = NodePtcRuntime.Config
/** Mount local FS, subprocess and PTC providers in an explicitly isolated role composition.
 * @param ctx Preset-local context with isolated fs, subprocess, sandbox and ptcRuntime services.
 * @param config DSH Node PTC runtime options.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (ctx.get('ptcRuntime')) throw new Error('Review-Gated native runtime needs preset-local ptcRuntime isolation')
  await ctx.plugin(LocalFs)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(StrictRoleSandbox)
  let options = config
  if (!('pkg' in process) && (config.launch === undefined || config.launch.kind === 'node-script' && config.launch.bootstrapPath === undefined)) {
    const asset = fileURLToPath(new URL('./lib/process.js', import.meta.resolve('@deepseek-ai/dsh-ptc-runtime-node/package.json')))
    if (!(await stat(asset)).isFile()) throw new Error('Review-Gated PTC bootstrap is not a file: ' + asset)
    options = { ...config, launch: { kind: 'node-script', executable: config.launch?.executable ?? process.execPath, bootstrapPath: asset } }
  }
  await ctx.plugin(NodePtcRuntime, options)
}
