/** Optional host registration of the logged-result display projection. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import { projection } from './projection.ts'

/** Host projection dependency; no workflow service dependency. */
export const name = 'review-gated-observed-ui'
export const inject = ['sessionProjections']

/** Register the pure observation fold for this plugin lifetime.
 * @param ctx Host context with the declared projection registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sessionProjections.register(projection), 'review-gated-ui: logged-result projection')
}
