/** Optional artifact-plane pairing smoke: both external plugins must be built before this test. */
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {} from 'dsh-remote-ssh/manager'
import type {} from 'dsh-remote-ssh/local-bridge'
import { remoteCwdTransport } from '../fixtures/remote-cwd-transport.js'
import { fixture, main, call } from '../fixtures/runtime.js'

const remoteArtifactRoot = process.env.DSH_REMOTE_SSH_ARTIFACT_ROOT
describe.skipIf(!remoteArtifactRoot)('Review-Gated with actual Remote SSH providers', () => {
  it('runs ordinary remote-session PTC locally and rejects managed workflow admission in the remote alias', async () => {
    if (!remoteArtifactRoot) throw new Error('Set DSH_REMOTE_SSH_ARTIFACT_ROOT to a built Remote SSH checkout')
    const transport = await remoteCwdTransport(remoteArtifactRoot)
    const f = await fixture(undefined, undefined, true, { bundle: true, mainPtcSimulation: true, remoteArtifactRoot })
    const ctx = await f.start()
    const remoteAlias = join(f.root, 'aliases', 'remote')
    expect(ctx.fs.processPathFromHostPath(remoteAlias)).toBeUndefined()
    expect(ctx.fs).not.toBe(ctx.get('localFs'))
    expect(ctx.subprocess).not.toBe(ctx.get('localSubprocess'))
    const stock = [...ctx.loader.entries()].find(entry => entry.options.id === 'ptc-runtime')
    expect(stock?.options.disabled).toBe(false)
    expect(stock?.fiber).toBeDefined()
    const localSpawn = vi.spyOn(ctx.localSubprocess, 'spawn')
    const resolveDirectory = vi.spyOn(ctx.fs, 'resolve')
    const statDirectory = vi.spyOn(ctx.fs, 'stat')
    onTestFinished(() => { localSpawn.mockRestore(); resolveDirectory.mockRestore(); statDirectory.mockRestore() })
    const ordinary = await main(ctx, remoteAlias, undefined, 'standard')
    expect(ctx.remoteSshManager.bindSession(ordinary.agent.id, ordinary.agent, remoteAlias)?.kind).toBe('remote')
    ordinary.scoped.effect(() => () => { ctx.remoteSshManager.unbindSession(ordinary.agent.id, ordinary.agent) })
    expect(ctx.remoteSshManager.sessionRoute(ordinary.agent.id)?.kind).toBe('remote')
    ordinary.scoped.tools.presentAs('ptc')
    const result = await call(ordinary.scoped, ordinary.agent, 'run_code', {
      code: 'console.log("local interpreter in a remote session")',
      description: 'Verify local interpreter ownership without remote commands',
    })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(JSON.stringify(result)).toContain('local interpreter in a remote session')
    expect(ctx.reviewGatedPermissions.of(ordinary.agent.session)).toBeUndefined()
    expect(localSpawn).toHaveBeenCalledOnce()
    expect(transport.open).toHaveBeenCalledOnce()
    expect(transport.requests.some(request => request.followSymlinks === true)).toBe(true)
    expect(resolveDirectory.mock.calls.some(([path]) => path === remoteAlias)).toBe(true)
    expect(statDirectory).toHaveBeenCalled()
    expect(transport.requests.length).toBeGreaterThanOrEqual(2)
    expect(localSpawn.mock.calls[0]?.[0].argv[0]).toBe(process.execPath)
    expect(transport.requests.every(request => request.method === 'resourceResolve')).toBe(true)
    await expect(main(ctx, remoteAlias, undefined, 'review-gated')).rejects.toThrow('requires a local workspace')
    await ordinary.handle.dispose()
    expect(ctx.remoteSshManager.sessionRoute(ordinary.agent.id)).toBeUndefined()
  })
})
