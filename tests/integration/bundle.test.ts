import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { fixture, main, call } from '../fixtures/runtime.js'

/** Real standalone patch through the Loader; native Windows confinement remains the deployment backend. */
describe('standalone shipped bundle patch', () => {
  it('refuses managed tools and model requests in an unmapped remote workspace while ordinary sessions remain usable', async () => {
    const f = await fixture(undefined, undefined, true, { bundle: true, routedWorkspace: true })
    const ctx = await f.start()
    let requests = 0
    ctx.llm.registerAdapter(['scripted'], new class extends LlmAdapter {
      override async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
        requests++
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    await expect(main(ctx, f.root, undefined, 'review-gated', false, { provider: 'scripted', model: 'fixture' })).rejects.toThrow('requires a local workspace')
    expect(requests).toBe(0)
    const ordinary = await main(ctx, f.root, undefined, 'standard', false, { provider: 'scripted', model: 'fixture' })
    ordinary.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ordinary task' }] }))
    await ordinary.agent.whenIdle()
    expect(requests).toBe(1)
  })
  it('admits a blank GUI-style preset switch and returns Clarifying through actual Node PTC', async () => {
    const f = await fixture(undefined, undefined, true, { bundle: true, mainPtcSimulation: true })
    const ctx = await f.start()
    const root = await main(ctx, f.root, undefined, 'standard', false, { provider: 'scripted', model: 'fixture' })
    let requests = 0
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    ctx.llm.registerAdapter(['scripted'], new class extends LlmAdapter {
      override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        requests++
        if (requests === 1) {
          expect(request.tools?.map(tool => tool.name)).toEqual(['run_code'])
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('fixture-status'), name: 'run_code', arguments: JSON.stringify({ code: 'console.log((await tools.rg_status({})).state.phase)', description: 'Read only the initial workflow phase' }) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        const tool = request.messages.findLast(message => message.role === 'tool')
        expect(tool?.role === 'tool' && tool.isError).not.toBe(true)
        expect(JSON.stringify(tool)).toContain('Clarifying')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Clarifying' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    await ctx.agentPresets.select(root.agent, 'review-gated')
    expect(ctx.reviewGatedPermissions.of(root.agent.session)?.role).toBe('main')
    expect(ctx.sandboxPolicy.resolve({ session: root.agent.session }).mode).toBe('read-only')
    root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Return the initial phase only' }] }))
    await root.agent.whenIdle()
    expect(errors).toEqual([])
    expect(requests).toBe(2)
    expect(root.agent.session.deriveMessages().at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Clarifying' }] })
    await root.handle.dispose()
    const resumed = await main(ctx, f.root, root.agent.id, 'review-gated', true)
    expect(ctx.reviewGatedJournals.view(resumed.agent.session).state.phase).toBe('Clarifying')
  })
  it('keeps an unmanaged Session on its original backend and file policy', async () => {
    const f = await fixture(undefined, undefined, false, { bundle: true })
    const ctx = await f.start()
    const ordinary = await main(ctx, f.root, undefined, 'standard')
    ordinary.scoped.tools.presentAs('ptc')
    const path = join(f.root, 'ordinary.txt')
    const result = await call(ordinary.scoped, ordinary.agent, 'run_code', {
      code: 'const fs = await import("node:fs/promises");await fs.writeFile(' + JSON.stringify(path) + ', "ordinary preserved");console.log("ordinary ok")',
      description: 'Write only the private ordinary fixture',
    })
    expect(result.isError).not.toBe(true)
    expect(await readFile(path, 'utf8')).toBe('ordinary preserved')
    expect(ctx.reviewGatedPermissions.of(ordinary.agent.session)).toBeUndefined()
  })
  it('refuses an unavailable native backend before Main makes a model request', async () => {
    const f = await fixture(undefined, undefined, true, { bundle: true, unavailable: 'all' })
    const ctx = await f.start()
    let calls = 0
    ctx.llm.registerAdapter(['scripted'], new class extends LlmAdapter {
      override async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
        calls++
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const root = await main(ctx, f.root, undefined, 'review-gated', false, { provider: 'scripted', model: 'fixture' })
    root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run this workflow' }] }))
    await root.agent.whenIdle()
    expect(calls).toBe(0)
    expect(ctx.reviewGatedJournals.view(root.agent.session).state.phase).toBe('Clarifying')
  })
  it('removes declared presets and their scoped tools when real Loader declarations are unmounted', async () => {
    const f = await fixture(undefined, undefined, false, { bundle: true })
    const ctx = await f.start()
    const root = await main(ctx, f.root)
    root.scoped.tools.presentAs('native')
    const caller = root.scoped
    await root.handle.dispose()
    for (const id of ['preset-review-gated', 'preset-review-gated-implementation', 'preset-review-gated-review', 'preset-review-gated-diagnostic']) {
      const entry = [...ctx.loader.entries()].find(entry => entry.options.id === id)
      if (!entry) throw new Error('Missing shipped preset declaration ' + id)
      if (!entry.fiber) throw new Error('Preset declaration has no active fiber')
      await entry.fiber.dispose()
    }
    expect((await ctx.agentPresets.list()).map(preset => preset.id)).toEqual(['standard'])
    expect(caller.tools.get('rg_status')).toBeUndefined()
    await expect(main(ctx, f.root)).rejects.toThrow()
  })
  it('loads four isolated managed presets without changing the default or existing declarations', async () => {
    const f = await fixture(undefined, undefined, false, { bundle: true })
    const ctx = await f.start()
    const roster = await ctx.agentPresets.list()
    expect(ctx.agentPresets.defaultId).toBe('standard')
    expect(roster.map(preset => preset.broken)).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect((await ctx.agentPresets.remoteExportList()).presets.map(preset => preset.id)).toEqual(['standard', 'review-gated'])
    expect((await ctx.agentPresets.readDocument('standard')).agentPreset).toBe('standard')
    expect(roster.map(preset => preset.id)).toEqual(['standard', 'review-gated', 'review-gated-implementation', 'review-gated-review', 'review-gated-diagnostic'])
    expect(ctx.get('reviewGatedExecution')).toBeDefined()
    expect([...ctx.loader.entries()].find(entry => entry.options.id === 'ptc-runtime')?.options.disabled).toBe(false)
    expect(ctx.get('ptcRuntime')).toBeDefined()
    const root = await main(ctx, f.root)
    root.scoped.tools.presentAs('native')
    expect((await call(root.scoped, root.agent, 'rg_status', {})).value).toMatchObject({ state: { phase: 'Clarifying' } })
    await expect(main(ctx, f.root, undefined, 'review-gated-implementation')).rejects.toThrow()
    await expect(main(ctx, f.root, undefined, 'review-gated-review')).rejects.toThrow()
    await expect(main(ctx, f.root, undefined, 'review-gated-diagnostic')).rejects.toThrow()
  })
})
