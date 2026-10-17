import { describe, expect, it } from 'vitest'
import { projection } from '../src/projection.ts'
import { readSummary, observationSchema } from '../src/summary.ts'
import { call, result, ptcStart, ptcEnd, summary, observation, tree } from './fixtures.ts'
const initial = (inheritedEventCount = 0) => projection.stateSchema.parse({ inheritedEventCount, calls: [], dispatches: [], observed: null })
describe('logged workflow projection', () => {
  it('correlates a successful native result and preserves immutable prior state', () => {
    const start = initial()
    const pending = projection.apply(start, call())
    const settled = projection.apply(pending, result())
    expect(start.calls).toEqual([])
    expect(settled.observed).toMatchObject({ tool: 'rg_status', transport: 'native', seq: 2, summary: { state: { phase: 'Approved', remainingExecutionMs: 800 } } })
    expect(projection.wire.view(settled)).toBe(settled.observed)
    expect(projection.stateSchema.parse(settled)).toEqual(settled)
  })
  it.each(['rg_start', 'rg_wait'])('reads %s workflow wrappers without promoting task status', name => {
    const state = projection.apply(projection.apply(initial(), call(1, name)), result({ status: 'Succeeded', workflow: summary('Paused') }))
    expect(state.observed?.summary.state.phase).toBe('Paused')
  })
  it('observes nested PTC before outer run_code settles', () => {
    const state = projection.apply(projection.apply(initial(), ptcStart()), ptcEnd())
    expect(state.observed).toMatchObject({ transport: 'ptc', callId: 'sub', tool: 'rg_wait' })
    expect(state.dispatches).toEqual([])
  })
  it('rejects mismatched PTC ids, names, arguments and failed outcomes', () => {
    const state = projection.apply(initial(), ptcStart())
    for (const changes of [{ rootCallId: 'wrong' }, { parentCallId: 'wrong' }, { subCallId: 'wrong' }, { name: 'rg_start' }, { arguments: {} }, { isError: true }, { error: { name: 'error', code: 'x' } }]) {
      const event = ptcEnd()
      Object.assign(event.data, changes)
      expect(projection.apply(state, event).observed).toBeNull()
    }
  })
  it('ignores inherited seed starts/results and seed-to-own pairings', () => {
    const seed = initial(3)
    expect(projection.apply(seed, call())).toBe(seed)
    expect(projection.apply(seed, result())).toBe(seed)
    expect(projection.apply(seed, result(summary(), { seq: 4 })).observed).toBeNull()
    expect(projection.apply(seed, ptcStart())).toBe(seed)
    expect(projection.apply(seed, ptcEnd(summary(), 4)).observed).toBeNull()
  })
  it('ignores unrelated, orphaned, malformed, spilled and error results while retaining last observation', () => {
    const observed = projection.apply(projection.apply(initial(), call()), result())
    expect(projection.apply(observed, call(3, 'other'))).toBe(observed)
    expect(projection.apply(initial(), result()).observed).toBeNull()
    for (const value of [result(null), result(summary(), { text: 'preview spilled' }), result(summary(), { isError: true }), result(summary(), { callId: 'wrong' }), result(summary(), { step: 2 })]) {
      expect(projection.apply(projection.apply(observed, call(3)), value).observed).toBe(observed.observed)
    }
    const multi = structuredClone(result()); multi.data.message.content.push({ type: 'text', text: '{}' })
    expect(projection.apply(projection.apply(initial(), call()), multi).observed).toBeNull()
  })
  it('consumes one matching result and ignores duplicates', () => {
    const state = projection.apply(projection.apply(initial(), call()), result())
    expect(projection.apply(state, result(summary('Completed'), { seq: 3 }))).toBe(state)
  })
  it('retains compact blocker counts, including truncated empty details', () => {
    const value = summary('Needs Changes')
    const review = { outcome: 'Needs Changes', unchecked: { count: 2, items: [] }, findingCount: 4, blockingFindingCount: 3, blockingFindings: { count: 3, items: ['src/a.ts:2: broken'] } }
    const parsed = readSummary({ ...value, state: { ...value.state, review } })
    expect(parsed?.state.review).toEqual(review)
    expect(readSummary({ ...value, state: { ...value.state, review: { ...review, blockingFindingCount: 5 } } })).toBeNull()
  })
  it('counts successful checks only when all independent process facts allow success', () => {
    const value = summary()
    const parsed = readSummary({ ...value, state: { ...value.state, verification: { snapshotId: 'old', treeId: tree, checks: [
      { exitCode: 0, signal: null, timedOut: false }, { exitCode: 0, signal: null, timedOut: true }, { exitCode: 0, signal: 'TERM', timedOut: false }, { exitCode: null, signal: null, timedOut: false },
    ] } } })
    expect(parsed?.state.verification).toMatchObject({ checkCount: 4, passedCount: 1, snapshotId: 'old' })
  })
  it('clears dangling calls at turn settlement without changing the last observation', () => {
    const observed = projection.apply(projection.apply(initial(), call()), result())
    const pending = projection.apply(projection.apply(observed, call(3)), ptcStart(4))
    const settled = projection.apply(pending, { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'completed' } } } as import('@deepseek-ai/dsh-session/types').SessionEvent<'turn/end'>)
    expect(settled.calls).toEqual([]); expect(settled.dispatches).toEqual([]); expect(settled.observed).toBe(observed.observed)
  })
  it('rejects invalid phase ids counts and unsafe dates', () => {
    expect(readSummary({})).toBeNull()
    expect(readSummary({ ...summary(), recordCount: -1 })).toBeNull()
    expect(observationSchema.safeParse({ ...observation(), time: Number.MAX_SAFE_INTEGER }).success).toBe(false)
    const value = summary()
    expect(readSummary({ ...value, state: { ...value.state, phase: 'Succeeded' } })).toBeNull()
  })
})
