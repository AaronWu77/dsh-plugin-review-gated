/** Keyless Loader/AgentLoop tests; RG_ROLE_SOURCE=1 selects the source runner under an ESM TypeScript launcher. */
import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RoleRequest } from '../../src/roles/runner.js'
import { managedDelegation } from '../../src/roles/delegation.js'
import { roleInstructions } from '../../src/roles/instructions.js'
import type {} from '../../src/roles/runner.js'
import type {} from '@deepseek-ai/dsh-session-persistence-jsonl'
import { fixture, main } from '../fixtures/runtime.js'
import { brief, readyEvents, snapshot, verification, passed, finding } from '../fixtures/workflow.js'
import { OperationRequestId, operationReceipt } from '../../src/workflow/authorization.js'
import type { OperationRequest } from '../../src/workflow/authorization.js'
import { questionBinding } from '../../src/workflow/questions.js'
import { replay } from '../../src/workflow/controller.js'
import type { WorkflowController } from '../../src/workflow/controller.js'
import { recordSchema } from '../../src/workflow/types.js'
import { journalSchema, workflowDomain } from '../../src/storage/journal.js'

const completed = { outcome: 'Completed' as const, summary: 'scripted output', problems: [], limitations: [] }
class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  constructor(private readonly answer: string, private readonly hold?: (signal: AbortSignal) => Promise<void>, private readonly truncated = false, private readonly reasoning = false) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.hold) await this.hold(options.signal!)
    if (this.reasoning) {
      yield { type: 'block-start', index: 1, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 1, text: 'fixture reasoning metadata' }
      yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'fixture reasoning metadata' } }
    }
    const text = this.answer
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: this.truncated ? 'max-tokens' : 'stop' } }
  }
}
// Isolated role lifecycle uses public user-input events, not natural-person identity or product acceptance evidence.
async function authorizeRoleWindow(parent: Agent, controller: WorkflowController, mode: OperationRequest['mode'] = 'implement-verify-review') {
  const request: OperationRequest = {
    id: OperationRequestId(randomUUID()), kind: 'execution', mode, revision: controller.state.brief!.revision,
    binding: questionBinding(controller.state), askedAt: Date.now(),
    afterSeq: parent.session.snapshotEvents().at(-1)?.seq ?? -1, status: 'pending',
  }
  await controller.apply({ type: 'operation-requested', request })
  const event = parent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: JSON.stringify({ reviewGatedOperation: { requestId: request.id, selected: 'Authorize' } }) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  await controller.apply({ type: 'operation-confirmed', requestId: request.id, ...operationReceipt(parent.session, request, event.seq) })
  const windowId = randomUUID()
  await controller.apply({ type: 'authorized-execution-started', requestId: request.id, id: windowId })
  return windowId
}
async function setup(answer = JSON.stringify(completed), hold?: (signal: AbortSignal) => Promise<void>, truncated = false, native = false, limits: { maxOutputBytes?: number; budgetMs?: number; unavailable?: 'all'; bundle?: boolean; reasoning?: boolean; authorize?: boolean } = {}) {
  const f = await fixture(undefined, limits.bundle ? undefined : 'main', !native, { ...limits.bundle ? { bundle: true } : {}, ...limits.maxOutputBytes === undefined ? {} : { maxOutputBytes: limits.maxOutputBytes }, ...limits.unavailable === undefined ? {} : { unavailable: limits.unavailable } })
  if (process.env.RG_ROLE_SOURCE === '1' && !limits.bundle) {
    // Loader exercises the changed source role runner without rebuilding the shared artifacts.
    const yaml = await readFile(f.configPath, 'utf8'), artifact = new URL('../../dist/roles/runner.js', import.meta.url).href
    expect(yaml).toContain(artifact)
    await writeFile(f.configPath, yaml.replaceAll(artifact, new URL('../../src/roles/runner.ts', import.meta.url).href))
  }
  const ctx = await f.start()
  const adapter = new ScriptedAdapter(answer, hold, truncated, limits.reasoning)
  ctx.llm.registerAdapter(['scripted'], adapter)
  const root = await main(ctx, f.root, randomUUID(), 'review-gated', false, { provider: 'scripted', model: 'fixture' })
  const controller = ctx.reviewGatedJournals.controller(root.agent.session)
  const requirements = limits.budgetMs === undefined ? brief : { ...brief, executionBudgetMs: limits.budgetMs }
  await controller.apply({ type: 'requirements-submitted', brief: requirements })
  await controller.apply(readyEvents()[1]!)
  if (limits.authorize !== false) await authorizeRoleWindow(root.agent, controller)
  const runId = randomUUID()
  await controller.apply({ type: 'implementation-started', runId })
  const request: RoleRequest = { role: 'implementation', parent: root.agent, runId, cwd: f.root, brief: requirements, repair: null, signal: new AbortController().signal }
  return { f, ctx, adapter, root, controller, request }
}

