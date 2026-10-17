import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { fixture, main, call } from '../fixtures/runtime.js'
import { brief } from '../fixtures/workflow.js'
import { journalSchema } from '../../src/storage/journal.js'

/** Real shipped YAML patch, persisted Session logs, and private storage across Loader restarts. */
describe('blank Session Review-Gated selection lifecycle', () => {
  it.each(['standard', 'ptc'])('initializes a never-managed metadata-only %s Session after restart before its first turn', async preset => {
    const f = await fixture(undefined, undefined, true, { bundle: true, ordinaryPtc: true, mainPtcSimulation: true })
    const ctx = await f.start()
    const root = await main(ctx, f.root, undefined, preset)
    setSandboxMode(root.agent.session, 'workspace-write')
    await ctx.agentPresets.select(root.agent, preset === 'standard' ? 'ptc' : 'standard')
    await ctx.agentPresets.select(root.agent, preset)
    const id = root.agent.id
    await ctx.sessions.flush(root.agent.session)
    await ctx.fiber.dispose()
    const restarted = await f.start()
    const restored = await main(restarted, f.root, id, preset, true, { provider: 'scripted', model: 'fixture' })
    expect(restored.agent.session.firstLiveSeq).toBeGreaterThan(0)
    expect(restored.agent.session.header.isSeeded).not.toBe(true)
    expect(restarted.reviewGatedPermissions.of(restored.agent.session)).toBeUndefined()
    await restarted.agentPresets.select(restored.agent, 'review-gated')
    let requests = 0
    const errors: unknown[] = []
    restarted.on('agent/error', ({ error }) => { errors.push(error) })
    restarted.llm.registerAdapter(['scripted'], new class extends LlmAdapter {
      override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        requests++
        if (requests === 1) {
          const data = JSON.parse(await readFile(join(f.root, 'storage', 'aaronwu_review_gated.json'), 'utf8'))
          expect(journalSchema.parse(data.tables.sessions[id]).records).toEqual([])
          expect(restarted.reviewGatedJournals.view(restored.agent.session)).toMatchObject({ state: { phase: 'Clarifying', approval: null }, recordCount: 0 })
          expect(request.tools?.map(tool => tool.name)).toEqual(['run_code'])
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('restored-initial-status'), name: 'run_code', arguments: JSON.stringify({ code: 'console.log((await tools.rg_status({})).state.phase)', description: 'Read the restored blank workflow phase' }) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        const result = request.messages.findLast(message => message.role === 'tool')
        expect(result?.role === 'tool' && result.isError).not.toBe(true)
        expect(JSON.stringify(result)).toContain('Clarifying')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Clarifying' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    restored.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the initial workflow phase only' }] }))
    await restored.agent.whenIdle()
    expect(errors).toEqual([])
    expect(requests).toBe(2)
  })

  it.each(['standard', 'ptc'])('releases Main on same-Agent switch to %s and retains its journal across switch-back and restart', async preset => {
    const f = await fixture(undefined, undefined, false, { bundle: true, ordinaryPtc: true })
    const ctx = await f.start()
    const root = await main(ctx, f.root, undefined, preset)
    setSandboxMode(root.agent.session, 'workspace-write')
    await ctx.agentPresets.select(root.agent, 'review-gated')
    await ctx.reviewGatedJournals.initialize(root.agent.session)
    const grant = ctx.reviewGatedPermissions.of(root.agent.session)!
    expect(grant.role).toBe('main')
    root.scoped.tools.presentAs('native')
    expect((await call(root.scoped, root.agent, 'rg_submit_brief', { brief })).isError).not.toBe(true)
    await ctx.agentPresets.select(root.agent, preset)
    expect(ctx.reviewGatedPermissions.of(root.agent.session) !== undefined).toBe(false)
    expect(ctx.reviewGatedPermissions.byId(root.agent.id) !== undefined).toBe(false)
    expect(() => ctx.reviewGatedPermissions.require(grant.policy)).toThrow('requires an admitted role')
    expect(ctx.sandboxPolicy.resolve({ session: root.agent.session }).mode).toBe('workspace-write')
    expect(ctx.sandboxPolicy.overrideOf(root.agent.session)).toBe('workspace-write')
    expect((await call(root.scoped, root.agent, 'rg_status', {})).isError).toBe(true)
    expect(ctx.reviewGatedJournals.view(root.agent.session)).toMatchObject({ state: { phase: 'Awaiting Approval', approval: null }, recordCount: 1 })
    await ctx.agentPresets.select(root.agent, 'review-gated')
    expect(ctx.reviewGatedPermissions.of(root.agent.session)).not.toBe(grant)
    // A stale preset disposer cannot revoke a later admission.
    ctx.reviewGatedPermissions.release(grant)
    expect(ctx.reviewGatedPermissions.of(root.agent.session)?.role).toBe('main')
    expect(ctx.sandboxPolicy.resolve({ session: root.agent.session }).mode).toBe('read-only')
    await ctx.agentPresets.select(root.agent, preset)
    const id = root.agent.id
    await ctx.sessions.flush(root.agent.session)
    await ctx.fiber.dispose()
    const restarted = await f.start()
    const restored = await main(restarted, f.root, id, preset, true)
    expect(restarted.reviewGatedPermissions.of(restored.agent.session)).toBeUndefined()
    expect(restarted.sandboxPolicy.resolve({ session: restored.agent.session }).mode).toBe('workspace-write')
    await restarted.agentPresets.select(restored.agent, 'review-gated')
    expect(restarted.reviewGatedJournals.view(restored.agent.session)).toMatchObject({ state: { phase: 'Awaiting Approval', approval: null }, recordCount: 1 })
    await restarted.agentPresets.select(restored.agent, preset)
    expect(restarted.reviewGatedPermissions.of(restored.agent.session)).toBeUndefined()
    expect(restarted.sandboxPolicy.resolve({ session: restored.agent.session }).mode).toBe('workspace-write')
    restored.scoped.tools.presentAs('ptc')
    const path = join(f.root, 'ordinary-after-release.txt')
    const result = await call(restored.scoped, restored.agent, 'run_code', {
      code: 'const fs = await import("node:fs/promises");await fs.writeFile(' + JSON.stringify(path) + ', "ordinary after release");console.log("ordinary ok")',
      description: 'Write only the private released fixture',
    })
    expect(result.isError).not.toBe(true)
    expect(await readFile(path, 'utf8')).toBe('ordinary after release')
  })

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('does not replace a later explicit %s mode on switch-away', async mode => {
    const f = await fixture(undefined, undefined, true, { bundle: true })
    const ctx = await f.start()
    const root = await main(ctx, f.root, undefined, 'standard')
    await ctx.agentPresets.select(root.agent, 'review-gated')
    setSandboxMode(root.agent.session, mode)
    await ctx.agentPresets.select(root.agent, 'standard')
    expect(ctx.reviewGatedPermissions.of(root.agent.session) !== undefined).toBe(false)
    expect(ctx.sandboxPolicy.overrideOf(root.agent.session)).toBe(mode)
    await ctx.sessions.flush(root.agent.session)
    const id = root.agent.id
    await ctx.fiber.dispose()
    const restarted = await f.start()
    const restored = await main(restarted, f.root, id, 'standard', true)
    expect(restarted.sandboxPolicy.overrideOf(restored.agent.session)).toBe(mode)
  })

  it.each(['review-gated', 'standard'])('refuses a missing blank managed journal after restart from %s', async preset => {
    const f = await fixture(undefined, undefined, true, { bundle: true })
    const ctx = await f.start()
    const root = await main(ctx, f.root, undefined, preset)
    if (preset === 'standard') {
      await ctx.agentPresets.select(root.agent, 'review-gated')
      await ctx.reviewGatedJournals.initialize(root.agent.session)
      await ctx.agentPresets.select(root.agent, 'standard')
    }
    const id = root.agent.id
    await ctx.sessions.flush(root.agent.session)
    await ctx.fiber.dispose()
    const path = join(f.root, 'storage', 'aaronwu_review_gated.json')
    const data = JSON.parse(await readFile(path, 'utf8'))
    delete data.tables.sessions[id]
    await writeFile(path, JSON.stringify(data))
    const restarted = await f.start()
    const restored = await main(restarted, f.root, id, preset, true, { provider: 'scripted', model: 'fixture' })
    if (preset === 'standard') await restarted.agentPresets.select(restored.agent, 'review-gated')
    restored.scoped.tools.presentAs('native')
    expect(() => restarted.reviewGatedJournals.view(restored.agent.session)).toThrow('no authoritative workflow journal')
    expect((await call(restored.scoped, restored.agent, 'rg_status', {})).isError).toBe(true)
    expect((await call(restored.scoped, restored.agent, 'rg_submit_brief', { brief })).isError).toBe(true)
    let requests = 0
    const errors: unknown[] = []
    restarted.on('agent/error', ({ error }) => { errors.push(error) })
    restarted.llm.registerAdapter(['scripted'], new class extends LlmAdapter {
      override async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
        requests++
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    restored.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the missing workflow phase' }] }))
    await restored.agent.whenIdle()
    expect(requests).toBe(0)
    expect(errors).toEqual([expect.objectContaining({ message: expect.stringContaining('no authoritative workflow journal') })])
    expect((JSON.parse(await readFile(path, 'utf8'))).tables.sessions[id]).toBeUndefined()
  })

  it('restores the captured policy through a graceful managed restart before switching away', async () => {
    const f = await fixture(undefined, undefined, true, { bundle: true, ordinaryPtc: true })
    const ctx = await f.start()
    const root = await main(ctx, f.root, undefined, 'ptc')
    setSandboxMode(root.agent.session, 'workspace-write')
    await ctx.agentPresets.select(root.agent, 'review-gated')
    await ctx.reviewGatedJournals.initialize(root.agent.session)
    const id = root.agent.id
    await ctx.fiber.dispose()
    const restarted = await f.start()
    const restored = await main(restarted, f.root, id, 'review-gated', true)
    expect(restarted.sandboxPolicy.overrideOf(restored.agent.session)).toBe('read-only')
    await restarted.agentPresets.select(restored.agent, 'ptc')
    expect(restarted.reviewGatedPermissions.of(restored.agent.session)).toBeUndefined()
    expect(restarted.sandboxPolicy.overrideOf(restored.agent.session)).toBe('workspace-write')
    expect(restarted.reviewGatedJournals.view(restored.agent.session).recordCount).toBe(0)
  })

  it('refuses a seeded blank Session without its own journal', async () => {
    const f = await fixture(undefined, undefined, true, { bundle: true })
    const ctx = await f.start()
    const handle = await ctx.agents.create({
      sessionId: SessionId('seeded-blank-fixture'),
      meta: { cwd: f.root, agentPreset: 'standard', isSeeded: true }, inheritedEventCount: SessionLogOffset(0), seed: [],
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'standard') },
    })
    await ctx.agentPresets.select(handle.agent, 'review-gated')
    expect(() => ctx.reviewGatedJournals.view(handle.agent.session)).toThrow('no authoritative workflow journal')
    handle.agent.ctx.tools.presentAs('native')
    expect((await call(handle.agent.ctx, handle.agent, 'rg_status', {})).isError).toBe(true)
  })

  it('refuses a corrupted journal after restart rather than replacing it', async () => {
    const f = await fixture(undefined, undefined, true, { bundle: true })
    const ctx = await f.start()
    const root = await main(ctx, f.root)
    const id = root.agent.id
    await ctx.fiber.dispose()
    const path = join(f.root, 'storage', 'aaronwu_review_gated.json')
    const data = JSON.parse(await readFile(path, 'utf8'))
    data.tables.sessions[id].state.phase = 'Approved'
    const corrupted = JSON.stringify(data)
    await writeFile(path, corrupted)
    await expect(f.start()).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(corrupted)
  })

  it('releases only its owned admission when the guard fiber unloads while the Agent stays live', async () => {
    const f = await fixture(undefined, undefined, true, { bundle: true })
    const ctx = await f.start()
    const root = await main(ctx, f.root)
    const other = await main(ctx, f.root)
    const guard = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
      .find(fiber => fiber.entry?.options.id === 'role-guard' && fiber.config.role === 'main')!
    await guard.dispose()
    expect(ctx.agents.get(root.agent.id)).toBe(root.agent)
    expect(ctx.reviewGatedPermissions.of(root.agent.session) !== undefined).toBe(false)
    expect(ctx.reviewGatedPermissions.of(other.agent.session)).toBeUndefined()
    expect(ctx.sandboxPolicy.overrideOf(root.agent.session)).toBe('danger-full-access')
    expect(ctx.sandboxPolicy.overrideOf(other.agent.session)).toBe('danger-full-access')
    expect(ctx.reviewGatedJournals.view(root.agent.session).recordCount).toBe(0)
  })

  it('releases the grant and restores its captured mode on Agent teardown without erasing the journal', async () => {
    const f = await fixture(undefined, undefined, true, { bundle: true })
    const ctx = await f.start()
    const root = await main(ctx, f.root, undefined, 'standard')
    await ctx.agentPresets.select(root.agent, 'review-gated')
    await ctx.reviewGatedJournals.initialize(root.agent.session)
    await root.handle.dispose()
    expect(ctx.reviewGatedPermissions.of(root.agent.session) !== undefined).toBe(false)
    expect(ctx.sandboxPolicy.overrideOf(root.agent.session)).toBe('danger-full-access')
    expect(ctx.reviewGatedJournals.view(root.agent.session).recordCount).toBe(0)
  })
})
