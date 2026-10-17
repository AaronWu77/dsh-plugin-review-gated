// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'
import type { ClientBundleRegistration, ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import * as UI from '../src/client/index.ts'
import type { ReviewActions } from '../src/client/ReviewAction.tsx'
import { observation, summary } from './fixtures.ts'
const runtimes: SlotTestRuntime[] = []
afterEach(async () => { cleanup(); for (const rt of runtimes.splice(0)) await rt.dispose(); for (const tag of document.querySelectorAll('style[data-plugin="@aaronwu/dsh-review-gated"]')) tag.remove() })
async function bench(plugin = UI, locale = 'en') {
  const rt = await SlotTestRuntime.create(); runtimes.push(rt)
  const language = new LocaleRuntime(rt.ctx); language.setLocale(locale); rt.ctx.provide('locale', language); rt.slots.installLocale(language)
  const open = vi.fn(); rt.ctx.provide('uiWorkspace', { openSession: open } as never)
  await rt.sessions.add({ id: 'parent' })
  const sid = 'parent' as SessionId
  const ref = rt.sessions.retainFor(rt.ctx, sid)
  await ref.ready
  await rt.declare({ 'conversation.session.header.actions': { kind: 'list', scope: 'session' } })
  const feature = await rt.mount(plugin)
  rt.renderSlot('conversation.session.header.actions', {}, { session: ref })
  return { rt, ref, feature, open, language, sid }
}
async function setCatalog(rt: SlotTestRuntime, entries: SubagentCatalogEntry[]) {
  await rt.sessions.setProjection('parent', 'subagentCatalog', entries)
  act(() => { rt.sessions.list.update(draft => { draft.projectionsBySession['parent' as SessionId] = { values: { subagentCatalog: entries }, state: 'ready', error: null } }) })
}
async function builtPlugin() {
  const manifest = JSON.parse(await readFile('../package.json', 'utf8'))
  const id = manifest.name
  expect(manifest.exports['./client'].default).toBe('./ui/lib/client.js')
  expect(manifest.dsh.client.platform).toBe('web')
  expect(manifest.dsh.client.external).toBeUndefined()
  const queue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = { mode: 'queue', pendingQueue: queue, load(registration) { queue.push(registration) }, create(options) { return createClientModuleSystem(target, { id: 'test-kernel', exports: {} }, options) } }
  runInNewContext(await readFile('lib/client.js', 'utf8'), { window: { __ModuleLoader__: target }, document })
  expect(queue.map(row => row.id)).toEqual([id])
  const loader = target.create({ boot: { rev: 'test', entries: [{ id, url: 'plugins/ui/client.js', rev: 'test' }], batches: [{ phase: 'application', url: 'plugins/ui/client.js', rev: 'test', entries: [id] }] }, staticModules: { react: React, 'react/jsx-runtime': jsxRuntime, '@deepseek-ai/dsh-client-ui-primitives': primitives }, loadBundle: async () => { throw new Error('Offline candidate must already be queued') } })
  const plugin = await loader.import(id, '', {}) as typeof UI
  expect(Object.keys(plugin).sort()).toEqual(['apply', 'inject'])
  return plugin
}
describe('real scoped slot renderer', () => {
  it.each(['en', 'zh'])('renders absence and observed approval in %s without claiming completion', async locale => {
    const b = await bench(UI, locale)
    screen.getByRole('button', { name: locale === 'en' ? 'Review workflow' : '审查工作流' }).focus()
    fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Review workflow' : '审查工作流' }))
    expect(screen.getByText(locale === 'en' ? 'No successful workflow summary observed in this session.' : '此会话尚未观察到成功的工作流摘要')).toBeTruthy()
    await b.rt.sessions.setProjection('parent', 'observedReviewGated', observation())
    expect(screen.getByText(locale === 'en' ? 'Approved revision 2 — not completion' : '第 2 版已批准，不代表完成')).toBeTruthy()
    expect(screen.getByText(locale === 'en' ? 'Requirements approved. Implementation and handoff are separate steps.' : '需求已批准，实施和交付是独立步骤')).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('800 / 1000')
    expect(b.open).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button'))
  })
  it('switches registered locale copy without replacing the observation', async () => {
    const b = await bench()
    await b.rt.sessions.setProjection('parent', 'observedReviewGated', observation())
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }))
    act(() => { b.language.setLocale('zh') })
    expect(screen.getByRole('dialog', { name: '最近观察到的状态' })).toBeTruthy()
    expect(screen.getByText('第 2 版已批准，不代表完成')).toBeTruthy()
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy()
    expect(screen.queryByText('Approved revision 2 — not completion')).toBeNull()
  })
  it('updates compact blockers pause and budgets from complete projection values', async () => {
    const b = await bench()
    const value = summary('Paused')
    await b.rt.sessions.setProjection('parent', 'observedReviewGated', observation({ ...value, state: { ...value.state, pauseReason: 'Repair budget exhausted', review: { outcome: 'Needs Changes', unchecked: { count: 2, items: [] }, findingCount: 4, blockingFindingCount: 3, blockingFindings: { count: 3, items: ['src/a.ts:2: broken'] } } } }))
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }))
    expect(screen.getByText('3 blocking / 4 findings · 2 unchecked')).toBeTruthy()
    expect(screen.getByText('src/a.ts:2: broken')).toBeTruthy()
    expect(screen.getByText('This result contains only part of the recorded details.')).toBeTruthy()
    expect(screen.getByText('Repair budget exhausted')).toBeTruthy()
    expect(screen.queryByText('Requirements approved. Implementation and handoff are separate steps.')).toBeNull()
  })
  it('opens only discovered one-shot children and denies stale catalog callbacks', async () => {
    const b = await bench()
    await b.rt.sessions.setProjection('parent', 'observedReviewGated', observation())
    await setCatalog(b.rt, [{ id: 'child', mode: 'one-shot', label: 'Implementation', createdAt: 1 }, { id: 'resident', mode: 'continuable', label: 'Other', createdAt: 2 }])
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }))
    expect(screen.getByRole('dialog').textContent).toContain('This run is not in the current parent child catalog; navigation is unavailable.')
    expect(screen.queryByText('Other')).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Open child conversation:/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /^Open child conversation:/ }))
    expect(b.open).toHaveBeenCalledExactlyOnceWith({ parentSessionId: 'parent', childSessionId: 'child', mode: 'one-shot' })
    const entry = b.rt.slots.entries('conversation.session.header.actions')[0]!
    const actions = (entry.inject as (sid: SessionId) => ReviewActions)(b.sid)
    await setCatalog(b.rt, [])
    expect(actions.openChild(b.sid, 'child' as SessionId)).toBe(false)
    expect(actions.openChild('foreign' as SessionId, 'child' as SessionId)).toBe(false)
    expect(b.open).toHaveBeenCalledTimes(1)
    cleanup()
    b.ref.release()
    await b.rt.sessions.drainDrops()
    const next = b.rt.sessions.retainFor(b.rt.ctx, b.sid); await next.ready
    await setCatalog(b.rt, [{ id: 'child' as SessionId, mode: 'one-shot', createdAt: 1 }])
    expect(actions.openChild(b.sid, 'child' as SessionId)).toBe(false)
    const current = (entry.inject as (sid: SessionId) => ReviewActions)(b.sid)
    expect(current.openChild(b.sid, 'child' as SessionId)).toBe(true)
    expect(b.open).toHaveBeenCalledTimes(2)
  })
  it('keeps observed data visible after navigation fails', async () => {
    const b = await bench(); b.open.mockImplementation(() => { throw new Error('navigation unavailable') })
    await b.rt.sessions.setProjection('parent', 'observedReviewGated', observation())
    await setCatalog(b.rt, [{ id: 'child', mode: 'one-shot', createdAt: 1 }])
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' })); fireEvent.click(screen.getByRole('button', { name: /^Open child conversation:/ }))
    expect(screen.getByRole('alert').textContent).toBe('Could not open the child conversation')
    expect(screen.getByText('Approved revision 2 — not completion')).toBeTruthy()
  })
  it('hides stale observations and navigation during history opening', async () => {
    const b = await bench()
    await b.rt.sessions.setProjection('parent', 'observedReviewGated', observation())
    await setCatalog(b.rt, [{ id: 'child' as SessionId, mode: 'one-shot', createdAt: 1 }])
    await b.rt.sessions.updateSessionSnapshot('parent', draft => { draft.openState = 'loading' })
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }))
    expect(screen.getByRole('status', { name: 'Workflow observations are unavailable while this session opens.' })).toBeTruthy()
    expect(screen.queryByText('Approved revision 2 — not completion')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Open child conversation:/ })).toBeNull()
  })
  it('renders diagnostic operation completion separately from workflow completion', async () => {
    const b = await bench()
    const value = summary('Paused')
    await b.rt.sessions.setProjection('parent', 'observedReviewGated', observation({ ...value, state: { ...value.state, hostOperation: { id: 'operation-1', kind: 'diagnostic', status: 'Completed', error: null } } }))
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }))
    expect(screen.getByRole('dialog').textContent).toContain('Operation ended — not workflow completion')
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(screen.queryByText('Handoff completed (observed)')).toBeNull()
  })
  it('unloads and reloads header registration without stale contributions', async () => {
    const b = await bench(); expect(b.rt.slots.entries('conversation.session.header.actions')).toHaveLength(1)
    await b.feature.dispose(); expect(b.rt.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    await b.rt.mount(UI); expect(b.rt.slots.entries('conversation.session.header.actions')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Review workflow' })).toBeTruthy()
  })
  it('loads actual lazy CJS artifact through Client Modules and mounts its exported plugin', async () => {
    const plugin = await builtPlugin()
    const b = await bench(plugin)
    await b.rt.sessions.setProjection('parent', 'observedReviewGated', observation(summary('Completed')))
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }))
    expect(screen.getByText('Handoff completed (observed)')).toBeTruthy()
    expect(screen.getByText('Logged tool result only. Not live workflow authority or proof that the current candidate can be handed off.')).toBeTruthy()
    expect(document.querySelectorAll('style[data-plugin="@aaronwu/dsh-review-gated"]')).toHaveLength(1)
  })
})
