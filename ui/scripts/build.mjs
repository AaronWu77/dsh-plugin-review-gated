/** Emit only this package's host and lazy CJS client candidate. */
import { build } from 'esbuild'
import { transform } from 'lightningcss'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
const ui = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ui)
for (const face of ['host', 'client']) {
  const result = spawnSync(process.execPath, ['../node_modules/typescript/bin/tsc', '-p', 'tsconfig.' + face + '.json'], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
await mkdir('dist', { recursive: true })
await build({ absWorkingDir: ui, entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'es2024' })
const manifest = JSON.parse(await readFile('../package.json', 'utf8'))
const id = manifest.name
if (manifest.exports['./client'].default !== './ui/lib/client.js' || manifest.dsh.client.platform !== 'web') throw new Error('Unsupported optional client manifest')
const external = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']
const result = await build({ absWorkingDir: ui, entryPoints: ['src/client/index.ts'], outfile: 'lib/client.js', bundle: true, platform: 'browser', format: 'cjs', target: 'es2024', jsx: 'automatic', external, metafile: true,
  banner: { js: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(id) + ', factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
  plugins: [{ name: 'owned-css-modules', setup(b) { b.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
    const input = await readFile(path)
    const compiled = transform({ filename: path, code: input, cssModules: { pattern: 'rg-ui_[name]_[local]_[hash]' }, minify: true })
    const classes = Object.fromEntries(Object.entries(compiled.exports ?? {}).map(([key, entry]) => [key, entry.name]))
    const tag = id + '/' + basename(path)
    const contents = `const css = ${JSON.stringify(compiled.code.toString())}; const tag = ${JSON.stringify(tag)}; if (!document.querySelector('style[data-plugin-css=' + JSON.stringify(tag) + ']')) { const el=document.createElement('style'); el.dataset.plugin=${JSON.stringify(id)}; el.dataset.pluginCss=tag; el.textContent=css; document.head.appendChild(el); } export default ${JSON.stringify(classes)}`
    return { contents, loader: 'js' }
  }) } }],
})
for (const output of Object.values(result.metafile.outputs)) for (const imp of output.imports) if (imp.external && !external.includes(imp.path)) throw new Error('Undeclared browser request: ' + imp.path)
await writeFile('dist/client-metafile.json', JSON.stringify(result.metafile, null, 2) + '\n')
console.log('Built lib/index.js, lib/client.js and lib/types; metadata in dist/')
