/** Native host-plane capabilities captured outside the model-facing routing realm. */
import type { Context } from '@deepseek-ai/cordis'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export interface HostWorld extends Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> {
  processPathFromHostPath(path: string): string | undefined
}
declare module '@deepseek-ai/cordis' { interface Context { reviewGatedHostWorld: HostWorld } }
export const name = 'review-gated-host-world'
export const inject = ['fs', 'subprocess']
/** Mount local capabilities without replacing deployment providers or rebinding native service contexts.
 * @param ctx Host plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  const world = ctx.isolate('fs').isolate('subprocess')
  await world.plugin(LocalFs)
  await world.plugin(LocalSubprocess)
  const fs = world.fs, subprocess = world.subprocess
  ctx.provide('reviewGatedHostWorld', Object.freeze({
    processPathFromHostPath: (path: string) => fs.processPathFromHostPath(path),
    resolveExecutable: (...args: Parameters<SubprocessRuntime['resolveExecutable']>) => subprocess.resolveExecutable(...args),
    spawn: (...args: Parameters<SubprocessRuntime['spawn']>) => subprocess.spawn(...args),
  }))
}
