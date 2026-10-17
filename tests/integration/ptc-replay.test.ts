/** Actual Node PTC and AgentLoop replay with native Windows ACL or simulated confinement; scripted responses are not live review. */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { fixture, main } from '../fixtures/runtime.js'
import { brief } from '../fixtures/workflow.js'
import { snapshotSchema, verificationSchema } from '../../src/workflow/types.js'

const exec = promisify(execFile)
const sections = [
  ['Completion', 'completion'], ['Changes', 'changes'], ['Problems', 'problems'],
  ['Verification and review', 'verificationAndReview'], ['Limitations', 'limitations'], ['Follow-up options', 'followUpOptions'],
] as const
const reportFields = z.object({
  completion: z.object({ phase: z.literal('Completed'), handoffCompleted: z.literal(true), currentDeliverableVerified: z.literal(true) }),
  changes: z.unknown(), problems: z.unknown(), verificationAndReview: z.unknown(), limitations: z.unknown(), followUpOptions: z.unknown(),
})

describe('shipped Review-Gated Main PTC turn and durable replay', () => {
  it.each([{ backend: 'simulated', native: false }, { backend: 'Windows ACL', native: true }].filter(test => !test.native || process.platform === 'win32'))('logs Main SDK calls, actual approval/checks, fresh roles, and the six-part final report ($backend)', async ({ native }) => {
    const f = await fixture(undefined, undefined, !native, { bundle: true, commandSimulation: true, mainPtcSimulation: true, rolePtcSimulation: true })
    const repository = join(f.root, 'repository')
    await mkdir(join(repository, 'src'), { recursive: true })
    await writeFile(join(repository, 'src/export.txt'), 'base')
    const outside = join(f.root, 'outside.txt')
    await writeFile(outside, 'outside baseline')
    for (const args of [['init', '--quiet'], ['add', '--', 'src/export.txt'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture baseline']]) {
      await exec('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], { cwd: repository, timeout: 10000 })
    }
    const ctx = await f.start()
    const root = await main(ctx, repository, undefined, 'review-gated', false, { provider: 'scripted', model: 'fixture' })
    await ctx.agentPresets.select(root.agent, 'review-gated')
    const nativeDenied = (path: string, label: string) => 'try {await (await import("node:fs/promises")).writeFile(' + JSON.stringify(path) + ',"unexpected mutation");throw new Error("Unexpected native write")}catch(error){if(error.code!=="EACCES"&&error.code!=="EPERM")throw error;console.log(' + JSON.stringify(label) + ')};'
    const command = "const fs=require('fs');if(fs.readFileSync('src/export.txt','utf8')!=='candidate')process.exit(2);"
      + (native ? 'fs.writeFileSync("generated-check.txt","artifact");try{fs.writeFileSync(' + JSON.stringify(outside) + ',"unexpected check mutation");throw new Error("Unexpected native check write")}catch(error){if(error.code!=="EACCES"&&error.code!=="EPERM")throw error;}' : '')
      + "console.log('fixture check passed')"
    const requirements = { ...brief, allowedPaths: ['src'], maxRepairRounds: 0, executionBudgetMs: 60000,
      verificationCommands: [{ executable: process.execPath, args: ['-e', command], timeoutMs: 60000 }] }
    const program = (native ? nativeDenied(join(repository, 'src/export.txt'), 'Main native write denied') : '')
      + 'try {await tools.write({file_path:"src/export.txt",content:"Main must not write"});throw new Error("Unexpected Main write")} catch(error) {if(error.toolName!=="write")throw error;console.log("Main SDK write denied")};'
      + 'const decision=await tools.ask_user_question({questions:[{id:"fixture-output",question:"Which fixture output is required?",options:[{label:"candidate"},{label:"other"}]}]});if(decision.answers[0].selected[0]!=="candidate")throw new Error("Fixture needs revised requirements");'
      + 'await tools.rg_submit_brief({brief:' + JSON.stringify(requirements) + '});'
      + 'await tools.rg_approve({revision:1});'
      + "console.log('@@RG_REPORT@@'+JSON.stringify(await tools.rg_report({})))"
    const order: string[] = []
    const calls: GenerateOptions[] = []
    const confinement: { role: string; mode: string; enforcement: string }[] = []
    ctx.on('tools/post-execute', async (execution, result, next) => {
      const decision = await next()
      if (execution.name === 'run_code' && execution.agent && !result.isError) {
        const role = ctx.reviewGatedPermissions.of(execution.agent.session)?.role
        const value = z.object({ sandbox: z.object({ mode: z.string(), enforcement: z.string() }) }).parse(result.value)
        if (role) confinement.push({ role, ...value.sandbox })
      }
      return decision
    })
    let rootCalls = 0
    const roleCalls = new Map<string, number>()
    ctx.on('user-questions/request', async request => {
      const approval = request.questions[0]!.options?.some(option => option.label === 'Approve')
      order.push(approval ? 'human approval' : 'human clarification')
      return { answers: [{ id: request.questions[0]!.id, selected: [approval ? 'Approve' : 'candidate'] }] }
    })
    ctx.llm.registerAdapter(['scripted'], new class extends LlmAdapter {
      override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        calls.push(request)
        expect(JSON.stringify(request.messages)).toContain('Native partial enforcement is accepted, not full isolation')
        let answer: string
        if (request.sessionId === root.agent.id) {
          rootCalls++
          if (rootCalls === 1) {
            order.push('Main PTC')
            expect(request.tools?.map(tool => tool.name)).toEqual(['run_code'])
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('fixture-main-ptc'), name: 'run_code', arguments: JSON.stringify({ code: program, description: 'Execute approved fixture workflow', timeoutMs: 120000 }) } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          if ([2, 4, 6].includes(rootCalls)) {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: 'Waiting for a separate exact logged user confirmation before the requested operation.' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Waiting for a separate exact logged user confirmation before the requested operation.' } }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
          if (rootCalls === 3) {
            order.push('Main confirmation PTC')
            const code = 'const status=await tools.rg_status({});const pending=status.decisionEvidence.pending[0];if(!pending?.availableUserConfirmation)throw new Error("Missing logged user confirmation");await tools.rg_confirm_question({questionId:pending.questionId,userMessageSeq:pending.availableUserConfirmation.userMessageSeq});console.log(JSON.stringify(await tools.rg_request_operation({kind:"execution"})))'
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('fixture-main-confirmation-ptc'), name: 'run_code', arguments: JSON.stringify({ code, description: 'Confirm the separately logged requirements decision and request execution permission', timeoutMs: 120000 }) } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          if ([5, 7].includes(rootCalls)) {
            const execution = rootCalls === 5
            order.push(execution ? 'Main execution PTC' : 'Main handoff PTC')
            const code = 'const status=await tools.rg_status({});const evidence=status.operationEvidence;if(!evidence.request||!evidence.availableUserConfirmation)throw new Error("Missing logged operation permission");await tools.rg_confirm_operation({requestId:evidence.request.id,userMessageSeq:evidence.availableUserConfirmation.userMessageSeq});'
              + (execution ? 'await tools.rg_execute({});console.log(JSON.stringify(await tools.rg_request_operation({kind:"handoff"})))' : 'await tools.rg_handoff({});console.log("@@RG_REPORT@@"+JSON.stringify(await tools.rg_report({})))')
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(execution ? 'fixture-main-execution-ptc' : 'fixture-main-handoff-ptc'), name: 'run_code', arguments: JSON.stringify({ code, description: execution ? 'Execute only the separately authorized workflow and request handoff permission' : 'Complete only the separately authorized handoff and report six sections', timeoutMs: 120000 }) } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          const tool = request.messages.findLast(message => message.role === 'tool')
          expect(tool?.role === 'tool' && tool.isError).not.toBe(true)
          const output = tool?.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('') ?? ''
          const encoded = output.slice(output.indexOf('@@RG_REPORT@@') + '@@RG_REPORT@@'.length).split('\n')[0]!
          const report = z.record(z.string(), z.unknown()).parse(JSON.parse(encoded))
          reportFields.parse(report)
          const firstOutput = JSON.stringify(request.messages.filter(message => message.role === 'tool'))
          expect(firstOutput).toContain('Main SDK write denied')
          if (native) {
            expect(firstOutput).toContain('Main native write denied')
            expect(output).toContain('File sandbox enforcement is partial on this host.')
          }
          expect(JSON.stringify(report.limitations)).toContain('Native partial enforcement is accepted, not full isolation')
          expect(Object.keys(report)).toEqual(sections.map(([, key]) => key))
          order.push('Main report')
          answer = sections.map(([heading, key]) => '## ' + heading + '\n\n' + JSON.stringify(report[key], null, 2)).join('\n\n')
        } else {
          const text = request.messages.filter(message => message.role === 'user').flatMap(message => message.content)
            .filter(block => block.type === 'text' && block.text.startsWith('Execute only the approved ')).map(block => block.type === 'text' ? block.text : '').join('')
          expect(JSON.stringify(request.messages)).not.toContain('Main-only private deliberation')
          const role = text.includes('approved implementation task') ? 'implementation' : 'review'
          const count = (roleCalls.get(role) ?? 0) + 1
          roleCalls.set(role, count)
          if (count === 1) {
            order.push(role)
            const shellCode = !native || role !== 'implementation' ? '' : 'const shell=await tools.pwsh({command:"Set-Content -LiteralPath src/export.txt -Value candidate -NoNewline",description:"Write approved private fixture through the isolated native shell"});if(shell.kind!=="foreground"||shell.exitCode!==0||shell.timedOut||shell.signal!==null||shell.sandbox?.enforcement!=="partial")throw new Error("Native shell did not succeed under partial confinement");console.log("Implementation native shell write allowed");'
            const nativeCode = !native ? '' : role === 'implementation'
              ? 'await (await import("node:fs/promises")).writeFile("src/export.txt","candidate");console.log("Implementation native write allowed");' + nativeDenied(outside, 'Implementation outside write denied')
              : nativeDenied('src/export.txt', 'Review native write denied')
            const code = nativeCode + shellCode + (role === 'implementation'
              ? 'await tools.write({file_path:"src/export.txt",content:"candidate"});console.log("implementation SDK wrote candidate")'
              : 'console.log(JSON.stringify(await tools.read({file_path:"src/export.txt"})));try {await tools.write({file_path:"src/export.txt",content:"bad review mutation"});throw new Error("Unexpected Review write")} catch(error) {if(error.toolName!=="write")throw error;console.log("Review SDK write denied")}')
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('fixture-' + role + '-ptc'), name: 'run_code', arguments: JSON.stringify({ code, description: 'Use only the fixed role fixture SDK operations' }) } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          const result = request.messages.findLast(message => message.role === 'tool')
          expect(result?.role === 'tool' && result.isError).not.toBe(true)
          const resultText = JSON.stringify(result)
          if (role === 'implementation') {
            expect(resultText).toContain('implementation SDK wrote candidate')
            if (native) {
              expect(resultText).toContain('Implementation native write allowed')
              expect(resultText).toContain('Implementation native shell write allowed')
              expect(resultText).toContain('Implementation outside write denied')
            }
            answer = JSON.stringify({ outcome: 'Completed', summary: 'Scripted fixture implementation', problems: [], limitations: ['Scripted, not live provider evidence'] })
          } else {
            expect(resultText).toContain('candidate')
            expect(resultText).toContain('Review SDK write denied')
            if (native) expect(resultText).toContain('Review native write denied')
            const payload = z.object({ snapshot: snapshotSchema, verification: verificationSchema, diff: z.string() }).parse(JSON.parse(text.split('Task inputs:\n').at(-1)!))
            expect(payload.verification.checks[0]?.stdout).toBe('fixture check passed\n')
            expect(payload.diff).toContain('+candidate')
            answer = JSON.stringify({ outcome: 'Passed', briefRevision: 1, snapshotId: payload.snapshot.id, treeId: payload.snapshot.treeId, findings: [], acceptance: [{ id: 'AC1', status: 'Passed', evidence: [{ kind: 'verification', checkIndex: 0, explanation: 'Snapshot checks passed' }] }], checked: ['AC1', 'caller', 'test'], unchecked: [], reason: '' })
          }
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Main-only private deliberation: run the approved fixture workflow and report six sections.' }] }))
    await root.agent.whenIdle()
    const question = ctx.reviewGatedJournals.controller(root.agent.session).state.questions!.find(item => item.status === 'service-returned')!
    expect(ctx.reviewGatedJournals.controller(root.agent.session).state.phase).toBe('Awaiting Approval')
    root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({ reviewGatedAnswer: { questionId: question.id, selected: 'Approve' } }) }] }))
    await root.agent.whenIdle()
    for (const kind of ['execution', 'handoff'] as const) {
      const state = ctx.reviewGatedJournals.controller(root.agent.session).state
      expect(state.phase).toBe(kind === 'execution' ? 'Approved' : 'Ready for Handoff')
      const request = state.operationAuthorization!
      expect(request).toMatchObject({ kind, status: 'pending' })
      root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({ reviewGatedOperation: { requestId: request.id, selected: 'Authorize' } }) }] }))
      await root.agent.whenIdle()
    }
    expect(order).toEqual(['Main PTC', 'human clarification', 'human approval', 'Main confirmation PTC', 'Main execution PTC', 'implementation', 'review', 'Main handoff PTC', 'Main report'])
    expect(calls).toHaveLength(12)
    expect(ctx.reviewGatedJournals.view(root.agent.session).state.phase).toBe('Completed')
    expect(await readFile(join(repository, 'src/export.txt'), 'utf8')).toBe('candidate')
    expect(await readFile(outside, 'utf8')).toBe('outside baseline')
    expect(confinement).toEqual([
      { role: 'main', mode: 'read-only', enforcement: native ? 'partial' : 'full' },
      { role: 'main', mode: 'read-only', enforcement: native ? 'partial' : 'full' },
      { role: 'implementation', mode: 'workspace-write', enforcement: native ? 'partial' : 'full' },
      { role: 'review', mode: 'read-only', enforcement: native ? 'partial' : 'full' },
      { role: 'main', mode: 'read-only', enforcement: native ? 'partial' : 'full' },
      { role: 'main', mode: 'read-only', enforcement: native ? 'partial' : 'full' },
    ])
    if (native) expect(confinement).toMatchSnapshot('actual native PTC mode and enforcement')
    const messages = root.agent.session.deriveMessages()
    const final = messages.findLast(message => message.role === 'assistant')
    const text = final?.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('') ?? ''
    expect(text.split('\n').filter(line => line.startsWith('## '))).toMatchSnapshot('model-visible Main report headings')
    await ctx.sessions.flush(root.agent.session)
    const reader = await ctx.sessionPersistence.open(root.agent.id, 'read')
    try {
      const log = await reader.read()
      expect(log.events.some(event => event.type === 'tool/call' && event.data.name === 'run_code')).toBe(true)
      expect(log.events.some(event => event.type === 'tool/result')).toBe(true)
      expect(log.events.some(event => event.type === 'request/header')).toBe(true)
      expect(JSON.stringify(log.events)).toContain('Native partial enforcement is accepted, not full isolation')
      expect(log.events.filter(event => event.type === 'user/message').some(event => JSON.stringify(event.data.content).includes('reviewGatedAnswer'))).toBe(true)
      expect(log.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user' && JSON.stringify(event.data.content).includes('reviewGatedOperation'))).toHaveLength(2)
      if (native) expect(JSON.stringify(log.events)).toContain('File sandbox enforcement is partial on this host.')
    } finally { await reader.close() }
    await root.handle.dispose()
    const resumed = await main(ctx, repository, root.agent.id, 'review-gated', true, { provider: 'scripted', model: 'fixture' })
    expect(resumed.agent.session.deriveMessages()).toEqual(messages)
    expect(ctx.reviewGatedJournals.view(resumed.agent.session).state.phase).toBe('Completed')
    expect(calls).toHaveLength(12)
  })
})
