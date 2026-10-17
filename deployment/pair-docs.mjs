/** Candidate-only pairing: never discovers or rewrites the host documentation corpus.
 * Run with Node's --import pointing to the audited DSH tsx ESM loader.
 * --write records the reviewed pairs; the default checks without writing.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const dshRoot = resolve(process.env.DSH_DOCS_ROOT ?? 'D:/deepseek-harness')
const shared = name => import(pathToFileURL(resolve(dshRoot, 'scripts', name)).href)
const { translationPairPaths, computeTranslationPairingRecord, renderTranslationPairingRecord } = await shared('translation-pairing-record.ts')
const { parseTranslationMarkdown, languageSwitcherTargets, translationStructureSignature, translationStructureDiff } = await shared('translation-pairing.ts')
const { hasLanguageSwitcher, translationLinkLocaleViolations } = await shared('translation-links.ts')

// Reviewed candidate files only. Extending this list requires reviewing both pages
// and reading any existing sidecar before permitting --write.
const candidates = [
  'README.md',
  'docs/bundle.md',
  'ui/README.md',
  'docs/execution.md',
  'docs/persistence.md',
  'docs/security.md',
  'docs/compatibility.md',
  'docs/upgrade-guide/v0.1.0-alpha.11/unified-package/guide.md',
  'docs/upgrade-guide/v0.1.0-alpha.12/repository-preflight/guide.md',
]
const args = process.argv.slice(2)
const write = args.includes('--write')
assert(args.filter(arg => arg === '--write').length <= 1, 'Duplicate --write')
const sources = args.filter(arg => arg !== '--write')
assert(sources.length > 0, 'Name explicit candidate English Markdown paths; no corpus-wide default is allowed')
assert.equal(new Set(sources).size, sources.length, 'Duplicate candidate path')
for (const source of sources) assert(candidates.includes(source), 'Not a reviewed candidate: ' + source)
const context = {
  repoRoot: pluginRoot,
  isTranslationPairSource: path => existsSync(resolve(pluginRoot, path.replace(/\.md$/, '.zh.md'))),
}
const records = []
for (const source of sources) {
  const paths = translationPairPaths(source)
  const en = await readFile(resolve(pluginRoot, paths.source), 'utf8')
  const zh = await readFile(resolve(pluginRoot, paths.zh), 'utf8')
  assert.equal(en.split('\n').length, zh.split('\n').length, source + ': physical line counts differ')
  const trees = { en: parseTranslationMarkdown(en), zh: parseTranslationMarkdown(zh) }
  const signatures = []
  for (const [path, text, tree, counterpart] of [[paths.source, en, trees.en, paths.zh], [paths.zh, zh, trees.zh, paths.source]]) {
    const switcher = languageSwitcherTargets(counterpart)
    assert(hasLanguageSwitcher(tree, text, switcher), path + ': missing language switcher')
    const linkContext = { ...context, sourcePath: path }
    assert.deepEqual(translationLinkLocaleViolations(text, linkContext, switcher, tree), [], path + ': wrong-locale links')
    signatures.push(translationStructureSignature(tree, switcher, { ...linkContext, markdown: text }))
  }
  assert.deepEqual(translationStructureDiff(...signatures), [], source + ': bilingual structure differs')
  const record = renderTranslationPairingRecord(paths, computeTranslationPairingRecord(paths, en, zh, context, trees))
  let previous
  try { previous = await readFile(resolve(pluginRoot, paths.meta), 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!write) assert.equal(previous, record, paths.meta + ': stale or missing pairing record')
  records.push({ paths, record, previous, lines: en.split('\n').length - 1 })
}
// Complete all validations before writing any sidecar. Markdown is never written.
for (const { paths, record, previous, lines } of records) {
  if (write && previous !== record) await writeFile(resolve(pluginRoot, paths.meta), record, 'utf8')
  console.log((write ? 'recorded' : 'checked') + ': ' + paths.source + ' (' + lines + ' lines per language)')
}
console.log('Candidate pairing passed: ' + records.length + ' pairs; host corpus was not scanned or written.')
