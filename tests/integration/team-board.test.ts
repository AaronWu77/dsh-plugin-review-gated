/** Advisory Teams task operations through real YAML Loader; no managed-role team membership. */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { fixture, main, call } from '../fixtures/runtime.js'
import type {} from '../../src/collaboration/team-board.js'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'

function value(result: Awaited<ReturnType<typeof call>>) {
  if (result.isError) throw new Error(JSON.stringify(result.content))
  const block = result.content.find(item => item.type === 'text')
  if (!block || block.type !== 'text') throw new Error('Missing board output')
  return JSON.parse(block.text) as { advisory: boolean; detailsOmitted?: boolean; data: { id: string; revision: number; status: string } }
}

describe('opt-in advisory Team board', () => {
  it('does not register when disabled and refuses explicitly enabled missing service', async () => {
    const disabled = await fixture(undefined, 'main', true), ctx = await disabled.start(), root = await main(ctx, disabled.root)
    expect(root.scoped.tools.get('rg_team_board', root.agent)).toBeUndefined()
    const missing = await fixture(undefined, 'main', true, { teamBoard: true }), other = await missing.start()
    await expect(main(other, missing.root)).rejects.toThrow(/agentTeams|advisory-board/)
  })
  it('coordinates tasks with revision CAS without changing workflow authority', async () => {
    const f = await fixture(undefined, 'main', true, { teamBoard: true, teamService: true }), ctx = await f.start(), root = await main(ctx, f.root)
    const before = ctx.reviewGatedJournals.view(root.agent.session)
    root.scoped.tools.presentAs('native')
    const created = value(await call(root.scoped, root.agent, 'rg_team_board', { operation: 'create', subject: 'Inspect candidate A', description: 'Advisory only; exact review evidence stays in the workflow journal' }))
    expect(created.advisory).toBe(true)
    const claimed = value(await call(root.scoped, root.agent, 'rg_team_board', { operation: 'update', taskId: created.data.id, expectedRevision: 1, action: 'claim' }))
    expect(claimed.data.revision).toBe(2)
    const stale = await call(root.scoped, root.agent, 'rg_team_board', { operation: 'update', taskId: created.data.id, expectedRevision: 1, action: 'complete' })
    expect(stale.isError).toBe(true)
    const completed = value(await call(root.scoped, root.agent, 'rg_team_board', { operation: 'update', taskId: created.data.id, expectedRevision: 2, action: 'complete' }))
    expect(completed.data.status).toBe('completed')
    expect(ctx.reviewGatedJournals.view(root.agent.session)).toEqual(before)
    expect(ctx.agentTeams.listMembers(root.agent)).toHaveLength(1)
    expect(ctx.subagents.list()).toEqual(['review-gated-managed'])
    await root.handle.dispose()
    const saved = await ctx.sessionPersistence.open(root.agent.id, 'read')
    try { expect((await saved.read()).events.filter(event => event.type === 'team/task')).toHaveLength(3) }
    finally { await saved.close() }
  })
  it('unregisters advisory tools with their actual Loader fiber without erasing durable tasks', async () => {
    const f = await fixture(undefined, 'main', true, { teamService: true }), ctx = await f.start(), root = await main(ctx, f.root)
    await ctx.loader.create({ name: new URL('../../dist/collaboration/team-board.js', import.meta.url).href })
    await ctx.loader.await()
    root.scoped.tools.presentAs('native')
    value(await call(root.scoped, root.agent, 'rg_team_board', { operation: 'create', subject: 'Retained', description: 'Advisory lifecycle fixture' }))
    const row = [...ctx.loader.entries()].find(entry => entry.options.name === new URL('../../dist/collaboration/team-board.js', import.meta.url).href)
    if (!row?.fiber) throw new Error('Missing root Loader advisory entry')
    const fiber = row.fiber
    await row.update({ disabled: true })
    await fiber.dispose()
    await ctx.loader.await()
    expect(ctx.tools.get('rg_team_board', root.agent)).toBeUndefined()
    expect(ctx.agentTeams.listTasks(root.agent)).toHaveLength(1)
  })
  it('withdraws board capability when its Team service disappears', async () => {
    const f = await fixture(undefined, 'main', true, { teamBoard: true, teamService: true }), ctx = await f.start(), root = await main(ctx, f.root)
    expect(ctx.tools.get('rg_team_board', root.agent)).toBeDefined()
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'agent-team')
    if (!row?.fiber) throw new Error('Missing Team service row')
    const fiber = row.fiber
    await row.update({ disabled: true })
    await fiber.dispose()
    await ctx.loader.await()
    expect(ctx.tools.get('rg_team_board', root.agent)).toBeUndefined()
    expect(ctx.reviewGatedJournals.view(root.agent.session).state.phase).toBe('Clarifying')
  })
  it('returns bounded committed identity rather than reporting a mutation failure on oversized details', async () => {
    const f = await fixture(undefined, 'main', true, { teamBoard: true, teamService: true, boardBytes: 1024 }), ctx = await f.start(), root = await main(ctx, f.root)
    root.scoped.tools.presentAs('native')
    const created = value(await call(root.scoped, root.agent, 'rg_team_board', { operation: 'create', subject: 'Bounded', description: '测'.repeat(1600) }))
    expect(created.detailsOmitted).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(created))).toBeLessThan(1024)
    expect(ctx.agentTeams.listTasks(root.agent)).toHaveLength(1)
    const tooLarge = await call(root.scoped, root.agent, 'rg_team_board', { operation: 'get', taskId: created.data.id })
    expect(tooLarge.isError).toBe(true)
    const committed = value(await call(root.scoped, root.agent, 'rg_team_board', { operation: 'update', taskId: created.data.id, expectedRevision: 1, action: 'claim' }))
    expect(committed.detailsOmitted).toBe(true)
    expect(committed.data.revision).toBe(2)
  })
  it('denies role children, changed policy and unsupported peer or assignment operations', async () => {
    const f = await fixture(undefined, 'main', true, { teamBoard: true, teamService: true }), ctx = await f.start(), root = await main(ctx, f.root)
    const board = root.scoped.tools.get('rg_team_board', root.agent)
    if (!board) throw new Error('Missing board tool')
    root.scoped.tools.presentAs('native')
    const forbidden = await call(root.scoped, root.agent, 'rg_team_board', { operation: 'update', taskId: '1', expectedRevision: 1, action: 'reassign', owner: 'reviewer' })
    expect(forbidden.isError).toBe(true)
    for (const role of ['implementation', 'review', 'diagnostic'] as const) {
      const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), parentAgent: root.agent, meta: { cwd: f.root }, setup: async (childCtx, child) => {
        ctx.reviewGatedPermissions.authorize(child, role)
        await ctx.agentPresets.mount(childCtx, 'review-gated-' + role)
      } })
      try {
        handle.agent.ctx.tools.register(board)
        handle.agent.ctx.tools.presentAs('native')
        const denied = await call(handle.agent.ctx, handle.agent, 'rg_team_board', { operation: 'list' })
        expect(denied.isError).toBe(true)
      } finally { await handle.dispose() }
    }
    setSandboxMode(root.agent.session, 'danger-full-access')
    expect((await call(root.scoped, root.agent, 'rg_team_board', { operation: 'list' })).isError).toBe(true)
    expect(ctx.agentTeams.listTasks(root.agent)).toEqual([])
  })
})
