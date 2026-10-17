/** Create private individual links; never install into or write through the DSH checkout. */
import { lstat, mkdir, readdir, realpath, symlink, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ui = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = process.env.DSH_ROOT
if (!root) throw new Error('Set DSH_ROOT to the read-only DSH checkout')
const local = resolve(ui, 'node_modules')
await mkdir(local, { recursive: true })
if ((await lstat(local)).isSymbolicLink()) throw new Error('node_modules must be a private directory')
async function link(name, path) {
  const target = await realpath(path)
  const dest = resolve(local, name)
  await mkdir(dirname(dest), { recursive: true })
  try { await symlink(target, dest, 'junction') } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!(await lstat(dest)).isSymbolicLink() || !(await realpath(dest)).toLowerCase().startsWith(resolve(root).toLowerCase() + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unexpected existing dependency: ' + dest)
    // Root dependency versions win when development package inputs differ.
  }
}
for (const source of ['node_modules', 'packages/client/ui-goal/node_modules', 'packages/session/session-projection/node_modules', 'packages/client/ui-renderer/node_modules', 'packages/test-support/client-runtime/node_modules']) {
  const path = resolve(root, source)
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      for (const item of await readdir(resolve(path, entry.name))) await link(entry.name + '/' + item, resolve(path, entry.name, item))
    } else await link(entry.name, resolve(path, entry.name))
  }
}
await link('@deepseek-ai/dsh-client-ui-workspace', resolve(root, 'packages/client/ui-workspace'))
await link('@deepseek-ai/dsh-subagent', resolve(root, 'packages/subagent/subagent'))
await link('@deepseek-ai/dsh-session-projection', resolve(root, 'packages/session/session-projection'))
const declared = JSON.parse(await readFile(resolve(ui, 'package.json'), 'utf8'))
const requested = new Set([...Object.keys(declared.dependencies ?? {}), ...Object.keys(declared.peerDependencies ?? {}), ...Object.keys(declared.devDependencies ?? {})])
for (const group of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  const parent = resolve(root, 'packages', group.name)
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = resolve(parent, entry.name)
    let pkg
    try { pkg = JSON.parse(await readFile(resolve(path, 'package.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (requested.has(pkg.name)) await link(pkg.name, path)
  }
}
const store = resolve(root, 'node_modules/.pnpm')
const versions = await readdir(store)
for (const name of ['esbuild']) {
  const version = versions.filter(v => v.startsWith(name + '@')).sort().at(-1)
  if (!version) throw new Error('Missing local tool: ' + name)
  await link(name, resolve(store, version, 'node_modules', name))
}
console.log('Created private individual dependency links under node_modules')
