/** Real shipped overlay and client registry; no browser server or live model. */
import { describe, expect, it } from 'vitest'
import ClientModuleRegistry from '@deepseek-ai/dsh-client-modules'
import { fixture, main, call } from '../fixtures/runtime.js'
import type {} from '../../ui/lib/types/projection.js'

const packageName = '@aaronwu/dsh-review-gated'
describe('unified package client discovery', () => {
  it('rejects a second file-based core entry instead of silently duplicating the browser module', async () => {
    const f = await fixture(undefined, undefined, true, { bundle: true })
    const ctx = await f.start()
    await ctx.loader.create({ name: new URL('../../dist/preset.js', import.meta.url).href, config: { id: 'duplicate-test-preset', plugins: [] } })
    await ctx.loader.await()
    await expect(ctx.plugin(ClientModuleRegistry)).rejects.toThrow('resolves from multiple active Loader sources')
  })

  it('discovers one UI source across all managed presets and removes only the panel when disabled', async () => {
    const f = await fixture(undefined, undefined, true, { bundle: true })
    const ctx = await f.start()
    await ctx.plugin(ClientModuleRegistry)
    const ids = () => ctx.clientModules.graph().entries.filter(row => row.id === packageName).map(row => row.id)
    expect(ids()).toEqual([packageName])
    const root = await main(ctx, f.root)
    expect(ids()).toEqual([packageName])
    expect(ctx.sessionProjections.snapshot(root.agent.session).values).toHaveProperty('observedReviewGated')
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'review-gated-observed-ui')!
    await row.update({ disabled: true })
    await ctx.loader.await()
    await expect.poll(ids).toEqual([])
    expect(ctx.sessionProjections.snapshot(root.agent.session).values).not.toHaveProperty('observedReviewGated')
    expect(ctx.reviewGatedPermissions.of(root.agent.session)?.role).toBe('main')
    root.scoped.tools.presentAs('native')
    const status = await call(root.scoped, root.agent, 'rg_status', {})
    expect(status.isError, JSON.stringify(status)).not.toBe(true)
    await row.update({ disabled: false })
    await ctx.loader.await()
    await expect.poll(ids).toEqual([packageName])
    expect(ctx.sessionProjections.snapshot(root.agent.session).values).toHaveProperty('observedReviewGated')
  })
})
