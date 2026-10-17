/** Host-only storage provider shared by scoped Main Agent consumers. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { z } from 'zod'
import { workflowDomain, WorkflowJournals } from './journal.js'
import type { JournalLimits } from './journal.js'
import type { ConfirmationMode } from '../workflow/interaction.js'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    reviewGatedHistory: { started: boolean; headerManaged: boolean; firstManagedSeq: number | null; lastManagedSeq: number | null }
  }
}

declare module '@deepseek-ai/cordis' { interface Context { reviewGatedJournals: WorkflowJournals } }
export interface Config extends JournalLimits { confirmationMode: ConfirmationMode }
export const name = 'review-gated-support'
export const inject = ['storageDomain', 'sessionProjections']
export const Config: Schema<Config> = Schema.object({
  confirmationMode: Schema.union(['buttons', 'legacy-json']).default('buttons'),
  maxRecords: Schema.number().min(1).step(1).default(10000),
  maxBytes: Schema.number().min(1).step(1).default(16 * 1024 * 1024),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const domain = await ctx.storageDomain.open(workflowDomain)
  ctx.sessionProjections.register({
    key: 'reviewGatedHistory', stateVersion: 1,
    stateSchema: z.strictObject({ started: z.boolean(), headerManaged: z.boolean(), firstManagedSeq: z.number().int().nonnegative().nullable(), lastManagedSeq: z.number().int().nonnegative().nullable() }),
    init: header => ({ started: false, headerManaged: header.agentPreset === 'review-gated', firstManagedSeq: null, lastManagedSeq: null }),
    apply: (state, event) => {
      if (event.type === 'agent-preset/selected' && event.data.agentPreset === 'review-gated')
        return { ...state, firstManagedSeq: state.firstManagedSeq ?? event.seq, lastManagedSeq: event.seq }
      if (!state.started && (event.type === 'turn/start' || event.type === 'request/header' || event.surfaceOp !== undefined))
        return { ...state, started: true }
      return state
    },
  })
  const journals = new WorkflowJournals(domain, config, session => {
    const history = ctx.sessionProjections.stateOf(session, 'reviewGatedHistory')
    if (!history) throw new Error('Review-Gated Session history projection is unavailable')
    // Only the first live selection can introduce a journal; restored managed history cannot.
    return !history.started && !(history.headerManaged && session.firstLiveSeq > 0)
      && (history.firstManagedSeq === null || (history.firstManagedSeq >= session.firstLiveSeq && history.firstManagedSeq === history.lastManagedSeq))
  }, config.confirmationMode)
  ctx.effect(() => () => journals.close())
  ctx.provide('reviewGatedJournals', journals)
}
