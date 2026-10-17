/** Browser entry: optional observation panel, without workflow commands. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import type {} from '../projection.ts'
import { ReviewAction } from './ReviewAction.tsx'
import { NS, en, zh, type ReviewKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'review-gated-observed': ReviewKey }
}
/** Browser services for standard slots, locale and child navigation only. */
export const inject = ['sessions', 'uiWorkspace', 'slots', 'locale']
/** Mount localized display contributions; no Remote methods or tool calls are issued.
 * @param ctx Browser context with the declared services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'review-gated-ui: dictionaries')
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'review-gated-observed', order: -15, locale: NS,
    inject: sessionId => {
      const binding = ctx.sessions.binding(sessionId)
      return { openChild(parentSessionId, childSessionId) {
        if (parentSessionId !== sessionId || binding === undefined || ctx.sessions.binding(sessionId) !== binding) return false
        const catalog = ctx.sessions.list.getSnapshot().projectionsBySession[parentSessionId]?.values.subagentCatalog
        if (!catalog?.some(child => child.id === childSessionId && child.mode === 'one-shot')) return false
        ctx.uiWorkspace.openSession({ parentSessionId, childSessionId, mode: 'one-shot' })
        return true
      } }
    },
  }, ReviewAction))
}
