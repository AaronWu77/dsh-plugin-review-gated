/** Real Loader/role/AgentLoop rejection audits with scripted outputs; not live-model acceptance. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { fixture, main, call, confirm, permission } from '../fixtures/runtime.js'
import { brief } from '../fixtures/workflow.js'
import { journalSchema, workflowDomain } from '../../dist/storage/journal.js'
const git = async (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '', GIT_CONFIG_SYSTEM: '' } })

it.each(['review', 'diagnostic'] as const)('persists a bounded %s rejection from the real role runner without accepted Review', async role => {
  const f = await fixture(undefined, 'main', true, { commandSimulation: true }), repository = join(f.root, 'repository')
  await mkdir(join(repository, 'src'), { recursive: true }); await writeFile(join(repository, 'src', 'export.txt'), 'base')
  await git(repository, 'init', '--quiet'); await git(repository, 'add', '--', 'src/export.txt')
  await git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'private fixture baseline')
  const ctx = await f.start(), calls: string[] = []
  ctx.llm.registerAdapter(['scripted'], new class extends LlmAdapter {
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      const text = JSON.stringify(request.messages), implementation = text.includes('approved implementation task')
      calls.push(implementation ? 'implementation' : role)
      let answer = 'not valid JSON'
      if (implementation) { await writeFile(join(repository, 'src', 'export.txt'), 'candidate'); answer = JSON.stringify({ outcome: 'Completed', summary: 'Fixture write', problems: [], limitations: ['Scripted fixture'] }) }
      else if (role === 'review') {
        const user = request.messages.filter(message => message.role === 'user').flatMap(message => message.content).find(block => block.type === 'text' && block.text.startsWith('Execute only the approved review task'))
        if (!user || user.type !== 'text') throw new Error('Missing Review task input')
        const input = JSON.parse(user.text.split('Task inputs:\n').at(-1)!)
        answer = JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', outcome: 'Passed', briefRevision: input.snapshot.briefRevision, snapshotId: input.snapshot.id, treeId: input.snapshot.treeId, findings: [], checked: ['AC1'], unchecked: [], reason: '', acceptance: [{ id: 'AC1', status: 'Passed', evidence: [{ kind: 'verification', checkIndex: 0, explanation: 'Fixture check' }] }] })
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }())
  const root = await main(ctx, repository, randomUUID(), 'review-gated', false, { provider: 'scripted', model: 'fixture' })
  root.scoped.tools.presentAs('native')
  if (role === 'review') {
    ctx.on('user-questions/request', async request => ({ answers: [{ id: request.questions[0]!.id, selected: ['Approve'] }] }))
    expect((await call(root.scoped, root.agent, 'rg_submit_brief', { brief: { ...brief, verificationCommands: [{ executable: process.execPath, args: ['-e', 'console.log("fixture verification")'], timeoutMs: 60000 }] } })).isError).toBe(false)
    expect((await call(root.scoped, root.agent, 'rg_approve', { revision: 1 })).isError).toBe(false)
    const q = ctx.reviewGatedJournals.controller(root.agent.session).state.questions![0]!
    expect((await confirm(root.scoped, root.agent, q.id, 'Approve')).result.isError).toBe(false)
    await permission(root.scoped, root.agent, 'execution')
    expect((await call(root.scoped, root.agent, 'rg_start', { operation: 'execution' })).isError).toBe(false)
    const id = ctx.reviewGatedJournals.controller(root.agent.session).state.hostOperation!.id
    for (let attempt = 0; attempt < 20 && ctx.reviewGatedJournals.controller(root.agent.session).state.hostOperation!.status === 'Running'; attempt++) expect((await call(root.scoped, root.agent, 'rg_wait', { id, waitMs: 10000 })).isError).toBe(false)
    expect(ctx.reviewGatedJournals.controller(root.agent.session).state).toMatchObject({ phase: 'Paused', review: null, hostOperation: { status: 'Completed' } })
  } else {
    expect((await call(root.scoped, root.agent, 'rg_start', { operation: 'diagnostic', question: 'Inspect only this fixture' })).isError).toBe(false)
    expect((await call(root.scoped, root.agent, 'rg_wait', { id: ctx.reviewGatedJournals.controller(root.agent.session).state.hostOperation!.id, waitMs: 10000 })).isError).toBe(false)
  }
  const state = ctx.reviewGatedJournals.controller(root.agent.session).state, failure = state.roleFailures![0]!
  expect(failure).toMatchObject({ role, kind: role === 'review' ? 'schema-validation' : 'json-parse', logReference: { sessionId: failure.runId } })
  expect(state.review).toBeNull(); expect(state.phase).toBe(role === 'review' ? 'Paused' : 'Clarifying')
  expect(calls.filter(item => item === role)).toHaveLength(1)
  if (role === 'review') expect(failure.issues).toContainEqual(expect.objectContaining({ code: 'unrecognized_keys' }))
  const stored = journalSchema.parse(ctx.storageDomain.get(workflowDomain.name)!.table('sessions').get(root.agent.session.id))
  expect(stored.records).toContainEqual({ version: 8, event: { type: 'role-result-rejected', failure } })
})
