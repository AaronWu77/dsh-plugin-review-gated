/** Actual Node PTC/AgentLoop summary recording consumed by the optional built UI projection. */
import { expect, it } from 'vitest'
import { z } from 'zod'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { fixture, main } from '../fixtures/runtime.js'
import { brief } from '../fixtures/workflow.js'

it('projects actual Main SDK results without treating requirements submission as completion', async () => {
  const f = await fixture(undefined, undefined, true, { bundle: true, mainPtcSimulation: true, observedUi: true })
  const ctx = await f.start()
  const root = await main(ctx, f.root, undefined, 'review-gated', false, { provider: 'scripted', model: 'fixture' })
  let calls = 0
  ctx.llm.registerAdapter(['scripted'], new class extends LlmAdapter {
    override async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
      if (++calls === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('observed-main'), name: 'run_code', arguments: JSON.stringify({
          code: 'await tools.rg_submit_brief({brief:' + JSON.stringify(brief) + '});return await tools.rg_status({})',
          description: 'Submit exact fixture requirements and observe pending approval',
        }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Awaiting the user decision; no implementation or handoff has started.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }())
  root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare the fixture brief only.' }] }))
  await root.agent.whenIdle()
  expect(calls).toBe(2)
  const projection = z.object({ observedReviewGated: z.object({ tool: z.literal('rg_status'), transport: z.literal('ptc'),
    summary: z.object({ state: z.object({ phase: z.literal('Awaiting Approval'), approval: z.null(), activeRunId: z.null(), repairRounds: z.literal(0) }), recordCount: z.literal(1) }) }) })
  projection.parse(ctx.sessionProjections.snapshot(root.agent.session).values)
  expect(ctx.reviewGatedJournals.view(root.agent.session).state.phase).toBe('Awaiting Approval')
  expect(root.agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch').map(event => event.data.name)).toEqual(['rg_submit_brief', 'rg_status'])
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'observed-review-ui')
  if (!entry?.fiber) throw new Error('Missing optional UI Loader entry')
  const fiber = entry.fiber
  await entry.update({ disabled: true })
  await fiber.dispose()
  await ctx.loader.await()
  expect(Object.hasOwn(ctx.sessionProjections.snapshot(root.agent.session).values, 'observedReviewGated')).toBe(false)
  expect(ctx.reviewGatedJournals.view(root.agent.session).state.phase).toBe('Awaiting Approval')
})
