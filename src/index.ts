/** Scoped Main Agent tools: requirements are approved only through the human answerer. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { mainInstructions } from './main-instructions.js'
import { briefDetails, confirmationQuestions } from './workflow/interaction.js'
import { askDecisionQuestion, confirmationReceipt, needsQuestionRefresh, questionBinding } from './workflow/questions.js'
import { requireOperationPermission, operationEvidence, OperationRequestId } from './workflow/authorization.js'
import { summarize } from './workflow/summary.js'
import type { SummaryLimits } from './workflow/summary.js'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from './storage/support.js'
import type {} from './workflow/execution.js'
import type { HostTasks } from './workflow/tasks.js'
import type {} from './verification/runner.js'
import type {} from './roles/runner.js'
import { RoleResultError } from './roles/output.js'
import { submittedBriefSchema, HostOperationId } from './workflow/types.js'
import { validatePath } from './git/snapshots.js'
import { verificationCompatibility } from './verification/compatibility.js'
import { buildReport, formatReport } from './workflow/report.js'
import type { MainReport } from './workflow/report.js'

type JsonValue = z.infer<ReturnType<typeof z.json>>

export const name = 'review-gated'
export const inject = ['tools', 'systemPrompt', 'agents', 'userQuestions', 'reviewGatedJournals']
export interface Config extends SummaryLimits { sectionOrder: number; diagnosticBudgetMs: number }
export const Config: Schema<Config> = Schema.object({ sectionOrder: Schema.number().default(80), diagnosticBudgetMs: Schema.number().min(1).max(2147483647).step(1).default(300000),
  summaryTextChars: Schema.number().min(64).max(8192).step(1).default(512), summaryItems: Schema.number().min(1).max(128).step(1).default(8) })
export { WorkflowController } from './workflow/controller.js'

export function apply(ctx: Context, config: Config): void {
  const journals = ctx.reviewGatedJournals
  const initializeFresh = async (agent: Agent): Promise<void> => {
    if (!agent.session.header.isSeeded && ctx.agents.roots().includes(agent)) await journals.initialize(agent.session)
  }
  ctx.on('agent/created', async ({ agent, source }) => {
    if (source === 'startup') await initializeFresh(agent)
  })
  ctx.effect(() => ctx.root.on('agent-preset/selected', async sessionId => {
    await Promise.resolve()
    if (shutdown.signal.aborted) return
    const agent = ctx.agents.get(sessionId)
    const scope = scopeOf(ctx)
    if (agent && scope && scopeChainOf(scopeOf(agent.ctx)).includes(scope)) {
      try { await initializeFresh(agent) }
      catch (error) { ctx.logger.warn('Review-Gated selection initialization refused: ' + String(error)) }
    }
  }))
  const shutdown = new AbortController()
  const pending = new Map<Promise<unknown>, Agent>()
  const actorLifetimes = new WeakMap<Agent, AbortController>()
  ctx.effect(() => async () => {
    shutdown.abort(new Error('Review-Gated preset unloaded'))
    await Promise.allSettled([...pending.keys()])
  })
  const actorSignal = (agent: Agent): AbortSignal => {
    let lifetime = actorLifetimes.get(agent)
    if (!lifetime) {
      lifetime = new AbortController()
      actorLifetimes.set(agent, lifetime)
      const owned = lifetime
      agent.ctx.effect(() => async () => {
        owned.abort(new Error('Main Agent disposed'))
        await Promise.allSettled([...pending].filter(([, owner]) => owner === agent).map(([task]) => task))
      })
    }
    return lifetime.signal
  }
  const json = (value: unknown): JsonValue => z.json().parse(JSON.parse(JSON.stringify(value)))
  const track = async <T>(agent: Agent, run: () => Promise<T>): Promise<JsonValue> => {
    const signal = AbortSignal.any([shutdown.signal, journals.signal, actorSignal(agent)])
    const task = Promise.resolve().then(() => { signal.throwIfAborted(); return run() })
    pending.set(task, agent)
    try { return json(await task) } finally { pending.delete(task) }
  }
  const toolView = (agent: Agent, includeCard = true) => {
    const view = journals.view(agent.session)
    const summary = summarize(view, agent.session, config, journals.confirmationMode)
    if (journals.confirmationMode === 'legacy-json') return summary
    const questions = confirmationQuestions(view.state)
    const pendingQuestion = view.state.questions?.find(question => ['pending', 'service-returned'].includes(question.status) && question.binding === questionBinding(view.state))
    const projected = questions.map(({ multi_select, ...question }) => ({ ...question, multiSelect: multi_select }))
    const replaceCard = ctx.get('sessionProjections')?.stateOf(agent.session, 'userQuestions')?.questions.active.some(card => card.questions.some(question => question.id === questions[0]?.id) && !isDeepStrictEqual(card.questions, projected)) ?? false
    return { ...summary, ...(includeCard ? { uiConfirmation: { mode: 'buttons', questions, replaceCard,
      refreshDecision: pendingQuestion && needsQuestionRefresh(pendingQuestion) ? { kind: pendingQuestion.kind, revision: pendingQuestion.revision } : null } } : {}) }
  }
  const observedTask = async (agent: Agent, task: ReturnType<HostTasks['start']>): Promise<JsonValue> => json({ ...(await task), workflow: toolView(agent, false) })
  const operation = <T>(agent: Agent, run: () => Promise<T>): Promise<JsonValue> => track(agent, () => journals.operation(agent.session, run))
  const owner = (exec: ToolExecution): Agent => {
    shutdown.signal.throwIfAborted()
    const agent = exec.agent
    if (!agent || ctx.agents.get(agent.id) !== agent || !ctx.agents.roots().includes(agent))
      throw new Error('Only the live Main Agent can operate the review-gated workflow')
    return agent
  }
  ctx.systemPrompt.section({ name: 'review-gated-rules', order: config.sectionOrder, interpolate: false,
    text: mainInstructions(journals.confirmationMode) })
  ctx.systemPrompt.context({ name: 'review-gated-state', order: config.sectionOrder, text: '' })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    // A selection can still be committing its initial row when the first turn assembles.
    if (agent) await initializeFresh(agent)
    const assembly = await next()
    const text = agent ? 'Review-Gated workflow state:\n' + JSON.stringify(toolView(agent, false)) : ''
    return { ...assembly, contexts: assembly.contexts.map(entry => entry.name === 'review-gated-state' ? { ...entry, text } : entry) }
  })
  const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
  ctx.tools.register(defineTool({
    name: 'ask_user_question', description: 'Show the exact pending Review-Gated decision as a persistent question card. Pass uiConfirmation.questions unchanged. Return pending immediately, then finish the turn; a real UI reply wakes Main automatically. Never ask the user to copy JSON. General clarification questions remain ordinary questions.',
    parameters: {
      questions: { type: 'array', required: true, description: 'Exact uiConfirmation.questions for a pending workflow decision.', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, question: { type: 'string', required: true },
        options: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string', required: true }, description: { type: 'string' } } } },
        multi_select: { type: 'boolean' },
      } } },
      timeout: { type: 'integer', description: 'Compatibility parameter for continued question cards; bound workflow decisions always return pending immediately.' },
    }, output,
    execute: async (args, exec) => {
      const agent = owner(exec), state = journals.controller(agent.session).state, expected = confirmationQuestions(state)
      exec.signal.throwIfAborted()
      if (journals.confirmationMode === 'buttons' && expected.length) {
        if (!isDeepStrictEqual(args.questions, expected)) throw new Error('Show uiConfirmation.questions unchanged; the displayed decision must match the approved scope')
        const projection = ctx.get('sessionProjections')?.stateOf(agent.session, 'userQuestions')
        if (!projection) throw new Error('The durable question-card projection is unavailable')
        if (projection.questions.active.some(item => item.callId !== exec.callId && isDeepStrictEqual(item.questions, expected.map(({ multi_select, ...question }) => ({ ...question, multiSelect: multi_select }))))) throw new Error('The confirmation card is already open; wait for its user reply instead of opening another')
        return json({ pending: true, callId: exec.callId })
      }
      if (journals.confirmationMode === 'buttons') {
        z.array(z.object({ id: z.string().min(1), question: z.string().min(1) })).min(1).parse(args.questions)
        return json({ pending: true, callId: exec.callId })
      }
      const questions = z.array(z.object({ id: z.string(), question: z.string(), options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(), multi_select: z.boolean().optional() })).min(1).parse(args.questions)
      return json(await ctx.userQuestions.ask({ agent, signal: exec.signal, questions: questions.map(question => ({ id: question.id, question: question.question, ...(question.options === undefined ? {} : { options: question.options.map(option => ({ label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })) }), ...(question.multi_select === undefined ? {} : { multiSelect: question.multi_select }) })) }))
    },
  }))
  const decideApproval = async (agent: Agent, revision: number, signal: AbortSignal) => {
    const controller = journals.controller(agent.session), state = controller.state
    if (!['Awaiting Approval', 'Approved', 'Implemented', 'Staged', 'Needs Changes', 'Paused', 'Ready for Handoff'].includes(state.phase) || !state.brief || state.brief.revision !== revision || (state.phase !== 'Awaiting Approval' && !state.approval?.approved) || state.activeRunId || state.executionWindow) throw new Error('No matching inactive requirement revision can be confirmed')
    if (state.brief.questions.length) throw new Error('Resolve open requirement questions before approval')
    await askDecisionQuestion(controller, agent.session, 'approval', {
      question: 'Approve this exact development brief?', detail: journals.confirmationMode === 'buttons' ? briefDetails(state.brief) + String.fromCharCode(10, 10) + 'Command compatibility: advisory only; backend capability unknown; no check or probe has run.' + String.fromCharCode(10) + verificationCompatibility(state.brief).warnings.map(item => 'Command ' + (item.commandIndex + 1) + ': ' + item.message).join(String.fromCharCode(10)) : '# Review-Gated requirements' + String.fromCharCode(10, 10) + JSON.stringify(state.brief, null, 2) + String.fromCharCode(10, 10) + 'Verification compatibility advisories (not executed checks):' + String.fromCharCode(10) + JSON.stringify(verificationCompatibility(state.brief), null, 2),
      options: [{ label: 'Approve' }, { label: 'Reject and revise' }], intent: { kind: 'plan-review', approve: 'Approve' },
    }, question => ctx.userQuestions.ask({ agent, signal, questions: [question] }), signal, journals.confirmationMode)
    return { needsConfirmation: true, ...toolView(agent) }
  }
  ctx.tools.register(defineTool({
    name: 'rg_start', description: 'Start a Main-owned approval, execution, or read-only diagnostic operation and immediately return its durable ID. Use rg_wait in separate bounded calls. A caller timeout does not cancel the task; rg_cancel cancels and drains it. Never approves requirements implicitly.',
    parameters: {
      operation: { type: 'string', required: true, description: 'Exactly approval, execution, or diagnostic.' },
      revision: { type: 'integer', description: 'Required for approval; the submitted requirement revision.' },
      question: { type: 'string', description: 'Required for diagnostic; the read-only investigation question.' },
    }, output,
    execute: async (args, exec) => {
      const agent = owner(exec), tasks = ctx.get('reviewGatedTasks')
      if (!tasks) throw new Error('Host task support is not mounted')
      exec.signal.throwIfAborted()
      const kind = z.enum(['approval', 'execution', 'diagnostic']).parse(args.operation)
      const state = journals.controller(agent.session).state
      if (kind === 'approval') {
        const revision = z.number().int().positive().parse(args.revision)
        if (!['Awaiting Approval', 'Approved', 'Implemented', 'Staged', 'Needs Changes', 'Paused', 'Ready for Handoff'].includes(state.phase) || !state.brief || state.brief.revision !== revision || state.brief.questions.length || (state.phase !== 'Awaiting Approval' && !state.approval?.approved) || state.activeRunId || state.executionWindow) throw new Error('No complete matching requirement revision awaits approval')
        return observedTask(agent, tasks.start(agent, kind, AbortSignal.any([actorSignal(agent), shutdown.signal]), signal => journals.operation(agent.session, async () => {
          await decideApproval(agent, revision, signal)
          return { phase: journals.controller(agent.session).state.phase, needsConfirmation: true }
        })))
      }
      if (kind === 'execution') {
        requireOperationPermission(state, agent.session, 'execution', journals.confirmationMode)
        if (!['Approved', 'Implemented', 'Staged', 'Needs Changes'].includes(state.phase) || !state.approval?.approved) throw new Error('Execute only an approved inactive workflow')
        const execution = ctx.get('reviewGatedExecution')
        if (!execution) throw new Error('Execution support is not mounted')
        return observedTask(agent, tasks.start(agent, kind, AbortSignal.any([actorSignal(agent), shutdown.signal]), async signal => ({ phase: (await execution.execute(agent, signal)).phase })))
      }
      if (state.activeRunId || !['Clarifying', 'Awaiting Approval', 'Approved', 'Paused', 'Needs Changes'].includes(state.phase)) throw new Error('Diagnostic requires an inactive workflow')
      const question = z.string().trim().min(1).parse(args.question), roles = ctx.get('reviewGatedRoles')
      if (!roles) throw new Error('Diagnostic role support is not mounted')
      return observedTask(agent, tasks.start(agent, kind, AbortSignal.any([actorSignal(agent), shutdown.signal]), async signal => {
        try { return json(await roles.diagnose({ parent: agent, question, budgetMs: config.diagnosticBudgetMs, signal })) }
        catch (error) {
          if (error instanceof RoleResultError && error.kind !== 'semantic-validation') await journals.controller(agent.session).apply({ type: 'role-result-rejected', failure: { role: error.role, runId: error.runId, kind: error.kind, issues: error.issues, issueCount: error.issueCount, logReference: { sessionId: error.runId } } })
          throw error
        }
      }))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rg_wait', description: 'Read or briefly wait for this Main workflow task. A timed-out or cancelled wait does not cancel the host task. Running after a service restart requires human recovery, never automatic resumption.',
    parameters: { id: { type: 'string', required: true, description: 'The durable ID returned by rg_start.' }, waitMs: { type: 'integer', description: 'Finite wait in milliseconds; zero reads immediately. The host caps this value.' } }, output,
    execute: async (args, exec) => {
      const agent = owner(exec), tasks = ctx.get('reviewGatedTasks')
      if (!tasks) throw new Error('Host task support is not mounted')
      return json({ ...(await tasks.wait(agent, HostOperationId(z.string().uuid().parse(args.id)), z.number().int().nonnegative().parse(args.waitMs ?? 0), exec.signal)), workflow: toolView(agent, false) })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rg_confirm_question', description: 'Record one current approval or recovery from the genuine logged reply to its confirmation card (or exact user input in explicitly configured legacy mode). Main supplies only the question ID and existing message sequence, never the answer or its source. Does not execute, hand off or reset scope/budget.',
    parameters: { questionId: { type: 'string', required: true, description: 'Current question ID from decisionEvidence.pending.' },
      userMessageSeq: { type: 'integer', required: true, description: 'Actual logged reply sequence from availableUserConfirmation; never invent a sequence or ask the user to supply it.' } }, output,
    execute: async (args, exec) => {
      const agent = owner(exec)
      return track(agent, async () => {
        const questionId = z.string().min(1).max(256).parse(args.questionId), seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(args.userMessageSeq)
        const execution = ctx.get('reviewGatedExecution'), signal = AbortSignal.any([exec.signal, journals.signal, shutdown.signal, actorSignal(agent)])
        if (execution) { await execution.confirmQuestion(agent, questionId, seq, signal); return toolView(agent) }
        return journals.operation(agent.session, async () => {
          const controller = journals.controller(agent.session), question = controller.state.questions?.find(item => item.id === questionId)
          if (!question || question.kind !== 'approval' || controller.state.snapshot) throw new Error('Question confirmation requires execution support for repository evidence')
          const confirmed = confirmationReceipt(agent.session, question, seq)
          signal.throwIfAborted()
          await controller.apply({ type: 'question-confirmed', questionId, ...confirmed })
          return toolView(agent)
        })
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rg_status', description: 'Read a compact workflow view, current confirmation card and available logged reply sequences. detail=true retrieves the complete journal view. Does not approve or advance anything.',
    parameters: { detail: { type: 'boolean', description: 'Return complete requirements, question details and check/review data only when needed.' } }, output,
    execute: async (args, exec) => {
      const view = journals.view(owner(exec).session)
      const verification = ctx.get('reviewGatedVerification')
      return json({ ...(args.detail === true ? { ...view, operationEvidence: operationEvidence(view.state, owner(exec).session, journals.confirmationMode) } : toolView(owner(exec))), effectiveLimits: { verification: args.detail === true ? verification?.limitsFor(view.state.brief) ?? null : { commandCount: view.state.brief?.verificationCommands.length ?? 0 },
        executionBudgetMs: view.state.brief?.executionBudgetMs ?? null,
        remainingExecutionMs: view.state.brief ? Math.max(0, view.state.brief.executionBudgetMs - Math.max(view.state.executionMs, view.state.executionWallMs ?? 0)) : null,
        executionWindowUnresolved: view.state.executionWindow !== undefined } })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rg_brief', description: 'Read the complete currently submitted brief without changing state.', parameters: {}, output,
    execute: async (_args, exec) => json({ brief: journals.controller(owner(exec).session).state.brief }),
  }))
  ctx.tools.register(defineTool({
    name: 'rg_question', description: 'Read one original question, complete detail/options, service answer and linked receipt.',
    parameters: { questionId: { type: 'string', required: true, description: 'Question identifier from the status summary.' } }, output,
    execute: async (args, exec) => {
      const id = z.string().min(1).max(256).parse(args.questionId), view = journals.view(owner(exec).session)
      const question = view.state.questions?.find(item => item.id === id)
      if (!question) throw new Error('No retained question has this identifier; consult authoritative history for older records')
      return json({ question })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rg_request_operation', description: 'Run bounded read-only repository preflight before preparing a separate one-use execution or handoff permission. A blocked preflight returns diagnostics and no usable card. Inspect operationEvidence.preflight and nextStep. In button mode, show the resulting uiConfirmation.questions unchanged with ask_user_question. Does not start a task, role, check or handoff. Ask only when the user requested further action.',
    parameters: { kind: { type: 'string', required: true, description: 'Exactly execution or handoff; execution never includes handoff.' } }, output,
    execute: async (args, exec) => {
      const agent = owner(exec), execution = ctx.get('reviewGatedExecution')
      if (!execution) throw new Error('Execution support is not mounted')
      return track(agent, async () => { const evidence = await execution.requestOperation(agent, z.enum(['execution', 'handoff']).parse(args.kind), AbortSignal.any([exec.signal, actorSignal(agent), shutdown.signal, journals.signal])); return journals.confirmationMode === 'buttons' ? toolView(agent) : evidence })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rg_confirm_operation', description: 'Record Authorize or Decline only from the actual latest user reply to the current operation card (or exact user input in explicitly configured legacy mode). Does not execute or hand off. Authorization permits only its exact one-use mode; requirement confirmation is insufficient.',
    parameters: { requestId: { type: 'string', required: true, description: 'Current operation request ID.' }, userMessageSeq: { type: 'integer', required: true, description: 'Actual logged input sequence from operationEvidence.availableUserConfirmation.' } }, output,
    execute: async (args, exec) => {
      const agent = owner(exec), execution = ctx.get('reviewGatedExecution')
      if (!execution) throw new Error('Execution support is not mounted')
      return track(agent, async () => {
        await execution.confirmOperation(agent, OperationRequestId(z.string().uuid().parse(args.requestId)), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(args.userMessageSeq), AbortSignal.any([exec.signal, actorSignal(agent), shutdown.signal, journals.signal]))
        return toolView(agent)
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rg_submit_brief', description: 'Submit a complete requirements brief or its next revision. Include explicit scope, acceptance criteria, verification commands, repair limit, execution budget, and unresolved questions. Submission alone approves nothing.',
    parameters: { brief: { type: 'json', required: true, description: 'Complete task brief; no implicit limits or approval flags. JSON schema: ' + JSON.stringify(z.toJSONSchema(submittedBriefSchema)) } }, output,
    execute: async (args, exec) => {
      const agent = owner(exec)
      const brief = submittedBriefSchema.parse(args.brief)
      for (const path of brief.allowedPaths) validatePath(path, true)
      for (const path of brief.generatedPaths ?? []) validatePath(path)
      return operation(agent, async () => {
        await journals.controller(agent.session).apply({ type: 'requirements-submitted', brief })
        return toolView(agent)
      })
    },
  }))
  for (const action of ['execute', 'handoff'] as const) ctx.tools.register(defineTool({
    name: 'rg_' + action,
    description: action === 'execute'
      ? 'Run the approved implementation, snapshot checks, independent review, and bounded repairs. Stop on uncertainty or failed checks. Does not commit, push, or perform final handoff.'
      : 'Re-check the current Passed snapshot and complete handoff. Reject changed HEAD, index, source, or untracked files. Never commits or pushes.',
    parameters: {}, output,
    execute: async (_args, exec) => {
      const agent = owner(exec)
      const execution = ctx.get('reviewGatedExecution')
      if (!execution) throw new Error('Review-Gated execution support is not mounted')
      return track(agent, async () => {
        const signal = AbortSignal.any([exec.signal, journals.signal, shutdown.signal, actorSignal(agent)])
        await execution[action](agent, signal)
        return toolView(agent)
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rg_report', description: 'Return the six-part factual Main report. Separately re-check current Git snapshot currency; never upgrade incomplete or scripted review evidence into live-model success.',
    parameters: {}, output: { ...output, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: formatReport(value as MainReport) }] },
    execute: async (_args, exec) => {
      const agent = owner(exec)
      return track(agent, async () => {
        const execution = ctx.get('reviewGatedExecution')
        const signal = AbortSignal.any([exec.signal, journals.signal, shutdown.signal, actorSignal(agent)])
        return execution ? execution.report(agent, signal) : buildReport(journals.view(agent.session), { status: 'not-checked', reason: 'Git execution support is not mounted.' }, agent.session)
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rg_recover', description: 'Open a recovery decision; phase stays unchanged until rg_confirm_question records its genuine logged user reply. In button mode show uiConfirmation.questions unchanged and wait for the card reply. Also reconfirms unchanged historical Staged recovery. Host-task quiescence and unresolved-window recovery are separate decisions; unresolved execution consumes unknown remaining budget. Never starts execution.',
    parameters: {}, output,
    execute: async (_args, exec) => {
      const agent = owner(exec), execution = ctx.get('reviewGatedExecution')
      if (!execution) throw new Error('Review-Gated execution support is not mounted')
      return track(agent, async () => {
        const signal = AbortSignal.any([exec.signal, journals.signal, shutdown.signal, actorSignal(agent)])
        if (await ctx.get('reviewGatedTasks')?.recover(agent, signal)) return { needsConfirmation: true, ...toolView(agent) }
        await execution.recover(agent, signal)
        return { decision: 'awaiting-user-confirmation', needsConfirmation: true, ...toolView(agent) }
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rg_cancel', description: 'Abort the Main-owned live execution, drain roles and commands, then cancel the task without reverting staged or working files. Unresolved old processes require rg_recover first.',
    parameters: { reason: { type: 'string', required: true, description: 'Explanation of this Main cancellation request; this is not human approval evidence.' } }, output,
    execute: async (args, exec) => {
      const agent = owner(exec), execution = ctx.get('reviewGatedExecution')
      if (!execution) throw new Error('Review-Gated execution support is not mounted')
      const reason = z.string().min(1).parse(args.reason)
      return track(agent, async () => {
        await execution.cancel(agent, reason, AbortSignal.any([exec.signal, journals.signal, shutdown.signal, actorSignal(agent)]))
        return toolView(agent)
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rg_approve', description: 'Ask and record requirement confirmation. Returns needsConfirmation until rg_confirm_question records its genuine logged user reply. In button mode show uiConfirmation.questions unchanged with ask_user_question, then finish the turn and wait. Also reconfirms unchanged inactive historical approval without revising requirements or resetting budget. Prefer rg_start(operation=approval) and bounded rg_wait.',
    parameters: { revision: { type: 'integer', required: true, description: 'The currently submitted requirement revision.' } }, output,
    execute: async (args, exec) => {
      const agent = owner(exec)
      return operation(agent, () => decideApproval(agent, args.revision, AbortSignal.any([journals.signal, shutdown.signal, actorSignal(agent), exec.signal])))
    },
  }))
}
