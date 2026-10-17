import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { observationSchema } from '../src/summary.ts'
export const tree = 'a'.repeat(40)
export function summary(phase = 'Approved') {
  return { recordCount: 4, state: { phase,
    brief: { id: 'brief-1', revision: 2, goal: 'Deliver approved task', executionBudgetMs: 1000, maxRepairRounds: 3 },
    approval: { questionId: 'approval-1', revision: 2, approved: true },
    snapshot: { id: 'snapshot-1', briefRevision: 2, treeId: tree, baseCommit: 'b'.repeat(40) },
    verification: { snapshotId: 'snapshot-1', treeId: tree, checkCount: 2, passedCount: 1 },
    review: null, activeRunId: 'not-discovered', repairRounds: 1, executionMs: 100, executionWallMs: 200, pauseReason: null } }
}
export function observation(value = summary()) { return observationSchema.parse({ seq: 2, time: 100, tool: 'rg_status', callId: 'call-1', transport: 'native', summary: value }) }
export function call(seq = 1, name = 'rg_status', callId = 'call-1'): SessionEvent<'tool/call'> {
  return { type: 'tool/call', seq: SessionSeq(seq), time: seq, data: { turn: 1, step: 1, name, callId: ToolCallId(callId), arguments: '{}' } }
}
export function result(value: unknown = summary(), options: { seq?: number; isError?: boolean; callId?: string; step?: number; text?: string } = {}): SessionEvent<'tool/result'> {
  const seq = options.seq ?? 2
  return { type: 'tool/result', seq: SessionSeq(seq), time: seq, surfaceOp: 'append', data: { turn: 1, step: options.step ?? 1,
    message: createToolResultMessage({ callId: ToolCallId(options.callId ?? 'call-1'), content: [{ type: 'text', text: options.text ?? JSON.stringify(value) }], isError: options.isError ?? false }) } }
}
export function ptcStart(seq = 1): SessionEvent<'tool/ptc-dispatch-start'> {
  return { type: 'tool/ptc-dispatch-start', seq: SessionSeq(seq), time: seq, data: { rootCallId: ToolCallId('root'), parentCallId: ToolCallId('root'), subCallId: ToolCallId('sub'), name: 'rg_wait', arguments: { id: 'task' } } }
}
export function ptcEnd(value: unknown = summary(), seq = 2): SessionEvent<'tool/ptc-dispatch'> {
  return { type: 'tool/ptc-dispatch', seq: SessionSeq(seq), time: seq, data: { ...ptcStart().data, isError: false, content: [{ type: 'text', text: JSON.stringify({ workflow: value }) }] } }
}
