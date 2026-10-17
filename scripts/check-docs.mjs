import { readFile, readdir, access } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import assert from 'node:assert/strict'

const newPairs = [['docs/upgrade-guide/v0.1.0-alpha.12/repository-preflight/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.12/repository-preflight/guide.zh.md'], ['docs/upgrade-guide/v0.1.0-alpha.11/unified-package/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.11/unified-package/guide.zh.md'], ['ui/README.md', 'ui/README.zh.md'], ['docs/team-board.md', 'docs/team-board.zh.md'], ['docs/upgrade-guide/v0.1.0-alpha.10/managed-delegation/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.10/managed-delegation/guide.zh.md']]
const paths = [...newPairs.flat(), 'docs/upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.zh.md', 'docs/upgrade-guide/v0.1.0-alpha.8/button-confirmation/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.8/button-confirmation/guide.zh.md', 'docs/upgrade-guide/v0.1.0-alpha.7/operation-permissions/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.7/operation-permissions/guide.zh.md', 'docs/upgrade-guide/v0.1.0-alpha.6/audited-decisions/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.6/audited-decisions/guide.zh.md', 'docs/upgrade-guide/v0.1.0-alpha.5/windows-verification-evidence/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.5/windows-verification-evidence/guide.zh.md', 'UPGRADE.md', 'README.md', 'README.zh.md', 'docs/workflow.md', 'docs/workflow.zh.md', 'docs/compatibility.md', 'docs/compatibility.zh.md', 'docs/persistence.md', 'docs/persistence.zh.md', 'docs/security.md', 'docs/security.zh.md', 'docs/execution.md', 'docs/execution.zh.md', 'docs/recovery.md', 'docs/recovery.zh.md', 'docs/bundle.md', 'docs/bundle.zh.md', 'docs/implementation-plan.md', 'docs/implementation-plan.zh.md', 'AGENTS.md']
for (const path of paths) {
  const text = await readFile(path, 'utf8')
  assert(text.endsWith('\n') && !text.endsWith('\n\n'), path + ': expected exactly one final newline')
  const withoutCode = text.replace(/\x60{3}[^]*?\x60{3}/g, '')
  for (const match of withoutCode.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]
    if (/^https?:/.test(target)) continue
    const [file, anchor] = target.split('#')
    const actual = file ? resolve(dirname(path), file) : resolve(path)
    await access(actual)
    if (anchor) {
      const page = await readFile(actual, 'utf8')
      assert(page.includes('id="' + anchor + '"'), path + ': missing explicit anchor ' + anchor)
    }
  }
}
for (const [en, zh] of [...newPairs, ['docs/upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.zh.md'], ['docs/upgrade-guide/v0.1.0-alpha.8/button-confirmation/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.8/button-confirmation/guide.zh.md'], ['docs/upgrade-guide/v0.1.0-alpha.7/operation-permissions/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.7/operation-permissions/guide.zh.md'], ['docs/upgrade-guide/v0.1.0-alpha.6/audited-decisions/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.6/audited-decisions/guide.zh.md'], ['docs/upgrade-guide/v0.1.0-alpha.5/windows-verification-evidence/guide.md', 'docs/upgrade-guide/v0.1.0-alpha.5/windows-verification-evidence/guide.zh.md'], ['README.md', 'README.zh.md'], ['docs/workflow.md', 'docs/workflow.zh.md'], ['docs/compatibility.md', 'docs/compatibility.zh.md'], ['docs/persistence.md', 'docs/persistence.zh.md'], ['docs/security.md', 'docs/security.zh.md'], ['docs/execution.md', 'docs/execution.zh.md'], ['docs/recovery.md', 'docs/recovery.zh.md'], ['docs/bundle.md', 'docs/bundle.zh.md'], ['docs/implementation-plan.md', 'docs/implementation-plan.zh.md']]) {
  const a = await readFile(en, 'utf8'), b = await readFile(zh, 'utf8')
  assert.equal(a.split('\n').length, b.split('\n').length, en + ': bilingual physical line counts differ')
  assert.deepEqual(a.match(/^#{1,6} /gm), b.match(/^#{1,6} /gm), en + ': heading structures differ')
  assert.deepEqual(a.match(/\x60{3}[^]*?\x60{3}/g), b.match(/\x60{3}[^]*?\x60{3}/g), en + ': code blocks differ')
}
// Current candidate guides follow the DSH upgrade-guide template. Historical
// guides stay frozen; do not modernize them merely to satisfy a new rule.
for (const [en, zh] of newPairs.slice(0, 2)) {
  const english = await readFile(en, 'utf8'), chinese = await readFile(zh, 'utf8')
  for (const [path, text, headings] of [[en, english, ['## Change', '## Migration']], [zh, chinese, ['## 变更', '## 迁移']]]) {
    assert(/^---\nkind: upgrade-guide\ndescription: "[^\n]+"\n---\n/.test(text), path + ': invalid upgrade-guide metadata')
    assert.equal((text.match(/^# /gm) ?? []).length, 1, path + ': expected one title')
    assert.deepEqual(text.match(/^## .+$/gm), headings, path + ': expected only Change and Migration sections')
  }
  assert(english.trim().split(/\s+/).length <= 500, en + ': exceeds the 500-word upgrade-guide limit')
  await access(en.replace(/\.md$/, '.i18n.yaml'))
}
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(manifest.name, '@aaronwu/dsh-review-gated')
async function ownedSources(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) result.push(...await ownedSources(path))
    else if (entry.isFile() && path.endsWith('.ts')) result.push(path)
  }
  return result
}
const sources = await ownedSources('src')
assert(sources.length > 0, 'No owned TypeScript sources found')
for (const path of sources) {
  const text = await readFile(path, 'utf8')
  assert(!text.includes('D:/deepseek-harness') && !text.includes('D:\\deepseek-harness'), path + ': machine-specific source dependency')
}
console.log('Documentation links, bilingual structure, and machine-path checks passed.')
