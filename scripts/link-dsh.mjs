import { readdir, readFile, writeFile, access } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'

const checkout = process.argv[2] ?? process.env.DSH_CHECKOUT
if (!checkout) throw new Error('Pass the DSH checkout path or set DSH_CHECKOUT.')
const root = resolve(checkout)
await access(resolve(root, 'pnpm-workspace.yaml'))
const packages = new Map()
async function scan(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.some(entry => entry.name === 'package.json')) {
    const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
    if (manifest.name?.startsWith('@deepseek-ai/')) packages.set(manifest.name, directory)
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !['node_modules', 'lib', 'dist', 'build', '.git'].includes(entry.name)) await scan(resolve(directory, entry.name))
  }
}
for (const directory of ['packages', 'vendor', 'native', 'apps']) await scan(resolve(root, directory))
if (!packages.has('@deepseek-ai/dsh-agent')) throw new Error('Checkout contains no DSH agent package.')
const overrides = [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([name, directory]) => {
  const path = relative(process.cwd(), directory).split(sep).join('/')
  return '  ' + JSON.stringify(name) + ': ' + JSON.stringify('link:' + path)
}).join('\n')
await writeFile('pnpm-workspace.yaml', 'packages: []\nstrictPeerDependencies: false\nautoInstallPeers: false\noverrides:\n' + overrides + '\n')
console.log('Configured ' + packages.size + ' local DSH links. Run pnpm install; this machine-local file is ignored by Git.')
