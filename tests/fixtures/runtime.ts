/** Real YAML/app Loader plus built external plugin, without real-model or browser credentials. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { stringify } from 'yaml'
import { afterEach, expect } from 'vitest'
import { boot, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '../../src/storage/support.js'
import { brief } from './workflow.js'
import { journalSchema } from '../../src/storage/journal.js'
import type {} from '../../src/workflow/execution.js'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
export async function fixture(maxBytes = 1024 * 1024, role?: 'main' | 'implementation' | 'review', simulatedSandbox = false, limits: { preflightTimeoutMs?: number; confirmationMode?: 'buttons' | 'legacy-json'; remoteArtifactRoot?: string; ordinaryPtc?: boolean; routedWorkspace?: boolean; bundle?: boolean; mainPtcSimulation?: boolean; rolePtcSimulation?: boolean; unavailable?: 'all' | 'checks'; maxOutputBytes?: number; commandSimulation?: boolean; commandTimeoutMs?: number; maxEvidenceBytes?: number; teamBoard?: boolean; teamService?: boolean; boardBytes?: number; observedUi?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'review-gated-loader-'))
  roots.push(root)
  const artifact = new URL('../../dist/index.js', import.meta.url).href
  const support = new URL('../../dist/storage/support.js', import.meta.url).href
  const rows: EntryOptions[] = [
    { id: 'working-directory', name: import.meta.resolve('@deepseek-ai/dsh-working-directory'), config: { defaultDirectory: root } },
    ...!role && !limits.bundle ? [{ id: 'fixture-fs', name: import.meta.resolve('@deepseek-ai/dsh-fs-local') }] : [],
    ...['llm', 'session', 'session-projection', 'tools', 'agent', 'user-questions', 'storage', 'agent-loop', 'subagent'].map(name => ({
      id: name, name: import.meta.resolve('@deepseek-ai/dsh-' + name), ...name === 'agent-loop' ? { config: { agents: [] } } : {},
    })),
    ...limits.observedUi ? [{ id: 'observed-review-ui', name: new URL('../../ui/lib/index.js', import.meta.url).href }] : [],
    { id: 'session-persistence-jsonl', name: import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'), config: { root: join(root, 'sessions'), compression: 'none' } },
    ...limits.teamService ? [{ id: 'agent-team', name: import.meta.resolve('@deepseek-ai/dsh-experimental-agent-team') }] : [],
    { id: 'system-prompt', name: import.meta.resolve('@deepseek-ai/dsh-system-prompt'), config: { personaPrefix: '' } },
    { id: 'storage-json', name: import.meta.resolve('@deepseek-ai/dsh-storage-json'), config: { root: join(root, 'storage') } },
    { id: 'storage-domain', name: import.meta.resolve('@deepseek-ai/dsh-storage-domain'), config: { backend: 'json' } },
    ...limits.bundle ? [] : [{ id: 'review-gated-support', name: support, config: { maxRecords: 100, maxBytes, confirmationMode: limits.confirmationMode ?? 'legacy-json' } }, { id: 'review-gated-host-tasks', name: new URL('../../dist/workflow/tasks.js', import.meta.url).href }],
    { id: 'agent-preset-registry', name: import.meta.resolve('@deepseek-ai/dsh-agent-preset-registry'), config: { default: 'standard' } },
    { id: 'preset-standard', name: import.meta.resolve('@deepseek-ai/dsh-agent-preset'), config: { id: 'standard', order: 1, plugins: limits.bundle ? [{ id: 'runtime-consumer', name: new URL('./required-ptc.ts', import.meta.url).href, isolate: { presetRuntimeProbe: true } }] : [] } },
    ...limits.ordinaryPtc ? [{ id: 'preset-ptc', name: import.meta.resolve('@deepseek-ai/dsh-agent-preset'), config: { id: 'ptc', order: 2, plugins: [{ id: 'tool-presentation', name: import.meta.resolve('@deepseek-ai/dsh-agent-tool-presentation'), config: { mode: 'ptc' } }] } }] : [],
    ...limits.bundle ? [
      ...[...limits.remoteArtifactRoot ? [] : ['fs-sandbox', 'subprocess-local'], 'shell-env', process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox'].map(name => ({ id: name, name: name === 'fs-sandbox' && limits.routedWorkspace ? new URL('./routed-fs.ts', import.meta.url).href : import.meta.resolve('@deepseek-ai/dsh-' + name), ...name === 'fs-sandbox' && limits.routedWorkspace ? { config: { cwd: root } } : {} })),
      { id: 'sandbox', name: simulatedSandbox ? new URL('./simulated-sandbox.ts', import.meta.url).href : import.meta.resolve('@deepseek-ai/dsh-sandbox-local'), config: { commandSimulation: limits.commandSimulation ?? false, unavailable: limits.unavailable ?? 'never', mainPtcSimulation: limits.mainPtcSimulation ?? false, rolePtcSimulation: limits.rolePtcSimulation ?? false } },
      { id: 'sandbox-policy', name: import.meta.resolve('@deepseek-ai/dsh-sandbox-policy'), config: { mode: 'danger-full-access', workspaceRoot: root } },
      { id: 'ptc-runtime', name: '@deepseek-ai/dsh-ptc-runtime-node', ...limits.remoteArtifactRoot ? { isolate: { fs: 'combined/local-fs', subprocess: 'combined/local-subprocess' } } : {} },
      ...limits.remoteArtifactRoot ? [
        { id: 'settings', name: import.meta.resolve('@deepseek-ai/dsh-settings') },
        { id: 'config-editor', name: import.meta.resolve('@deepseek-ai/dsh-config-editor') },
        { id: 'remote-local-world', name: 'cordis:group', group: true, isolate: { fs: 'combined/local-fs', subprocess: 'combined/local-subprocess', spillStore: true as const }, config: [
          ...['fs-sandbox', 'subprocess-local', 'spill-local'].map(name => ({ id: name, name: import.meta.resolve('@deepseek-ai/dsh-' + name) })),
          { id: 'bridge', name: pathToFileURL(join(limits.remoteArtifactRoot, 'lib', 'local-bridge.js')).href },
        ] },
        ...['manager', 'router-fs', 'router-subprocess'].map(name => ({ id: 'remote-ssh-' + name, name: pathToFileURL(join(limits.remoteArtifactRoot!, 'lib', name + '.js')).href, ...name === 'manager' ? { config: { aliasRoot: join(root, 'aliases'), servers: [{ id: 'never-connect', label: 'Isolated test', sshTarget: 'never-connect.invalid' }], workspaces: [{ id: 'remote', serverId: 'never-connect', remotePath: '/srv/project' }] } } : {} })),
      ] : [],
    ] : role ? [
      ...['fs-local', 'subprocess-local'].map(name => ({ id: name, name: import.meta.resolve('@deepseek-ai/dsh-' + name) })),
      { id: 'sandbox', name: simulatedSandbox ? new URL('./simulated-sandbox.ts', import.meta.url).href : import.meta.resolve('@deepseek-ai/dsh-sandbox-local'), config: { commandSimulation: limits.commandSimulation ?? false, unavailable: limits.unavailable ?? 'never' } },
      { id: 'sandbox-policy', name: import.meta.resolve('@deepseek-ai/dsh-sandbox-policy'), config: { mode: 'danger-full-access', workspaceRoot: root } },
      { id: 'permissions', name: new URL('../../dist/security/permissions.js', import.meta.url).href },
      { id: 'native-sandbox', name: new URL('../../dist/security/native.js', import.meta.url).href },
      { id: 'ptc-runtime', name: import.meta.resolve('@deepseek-ai/dsh-ptc-runtime-node') },
      { id: 'roles', name: new URL('../../dist/roles/runner.js', import.meta.url).href, config: { implementationPreset: 'review-gated-implementation', reviewPreset: 'review-gated-review', maxDepth: 1, ...limits.maxOutputBytes === undefined ? {} : { maxOutputBytes: limits.maxOutputBytes } } },
      { id: 'host-world', name: new URL('../../dist/security/host-world.js', import.meta.url).href },
      { id: 'verification', name: new URL('../../dist/verification/runner.js', import.meta.url).href, config: { ...limits.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: limits.commandTimeoutMs }, ...limits.maxEvidenceBytes === undefined ? {} : { maxEvidenceBytes: limits.maxEvidenceBytes } } },
      { id: 'execution', name: new URL('../../dist/workflow/execution.js', import.meta.url).href, config: { snapshotParent: root, ...limits.preflightTimeoutMs === undefined ? {} : { preflightTimeoutMs: limits.preflightTimeoutMs } } },
    ] : [],
    ...limits.bundle ? [] : [{ id: 'preset-review-gated', name: import.meta.resolve('@deepseek-ai/dsh-agent-preset'), config: { id: 'review-gated', plugins: role ? [{
      id: 'native-role-world', name: 'cordis:group', group: true, isolate: { fs: true, subprocess: true, sandbox: true, ptcRuntime: true }, config: [
        { id: 'native-runtime', name: new URL('../../dist/security/native-runtime.js', import.meta.url).href },
        { id: 'workflow-tools', name: artifact },
        ...limits.teamBoard ? [{ id: 'advisory-board', name: new URL('../../dist/collaboration/team-board.js', import.meta.url).href, config: { maxOutputBytes: limits.boardBytes ?? 16384 } }] : [],
        { id: 'ptc', name: import.meta.resolve('@deepseek-ai/dsh-agent-tool-presentation'), config: { mode: 'ptc' } },
        { id: 'guard', name: new URL('../../dist/security/role-guard.js', import.meta.url).href, config: { role } },
      ],
    }] : [{ id: 'workflow-tools', name: artifact }] } }],
  ]
  if (role) for (const childRole of ['implementation', 'review', 'diagnostic'] as const) rows.push({
    id: 'preset-' + childRole, name: import.meta.resolve('@deepseek-ai/dsh-agent-preset'), config: {
      id: 'review-gated-' + childRole, plugins: [{ id: 'native-role-world', name: 'cordis:group', group: true, isolate: { fs: true, subprocess: true, sandbox: true, ptcRuntime: true }, config: [
        { id: 'native-runtime', name: new URL('../../dist/security/native-runtime.js', import.meta.url).href },
        { id: 'guard', name: new URL('../../dist/security/role-guard.js', import.meta.url).href, config: { role: childRole } },
        { id: 'ptc', name: import.meta.resolve('@deepseek-ai/dsh-agent-tool-presentation'), config: { mode: 'ptc' } },
      ] }],
    },
  })
  const configPath = join(root, 'cordis.yml')
  const overlay = () => {
    const patches = loadOverlayPatches('review-gated-test', fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url)))
    const configure = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) configure(item); return }
      if (typeof value !== 'object' || value === null) return
      if ('id' in value && value.id === 'review-gated-support') {
        const previous = 'config' in value && typeof value.config === 'object' && value.config !== null ? value.config : {}
        Object.assign(value, { config: { ...previous, confirmationMode: limits.confirmationMode ?? 'legacy-json' } })
      }
      for (const child of Object.values(value)) configure(child)
    }
    configure(patches)
    return patches
  }
  const composed = limits.remoteArtifactRoot ? composeEntries([[{ insert: rows }], overlay()]) : rows
  await writeFile(configPath, stringify(composed))
  const start = async () => {
    const patches = limits.bundle && !limits.remoteArtifactRoot ? overlay() : undefined
    const ctx = await boot('review-gated-test', configPath, patches, limits.remoteArtifactRoot ? ctx => {
      ctx.provide('profileContext', { name: 'combined', startedBundles: [], dir: root, patchPath: join(root, 'cordis.patch.yml'), installAnchor: join(root, 'package.json'), cwd: root, home: root, overlays: [], telemetryDisabledEnv: undefined })
    } : undefined, new URL('../../', import.meta.url).href)
    contexts.push(ctx)
    const state = [...ctx.loader.entries()].find(entry => entry.options.id === 'review-gated-support')?.fiber?.state
    expect(state).toBe(2)
    return ctx
  }
  return { root, configPath, start }
}
export async function main(ctx: Context, cwd: string, id: string = randomUUID(), preset = 'review-gated', resume = false, agentOptions?: AgentOptions) {
  let scoped: Context | undefined
  const setup = async (agentCtx: Context) => {
    scoped = agentCtx
    await ctx.agentPresets.mount(agentCtx, preset)
  }
  const handle = resume
    ? await ctx.agents.resume({ resumeSessionId: SessionId(id), setup, ...agentOptions ? { agentOptions } : {} })
    : await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd, agentPreset: preset }, setup, ...agentOptions ? { agentOptions } : {} })
  if (!scoped) throw new Error('Agent factory did not supply scoped context')
  return { handle, scoped, agent: handle.agent }
}
export function call(scoped: Context, agent: Agent, name: string, args: unknown, signal = new AbortController().signal) {
  return scoped.tools.execute({ callId: ToolCallId(randomUUID()), name, arguments: args, agent, signal })
}

/** Request and confirm a distinct operation using genuine later input in positive service tests only.
 * @param scoped Main tool context. @param agent Main owner. @param kind Exact operation to permit.
 * @returns The logged confirmation event and unchanged-phase granted state.
 */
export async function permission(scoped: Context, agent: Agent, kind: 'execution' | 'handoff') {
  const signal = new AbortController().signal
  const execution = scoped.get('reviewGatedExecution')
  if (!execution) throw new Error('Execution fixture service is unavailable')
  const evidence = await execution.requestOperation(agent, kind, signal)
  if (!evidence.request) throw new Error('Operation request was not published')
  const event = agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: JSON.stringify({ reviewGatedOperation: { requestId: evidence.request.id, selected: 'Authorize' } }) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return { event, state: await execution.confirmOperation(agent, evidence.request.id, event.seq, signal) }
}

/** Append an exact logged user confirmation and submit its sequence to the workflow tool. */
export async function confirm(scoped: Context, agent: Agent, questionId: string, selected: string) {
  const event = agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: JSON.stringify({ reviewGatedAnswer: { questionId, selected } }) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return { event, result: await call(scoped, agent, 'rg_confirm_question', { questionId, userMessageSeq: event.seq }) }
}
