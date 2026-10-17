/** Validate actual packed exports in an isolated NodeNext consumer without installing a profile. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, readFile, writeFile, mkdir, symlink, realpath, rm, stat, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { x as extract, t as list } from 'tar'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'review-gated-package-'))
try {
  let npmCli
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    const candidate = process.platform === 'win32' ? join(directory, 'node_modules/npm/bin/npm-cli.js') : join(directory, 'npm')
    try { npmCli = await realpath(candidate); break } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
  }
  assert(npmCli, 'npm CLI must be installed alongside Node/on PATH')
  const packed = await exec(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root, timeout: 60000 })
  const [pack] = JSON.parse(packed.stdout)
  const archive = join(temporary, pack.filename)
  const entries = []
  await list({ file: archive, onReadEntry: entry => entries.push(entry.path) })
  assert(entries.includes('package/cordis.patch.yml'))
  assert(!entries.some(path => /^package\/(?:node_modules\/|tests\/|pnpm-workspace\.yaml|pnpm-lock\.yaml)/.test(path)))
  assert(entries.filter(path => path.startsWith('package/scripts/')).every(path => path === 'package/scripts/profile-migration.mjs'))
  for (const asset of ['ui/lib/index.js', 'ui/lib/client.js', 'ui/lib/types/index.d.ts', 'ui/lib/types/client/index.d.ts']) assert(entries.includes('package/' + asset))
  assert(!entries.includes('package/ui/package.json'))
  const consumer = join(temporary, 'consumer')
  const destination = join(consumer, 'node_modules/@aaronwu/dsh-review-gated')
  await mkdir(destination, { recursive: true })
  await extract({ file: archive, cwd: destination, strip: 1 })
  const actual = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'))
  assert.deepEqual(actual.exports, manifest.exports)
  assert.deepEqual(actual.peerDependencies, manifest.peerDependencies)
  assert.equal(actual.dsh.bundle.patch, './cordis.patch.yml')
  for (const [name] of Object.entries({ ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.devDependencies })) {
    const target = join(consumer, 'node_modules', name)
    await mkdir(dirname(target), { recursive: true })
    let dependency
    try { dependency = await realpath(join(root, 'node_modules', name)) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      dependency = await realpath(join(root, 'src/node_modules', name))
    }
    await symlink(dependency, target, process.platform === 'win32' ? 'junction' : 'dir')
  }
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ type: 'module' }) + '\n')
  const runtime = [], imports = []
  let count = 0
  for (const [key, entry] of Object.entries(manifest.exports)) {
    const specifier = manifest.name + (key === '.' ? '' : key.slice(1))
    if (typeof entry === 'string') { assert((await stat(join(destination, entry))).isFile()); continue }
    assert((await stat(join(destination, entry.default))).isFile())
    assert((await stat(join(destination, entry.types))).isFile())
    if (key === './client') {
      imports.push('import type * as browser from ' + JSON.stringify(specifier) + ';type Browser = typeof browser;')
      const script = await readFile(join(destination, entry.default), 'utf8')
      assert(script.includes('window.__ModuleLoader__.load({ id: ' + JSON.stringify(manifest.name)))
      assert(!script.includes('@aaronwu/dsh-review-gated-ui'))
      continue
    }
    runtime.push('const m' + count + '=await import(' + JSON.stringify(specifier) + ');if("apply" in m' + count + '){assert(!("default" in m' + count + '));assert.equal(typeof m' + count + '.name,"string");if("inject" in m' + count + ')assert(typeof m' + count + '.inject==="object")}')
    imports.push('import * as m' + count + ' from ' + JSON.stringify(specifier) + ';void m' + count + ';')
    count++
  }
  await writeFile(join(consumer, 'smoke.mjs'), 'import assert from "node:assert/strict";\n' + runtime.join('\n') + '\n')
  await writeFile(join(consumer, 'consumer.ts'), imports.join('\n') + '\n')
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2024', types: ['node'] }, files: ['consumer.ts'] }) + '\n')
  await exec(process.execPath, [join(consumer, 'smoke.mjs')], { cwd: consumer, timeout: 30000 })
  await exec(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], { cwd: consumer, timeout: 30000 })
  await writeFile(join(consumer, 'simulated-sandbox.mjs'), `import {SandboxProvider} from '@deepseek-ai/dsh-sandbox';
export default class FixtureSandbox extends SandboxProvider {
  confine(argv) { return Promise.resolve({argv:[...argv],enforcement:'full',denialSignatures:[],runnerFailureRules:[]}) }
}
`)
  await writeFile(join(consumer, 'ptc-smoke.mjs'), `
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {boot,loadOverlayPatches} from '@deepseek-ai/dsh-app-boot'
import {SessionId} from '@deepseek-ai/dsh-session'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import ClientModuleRegistry from '@deepseek-ai/dsh-client-modules'
const root=fileURLToPath(new URL('./',import.meta.url))
const rows=['llm','session','session-projection','tools','agent','user-questions','storage','agent-loop','subagent'].map(name=>({id:name,name:import.meta.resolve('@deepseek-ai/dsh-'+name),...name==='agent-loop'?{config:{agents:[]}}:{}}))
rows.push(
  {id:'working-directory',name:import.meta.resolve('@deepseek-ai/dsh-working-directory'),config:{defaultDirectory:root}},
  {id:'system-prompt',name:import.meta.resolve('@deepseek-ai/dsh-system-prompt'),config:{personaPrefix:''}},
  {id:'storage-json',name:import.meta.resolve('@deepseek-ai/dsh-storage-json'),config:{root:root+'storage'}},
  {id:'storage-domain',name:import.meta.resolve('@deepseek-ai/dsh-storage-domain'),config:{backend:'json'}},
  {id:'agent-preset-registry',name:import.meta.resolve('@deepseek-ai/dsh-agent-preset-registry'),config:{default:'standard'}},
  {id:'preset-standard',name:import.meta.resolve('@deepseek-ai/dsh-agent-preset'),config:{id:'standard',order:1,plugins:[]}},
  ...['fs-sandbox','subprocess-local','shell-env',process.platform==='win32'?'pwsh-sandbox':'bash-sandbox'].map(name=>({id:name,name:import.meta.resolve('@deepseek-ai/dsh-'+name)})),
  {id:'sandbox',name:new URL('./simulated-sandbox.mjs',import.meta.url).href},
  {id:'sandbox-policy',name:import.meta.resolve('@deepseek-ai/dsh-sandbox-policy'),config:{mode:'danger-full-access',workspaceRoot:root}},
  {id:'ptc-runtime',name:'@deepseek-ai/dsh-ptc-runtime-node'})
const filename=root+'cordis.yml'
await writeFile(filename,JSON.stringify(rows))
const patch=fileURLToPath(new URL('./node_modules/@aaronwu/dsh-review-gated/cordis.patch.yml',import.meta.url))
const ctx=await boot('packed-ptc-smoke',filename,loadOverlayPatches('packed-ptc-smoke',patch),undefined,new URL('./',import.meta.url).href)
try {
  assert.equal([...ctx.loader.entries()].find(e=>e.options.id==='ptc-runtime')?.options.disabled,false)
  assert.equal([...ctx.loader.entries()].find(e=>e.options.id==='review-gated-native-runtime'),undefined)
  await ctx.plugin(ClientModuleRegistry)
  assert.deepEqual(ctx.clientModules.graph().entries.filter(row=>row.id==='@aaronwu/dsh-review-gated').map(row=>row.id),['@aaronwu/dsh-review-gated'])
  assert.equal(typeof ctx.reviewGatedTasks.start,'function')
  assert.equal(typeof ctx.reviewGatedHostWorld.resolveExecutable,'function')
  assert.deepEqual((await ctx.agentPresets.list()).map(p=>p.broken),[undefined,undefined,undefined,undefined,undefined])
  assert.deepEqual((await ctx.agentPresets.remoteExportList()).presets.map(p=>p.id),['standard','review-gated'])
  const handle=await ctx.agents.create({sessionId:SessionId('packed-smoke'),meta:{cwd:root},setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'review-gated')}})
  const result=await handle.agent.ctx.tools.execute({callId:ToolCallId('packed-status'),name:'run_code',arguments:{code:'console.log((await tools.rg_status({})).state.phase)',description:'Read initial packed workflow phase'},agent:handle.agent,signal:new AbortController().signal})
  assert(!result.isError,JSON.stringify(result))
  assert(JSON.stringify(result.value).includes('Clarifying'))
  await handle.dispose()
} finally {await ctx.fiber.dispose()}
console.log('Packed Loader/Node PTC bootstrap returned Clarifying; sandbox is simulated.')
`)
  const ptc = await exec(process.execPath, [join(consumer, 'ptc-smoke.mjs')], { cwd: consumer, timeout: 30000 })
  console.log(ptc.stdout.trim())
  const artifacts = join(root, '.local/artifacts')
  await mkdir(artifacts, { recursive: true })
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
  const filename = pack.filename.replace(/\.tgz$/, '-' + digest.slice(0, 12) + '.tgz')
  const target = join(artifacts, filename)
  try { await copyFile(archive, target, constants.COPYFILE_EXCL) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    assert.equal(createHash('sha256').update(await readFile(target)).digest('hex'), digest, 'Existing content-named archive must never be overwritten')
  }
  const checksum = digest + '  ' + filename + String.fromCharCode(10)
  try { await writeFile(target + '.sha256', checksum, { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await readFile(target + '.sha256', 'utf8'), checksum) }
  console.log('Validated immutable local archive: .local/artifacts/' + filename)
  console.log('SHA256: ' + digest)
  console.log('Packed archive: ' + entries.length + ' entries; ' + count + ' ESM/type exports passed isolated NodeNext consumer checks.')
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  await rm(temporary, { recursive: true, force: true })
}
