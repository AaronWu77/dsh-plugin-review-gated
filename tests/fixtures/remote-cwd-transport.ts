/** In-memory AHP directory probe for the artifact-plane Remote SSH composition test. */
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { AhpClient, InMemoryTransport, type JsonRpcMessage } from '@microsoft/agent-host-protocol/client'
import { onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import type { AhpConnection } from 'dsh-remote-ssh/runtime'

/** Install a transport factory before the real manager constructs its shared SSH runtime. */
export async function remoteCwdTransport(artifactRoot: string) {
  // Native loading shares the ESM artifact instance used by the external app Loader.
  const entry = createRequire(import.meta.url)(join(artifactRoot, 'lib', 'index.js'))
  if (typeof entry.RemoteSshRuntime !== 'function') throw new Error('Built Remote SSH runtime is missing')
  // The optional artifact's private connection factory is this test's transport seam.
  const prototype: { open: () => Promise<AhpConnection> } = Reflect.get(entry.RemoteSshRuntime, 'prototype')
  const [transport, peer] = InMemoryTransport.pair()
  const client = new AhpClient(transport)
  const requests: { method: string; followSymlinks?: boolean | undefined }[] = []
  const parameters = z.object({ uri: z.literal('file:///srv/project'), followSymlinks: z.boolean().optional() })
  const open = vi.spyOn(prototype, 'open').mockImplementation(async function (this: object) {
    z.object({ sshTarget: z.literal('never-connect.invalid') }).parse(Reflect.get(this, 'config'))
    return { client, protocolVersion: '1.0.0', defaultDirectory: '/srv/project' }
  })
  client.connect()
  const responses = (async () => {
    for (;;) {
      const frame = await peer.recv()
      if (frame === null) return
      if (frame.kind !== 'text') throw new Error('Expected a real AHP client text request')
      const request: JsonRpcMessage = JSON.parse(frame.text)
      if (!('method' in request) || !('id' in request)) continue
      const parsed = parameters.safeParse(request.params)
      requests.push({ method: request.method, ...parsed.success ? { followSymlinks: parsed.data.followSymlinks } : {} })
      if (request.method === 'resourceResolve' && parsed.success) {
        await peer.send({ jsonrpc: '2.0', id: request.id, result: { uri: parsed.data.uri, type: 'directory' } })
      } else {
        await peer.send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Fixture permits only the remote workspace directory probe' } })
      }
    }
  })()
  onTestFinished(async () => {
    open.mockRestore()
    await client.shutdown()
    peer.close()
    await responses
  })
  return { open, requests }
}
