import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it } from 'vitest'
import { call, result, summary } from './fixtures.ts'
const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('built optional package via real YAML Loader', () => {
  it('boots Session registry and built host plugin, replays results and removes projection on unload', async () => {
    const plugin = await import('../lib/index.js')
    expect('default' in plugin).toBe(false)
    const root = await mkdtemp(resolve('dist/loader-')); roots.push(root)
    const path = join(root, 'cordis.yml')
    await writeFile(path, "- name: '@deepseek-ai/dsh-session'\n- name: '@deepseek-ai/dsh-session-projection'\n- name: '@aaronwu/dsh-review-gated/observed-ui'\n")
    const ctx = new Context(); contexts.push(ctx); ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader); ctx.loader.builtins.include = Include
    const modules = new Map([['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry], ['@aaronwu/dsh-review-gated/observed-ui', plugin]])
    ctx.loader.internal = { version: 'v2', async import(name: string) { if (!modules.has(name)) throw new Error('Unexpected import ' + name); return modules.get(name) } } as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } }); await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => !entry.fiber && !entry.disabled).map(entry => entry.options.name)).toEqual([])
    const session = ctx.sessions.create(SessionId('ui-loader'))
    session.append('tool/call', call().data)
    session.append('tool/result', result(summary('Paused')).data, { surfaceOp: 'append' })
    expect(ctx.sessionProjections.snapshot(session).values.observedReviewGated?.summary.state.phase).toBe('Paused')
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === '@aaronwu/dsh-review-gated/observed-ui')
    expect(entry?.fiber).toBeTruthy(); await entry!.fiber!.dispose()
    expect('observedReviewGated' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })
})
