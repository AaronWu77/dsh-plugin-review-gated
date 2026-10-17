/** Real Loader and Git: cards follow preflight; no blocked observation starts a role. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { fixture, main, call, confirm, permission } from '../fixtures/runtime.js'
import { brief } from '../fixtures/workflow.js'
import { confirmationQuestions } from '../../dist/workflow/interaction.js'
import { WorkflowExecution, Config } from '../../dist/workflow/execution.js'
import type { HostWorld } from '../../dist/security/host-world.js'
import { PreflightId } from '../../dist/workflow/preflight.js'
import { OperationRequestId } from '../../dist/workflow/authorization.js'
import { questionBinding } from '../../dist/workflow/questions.js'
import { operationEvidence } from '../../dist/workflow/authorization.js'
const signal = () => new AbortController().signal
const testConfig=(snapshotParent:string,preflightTimeoutMs:number)=>Config({snapshotParent,preflightTimeoutMs,gitExecutable:'git',timeoutMs:10000,integrityTimeoutMs:120000,maxOutputBytes:1024*1024,maxFileBytes:16*1024*1024,maxTreeEntries:10000,maxTreeBytes:64*1024*1024,maxMetadataEntries:100000})
const human = (agent: Awaited<ReturnType<typeof main>>['agent'], text: string) => agent.session.append('user/message', createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}),{surfaceOp:'append'})
async function setup(preflightTimeoutMs?: number) {
  const f=await fixture(undefined,'main',true,preflightTimeoutMs===undefined?{}:{preflightTimeoutMs}), repository=join(f.root,'repository')
  await mkdir(join(repository,'src'),{recursive:true})
  await writeFile(join(repository,'src/check.js'),'export const value = 1\n')
  const run = async (args: string[]) => promisify(execFile)('git', ['-c','core.autocrlf=false','-c','core.hooksPath='+(process.platform==='win32'?'NUL':'/dev/null'),...args],{cwd:repository,timeout:10000,env:{...process.env,GIT_CONFIG_GLOBAL:'',GIT_CONFIG_SYSTEM:''}})
  await run(['init','--quiet']);await run(['add','--','src/check.js']);await run(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--quiet','-m','fixture'])
  const ctx=await f.start(),root=await main(ctx,repository)
  root.scoped.tools.presentAs('native')
  ctx.on('user-questions/request',async request=>({answers:[{id:request.questions[0]!.id,selected:['Approve']}]}))
  const current={...brief,allowedPaths:['src'],verificationCommands:[{executable:'node',args:['--version'],timeoutMs:1000}],executionBudgetMs:60000}
  expect((await call(root.scoped,root.agent,'rg_submit_brief',{brief:current})).isError).not.toBe(true)
  expect((await call(root.scoped,root.agent,'rg_approve',{revision:1})).isError).not.toBe(true)
  const controller=ctx.reviewGatedJournals.controller(root.agent.session)
  expect((await confirm(root.scoped,root.agent,controller.state.questions![0]!.id,'Approve')).result.isError).not.toBe(true)
  return {f,repository,ctx,root,run,controller}
}
describe('repository preflight before operation permission',()=>{
  it('accepts safe per-worktree settings and displays the exact baseline before a card',async()=>{
    const {ctx,root,run,controller}=await setup()
    await run(['config','extensions.worktreeConfig','true'])
    await run(['config','--worktree','core.hooksPath','unused-hooks'])
    const result=await ctx.reviewGatedExecution.requestOperation(root.agent,'execution',signal())
    expect(result.preflight?.status).toBe('passed')
    const request=controller.state.operationAuthorization!
    expect(request.preflight?.head).toMatch(/^[a-f0-9]{40,64}$/)
    const cards=confirmationQuestions(controller.state)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.options[0]!.description).toContain(request.preflight!.head)
    expect(cards[0]!.options[0]!.description).toContain(request.preflight!.repository)
    expect(controller.state.preflightMs).toBeGreaterThan(0)
    expect(controller.state.executionMs).toBe(0)
  })
  it('refuses unsupported effective configuration before publishing an Authorize card',async()=>{
    const {ctx,root,run,controller}=await setup()
    await run(['config','filter.fixture.clean','do-not-run-this'])
    const roles=vi.spyOn(ctx.reviewGatedRoles,'run')
    const result=await ctx.reviewGatedExecution.requestOperation(root.agent,'execution',signal())
    expect(result.preflight?.status).toBe('blocked')
    expect(result.preflight?.issues.map(issue=>issue.message).join(' ')).toContain('filter.fixture.clean')
    expect(controller.state.operationAuthorization).toBeUndefined()
    expect(confirmationQuestions(controller.state)).toEqual([])
    expect(result.nextStep).toContain('Resolve')
    expect(roles).not.toHaveBeenCalled()
    expect(controller.state.executionWindow).toBeUndefined()
  })
  it('rejects nested repository scope before requesting authorization',async()=>{
    const {ctx,root,run,controller,repository}=await setup()
    await mkdir(join(repository,'src/nested'))
    await run(['init','--quiet','src/nested'])
    const result=await ctx.reviewGatedExecution.requestOperation(root.agent,'execution',signal())
    expect(result.preflight?.status).toBe('blocked')
    expect(confirmationQuestions(controller.state)).toEqual([])
    expect(controller.state.operationAuthorization).toBeUndefined()
  })
  it('records a failed baseline recheck and the observed real reply without granting permission',async()=>{
    const {ctx,root,run,controller}=await setup()
    await ctx.reviewGatedExecution.requestOperation(root.agent,'execution',signal())
    const request=controller.state.operationAuthorization!
    const input=human(root.agent,JSON.stringify({reviewGatedOperation:{requestId:request.id,selected:'Authorize'}}))
    await run(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','--quiet','-m','moved-baseline'])
    await expect(ctx.reviewGatedExecution.confirmOperation(root.agent,request.id,input.seq,signal())).rejects.toThrow('baseline changed')
    expect(controller.state.operationAuthorization?.status).toBe('pending')
    expect(controller.state.operationAuthorization?.receipt).toBeUndefined()
    expect(controller.state.repositoryPreflight).toMatchObject({status:'blocked',observedConfirmation:{seq:input.seq,selected:'Authorize'}})
    expect(confirmationQuestions(controller.state)).toEqual([])
    expect(operationEvidence(controller.state,root.agent.session).availableUserConfirmation).toBeNull()
    const next=await ctx.reviewGatedExecution.requestOperation(root.agent,'execution',signal())
    expect(next.preflight?.status).toBe('passed')
    expect(controller.state.operationAuthorization?.id).not.toBe(request.id)
    expect(controller.state.operationAuthorization?.preflight?.head).not.toBe(request.preflight?.head)
  })
  it('refuses execution if a different clean HEAD appears after authorization, before consuming it',async()=>{
    const {ctx,root,run,controller}=await setup()
    await permission(root.scoped,root.agent,'execution')
    const roles=vi.spyOn(ctx.reviewGatedRoles,'run')
    await run(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','--quiet','-m','after-authorization'])
    await expect(ctx.reviewGatedExecution.execute(root.agent,signal())).rejects.toThrow('baseline changed')
    expect(controller.state.operationAuthorization?.status).toBe('granted')
    expect(controller.state.executionWindow).toBeUndefined()
    expect(controller.state.repositoryPreflight?.status).toBe('blocked')
    expect(roles).not.toHaveBeenCalled()
  })
  it('persists structured real Git failures including high-resolution timing rather than losing the failure',async()=>{
    const {ctx,root,controller,repository}=await setup()
    await writeFile(join(repository,'.git','refs','heads','broken-fixture'),'f'.repeat(40)+'\n',{flag:'wx'})
    const result=await ctx.reviewGatedExecution.requestOperation(root.agent,'execution',signal())
    expect(result.preflight?.status).toBe('blocked')
    const diagnostic=result.preflight?.issues.find(issue=>issue.diagnostic)?.diagnostic
    expect(diagnostic).toMatchObject({kind:'exit',timedOut:false,aborted:false})
    expect(diagnostic?.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(diagnostic?.exitCode).not.toBe(0)
    expect(diagnostic?.stderr.length).toBeGreaterThan(0)
    expect(controller.state.operationAuthorization).toBeUndefined()
    expect(confirmationQuestions(controller.state)).toEqual([])
  })
  it('records total-preflight timeout and drains the interrupted inspection without execution charges',async()=>{
    const {ctx,root,controller,f}=await setup()
    let aborted=false
    const resolveExecutable: HostWorld['resolveExecutable']=async(_executable,_cwd,signal)=>{
      await new Promise<void>((_resolve,reject)=>{
        const stop=()=>{aborted=true;reject(signal?.reason)}
        if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true})
      })
      throw new Error('Unreachable completed inspection')
    }
    const execution=new WorkflowExecution(ctx.extend({reviewGatedHostWorld:{...ctx.reviewGatedHostWorld,resolveExecutable}}),testConfig(f.root,40))
    try {
      const result=await execution.requestOperation(root.agent,'execution',signal())
      expect(aborted).toBe(true)
      expect(result.preflight).toMatchObject({status:'blocked',issues:[{code:'preflight-total-timeout'}]})
      expect(controller.state.executionMs).toBe(0)
      expect(controller.state.executionWindow).toBeUndefined()
      expect(confirmationQuestions(controller.state)).toEqual([])
    } finally {await execution.close()}
  })
  it('settles a previous unfinished preflight conservatively before an explicit new request',async()=>{
    const {ctx,root,controller}=await setup()
    const before=controller.state
    await controller.apply({type:'repository-preflight-recorded',preflight:{id:PreflightId(randomUUID()),requestId:OperationRequestId(randomUUID()),kind:'execution',revision:1,scopeBinding:questionBinding(before),status:'running',startedAt:Date.now(),durationMs:0,baseline:null,limits:{commandTimeoutMs:1000,integrityTimeoutMs:2000,totalTimeoutMs:3000},issues:[]}})
    const result=await ctx.reviewGatedExecution.requestOperation(root.agent,'execution',signal())
    expect(result.preflight?.status).toBe('passed')
    expect(controller.state.preflightMs).toBeGreaterThanOrEqual(3000)
    expect(controller.state.executionMs).toBe(0)
    expect(controller.state.operationAuthorization?.status).toBe('pending')
  })
  it('reserves one repository before final preflight without consuming permission or charging a conflicting Main',async()=>{
    const {ctx,root,controller,repository,f}=await setup()
    await permission(root.scoped,root.agent,'execution')
    const other=await main(ctx,repository)
    other.scoped.tools.presentAs('native')
    expect((await call(other.scoped,other.agent,'rg_submit_brief',{brief})).isError).toBe(false)
    expect((await call(other.scoped,other.agent,'rg_approve',{revision:1})).isError).toBe(false)
    const otherController=ctx.reviewGatedJournals.controller(other.agent.session)
    await confirm(other.scoped,other.agent,otherController.state.questions![0]!.id,'Approve')
    const entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>(), cancellation=new AbortController()
    const originalResolve=ctx.reviewGatedHostWorld.resolveExecutable.bind(ctx.reviewGatedHostWorld)
    const resolveExecutable: HostWorld['resolveExecutable']=async(...args)=>{entered.resolve();await release.promise;return originalResolve(...args)}
    const execution=new WorkflowExecution(ctx.extend({reviewGatedHostWorld:{...ctx.reviewGatedHostWorld,resolveExecutable}}),testConfig(f.root,180000))
    const activity=execution.execute(root.agent,cancellation.signal)
    const completion=expect(activity).rejects.toThrow()
    try {
      await Promise.race([entered.promise,activity.then(()=>{throw new Error('Execution finished before inspection barrier')})])
      await expect(execution.requestOperation(other.agent,'execution',signal())).rejects.toThrow('Another workflow owns')
      expect(otherController.state.operationAuthorization).toBeUndefined()
      expect(otherController.state.executionMs).toBe(0)
      expect(otherController.state.executionWindow).toBeUndefined()
    } finally {cancellation.abort(new Error('Fixture cancellation after conflict observation'));release.resolve();try{await completion}finally{await execution.close()}}
    expect(controller.state.operationAuthorization?.status).toBe('granted')
    expect(controller.state.executionWindow).toBeUndefined()
    expect(controller.state.executionWallMs??0).toBe(0)
  })
  it('rejects glob and full-review exclusions on new briefs without changing prior approval',async()=>{
    const {root,controller}=await setup()
    const previous=controller.state
    for(const generatedPaths of [['src/*.js'],['.']]) {
      const result=await call(root.scoped,root.agent,'rg_submit_brief',{brief:{...brief,revision:2,generatedPaths}})
      expect(result.isError).toBe(true)
      expect(controller.state).toEqual(previous)
    }
  })
})
