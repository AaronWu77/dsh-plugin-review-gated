import { describe, expect, it } from 'vitest'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '../../src/security/permissions.js'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import { fixture, main, call } from '../fixtures/runtime.js'

describe('native Review-Gated role confinement through YAML presets', () => {
  it('fixes Main read-only authority even in a danger-full-access deployment', async () => {
    const f = await fixture(undefined, 'main'), ctx = await f.start(), root = await main(ctx, f.root)
    expect(ctx.reviewGatedPermissions.of(root.agent.session)?.policy.mode).toBe('read-only')
    expect(ctx.sandboxPolicy.resolve({ session: root.agent.session }).mode).toBe('read-only')
    const runtime = ctx.ptcRuntime
    expect(runtime.language).toBe('typescript')
    const path = join(f.root, 'forbidden.txt')
    const result = await call(root.scoped, root.agent, 'run_code', {
      code: 'await (await import("node:fs/promises")).writeFile(' + JSON.stringify(path) + ', "forbidden"); return "wrote"',
      description: 'Attempt direct native workspace write under Main policy',
    })
    expect(result.isError).toBe(true)
    await expect(access(path)).rejects.toThrow()
    if (process.platform === 'win32') {
      expect(JSON.stringify(result.content)).toContain('enforcement: partial')
      expect(JSON.stringify(result.content)).toMatch(/EACCES|EPERM/)
    }
    const standard = await main(ctx, f.root, randomUUID(), 'standard')
    expect(ctx.reviewGatedPermissions.of(standard.agent.session)).toBeUndefined()
    expect(ctx.sandboxPolicy.resolve({ session: standard.agent.session }).mode).toBe('danger-full-access')
  })
  it('keeps ordinary PTC calls on the unmodified deployment policy', async () => {
    const f = await fixture(undefined, 'main'), ctx = await f.start(), root = await main(ctx, f.root, randomUUID(), 'standard')
    root.scoped.tools.presentAs('ptc')
    const path = join(f.root, 'ordinary.txt')
    const result = await call(root.scoped, root.agent, 'run_code', {
      code: 'await (await import("node:fs/promises")).writeFile(' + JSON.stringify(path) + ', "ordinary"); return 42',
      description: 'Write ordinary fixture under the existing deployment policy',
    })
    expect(result.isError).toBe(false)
    await expect(access(path)).resolves.toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('42')
  })
  it('denies escalation and refuses a later mode change through the executor', async () => {
    const f = await fixture(undefined, 'main'), ctx = await f.start(), root = await main(ctx, f.root)
    const code = { code: 'return 1', description: 'Read current status through a native PTC program' }
    const wider = await call(root.scoped, root.agent, 'run_code', { ...code, sandbox_permissions: 'workspace-write', justification: 'write' })
    expect(wider.isError).toBe(true)
    expect(JSON.stringify(wider.content)).toContain('cannot request')
    setSandboxMode(root.agent.session, 'danger-full-access')
    const changed = await call(root.scoped, root.agent, 'run_code', code)
    expect(changed.isError).toBe(true)
    expect(JSON.stringify(changed.content)).toContain('policy changed')
  })
  it('rejects an unmanaged Review root before publication', async () => {
    const f = await fixture(undefined, 'review'), ctx = await f.start()
    await expect(main(ctx, f.root)).rejects.toThrow('host-managed admission')
    expect(ctx.agents.roots()).toEqual([])
  })
  it('rejects a child using the Main preset and removes its pending identity', async () => {
    const f = await fixture(undefined, 'main'), ctx = await f.start(), root = await main(ctx, f.root)
    const id = SessionId(randomUUID())
    await expect(ctx.agents.create({ sessionId: id, parentAgent: root.agent, meta: { cwd: f.root }, setup: async childCtx => {
      await ctx.agentPresets.mount(childCtx, 'review-gated')
    } })).rejects.toThrow('live root')
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.reviewGatedPermissions.of(root.agent.session)?.role).toBe('main')
  })
  it('provides an enforcing private filesystem despite an unconfined deployment provider', async () => {
    const f = await fixture(undefined, 'main'), ctx = await f.start(), root = await main(ctx, f.root)
    const child = await ctx.agents.create({ sessionId: SessionId(randomUUID()), parentAgent: root.agent, meta: { cwd: f.root }, setup: async (childCtx, actor) => {
      ctx.reviewGatedPermissions.authorize(actor, 'implementation')
      await ctx.agentPresets.mount(childCtx, 'review-gated-implementation')
    } })
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    let executed = false
    child.agent.ctx.tools.register(defineTool({ name: 'write', description: 'Test alternate host writer', parameters: {},
      output: { schema: { type: 'json' }, render: () => [] }, execute: async () => { executed = true; return null } }))
    child.agent.ctx.tools.presentAs('native')
    const result = await call(child.agent.ctx, child.agent, 'write', {})
    expect(ctx.fs.sandboxMode).toBeUndefined()
    expect(result.isError).toBe(false)
    expect(executed).toBe(true)
    await child.dispose()
  })
  it('denies a newly registered scoped mutation capability even after an allow listener', async () => {
    const f = await fixture(undefined, 'main'), ctx = await f.start(), root = await main(ctx, f.root)
    let executed = false
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    root.scoped.tools.register(defineTool({ name: 'unsafe_mutation', description: 'Test-only alternate mutation', parameters: {},
      output: { schema: { type: 'json' }, render: () => [] }, execute: async () => { executed = true; return null } }))
    root.scoped.tools.presentAs('native')
    ctx.on('tools/pre-execute', async (_execution, next) => { await next(); return { kind: 'allow' } })
    const result = await call(root.scoped, root.agent, 'unsafe_mutation', {})
    expect(result.isError).toBe(true)
    expect(executed).toBe(false)
    expect(JSON.stringify(result.content)).toContain('not available')
    await root.handle.dispose()
    expect(ctx.reviewGatedPermissions.of(root.agent.session)).toBeUndefined()
  })
})
