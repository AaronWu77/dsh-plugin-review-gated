import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, symlink, link, writeFile, chmod } from 'node:fs/promises'
import { tmpdir, devNull } from 'node:os'
import { join } from 'node:path'
import { inflateSync, deflateSync } from 'node:zlib'
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { GitSnapshots, GitFailure, validatePath } from '../../src/git/snapshots.js'
import { brief } from '../fixtures/workflow.js'

const exec = promisify(execFile)
const resolver = new Context()
let disposeResolver: (() => Promise<void>) | undefined
beforeAll(async () => { const fiber = await resolver.plugin(LocalSubprocess); disposeResolver = () => fiber.dispose(); limits.gitExecutable = await resolver.subprocess.resolveExecutable('git') })
afterAll(() => disposeResolver?.())
const limits = { gitExecutable: '', timeoutMs: 10000, maxOutputBytes: 1024 * 1024, maxFileBytes: 512 * 1024, maxTreeEntries: 100, maxTreeBytes: 1024 * 1024, maxMetadataEntries: 1000 }
let directory: string
let git: GitSnapshots
const fixtureGitNull = process.platform === 'win32' ? 'NUL' : devNull
const fixtureEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: fixtureGitNull, GIT_TERMINAL_PROMPT: '0' }
async function command(...args: string[]) {
  return exec(limits.gitExecutable, ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + fixtureGitNull, '-c', 'commit.gpgSign=false', ...args], { cwd: directory, timeout: 10000, env: fixtureEnv })
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'review-gated-test-'))
  await mkdir(join(directory, 'src'))
  await writeFile(join(directory, 'src', 'export.txt'), 'old\n')
  await command('init', '--quiet')
  await command('add', '--', 'src/export.txt')
  await command('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture')
  git = await GitSnapshots.open(directory, limits)
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('snapshot staging and review identity', () => {
  it('inspects a read-only authorization baseline and does one fsck per phase', async () => {
    const indexBefore = await readFile(join(directory, '.git/index'))
    const internals = git as unknown as { invoke(args: readonly string[], timeoutMs?: number): Promise<Buffer> }
    const calls = vi.spyOn(internals, 'invoke')
    try {
      const baseline = await git.inspectBaseline(brief)
      expect(baseline).toEqual({ repository: git.repository, head: (await command('rev-parse', 'HEAD')).stdout.trim(), treeId: (await command('rev-parse', 'HEAD^{tree}')).stdout.trim() })
      expect(calls.mock.calls.filter(([args]) => args[0] === 'fsck')).toHaveLength(1)
      expect(calls.mock.calls.find(([args]) => args[0] === 'fsck')?.[1]).toBe(120000)
      calls.mockClear()
      const snapshot = await git.capture({ ...brief, executionIntent: 'verification-only' }, baseline.head)
      expect(calls.mock.calls.filter(([args]) => args[0] === 'fsck')).toHaveLength(1)
      calls.mockClear()
      await git.assertCurrent(snapshot)
      expect(calls.mock.calls.filter(([args]) => args[0] === 'fsck')).toHaveLength(1)
      expect(await readFile(join(directory, '.git/index'))).toEqual(indexBefore)
    } finally { calls.mockRestore() }
  })
  it('allows standalone worktree configuration without enabling hooks', async () => {
    await command('config', 'extensions.worktreeConfig', 'true')
    await command('config', '--worktree', 'core.hooksPath', '/untrusted-hook-location')
    await command('config', '--worktree', 'core.fsmonitor', 'untrusted-fsmonitor')
    const standalone = await GitSnapshots.open(directory, { ...limits, integrityTimeoutMs: 120000 })
    await expect(standalone.inspectBaseline(brief)).resolves.toMatchObject({ repository: git.repository })
    const internals = standalone as unknown as { invoke(args: readonly string[]): Promise<Buffer> }
    const configuredHooks = (await internals.invoke(['config', '--get', 'core.hooksPath'])).toString().trim()
    expect(configuredHooks).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null')
  })
  it.each(['local', 'worktree'])('reports dangerous %s config keys and origins without values or following includes', async scope => {
    await command('config', 'extensions.worktreeConfig', 'true')
    const origin = scope === 'worktree' ? 'config.worktree' : 'config'
    const secret = 'SECRET-CONFIG-VALUE-DO-NOT-REPORT'
    await command('config', '--' + scope, 'filter.fixture.clean', secret)
    let failure: unknown
    try { await git.head() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('filter.fixture.clean')
    expect((failure as Error).message).toContain(origin)
    expect((failure as Error).message).not.toContain(secret)
    await command('config', '--' + scope, '--unset', 'filter.fixture.clean')
    const include = join(directory, '.git', 'invalid-include')
    await writeFile(include, 'INVALID CONFIGURATION THAT MUST NOT BE READ')
    await command('config', '--' + scope, 'include.path', include)
    await expect(git.head()).rejects.toThrow('include.path')
  })
  it.each(['filter.fixture.smudge', 'diff.fixture.textconv', 'extensions.partialClone', 'remote.fixture.promisor', 'fsck.skipList', 'core.worktree'])('rejects dangerous worktree config %s', async key => {
    await command('config', 'extensions.worktreeConfig', 'true')
    await command('config', '--worktree', key, 'SECRET-UNTRUSTED-VALUE')
    await expect(git.head()).rejects.toThrow('Repository-controlled Git')
  })
  it('audits config.worktree hard links before Git reads them', async () => {
    await command('config', 'extensions.worktreeConfig', 'true')
    const source = join(directory, '.git', 'linked-config-source')
    await writeFile(source, '[core]\n hooksPath = /untrusted\n')
    await link(source, join(directory, '.git', 'config.worktree'))
    await expect(git.head()).rejects.toThrow('Linked Git metadata')
  })
  it('rejects linked worktrees even when worktreeConfig is enabled', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'review-gated-linked-test-'))
    const target = join(parent, 'linked')
    try {
      await command('config', 'extensions.worktreeConfig', 'true')
      await command('worktree', 'add', '--detach', target, 'HEAD')
      await expect(GitSnapshots.open(target, limits)).rejects.toThrow('linked Git metadata')
    } finally {
      await command('worktree', 'remove', '--force', target)
      await rm(parent, { recursive: true, force: true })
    }
  })
  it('checks approved ancestors before whole-tree scanning, including ignored generated repositories', async () => {
    await writeFile(join(directory, '.git/info/exclude'), 'nested/\n')
    await mkdir(join(directory, 'nested'))
    await exec(limits.gitExecutable, ['init', '--quiet'], { cwd: join(directory, 'nested'), timeout: 10000, env: fixtureEnv })
    const nested = { ...brief, allowedPaths: ['nested/new/subdir'], generatedPaths: ['nested'] }
    await expect(git.inspectBaseline(nested)).rejects.toThrow('Approved path crosses nested repository boundary: nested')
    await expect(git.inspectBaseline({ ...brief, allowedPaths: ['.'] })).rejects.toThrow('Nested repository boundary')
  })
  it('retains strict whole-tree checks outside the approved paths', async () => {
    await writeFile(join(directory, '.git/info/exclude'), 'outside.txt\n')
    await writeFile(join(directory, 'outside.txt'), 'unreviewed')
    await expect(git.inspectBaseline({ ...brief, allowedPaths: ['src'] })).rejects.toThrow('including ignored files: outside.txt')
  })

  it('preserves typed bounded diagnostics and legacy constructor compatibility', () => {
    const legacy = new GitFailure(['status'], 3, 'stderr')
    expect(legacy.diagnostic).toEqual({ args: ['status'], exitCode: 3, stdout: '', stderr: 'stderr', signal: null, timedOut: false, aborted: false, elapsedMs: 0, kind: 'exit' })
    const failure = new GitFailure(['-c', 'fixture.secret=DO-NOT-LEAK', 'status', 'x'.repeat(50000)], null, 'z'.repeat(50000), { stdout: 'a'.repeat(50000), kind: 'spawn', cause: new Error('safe cause') })
    expect(failure.message).not.toContain('DO-NOT-LEAK')
    const echoed = new GitFailure(['-c', 'fixture.secret=DO-NOT-LEAK', 'status'], 1, 'error: DO-NOT-LEAK', { stdout: 'DO-NOT-LEAK' })
    expect(echoed.message + JSON.stringify(echoed.diagnostic)).not.toContain('DO-NOT-LEAK')
    expect(failure.args.every(arg => Buffer.byteLength(arg) <= 256)).toBe(true)
    expect(Buffer.byteLength(failure.stdout)).toBeLessThanOrEqual(8192)
    expect(Buffer.byteLength(failure.stderr)).toBeLessThanOrEqual(8192)
    expect(failure.cause).toBeInstanceOf(Error)
    expect(Object.isFrozen(failure.diagnostic)).toBe(true)
    const config = new GitFailure(['config', 'fixture.secret', 'DO-NOT-LEAK'], 1, 'DO-NOT-LEAK', { stdout: 'DO-NOT-LEAK' })
    expect(config.message + JSON.stringify(config.diagnostic)).not.toContain('DO-NOT-LEAK')
  })
  it('preserves real exit failure stdout/stderr and exit status', async () => {
    const invoke = (git as unknown as { invoke(args: readonly string[]): Promise<Buffer> }).invoke.bind(git)
    const failure = await invoke(['rev-parse', '--verify', 'refs/heads/missing-fixture']).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GitFailure)
    expect(failure).toMatchObject({ kind: 'exit', exitCode: 128, signal: null, timedOut: false, aborted: false, stdout: '' })
    expect((failure as GitFailure).stderr).toContain('fatal:')
    expect((failure as GitFailure).elapsedMs).toBeGreaterThanOrEqual(0)
    const partial = await invoke(['rev-parse', 'HEAD', 'refs/heads/missing-fixture']).catch((error: unknown) => error)
    expect(partial).toBeInstanceOf(GitFailure)
    expect((partial as GitFailure).stdout).toContain(await git.head())
    expect((partial as GitFailure).stderr).toContain('fatal:')
  })
  it('classifies spawn failures and preserves a safe cause', async () => {
    const internals = git as unknown as { limits: { gitExecutable: string }; invoke(args: readonly string[]): Promise<Buffer> }
    const executable = internals.limits.gitExecutable
    try {
      internals.limits.gitExecutable = join(directory, '.git', 'missing-fixture-executable')
      const failure = await internals.invoke(['status']).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(GitFailure)
      expect(failure).toMatchObject({ kind: 'spawn', exitCode: null, signal: null, timedOut: false, aborted: false })
      expect((failure as GitFailure).cause).toMatchObject({ code: 'ENOENT' })
    } finally { internals.limits.gitExecutable = executable }
    await expect(git.head()).resolves.toMatch(/^[a-f0-9]+$/)
  })
  it('classifies output limits without parsing error messages', async () => {
    const tiny = await GitSnapshots.open(directory, { ...limits, maxFileBytes: 1 })
    const invoke = (tiny as unknown as { invoke(args: readonly string[]): Promise<Buffer> }).invoke.bind(tiny)
    const failure = await invoke(['cat-file', 'blob', 'HEAD:src/export.txt']).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GitFailure)
    expect(failure).toMatchObject({ kind: 'output-limit', timedOut: false, aborted: false })
    expect((failure as GitFailure).cause).toBeInstanceOf(Error)
  })
  it('times out a private scratch Git stdin wait and drains before rejection', async () => {
    const invoke = (git as unknown as { invoke(args: readonly string[], timeoutMs: number): Promise<Buffer> }).invoke.bind(git)
    // hash-object waits for EOF on its owned pipe; no production repo, gc or timing race.
    const failure = await invoke(['hash-object', '--stdin'], 50).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GitFailure)
    expect(failure).toMatchObject({ kind: 'timeout', timedOut: true, aborted: false })
    expect((failure as GitFailure).elapsedMs).toBeGreaterThan(0)
    await expect(git.inspectBaseline(brief)).resolves.toHaveProperty('head')
  })
  it('classifies in-flight cancellation while retaining process outcome and draining', async () => {
    const abort = new AbortController()
    const owned = await GitSnapshots.open(directory, limits, abort.signal)
    const invoke = (owned as unknown as { invoke(args: readonly string[]): Promise<Buffer> }).invoke.bind(owned)
    const pending = invoke(['hash-object', '--stdin']).catch((error: unknown) => error)
    // invoke spawns synchronously before returning its promise: abort owns a started child.
    abort.abort(new Error('fixture cancellation'))
    const failure = await pending
    expect(failure).toBeInstanceOf(GitFailure)
    expect(failure).toMatchObject({ kind: 'aborted', aborted: true, timedOut: false })
    expect((failure as GitFailure).cause).toBeInstanceOf(Error)
  })
  it('uses the independent integrity budget, leaving ordinary commands unchanged', async () => {
    const owned = await GitSnapshots.open(directory, { ...limits, integrityTimeoutMs: 123456 })
    const internals = owned as unknown as { invoke(args: readonly string[], timeoutMs?: number): Promise<Buffer> }
    const calls = vi.spyOn(internals, 'invoke')
    try {
      await owned.inspectBaseline(brief)
      expect(calls.mock.calls.find(([args]) => args[0] === 'fsck')?.[1]).toBe(123456)
      expect(calls.mock.calls.find(([args]) => args[0] === 'status')?.[1]).toBe(10000)
    } finally { calls.mockRestore() }
  })
  it('refuses Git open and later operations after execution cancellation', async () => {
    const abort = new AbortController()
    const owned = await GitSnapshots.open(directory, limits, abort.signal)
    abort.abort(new Error('execution deadline reached'))
    await expect(owned.head()).rejects.toThrow('execution deadline reached')
    await expect(GitSnapshots.open(directory, limits, abort.signal)).rejects.toThrow('execution deadline reached')
  })
  it.each(['--assume-unchanged', '--skip-worktree'])('rejects index hiding flag %s without resetting it', async flag => {
    await command('update-index', flag, 'src/export.txt')
    await writeFile(join(directory, 'src/export.txt'), 'hidden edit\n')
    await expect(git.assertCleanBase()).rejects.toThrow('Hidden Git index flag')
    await expect(git.stage(brief, await git.head())).rejects.toThrow('Hidden Git index flag')
    expect((await command('ls-files', '-v')).stdout).toMatch(flag === '--skip-worktree' ? /^S / : /^h /)
  })
  it('rejects ignored source but permits only explicitly declared generated artifacts', async () => {
    await writeFile(join(directory, '.git/info/exclude'), 'ignored.txt\nartifacts/\n')
    await writeFile(join(directory, 'ignored.txt'), 'not reviewed')
    await expect(git.assertCleanBase(brief)).rejects.toThrow('including ignored')
    await rm(join(directory, 'ignored.txt'))
    await mkdir(join(directory, 'artifacts')); await writeFile(join(directory, 'artifacts/log.txt'), 'generated')
    await expect(git.assertCleanBase(brief)).rejects.toThrow('including ignored')
    const approved = { ...brief, generatedPaths: ['artifacts'] }
    const base = await git.assertCleanBase(approved)
    await writeFile(join(directory, 'src/export.txt'), 'candidate')
    const candidate = await git.stage(approved, base)
    await git.assertCurrent(candidate)
    await writeFile(join(directory, 'src/export.txt'), 'changed source')
    await expect(git.assertCurrent(candidate)).rejects.toThrow()
  })
  it('rejects CRLF bytes that differ from the reviewed Git blob', async () => {
    await command('config', 'core.autocrlf', 'true')
    await writeFile(join(directory, 'src/export.txt'), 'new\r\n')
    await writeFile(join(directory, '.gitattributes'), '*.txt text eol=lf\n')
    await command('add', '.gitattributes'); await command('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'attrs', '--quiet')
    await expect(git.stage(brief, await git.head())).rejects.toThrow('line endings')
  })
  it('rejects a repository executable and relative Git program before executing either', async () => {
    await expect(GitSnapshots.open(directory, { ...limits, gitExecutable: 'git' })).rejects.toThrow('absolute')
    const binary = join(directory, 'git.exe'); await writeFile(binary, 'not an executable')
    await expect(GitSnapshots.open(directory, { ...limits, gitExecutable: binary })).rejects.toThrow('outside')
  })
  it('authenticates non-root subtree object contents instead of trusting their OID filenames', async () => {
    await mkdir(join(directory, 'config')); await writeFile(join(directory, 'config/secret.txt'), 'baseline')
    await command('add', 'config'); await command('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline', '--quiet')
    const base = await git.assertCleanBase(), subtree = (await command('rev-parse', 'HEAD:config')).stdout.trim()
    const oldBlob = (await command('rev-parse', 'HEAD:config/secret.txt')).stdout.trim()
    const payload = join(directory, '.git/payload'); await writeFile(payload, 'tampered')
    const newBlob = (await command('hash-object', '-w', payload)).stdout.trim()
    const objectPath = join(directory, '.git/objects', subtree.slice(0, 2), subtree.slice(2))
    const data = inflateSync(await readFile(objectPath)), index = data.indexOf(Buffer.from(oldBlob, 'hex'))
    expect(index).toBeGreaterThan(0); Buffer.from(newBlob, 'hex').copy(data, index)
    await chmod(objectPath, 0o600)
    await writeFile(objectPath, deflateSync(data))
    await writeFile(join(directory, 'config/secret.txt'), 'tampered')
    await writeFile(join(directory, 'src/export.txt'), 'allowed candidate')
    await expect(git.stage(brief, base)).rejects.toThrow()
  })
  it.each(['include.path', 'fsck.skipList', 'fsck.hashMismatch', 'core.worktree'])('refuses configuration indirection or object-check suppression %s', async key => {
    await command('config', key, key === 'fsck.hashMismatch' ? 'ignore' : '/outside')
    await expect(git.head()).rejects.toThrow('Repository-controlled Git')
  })
  it('rejects incomplete digest manifests and source citations outside snapshot files or lines', async () => {
    await writeFile(join(directory, 'src/export.txt'), 'candidate')
    const candidate = await git.stage(brief, await git.head())
    await expect(git.assertCurrent({ ...candidate, fileDigests: [] })).rejects.toThrow('digest')
    const output = await git.materialize(candidate, tmpdir())
    const review = { outcome: 'Passed' as const, briefRevision: 1, snapshotId: candidate.id, treeId: candidate.treeId, findings: [], checked: [], unchecked: [], reason: '' }
    try {
      for (const evidence of [{ kind: 'source' as const, file: 'outside.txt', line: 1, explanation: 'not source' }, { kind: 'source' as const, file: 'src/export.txt', line: 20, explanation: 'not a line' }]) {
        await expect(git.assertReviewEvidence(candidate, { ...review, acceptance: [{ id: 'AC1', status: 'Passed', evidence: [evidence] }] }, output.directory)).rejects.toThrow('outside')
      }
      await writeFile(join(output.directory, 'src/export.txt'), Buffer.from([0xc3, 0x28]))
      await expect(git.assertReviewEvidence(candidate, { ...review, acceptance: [{ id: 'AC1', status: 'Passed', evidence: [{ kind: 'source', file: 'src/export.txt', line: 1, explanation: 'invalid text' }] }] }, output.directory)).rejects.toThrow('UTF-8')
    } finally { await output.dispose() }
  })
  it('captures a clean unchanged tree for verification-only execution', async () => {
    const indexPath = join(directory, '.git', 'index')
    const indexBefore = await readFile(indexPath)
    const base = await git.assertCleanBase({ ...brief, executionIntent: 'verification-only' })
    const snapshot = await git.capture({ ...brief, executionIntent: 'verification-only' }, base)
    expect(snapshot.changedPaths).toEqual([])
    expect(snapshot.baseCommit).toBe(base)
    expect(snapshot.treeId).toMatch(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
    await git.assertCurrent(snapshot)
    expect(await readFile(indexPath)).toEqual(indexBefore)
    await expect(git.assertCurrent({ ...snapshot, treeId: 'a'.repeat(40) })).rejects.toThrow('approved baseline')
  })
  it('binds staged contents without a commit and exports that immutable tree', async () => {
    const base = await git.assertCleanBase()
    await writeFile(join(directory, 'src', 'export.txt'), 'new\n')
    await writeFile(join(directory, 'src', 'new.bin'), Buffer.from([0, 1, 255]))
    const snapshot = await git.stage(brief, base)
    expect(snapshot.changedPaths).toEqual(['src/export.txt', 'src/new.bin'])
    expect(await git.head()).toBe(base)
    expect((await command('rev-list', '--count', 'HEAD')).stdout.trim()).toBe('1')
    expect(await git.diff(snapshot)).toContain('+new')
    const output = await git.materialize(snapshot, tmpdir())
    try {
      expect(await readFile(join(output.directory, 'src', 'export.txt'), 'utf8')).toBe('new\n')
      expect(await readFile(join(output.directory, 'src', 'new.bin'))).toEqual(Buffer.from([0, 1, 255]))
      await writeFile(join(directory, 'src', 'export.txt'), 'later unstaged\n')
      expect(await git.tree()).toBe(snapshot.treeId)
      await expect(git.assertCurrent(snapshot)).rejects.toThrow()
      expect(await readFile(join(output.directory, 'src', 'export.txt'), 'utf8')).toBe('new\n')
      await command('add', '--', 'src/export.txt')
      expect(await git.tree()).not.toBe(snapshot.treeId)
      await expect(git.assertCurrent(snapshot)).rejects.toThrow('Snapshot')
    } finally { await output.dispose() }
  })
  it('allows generated verification artifacts but rejects altered or missing exported source', async () => {
    const base = await git.head()
    await writeFile(join(directory, 'src', 'export.txt'), 'candidate')
    const snapshot = await git.stage(brief, base)
    const output = await git.materialize(snapshot, tmpdir())
    try {
      await writeFile(join(output.directory, 'generated.txt'), 'test artifact')
      await git.assertMaterialized(snapshot, output.directory)
      await writeFile(join(output.directory, 'src', 'export.txt'), 'test changed source')
      await expect(git.assertMaterialized(snapshot, output.directory)).rejects.toThrow('Snapshot source changed')
      await rm(join(output.directory, 'src', 'export.txt'))
      await expect(git.assertMaterialized(snapshot, output.directory)).rejects.toThrow()
    } finally { await output.dispose() }
  })
  it('rejects an active Git operation even when the staged tree is unchanged', async () => {
    await writeFile(join(directory, 'src', 'export.txt'), 'candidate')
    const snapshot = await git.stage(brief, await git.head())
    await writeFile(join(directory, '.git', 'MERGE_HEAD'), snapshot.baseCommit + '\n')
    await expect(git.assertCurrent(snapshot)).rejects.toThrow('operation')
  })
  it.each(['filter.fixture.clean', 'filter.fixture.process', 'diff.fixture.command', 'diff.fixture.textconv', 'extensions.partialClone', 'remote.fixture.promisor'])('refuses repository-controlled Git programs or lazy-fetch helpers: %s', async key => {
    await command('config', key, 'untrusted-program')
    await expect(git.head()).rejects.toThrow('Repository-controlled Git')
  })
  it('suppresses repository fsmonitor programs before status reads', async () => {
    const marker = join(directory, '.git', 'fsmonitor-ran')
    const program = join(directory, '.git', 'fsmonitor.cjs')
    await writeFile(program, 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "ran")')
    await command('config', 'core.fsmonitor', '"' + process.execPath.replaceAll('\\', '/') + '" "' + program.replaceAll('\\', '/') + '"')
    await git.assertCleanBase()
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves unrelated changes and index when scope is violated', async () => {
    const base = await git.head()
    const originalTree = await git.tree()
    await writeFile(join(directory, 'outside.txt'), 'unrelated\n')
    await writeFile(join(directory, 'src', 'export.txt'), 'change\n')
    await expect(git.stage(brief, base)).rejects.toThrow('scope')
    expect(await git.tree()).toBe(originalTree)
    expect(await readFile(join(directory, 'outside.txt'), 'utf8')).toBe('unrelated\n')
  })
  it('requires a clean initial repository', async () => {
    await writeFile(join(directory, 'src', 'export.txt'), 'existing work\n')
    await expect(git.assertCleanBase()).rejects.toThrow('Existing')
    await command('add', '--', 'src/export.txt')
    await expect(git.assertCleanBase()).rejects.toThrow('Existing')
  })
  it('rejects untracked contents appearing after staging', async () => {
    const base = await git.head()
    await writeFile(join(directory, 'src', 'export.txt'), 'change\n')
    const snapshot = await git.stage(brief, base)
    await writeFile(join(directory, 'unexpected.txt'), 'not reviewed\n')
    await expect(git.assertCurrent(snapshot)).rejects.toThrow('Unreviewed workspace file')
  })
  it('handles deleted files and names containing spaces', async () => {
    const base = await git.head()
    await rm(join(directory, 'src', 'export.txt'))
    await writeFile(join(directory, 'src', 'name with spaces.txt'), 'replacement\n')
    const snapshot = await git.stage(brief, base)
    expect(snapshot.changedPaths).toEqual(['src/export.txt', 'src/name with spaces.txt'])
    const output = await git.materialize(snapshot, tmpdir())
    try {
      await expect(readFile(join(output.directory, 'src', 'export.txt'))).rejects.toThrow()
      expect(await readFile(join(output.directory, 'src', 'name with spaces.txt'), 'utf8')).toBe('replacement\n')
    } finally { await output.dispose() }
  })
  it('rejects a moved base, an empty candidate, and a foreign snapshot', async () => {
    await expect(git.stage(brief, 'f'.repeat(40))).rejects.toThrow('Base')
    await expect(git.stage(brief, await git.head())).rejects.toThrow('No task')
    await writeFile(join(directory, 'src', 'export.txt'), 'change\n')
    const snapshot = await git.stage(brief, await git.head())
    await expect(git.materialize({ ...snapshot, repository: 'foreign' }, tmpdir())).rejects.toThrow('another')
  })
  it('rejects nested cwd and active Git operations', async () => {
    await expect(GitSnapshots.open(join(directory, 'src'), limits)).rejects.toThrow('root')
    await writeFile(join(directory, '.git', 'MERGE_HEAD'), await git.head())
    await expect(GitSnapshots.open(directory, limits)).rejects.toThrow('operation')
  })
  it('enforces output entry and file limits without a partial handoff', async () => {
    await writeFile(join(directory, 'src', 'new.txt'), 'new\n')
    const snapshot = await git.stage(brief, await git.head())
    const small = await GitSnapshots.open(directory, { ...limits, maxTreeEntries: 1 })
    await expect(small.materialize(snapshot, tmpdir())).rejects.toThrow('entry limit')
    const tiny = await GitSnapshots.open(directory, { ...limits, maxFileBytes: 1 })
    await expect(tiny.materialize(snapshot, tmpdir())).rejects.toThrow('file limit')
  })
  it.skipIf(process.platform === 'win32')('rejects symlink staging rather than following it', async () => {
    await symlink('/outside', join(directory, 'src', 'link'))
    await expect(git.stage(brief, await git.head())).rejects.toThrow('Symlink')
  })
  it.each(['../outside', 'src/../../outside', '/absolute', 'C:/absolute', 'src\\escape', '.git/config', 'src//file', 'src/./file', 'src/*', 'src/**', 'src/a?', 'src/[ab]', 'src/{a,b}'])('rejects unsafe path %s', path => {
    expect(() => validatePath(path)).toThrow('Unsafe')
  })
  it('admits only explicit root scope and validates resource limits', async () => {
    expect(validatePath('.', true)).toBe('.')
    expect(() => validatePath('.')).toThrow()
    await expect(GitSnapshots.open(directory, { ...limits, maxFileBytes: 0 })).rejects.toThrow('limit')
  })
})
