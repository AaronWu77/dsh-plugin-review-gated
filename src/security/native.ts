/** Capture the deployment backend before preset-local sandbox isolation. */
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
declare module '@deepseek-ai/cordis' { interface Context { reviewGatedNativeSandbox: SandboxProvider } }
export const name = 'review-gated-native-sandbox'
export const inject = ['sandbox']
export function apply(ctx: Context): void { ctx.provide('reviewGatedNativeSandbox', ctx.sandbox) }
