/** Apply reusable DSH copy/pairing checks only to this optional candidate. */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const root = process.env.DSH_ROOT
if (!root) throw new Error('Set DSH_ROOT to the read-only DSH checkout')
const load = name => import(pathToFileURL(resolve(root, 'scripts', name)).href)
const { findUiI18nViolations } = await load('verify-client-ui-i18n.ts')
const { computeTranslationPairingRecord, renderTranslationPairingRecord, translationPairPaths } = await load('translation-pairing-record.ts')
const { translationStructureSignature, translationStructureDiff, parseTranslationMarkdown } = await load('translation-pairing.ts')
const en = await readFile('README.md', 'utf8')
const zh = await readFile('README.zh.md', 'utf8')
if (en.split('\n').length !== zh.split('\n').length) throw new Error('README pair line counts differ')
const context = { repoRoot: resolve('..'), isTranslationPairSource: path => path.endsWith('.md') && existsSync(resolve('..', path.slice(0, -3) + '.i18n.yaml')) }
const structural = translationStructureDiff(translationStructureSignature(parseTranslationMarkdown(en), 'ui/README.zh.md', { ...context, sourcePath: 'ui/README.md', markdown: en }), translationStructureSignature(parseTranslationMarkdown(zh), 'ui/README.md', { ...context, sourcePath: 'ui/README.zh.md', markdown: zh }))
if (structural.length) throw new Error('README pair structure differs: ' + JSON.stringify(structural))
const paths = translationPairPaths('ui/README.md')
const record = renderTranslationPairingRecord(paths, computeTranslationPairingRecord(paths, en, zh, context))
if (process.argv.includes('--write')) await writeFile('README.i18n.yaml', record)
else if (await readFile('README.i18n.yaml', 'utf8') !== record) throw new Error('README pair changed; confirm both languages and run --write')
const violations = []
for (const file of await readdir('src/client')) if (/\.tsx?$/.test(file)) violations.push(...findUiI18nViolations('src/client/' + file, await readFile('src/client/' + file, 'utf8')))
if (violations.length) throw new Error('UI copy violations: ' + JSON.stringify(violations))
if (findUiI18nViolations('src/client/negative.tsx', 'export const Bad = () => <button aria-label="Untranslated action">Literal text</button>').length === 0) throw new Error('UI copy validator missed negative control')
async function textFiles(dir) {
  const files = []
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = dir + '/' + item.name
    if (item.isDirectory()) files.push(...await textFiles(path))
    else if (item.isFile()) files.push(path)
    else throw new Error('Unexpected source link: ' + path)
  }
  return files
}
const owned = ['../package.json', '.gitignore', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.host.json', 'tsconfig.client.json', 'vitest.config.ts', ...await textFiles('src'), ...await textFiles('tests'), ...await textFiles('scripts')]
for (const path of owned) {
  const text = await readFile(path, 'utf8')
  if (!text.endsWith('\n') || text.endsWith('\n\n') || /[ \t]+$/m.test(text)) throw new Error('Whitespace or final-newline violation: ' + path)
}
console.log('Candidate UI copy, README pairing and owned whitespace checks passed (negative control rejected)')
