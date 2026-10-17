/** Real continued-question replies exercise both shipped tool presentations. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { workflowDomain, journalSchema } from '../../dist/storage/journal.js'
import { buttonSetup as setup, git } from '../fixtures/buttons.js'

describe('button decisions through shipped Main and real continued-question replies', () => {
  it.each(['native', 'ptc'] as const)('runs approval, permission and managed roles without pasted JSON (%s)', async mode => {
    const f = await setup(mode)
    f.root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement the isolated fixture task; ask me using buttons.' }] }))
    await f.root.agent.whenIdle()
    expect(f.controller.state.phase).toBe('Awaiting Approval')
    expect(f.ctx.reviewGatedJournals.confirmationMode).toBe('buttons')
    const cards = () => f.ctx.sessionProjections.stateOf(f.root.agent.session, 'userQuestions')!.questions.active
    const approval = cards().find(item => item.state === 'continued')!
    expect(approval).toBeDefined()
    expect(approval.questions[0]!.options![0]!.description).toContain('Execution budget:')
    expect(approval.questions[0]!.options![0]!.description).not.toContain('reviewGatedAnswer')
    expect(f.order).toEqual([])
    expect(f.ctx.userQuestions.answer(f.root.agent, approval.callId, { answers: [{ id: approval.questions[0]!.id, selected: ['Approve'] }] })).toBe(true)
    await f.root.agent.whenIdle()
    expect(f.controller.state.phase).toBe('Approved')
    expect(f.controller.state.questions![0]!.receipt?.source).toBe('session-user-question-reply')
    const operation = cards().find(item => item.state === 'continued')!
    expect(operation).toBeDefined()
    expect(operation.questions[0]!.options![0]!.description).toContain('No commit or push')
    expect(f.controller.state.operationAuthorization?.status).toBe('pending')
    expect(f.order).toEqual([])
    expect(f.ctx.userQuestions.answer(f.root.agent, operation.callId, { answers: [{ id: operation.questions[0]!.id, selected: ['Authorize'] }] })).toBe(true)
    await f.root.agent.whenIdle()
    expect(f.controller.state.phase).toBe('Ready for Handoff')
    expect(f.controller.state.operationAuthorization).toMatchObject({ status: 'consumed', receipt: { source: 'session-user-question-reply' } })
    expect(f.order).toEqual(['implementation', 'review'])
    expect(f.controller.state.verification!.checks[0]!.exitCode).toBe(0)
    expect(f.controller.state.review!.outcome).toBe('Passed')
    expect(cards()).toEqual([])
    expect((await git(f.repository, 'status', '--short')).stdout.trim()).toBe('M  src/export.txt')
    expect(await readFile(join(f.repository, 'src/export.txt'), 'utf8')).toBe('candidate')
    const humanText = f.root.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(humanText).toHaveLength(1)
    expect(f.calls.filter(name => name === 'ask_user_question')).toHaveLength(2)
    const receipts = journalSchema.parse(f.ctx.storageDomain.get(workflowDomain.name)!.table('sessions').get(f.root.agent.id)).records.filter(record => record.event.type === 'question-confirmed' || record.event.type === 'operation-confirmed')
    expect(receipts.every(record => record.version === 8)).toBe(true)
  })
})
