/** Preset consumer requiring the public host runtime through Loader injection. */
import type { Context } from '@deepseek-ai/cordis'
import type { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
declare module '@deepseek-ai/cordis' { interface Context { presetRuntimeProbe: { runtime: PtcRuntime } } }
export const inject = ['ptcRuntime']
export function apply(ctx: Context): void { ctx.provide('presetRuntimeProbe', { runtime: ctx.ptcRuntime }) }
