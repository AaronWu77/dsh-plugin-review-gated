/** Real Loader, AgentLoop and public UI reply channel; model decisions and confinement are scripted. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { confirmationQuestions } from '../../dist/workflow/interaction.js'
import { needsQuestionRefresh } from '../../dist/workflow/questions.js'
import { decisionEvidence } from '../../dist/workflow/decision-evidence.js'
import { operationEvidence } from '../../dist/workflow/authorization.js'
import { brief } from './workflow.js'
import { fixture, main } from './runtime.js'

const exec = promisify(execFile)
export async function git(cwd: string, ...args: string[]) { return exec('git', ['-c', 'core.autocrlf=false', ...args], { cwd, timeout: 10000 }) }
async function* textResult(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
async function* toolResult(mode: 'native' | 'ptc', name: string, args: object): AsyncIterable<StreamChunk> {
  const actual = mode === 'native' ? { name, arguments: JSON.stringify(args) }
    : { name: 'run_code', arguments: JSON.stringify({ code: 'return await tools.' + name + '(' + JSON.stringify(args) + ')', description: 'Drive the current approved workflow step' }) }
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), ...actual } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

export async function buttonSetup(mode: 'native' | 'ptc', execute = true) {
  const f = await fixture(undefined, undefined, true, { bundle: true, confirmationMode: 'buttons', mainPtcSimulation: true, commandSimulation: true })
  const repository = join(f.root, 'repository')
  await mkdir(join(repository, 'src'), { recursive: true })
  await writeFile(join(repository, 'src/export.txt'), 'base')
  await git(repository, 'init', '--quiet')
  await git(repository, 'add', '--', 'src/export.txt')
  await git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture baseline')
  const ctx = await f.start(), order: string[] = [], calls: string[] = []
  const root = await main(ctx, repository, randomUUID(), 'review-gated', false, { provider: 'scripted', model: 'fixture' })
  root.scoped.tools.presentAs(mode)
  const controller = ctx.reviewGatedJournals.controller(root.agent.session)
  const requirements = { ...brief, verificationCommands: [{ executable: process.execPath, args: ['-e', 'if(require("node:fs").readFileSync("src/export.txt","utf8")!=="candidate") process.exit(1); console.log("verified")'], timeoutMs: 60000 }] }
  const adapter = new class extends LlmAdapter {
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      const inputs = request.messages.filter(message => message.role === 'user').flatMap(message => message.content).filter(block => block.type === 'text')
      const task = inputs.find(block => block.type === 'text' && block.text.startsWith('Execute only the approved '))
      if (task?.type === 'text') {
        if (task.text.includes('approved implementation task')) {
          order.push('implementation')
          await writeFile(join(repository, 'src/export.txt'), 'candidate')
          yield* textResult(JSON.stringify({ outcome: 'Completed', summary: 'scripted writer', problems: [], limitations: ['scripted model'] }))
        } else {
          order.push('review')
          const payload = JSON.parse(task.text.split(String.fromCharCode(10) + 'Task inputs:' + String.fromCharCode(10)).at(-1)!)
          yield* textResult(JSON.stringify({ outcome: 'Passed', briefRevision: 1, snapshotId: payload.snapshot.id, treeId: payload.snapshot.treeId,
            findings: [], checked: ['AC1'], unchecked: [], reason: 'scripted snapshot review', acceptance: [{ id: 'AC1', status: 'Passed', evidence: [{ kind: 'verification', checkIndex: 0, explanation: 'Exact host check passed' }] }] }))
        }
        return
      }
      if (calls.length > 60) throw new Error('Scripted Main did not reach a human decision or terminal phase')
      const state = controller.state
      let name: string, args: object
      if (!state.brief) { name = 'rg_submit_brief'; args = { brief: requirements } }
      else if (state.hostOperation?.status === 'Running' && !state.questions?.some(question => question.kind === 'host-recovery' && question.status === 'pending')) { name = 'rg_wait'; args = { id: state.hostOperation.id, waitMs: 10000 } }
      else if (state.phase === 'Awaiting Approval' && !state.questions?.length) { name = 'rg_start'; args = { operation: 'approval', revision: 1 } }
      else {
        const decision = decisionEvidence(state, [], root.agent.session, 'buttons').pending.find(item => item.availableUserConfirmation)
        const operation = operationEvidence(state, root.agent.session, 'buttons')
        if (decision?.availableUserConfirmation) { name = 'rg_confirm_question'; args = { questionId: decision.questionId, userMessageSeq: decision.availableUserConfirmation.userMessageSeq } }
        else if (operation.availableUserConfirmation && state.operationAuthorization?.status === 'pending') { name = 'rg_confirm_operation'; args = { requestId: state.operationAuthorization.id, userMessageSeq: operation.availableUserConfirmation.userMessageSeq } }
        else if (state.questions?.some(question => needsQuestionRefresh(question))) { const question = state.questions.find(item => needsQuestionRefresh(item))!; name = question.kind === 'approval' ? 'rg_start' : 'rg_recover'; args = question.kind === 'approval' ? { operation: 'approval', revision: question.revision } : {} }
        else if (confirmationQuestions(state).length) {
          if (ctx.sessionProjections.stateOf(root.agent.session, 'userQuestions')!.questions.active.some(item => item.state === 'continued' && item.questions.some(question => question.id === confirmationQuestions(state)[0]!.id))) { yield* textResult('Please select an option and submit in the question card.'); return }
          name = 'ask_user_question'; args = { questions: confirmationQuestions(state) }
        } else if (state.phase === 'Approved' && !state.operationAuthorization) { name = 'rg_request_operation'; args = { kind: 'execution' } }
        else if (execute && state.phase === 'Approved' && state.operationAuthorization?.status === 'granted') { name = 'rg_start'; args = { operation: 'execution' } }
        else { yield* textResult('Workflow phase: ' + state.phase); return }
      }
      calls.push(name)
      yield* toolResult(mode, name, args)
    }
  }
  ctx.llm.registerAdapter(['scripted'], adapter)
  return { f, ctx, root, repository, controller, calls, order }
}