import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { brief } from '../fixtures/workflow.js'
import { journalSchema } from '../../src/storage/journal.js'
import { fixture, main, call, confirm } from '../fixtures/runtime.js'

describe('external plugin through the real YAML Loader', () => {
  it('shows non-executed compatibility advisories in status and actual approval detail without changing approved argv', async () => {
    const f = await fixture(undefined, undefined, true, { bundle: true }), ctx = await f.start(), root = await main(ctx, f.root)
    root.scoped.tools.presentAs('native')
    const requirements = { ...brief, verificationCommands: [
      { executable: 'node', args: ['--version'], timeoutMs: 60000 },
      { executable: 'node', args: ['--test', 'tests/export.test.js'], timeoutMs: 60000 },
      { executable: 'node', args: ['--test', '--test-isolation=none', 'tests/export.test.js'], timeoutMs: 60000 },
    ] }
    expect((await call(root.scoped, root.agent, 'rg_submit_brief', { brief: requirements })).isError).toBe(false)
    const status = await call(root.scoped, root.agent, 'rg_status', { detail: true })
    expect(status.isError).toBe(false)
    const warnings = process.platform === 'win32'
      ? [expect.objectContaining({ commandIndex: 1, kind: 'windows-node-test-piped-children', authority: 'platform-advisory', message: expect.stringContaining('revised brief and new human approval') })] : []
    expect(status.value).toMatchObject({ state: { phase: 'Awaiting Approval', brief: requirements, approval: null, verification: null, review: null },
      recordCount: 1, effectiveLimits: { verification: { compatibility: { platform: process.platform, backendCapability: 'unknown', preflightExecuted: false, warnings } } } })
    expect(JSON.stringify(status.content)).toContain('backendCapability')
    const compact = await call(root.scoped, root.agent, 'rg_status', {})
    expect(compact.isError).toBe(false)
    expect(compact.value).toMatchObject({ state: { phase: 'Awaiting Approval', brief: { id: requirements.id, revision: 1, commandCount: 3 }, approval: null }, operationEvidence: { request: null } })
    expect(JSON.stringify(compact.value)).not.toContain('verificationCommands')
    expect((await call(root.scoped, root.agent, 'rg_brief', {})).value).toEqual({ brief: requirements })
    let detail = ''
    ctx.on('user-questions/request', async request => {
      detail = request.questions[0]!.detail!
      expect(detail).toContain('Verification compatibility advisories (not executed checks)')
      expect(detail).toContain('"backendCapability": "unknown"')
      expect(detail).toContain('"preflightExecuted": false')
      if (process.platform === 'win32') {
        expect(detail).toContain('"commandIndex": 1')
        expect(detail).toContain('windows-node-test-piped-children')
        expect(detail).toContain('revised brief and new human approval')
        expect(detail).not.toContain('"commandIndex": 2')
      } else expect(detail).toContain('"warnings": []')
      return { answers: [{ id: request.questions[0]!.id, selected: ['Approve'] }] }
    })
    const approval = await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
    expect(approval.isError).toBe(false)
    expect(approval.value).toMatchObject({ needsConfirmation: true, state: { phase: 'Awaiting Approval', approval: null } })
    const question = ctx.reviewGatedJournals.controller(root.agent.session).state.questions!.at(-1)!
    const confirmation = await confirm(root.scoped, root.agent, question.id, 'Approve')
    expect(confirmation.result.isError).toBe(false)
    expect(detail).not.toBe('')
    const state = ctx.reviewGatedJournals.controller(root.agent.session).state
    expect(state.phase).toBe('Approved')
    expect(state.brief?.verificationCommands).toEqual(requirements.verificationCommands)
    expect(state.verification).toBeNull()
    expect(state.review).toBeNull()
  })
  it('restores a fresh Main that has not called a workflow tool yet', async () => {
    const f = await fixture(undefined, undefined, true, { bundle: true })
    const ctx = await f.start()
    const root = await main(ctx, f.root)
    await ctx.sessions.flush(root.agent.session)
    const id = root.agent.id
    await root.handle.dispose()
    const resumed = await main(ctx, f.root, id, 'review-gated', true)
    expect(resumed.agent.session.firstLiveSeq).toBeGreaterThan(0)
    resumed.scoped.tools.presentAs('native')
    const status = await call(resumed.scoped, resumed.agent, 'rg_status', {})
    expect(status.isError).not.toBe(true)
    expect(status.value).toMatchObject({ state: { phase: 'Clarifying' }, recordCount: 0 })
  })
  it('exposes scoped tools, waits for a human answer, and restores durable approval', async () => {
    const f = await fixture()
    const ctx = await f.start()
    const id = randomUUID()
    const root = await main(ctx, f.root, id)
    await ctx.agentPresets.select(root.agent, 'review-gated')
    await ctx.sessions.flush(root.agent.session)
    const submitted = await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    expect(submitted.isError).toBe(false)
    expect(JSON.stringify(submitted.content)).toContain('Awaiting Approval')
    expect(ctx.reviewGatedJournals.view(root.agent.session).state.approval).toBeNull()
    let shown = ''
    ctx.on('user-questions/request', async request => {
      shown = request.questions[0]!.detail!
      expect(shown).toContain(brief.goal)
      expect(shown).toContain('executionBudgetMs')
      return { answers: [{ id: request.questions[0]!.id, selected: ['Approve'] }] }
    })
    const pending = await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
    expect(pending.isError).toBe(false)
    expect(pending.value).toMatchObject({ needsConfirmation: true, state: { phase: 'Awaiting Approval', approval: null } })
    const question = ctx.reviewGatedJournals.controller(root.agent.session).state.questions!.at(-1)!
    const confirmation = await confirm(root.scoped, root.agent, question.id, 'Approve')
    expect(confirmation.result.isError).toBe(false)
    expect(JSON.stringify(confirmation.result.content)).toContain('Approved')
    const journal = JSON.parse(await readFile(join(f.root, 'storage', 'aaronwu_review_gated.json'), 'utf8'))
    expect(journal.tables.sessions[id].records).toHaveLength(4)
    expect(journal.tables.sessions[id].records.every((record: { version: number }) => record.version === 7)).toBe(true)
    expect(journalSchema.parse(journal.tables.sessions[id]).state.approval?.approved).toBe(true)
    const standard = await main(ctx, f.root, randomUUID(), 'standard')
    expect((await call(standard.scoped, standard.agent, 'rg_status', {})).isError).toBe(true)
    await ctx.fiber.dispose()
    const restarted = await f.start()
    const resumed = await main(restarted, f.root, id, 'review-gated', true)
    expect(restarted.reviewGatedJournals.view(resumed.agent.session).state.phase).toBe('Approved')
    expect((await call(resumed.scoped, resumed.agent, 'rg_status', {})).isError).toBe(false)
  })
  it('refuses an incomplete backup instead of resetting a restored workflow to Clarifying', async () => {
    const f = await fixture(), ctx = await f.start(), root = await main(ctx, f.root)
    await ctx.agentPresets.select(root.agent, 'review-gated')
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    await ctx.sessions.flush(root.agent.session)
    const id = root.agent.id
    await ctx.fiber.dispose()
    const path = join(f.root, 'storage', 'aaronwu_review_gated.json')
    const data = JSON.parse(await readFile(path, 'utf8'))
    delete data.tables.sessions[id]
    await writeFile(path, JSON.stringify(data))
    const restarted = await f.start()
    const resumed = await main(restarted, f.root, id, 'review-gated', true)
    const result = await call(resumed.scoped, resumed.agent, 'rg_status', {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('no authoritative workflow journal')
    expect((await call(resumed.scoped, resumed.agent, 'rg_submit_brief', { brief })).isError).toBe(true)
  })
  it('does not grant approval when the answerer is absent or the revision is stale', async () => {
    const f = await fixture(), ctx = await f.start(), root = await main(ctx, f.root)
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    expect((await call(root.scoped, root.agent, 'rg_approve', { revision: 2 })).isError).toBe(true)
    expect((await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })).isError).toBe(true)
    expect(ctx.reviewGatedJournals.view(root.agent.session).state.phase).toBe('Awaiting Approval')
    expect(ctx.reviewGatedJournals.view(root.agent.session).state.approval).toBeNull()
  })
  it('declines free text and human rejection rather than interpreting them as approval', async () => {
    const f = await fixture(), ctx = await f.start(), root = await main(ctx, f.root)
    ctx.on('user-questions/request', async request => ({ answers: [{ id: request.questions[0]!.id, selected: [], custom: 'Sounds good' }] }))
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    expect((await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })).isError).toBe(true)
    expect(ctx.reviewGatedJournals.view(root.agent.session).state.phase).toBe('Awaiting Approval')
    expect(ctx.reviewGatedJournals.view(root.agent.session).state.approval).toBeNull()
  })
  it('rejects storage overflow without publishing requirements', async () => {
    const f = await fixture(1024), ctx = await f.start(), root = await main(ctx, f.root)
    expect((await call(root.scoped, root.agent, 'rg_submit_brief', { brief })).isError).toBe(true)
    expect(ctx.reviewGatedJournals.view(root.agent.session).state.phase).toBe('Clarifying')
    expect(ctx.reviewGatedJournals.view(root.agent.session).recordCount).toBe(0)
  })
  it('publishes the durable state to observers at the storage commit point', async () => {
    const f = await fixture(), ctx = await f.start(), root = await main(ctx, f.root)
    const phases: string[] = []
    ctx.on('domain/changed', () => { phases.push(ctx.reviewGatedJournals.view(root.agent.session).state.phase) })
    ctx.on('user-questions/request', async request => ({ answers: [{ id: request.questions[0]!.id, selected: ['Approve'] }] }))
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    const pending = await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
    expect(pending.value).toMatchObject({ needsConfirmation: true, state: { phase: 'Awaiting Approval' } })
    const question = ctx.reviewGatedJournals.controller(root.agent.session).state.questions!.at(-1)!
    expect((await confirm(root.scoped, root.agent, question.id, 'Approve')).result.isError).toBe(false)
    expect(phases.at(-1)).toBe('Approved')
  })
  it('keeps the requirement revision stable while a human approval wait is active', async () => {
    const f = await fixture(), ctx = await f.start(), root = await main(ctx, f.root)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    ctx.on('user-questions/request', async request => {
      entered.resolve()
      await release.promise
      return { answers: [{ id: request.questions[0]!.id, selected: ['Approve'] }] }
    })
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    const pending = call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
    try {
      await entered.promise
      expect((await call(root.scoped, root.agent, 'rg_submit_brief', { brief: { ...brief, revision: 2 } })).isError).toBe(true)
      expect(ctx.reviewGatedJournals.view(root.agent.session).state.brief?.revision).toBe(1)
    } finally { release.resolve() }
    expect((await pending).isError).toBe(false)
  })
  it('cancels a human wait on journal shutdown and drains it before closing storage', async () => {
    const f = await fixture(), ctx = await f.start(), root = await main(ctx, f.root)
    const entered = Promise.withResolvers<void>()
    ctx.on('user-questions/request', request => new Promise((_accept, reject) => {
      const signal = request.signal!
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      entered.resolve()
    }))
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    const pending = call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
    await entered.promise
    const journals = ctx.reviewGatedJournals
    await journals.close()
    expect((await pending).isError).toBe(true)
    expect(() => journals.view(root.agent.session)).toThrow('closed')
    const data = JSON.parse(await readFile(join(f.root, 'storage', 'aaronwu_review_gated.json'), 'utf8'))
    expect(data.tables.sessions[root.agent.id].state.approval).toBeNull()
  })
  it('drains a pending approval when its Main Agent is disposed', async () => {
    const f = await fixture(), ctx = await f.start(), root = await main(ctx, f.root)
    const entered = Promise.withResolvers<void>()
    ctx.on('user-questions/request', request => new Promise((_accept, reject) => {
      request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true })
      entered.resolve()
    }))
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    const pending = call(root.scoped, root.agent, 'rg_approve', { revision: 1 })
    await entered.promise
    await root.handle.dispose()
    expect((await pending).isError).toBe(true)
    expect(ctx.reviewGatedJournals.view(root.agent.session).state.approval).toBeNull()
  })
  it('denies inherited Main tools to a child Agent', async () => {
    const f = await fixture(), ctx = await f.start(), root = await main(ctx, f.root)
    let scoped: Context | undefined
    const child = await ctx.agents.create({ sessionId: SessionId(randomUUID()), parentAgent: root.agent, meta: { cwd: f.root, origin: 'subagent' }, setup: async agentCtx => {
      scoped = agentCtx
      await ctx.agentPresets.mount(agentCtx, 'review-gated')
    } })
    if (!scoped) throw new Error('Child context missing')
    expect((await call(scoped, child.agent, 'rg_submit_brief', { brief })).isError).toBe(true)
    expect((await call(scoped, child.agent, 'rg_approve', { revision: 1 })).isError).toBe(true)
    expect(ctx.reviewGatedJournals.view(root.agent.session).state.approval).toBeNull()
    await child.dispose()
  })
  it('refuses a journal copied to a different Session identity', async () => {
    const f = await fixture(), ctx = await f.start(), root = await main(ctx, f.root)
    await call(root.scoped, root.agent, 'rg_submit_brief', { brief })
    const changed = { ...root.agent.session.header, createdAt: root.agent.session.header.createdAt + 1 }
    const { Session } = await import('@deepseek-ai/dsh-session')
    const wrong = Session.create(root.agent.id, [], changed)
    expect(() => ctx.reviewGatedJournals.view(wrong)).toThrow('another Session')
  })
  it('removes tools when a real Loader entry is unmounted while the Agent remains live', async () => {
    const f = await fixture(), ctx = await f.start(), root = await main(ctx, f.root, randomUUID(), 'standard')
    expect((await call(root.scoped, root.agent, 'rg_status', {})).isError).toBe(true)
    const entry = await ctx.loader.create({ name: new URL('../../dist/index.js', import.meta.url).href })
    expect((await call(root.scoped, root.agent, 'rg_status', {})).isError).toBe(false)
    await ctx.loader.remove(entry)
    expect(ctx.agents.get(root.agent.id)).toBe(root.agent)
    expect((await call(root.scoped, root.agent, 'rg_status', {})).isError).toBe(true)
  })
  it('rejects old scoped tool calls after their Agent is disposed', async () => {
    const f = await fixture(), ctx = await f.start(), root = await main(ctx, f.root)
    expect((await call(root.scoped, root.agent, 'rg_status', {})).isError).toBe(false)
    await root.handle.dispose()
    expect(ctx.agents.get(root.agent.id)).toBeUndefined()
    expect((await call(root.scoped, root.agent, 'rg_status', {})).isError).toBe(true)
  })
})
