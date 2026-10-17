/** Replayable, observation-only projection over committed native and PTC tool results. */
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-tools/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { observationSchema, readSummary } from './summary.ts'

const tools = new Set(['rg_status', 'rg_submit_brief', 'rg_confirm_question', 'rg_request_operation', 'rg_confirm_operation',
  'rg_execute', 'rg_handoff', 'rg_recover', 'rg_cancel', 'rg_approve', 'rg_start', 'rg_wait'])
const id = z.string().min(1)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const callSchema = z.object({ callId: id, name: id, turn: count, step: count })
const dispatchSchema = z.object({ rootCallId: id, parentCallId: id, subCallId: id, name: id, arguments: z.json() })
const stateSchema = z.object({ inheritedEventCount: count, calls: z.array(callSchema), dispatches: z.array(dispatchSchema), observed: observationSchema.nullable() })
type FoldState = z.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { observedReviewGated: FoldState['observed'] }
  interface SessionProjectionStateMap { observedReviewGated: FoldState }
}

function summaryFrom(content: readonly ContentBlock[], name: string) {
  if (content.length !== 1 || content[0]?.type !== 'text') return null
  let value: unknown
  try { value = JSON.parse(content[0].text) } catch (error) { /* Non-JSON and spilled previews are not summary observations. */ return null }
  if (name === 'rg_start' || name === 'rg_wait') {
    const wrapped = z.object({ workflow: z.unknown() }).safeParse(value)
    return wrapped.success ? readSummary(wrapped.data.workflow) : null
  }
  return readSummary(value)
}

/** Existing Session events are the sole input; no journal subscription or domain mutation occurs. */
export const projection = {
  key: 'observedReviewGated', stateVersion: 2, stateSchema,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, calls: [], dispatches: [], observed: null }),
  apply(state, event: SessionEvent) {
    if (event.seq < state.inheritedEventCount) return state
    switch (event.type) {
      case 'tool/call': {
        if (!tools.has(event.data.name)) return state
        const parsed = callSchema.safeParse(event.data)
        if (!parsed.success || state.calls.some(c => c.callId === parsed.data.callId)) return state
        return { ...state, calls: [...state.calls, parsed.data] }
      }
      case 'tool/ptc-dispatch-start': {
        if (!tools.has(event.data.name)) return state
        const parsed = dispatchSchema.safeParse(event.data)
        if (!parsed.success || state.dispatches.some(d => d.subCallId === parsed.data.subCallId)) return state
        return { ...state, dispatches: [...state.dispatches, parsed.data] }
      }
      case 'tool/result': {
        const message = event.data.message
        const call = state.calls.find(c => c.callId === message.toolCallId && c.turn === event.data.turn && c.step === event.data.step)
        if (!call) return state
        const next = { ...state, calls: state.calls.filter(c => c !== call) }
        if (message.isError !== false || event.data.error !== undefined) return next
        const summary = summaryFrom(message.content, call.name)
        if (!summary) return next
        return { ...next, observed: { seq: event.seq, time: event.time, tool: call.name, callId: call.callId, transport: 'native', summary } }
      }
      case 'tool/ptc-dispatch': {
        const result = event.data
        const start = state.dispatches.find(d => d.subCallId === result.subCallId && d.rootCallId === result.rootCallId
          && d.parentCallId === result.parentCallId && d.name === result.name && JSON.stringify(d.arguments) === JSON.stringify(result.arguments))
        if (!start) return state
        const next = { ...state, dispatches: state.dispatches.filter(d => d !== start) }
        if (result.isError !== false || result.error !== undefined) return next
        const summary = summaryFrom(result.content, result.name)
        if (!summary) return next
        return { ...next, observed: { seq: event.seq, time: event.time, tool: result.name, callId: result.subCallId, transport: 'ptc', summary } }
      }
      case 'turn/end':
        return state.calls.length || state.dispatches.length ? { ...state, calls: [], dispatches: [] } : state
      default: return state // Session event families are merge-extensible.
    }
  },
  wire: { viewSchema: observationSchema.nullable(), view: state => state.observed },
} satisfies ProjectionDefinition<'observedReviewGated'>