describe('host-managed role turns through real YAML and AgentLoop', () => {
  it('publishes one-shot descriptors, parent catalog and lifecycle through the Subagent service', async () => {
    const f = await setup()
    const started: string[] = [], ended: string[] = []
    f.ctx.on('subagent/start', info => { started.push(info.id) })
    f.ctx.on('subagent/end', info => { ended.push(info.id) })
    const result = await f.ctx.reviewGatedRoles.run(f.request)
    expect(started).toEqual([result.agentId])
    expect(ended).toEqual([result.agentId])
    expect(f.root.agent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog').map(event => event.data)).toEqual([
      expect.objectContaining({ childId: result.agentId, mode: 'one-shot', label: 'Review-Gated implementation' }),
    ])
    const stored = await f.ctx.sessionPersistence.open(result.agentId, 'read')
    try {
      const log = await stored.read()
      expect(log.events.filter(event => event.type === 'subagent/descriptor').map(event => event.data)).toEqual([
        expect.objectContaining({ mode: 'one-shot', provider: 'review-gated-managed', label: 'Review-Gated implementation' }),
      ])
    } finally { await stored.close() }
  })
  it('rejects arbitrary callers of the managed provider even with a live admitted Main', async () => {
    const f = await setup()
    await expect(f.ctx.subagents.startActivation({
      provider: 'review-gated-managed', lifecycle: 'one-shot', childId: SessionId(randomUUID()),
      label: 'Unadmitted task', signal: new AbortController().signal, delivery: 'caller',
      request: { parent: f.root.agent, maxDepth: 1,
        prompt: [{ type: 'text', text: 'Execute only the approved implementation task.' }] },
    })).rejects.toThrow('host-prepared role admission')
    expect(f.adapter.calls).toHaveLength(0)
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
    expect(f.ctx.reviewGatedJournals.view(f.root.agent.session).state.activeRunId).toBe(f.request.runId)
  })
  it('retains a same-identity admission after a mismatched signal or cwd attempt', async () => {
    const f = await setup()
    const provider = 'same-identity-admission'
    const delegate = managedDelegation(f.ctx, provider)
    const childId = SessionId('same-identity-admission-child')
    const launchSignal = new AbortController().signal
    const launch = {
      parent: f.root.agent, childId, role: 'implementation' as const, preset: 'review-gated-implementation',
      cwd: f.request.cwd, maxDepth: 1, prompt: [], signal: launchSignal,
    }
    const gate = Promise.withResolvers<true>()
    const entered = Promise.withResolvers<Parameters<typeof f.ctx.subagents.startActivation>[0]>()
    const originalStart = f.ctx.subagents.startActivation.bind(f.ctx.subagents)
    const startSpy = vi.spyOn(f.ctx.subagents, 'startActivation').mockImplementation(async spec => {
      entered.resolve(spec)
      await gate.promise
      return originalStart(spec)
    })
    const legitimate = delegate(launch)
    const admitted = await entered.promise
    const wrongSignal = new AbortController().signal
    await expect(originalStart({
      ...admitted, signal: wrongSignal,
      request: { ...admitted.request, cwd: admitted.request.cwd + '-wrong' },
    })).rejects.toThrow('host-prepared role admission')
    gate.resolve(true)
    const result = await legitimate
    startSpy.mockRestore()
    try {
      expect(result.childId).toBe(childId)
    } finally {
      await result.dispose()
    }
  })

  it('unregisters managed provider admission with the role plugin lifetime', async () => {
    const f = await setup()
    expect(f.ctx.subagents.list()).toContain('review-gated-managed')
    const row = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'roles')
    if (!row?.fiber) throw new Error('Missing role provider fixture')
    await row.fiber.dispose()
    expect(f.ctx.subagents.list()).not.toContain('review-gated-managed')
    await expect(f.ctx.subagents.startActivation({
      provider: 'review-gated-managed', lifecycle: 'one-shot', label: 'Unadmitted task',
      signal: new AbortController().signal, delivery: 'caller',
      request: { parent: f.root.agent, prompt: [] },
    })).rejects.toThrow('no subagent provider')
  })
  it('accepts implementation JSON with reasoning metadata through the shipped role runner', async () => {
    const f = await setup(JSON.stringify(completed), undefined, false, false, { reasoning: true, bundle: true })
    const result = await f.ctx.reviewGatedRoles.run(f.request)
    expect(result.result).toEqual(completed)
    expect(f.ctx.agents.get(result.agentId)).toBeUndefined()
  })
  it('dispatches the hidden implementation preset through the shipped host runner', async () => {
    const f = await setup(JSON.stringify(completed), undefined, false, false, { bundle: true })
    expect((await f.ctx.agentPresets.remoteExportList()).presets.map(preset => preset.id)).toEqual(['standard', 'review-gated'])
    expect((await f.ctx.agentPresets.resolve('review-gated-implementation')).id).toBe('review-gated-implementation')
    const result = await f.ctx.reviewGatedRoles.run(f.request)
    expect(result.result).toEqual(completed)
    expect(f.adapter.calls).toHaveLength(1)
  })
  it('sets child metadata and permission before publication, then removes the child at settlement', async () => {
    const f = await setup()
    let child: Agent | undefined
    f.ctx.on('agent/created', async ({ agent }) => {
      if (agent.id === f.request.runId) {
        child = agent
        expect(agent.session.header.parentSession).toBe(f.root.agent.id)
        expect(agent.session.header.cwd).toBe(f.f.root)
        expect(agent.session.header.agentPreset).toBe('review-gated-implementation')
        expect(f.ctx.reviewGatedPermissions.of(agent.session)?.policy.mode).toBe('workspace-write')
      }
    })
    const result = await f.ctx.reviewGatedRoles.run(f.request)
    expect(result.role).toBe('implementation')
    expect(result.result).toEqual(completed)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(f.adapter.calls).toHaveLength(1)
    expect(child).toBeDefined()
    expect(f.ctx.agents.get(child!.id)).toBeUndefined()
    expect(f.ctx.reviewGatedPermissions.of(child!.session)).toBeUndefined()
    const persisted = await f.ctx.sessionPersistence.open(child!.id, 'read')
    try {
      const log = await persisted.read()
      const input = log.events.find(event => event.type === 'user/message')
      expect(input?.type).toBe('user/message')
      if (input?.type === 'user/message') {
        expect(JSON.stringify(input.data.content)).toContain(roleInstructions('implementation'))
        expect(JSON.stringify(f.adapter.calls[0]!.messages)).toContain(roleInstructions('implementation'))
        const text = input.data.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('')
        const payload = JSON.parse(text.split('Task inputs:\n').at(-1)!)
        expect(payload.verificationCompatibility).toEqual({ platform: process.platform, backendCapability: 'unknown', preflightExecuted: false, warnings: [] })
        expect(text).toContain('a result instance matching the schema below, not the schema document itself')
        expect(text).toContain('do not include extra fields or schema metadata such as $schema')
        expect(text).toContain('Do not use markdown fences or text outside the JSON object')
        const displayed = JSON.parse(text.split('Result JSON schema (describes allowed result fields; do not copy this document):\n')[1]!.split('\nTask inputs:')[0]!)
        expect(displayed).not.toHaveProperty('$schema')
        expect(displayed.oneOf.every((branch: { additionalProperties: boolean }) => branch.additionalProperties === false)).toBe(true)
        expect(f.adapter.calls[0]!.messages.find(message => message.role === 'user')?.content).toEqual(input.data.content)
        expect(JSON.stringify(f.adapter.calls[0]!.messages.filter(message => message.role === 'system'))).not.toContain(roleInstructions('implementation'))
        expect(text.split('Task inputs:\n')[0]).toMatchSnapshot('logged implementation instructions')
      }
    } finally { await persisted.close() }
  })
  it('creates Review with fresh history and a snapshot cwd rather than the implementation workspace', async () => {
    const f = await setup(JSON.stringify(passed), undefined, false, false, { reasoning: true })
    await f.controller.apply({ type: 'implementation-finished', runId: f.request.runId, result: completed, elapsedMs: 1 })
    const candidate = { ...snapshot, repository: f.f.root }
    await f.ctx.reviewGatedJournals.bindBase(f.root.agent.session, candidate.baseCommit, candidate.repository)
    await f.controller.apply({ type: 'snapshot-created', snapshot: candidate })
    await f.controller.apply({ type: 'verification-recorded', evidence: verification })
    const runId = randomUUID(), cwd = join(f.f.root, 'immutable-review')
    await mkdir(cwd)
    await f.controller.apply({ type: 'review-started', runId })
    const request: RoleRequest = { role: 'review', parent: f.root.agent, runId, cwd, brief, snapshot: candidate, verification, diff: 'fixture diff', hostObservations: { snapshotId: candidate.id, treeId: candidate.treeId, sourceIntegrity: 'checked', allowedScope: 'checked', checkedAt: 1, scopeBaseCommit: candidate.baseCommit }, signal: new AbortController().signal }
    await expect(f.ctx.reviewGatedRoles.run({ ...request, snapshot: { ...candidate, treeId: 'c'.repeat(40) } })).rejects.toThrow('current snapshot and verification')
    await expect(f.ctx.reviewGatedRoles.run({ ...request, verification: { ...verification, treeId: 'c'.repeat(40) } })).rejects.toThrow('current snapshot and verification')
    expect(f.adapter.calls).toHaveLength(0)
    expect(f.ctx.agents.get(SessionId(runId))).toBeUndefined()
    f.ctx.on('agent/created', ({ agent }) => {
      if (agent.id === runId) {
        expect(agent.session.header.cwd).toBe(cwd)
        expect(agent.session.header.agentPreset).toBe('review-gated-review')
        expect(f.ctx.reviewGatedPermissions.of(agent.session)).toMatchObject({ role: 'review', policy: { mode: 'read-only', workspaceRoot: cwd } })
      }
      return undefined
    })
    const result = await f.ctx.reviewGatedRoles.run(request)
    expect(result.role).toBe('review')
    expect(result.result).toEqual(passed)
    const messages = JSON.stringify(f.adapter.calls[0]!.messages)
    expect(messages).toContain(snapshot.treeId)
    expect(messages).not.toContain('scripted output')
    expect(messages).toContain(roleInstructions('review'))
    const contextText = f.adapter.calls[0]!.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(contextText).toContain('Current working directory: ' + JSON.stringify(cwd))
    expect(f.ctx.agents.get(result.agentId)).toBeUndefined()
    const persisted = await f.ctx.sessionPersistence.open(result.agentId, 'read')
    try {
      const log = await persisted.read()
      const input = log.events.find(event => event.type === 'user/message' && JSON.stringify(event.data.content).includes(roleInstructions('review')))
      expect(input?.type).toBe('user/message')
      if (input?.type === 'user/message') expect(JSON.stringify(input.data.content)).toContain(roleInstructions('review'))
    } finally { await persisted.close() }
  })
  it.each([
    { label: 'copied $schema', text: JSON.stringify({ ...completed, $schema: 'copied' }), kind: 'schema-validation' },
    { label: 'wrong type', text: JSON.stringify({ ...completed, summary: 42 }), kind: 'schema-validation' },
    { label: 'unknown field', text: JSON.stringify({ ...completed, extra: true }), kind: 'schema-validation' },
    { label: 'markdown fences', text: '```json\n' + JSON.stringify(completed) + '\n```', kind: 'json-parse' },
  ])('rejects Implementation $label once through actual Loader without repairing output', async ({ text, kind }) => {
    const f = await setup(text)
    await expect(f.ctx.reviewGatedRoles.run(f.request)).rejects.toMatchObject({
      name: 'RoleResultError', role: 'implementation', runId: f.request.runId, kind,
    })
    expect(f.adapter.calls).toHaveLength(1)
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
    expect(f.controller.state.implementation).toBeNull()
  })
  it.each([
    { label: 'copied $schema', value: { ...passed, $schema: 'copied' } },
    { label: 'wrong type', value: { ...passed, findings: 'not an array' } },
    { label: 'unknown field', value: { ...passed, extra: true } },
  ])('never turns an invalid Review $label into Passed through actual Loader', async ({ value }) => {
    const f = await setup(JSON.stringify(value), undefined, false, false, { reasoning: true })
    await f.controller.apply({ type: 'implementation-finished', runId: f.request.runId, result: completed, elapsedMs: 1 })
    const candidate = { ...snapshot, repository: f.f.root }
    await f.ctx.reviewGatedJournals.bindBase(f.root.agent.session, candidate.baseCommit, candidate.repository)
    await f.controller.apply({ type: 'snapshot-created', snapshot: candidate })
    await f.controller.apply({ type: 'verification-recorded', evidence: verification })
    const runId = randomUUID(), cwd = join(f.f.root, 'immutable-review')
    await mkdir(cwd)
    await f.controller.apply({ type: 'review-started', runId })
    const error = await f.ctx.reviewGatedRoles.run({ role: 'review', parent: f.root.agent, runId, cwd, brief, snapshot: candidate, verification, diff: 'fixture diff', hostObservations: { snapshotId: candidate.id, treeId: candidate.treeId, sourceIntegrity: 'checked', allowedScope: 'checked', checkedAt: 1, scopeBaseCommit: candidate.baseCommit }, signal: new AbortController().signal })
      .then(() => null, (error: unknown) => error)
    expect(error).toMatchObject({ name: 'RoleResultError', role: 'review', runId, kind: 'schema-validation' })
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error('Expected invalid Review failure')
    await f.controller.apply({ type: 'role-interrupted', runId, reason: error.message, elapsedMs: 1 })
    expect(f.controller.state.phase).toBe('Paused')
    expect(f.controller.state.review).toBeNull()
    expect(f.controller.state.pauseReason).toBe('Role review result failed schema validation')
    expect(f.adapter.calls).toHaveLength(1)
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
  })
  it('rejects complete output beyond its configured UTF-8 byte limit', async () => {
    const f = await setup(JSON.stringify(completed), undefined, false, false, { maxOutputBytes: 1 })
    await expect(f.ctx.reviewGatedRoles.run(f.request)).rejects.toThrow('byte limit')
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
  })
  it('interrupts an unfinished role when the approved execution budget expires', async () => {
    const f = await setup(JSON.stringify(completed), signal => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }), false, false, { budgetMs: 10 })
    await expect(f.ctx.reviewGatedRoles.run(f.request)).rejects.toThrow('budget exhausted')
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
  })
  it('denies direct Implementation without separate consumed execution permission', async () => {
    const f = await setup(undefined, undefined, false, false, { authorize: false })
    const children: Agent[] = []
    f.ctx.on('agent/created', ({ agent }) => { children.push(agent); return undefined })
    expect(f.controller.state).toMatchObject({ phase: 'Implementing', activeRunId: f.request.runId })
    expect(f.controller.state.operationAuthorization).toBeUndefined()
    await expect(f.ctx.reviewGatedRoles.run(f.request)).rejects.toThrow('consumed operation permission')
    expect(children).toEqual([])
    expect(f.adapter.calls).toHaveLength(0)
  })
  it.each(['legacy', 'consumed'] as const)('denies restored %s Implementing history without live execution permission', async history => {
    const f = await setup(undefined, undefined, false, false, { authorize: history !== 'legacy' })
    if (history === 'legacy') {
      const table = f.ctx.storageDomain.get(workflowDomain.name)!.table('sessions')
      const stored = journalSchema.parse(table.get(f.root.agent.id))
      const records = [...readyEvents().slice(0, 2), { type: 'implementation-started', runId: f.request.runId }]
        .map(event => recordSchema.parse({ version: 4, event }))
      await table.put(f.root.agent.id, journalSchema.parse({ ...stored, records, state: replay(records) }))
    }
    await f.ctx.sessions.flush(f.root.agent.session)
    await f.ctx.fiber.dispose()
    const ctx = await f.f.start()
    ctx.llm.registerAdapter(['scripted'], f.adapter)
    const root = await main(ctx, f.f.root, f.root.agent.id, 'review-gated', true, { provider: 'scripted', model: 'fixture' })
    await ctx.agentPresets.select(root.agent, 'review-gated')
    expect(ctx.reviewGatedPermissions.of(root.agent.session)?.role).toBe('main')
    const state = ctx.reviewGatedJournals.view(root.agent.session).state
    expect(state).toMatchObject({ phase: 'Implementing', activeRunId: f.request.runId })
    if (history === 'legacy') expect(state.operationAuthorization).toBeUndefined()
    else expect(state.operationAuthorization!.receipt!.seq).toBeLessThan(root.agent.session.firstLiveSeq)
    const children: Agent[] = []
    ctx.on('agent/created', ({ agent }) => { children.push(agent); return undefined })
    await expect(ctx.reviewGatedRoles.run({ ...f.request, parent: root.agent })).rejects.toThrow('consumed operation permission')
    expect(children).toEqual([])
    expect(f.adapter.calls).toHaveLength(0)
  })
  it('denies a consumed permission attached to a different execution window', async () => {
    const f = await setup()
    const original = f.controller.state.executionWindow!.id
    await f.controller.apply({ type: 'role-interrupted', runId: f.request.runId, reason: 'Fixture role stopped', elapsedMs: 0 })
    await f.controller.apply({ type: 'execution-window-finished', id: original, elapsedMs: 0 })
    await f.controller.apply({ type: 'resumed' })
    const different = randomUUID()
    await f.controller.apply({ type: 'execution-window-started', id: different })
    await f.controller.apply({ type: 'implementation-started', runId: f.request.runId })
    expect(f.controller.state.operationAuthorization).toMatchObject({ status: 'consumed', operationId: original })
    expect(f.controller.state.executionWindow?.id).toBe(different)
    const children: Agent[] = []
    f.ctx.on('agent/created', ({ agent }) => { children.push(agent); return undefined })
    await expect(f.ctx.reviewGatedRoles.run(f.request)).rejects.toThrow('consumed operation permission')
    expect(children).toEqual([])
    expect(f.adapter.calls).toHaveLength(0)
  })
  it('denies Implementation repair under a verify-review-only permission', async () => {
    const f = await setup()
    await f.controller.apply({ type: 'implementation-finished', runId: f.request.runId, result: completed, elapsedMs: 0 })
    await f.controller.apply({ type: 'execution-window-finished', id: f.controller.state.executionWindow!.id, elapsedMs: 0 })
    await authorizeRoleWindow(f.root.agent, f.controller, 'verify-review')
    const candidate = { ...snapshot, repository: f.f.root }
    await f.ctx.reviewGatedJournals.bindBase(f.root.agent.session, candidate.baseCommit, candidate.repository)
    await f.controller.apply({ type: 'snapshot-created', snapshot: candidate })
    await f.controller.apply({ type: 'verification-recorded', evidence: verification })
    const reviewId = randomUUID()
    await f.controller.apply({ type: 'review-started', runId: reviewId })
    await f.controller.apply({ type: 'review-finished', runId: reviewId, result: { ...passed, outcome: 'Needs Changes', findings: [finding] }, elapsedMs: 0 })
    const runId = randomUUID()
    await f.controller.apply({ type: 'implementation-started', runId })
    expect(f.controller.state.operationAuthorization).toMatchObject({ status: 'consumed', mode: 'verify-review', operationId: f.controller.state.executionWindow!.id })
    const children: Agent[] = []
    f.ctx.on('agent/created', ({ agent }) => { children.push(agent); return undefined })
    await expect(f.ctx.reviewGatedRoles.run({ ...f.request, runId, repair: f.controller.state.review })).rejects.toThrow('consumed operation permission')
    expect(children).toEqual([])
    expect(f.adapter.calls).toHaveLength(0)
  })
  it('rechecks cancellation after workspace resolution before creating any child', async () => {
    const f = await setup(), abort = new AbortController(), children: Agent[] = []
    f.ctx.on('agent/created', ({ agent }) => { children.push(agent); return undefined })
    // run reaches its first realpath await synchronously; abort before either filesystem callback can resume it.
    const pending = f.ctx.reviewGatedRoles.run({ ...f.request, signal: abort.signal })
    const rejected = expect(pending).rejects.toThrow('cancelled during workspace resolution')
    abort.abort(new Error('cancelled during workspace resolution'))
    await rejected
    expect(children).toEqual([])
    expect(f.adapter.calls).toHaveLength(0)
    expect(f.ctx.agents.get(SessionId(f.request.runId))).toBeUndefined()
  })
  it('does not execute a role when journal identity or requirements differ', async () => {
    const f = await setup()
    await expect(f.ctx.reviewGatedRoles.run({ ...f.request, runId: randomUUID() })).rejects.toThrow('approved active')
    await expect(f.ctx.reviewGatedRoles.run({ ...f.request, brief: { ...brief, goal: 'invented scope' } })).rejects.toThrow('approved active')
    const ordinary = await main(f.ctx, f.f.root, randomUUID(), 'standard')
    await expect(f.ctx.reviewGatedRoles.run({ ...f.request, parent: ordinary.agent })).rejects.toThrow('admitted live Main Agent')
    expect(f.ctx.agents.get(SessionId(f.request.runId))).toBeUndefined()
    expect(f.adapter.calls).toHaveLength(0)
  })
  it('rejects a changed child file policy before the first model request', async () => {
    const f = await setup()
    f.ctx.on('agent/created', async ({ agent }) => {
      if (agent.id === f.request.runId) setSandboxMode(agent.session, 'danger-full-access')
    })
    await expect(f.ctx.reviewGatedRoles.run(f.request)).rejects.toThrow('did not complete')
    expect(f.adapter.calls).toHaveLength(0)
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
  })
  it('rejects an implementation cwd outside the approved repository', async () => {
    const f = await setup(), other = join(f.f.root, 'other')
    await mkdir(other)
    await expect(f.ctx.reviewGatedRoles.run({ ...f.request, cwd: other })).rejects.toThrow('approved workspace')
    expect(f.adapter.calls).toHaveLength(0)
  })
  it('rejects overlapping roles and drains cancellation before returning', async () => {
    const entered = Promise.withResolvers<void>()
    const f = await setup(JSON.stringify(completed), signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      entered.resolve()
    }))
    const abort = new AbortController()
    const promise = f.ctx.reviewGatedRoles.run({ ...f.request, signal: abort.signal })
    const observed = promise.then(() => null, error => error)
    await entered.promise
    await expect(f.ctx.reviewGatedRoles.run(f.request)).rejects.toThrow('owns this repository')
    abort.abort(new Error('parent cancelled'))
    expect(await observed).toBeInstanceOf(Error)
    expect(f.ctx.agents.get(SessionId(f.request.runId))).toBeUndefined()
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
  })
  it.each([{ text: 'not JSON', truncated: false }, { text: '{}', truncated: false }, { text: JSON.stringify(completed), truncated: true }])('refuses malformed or incomplete output: $text', async ({ text, truncated }) => {
    const f = await setup(text, undefined, truncated)
    await expect(f.ctx.reviewGatedRoles.run(f.request)).rejects.toThrow()
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
  })
  it('cancels and drains a role when its Main Agent is disposed', async () => {
    const entered = Promise.withResolvers<void>()
    const f = await setup(JSON.stringify(completed), signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      entered.resolve()
    }))
    const promise = f.ctx.reviewGatedRoles.run(f.request)
    const observed = promise.then(() => null, error => error)
    await entered.promise
    await f.root.handle.dispose()
    expect(await observed).toBeInstanceOf(Error)
    expect(f.ctx.agents.roots()).toEqual([])
  })
  it('drains all role work when its host provider is disposed', async () => {
    const entered = Promise.withResolvers<void>()
    const f = await setup(JSON.stringify(completed), signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      entered.resolve()
    }))
    const promise = f.ctx.reviewGatedRoles.run(f.request)
    const observed = promise.then(() => null, error => error)
    await entered.promise
    await f.ctx.reviewGatedRoles.close()
    expect(await observed).toBeInstanceOf(Error)
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
  })
  it('reports model failure and disposes the real role child without a successful result', async () => {
    const f = await setup(JSON.stringify(completed), async () => { throw new Error('scripted model failure') })
    await expect(f.ctx.reviewGatedRoles.run(f.request)).rejects.toThrow('did not complete successfully')
    expect(f.adapter.calls).toHaveLength(1)
    expect(f.ctx.agents.get(SessionId(f.request.runId))).toBeUndefined()
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
    expect(f.controller.state.implementation).toBeNull()
  })
  it('rejects an unpatched Host extension before provider registration', async () => {
    const f = await setup(JSON.stringify(completed))
    Object.defineProperty(f.ctx.subagents, 'supportsLocalOneShot', { value: false })
    const { managedDelegation } = await import('../../dist/roles/delegation.js')
    expect(() => managedDelegation(f.ctx, 'unsupported-host')).toThrow('stock alpha2 is unsupported')
    expect(f.adapter.calls).toHaveLength(0)
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
  })
  it('rejects an unavailable native backend before any role model call', async () => {
    const f = await setup(JSON.stringify(completed), undefined, false, false, { unavailable: 'all' })
    await expect(f.ctx.reviewGatedRoles.run(f.request)).rejects.toThrow('Test-owned unavailable native backend')
    expect(f.adapter.calls).toHaveLength(0)
    expect(f.ctx.agents.roots()).toEqual([f.root.agent])
  })
})
