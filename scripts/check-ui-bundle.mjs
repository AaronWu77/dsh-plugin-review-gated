/** Compose the integrated optional UI row through the public app bootstrap; no GUI/profile installation. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'review-gated-ui-bundle-'))
try {
  const filename = join(temporary, 'cordis.yml')
  await writeFile(filename, JSON.stringify([
    { id: 'session', name: import.meta.resolve('@deepseek-ai/dsh-session') },
    { id: 'projections', name: import.meta.resolve('@deepseek-ai/dsh-session-projection') },
  ]))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  const rows = loadOverlayPatches('review-gated-ui-bundle', join(root, manifest.dsh.bundle.patch)).flatMap(patch => patch.insert ?? [])
  const observed = rows.filter(row => row.id === 'review-gated-observed-ui')
  assert.equal(observed.length, 1)
  const patch = [{ insert: observed }]
  const ctx = await boot('review-gated-ui-bundle', filename, patch, undefined, pathToFileURL(temporary).href + '/')
  try {
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'review-gated-observed-ui')
    assert(row?.fiber)
    const session = ctx.sessions.create(SessionId('optional-ui-overlay'))
    assert(Object.hasOwn(ctx.sessionProjections.snapshot(session).values, 'observedReviewGated'))
    assert.equal(ctx.get('reviewGatedJournals'), undefined)
    await row.update({ disabled: true })
    await ctx.loader.await()
    assert(!Object.hasOwn(ctx.sessionProjections.snapshot(session).values, 'observedReviewGated'))
  } finally { await ctx.fiber.dispose() }
  console.log('Optional UI bundle overlay loads and unloads through public boot without workflow authority.')
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  await rm(temporary, { recursive: true, force: true })
}
