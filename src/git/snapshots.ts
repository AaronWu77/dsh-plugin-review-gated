/** Trusted, shell-free Git operations for snapshot-bound review. */
import { execFile } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { boundedRoleResultError } from '../roles/output.js'
import { lstat, mkdtemp, mkdir, realpath, rm, writeFile, chmod, readFile, unlink, readdir } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path'
import { devNull, tmpdir } from 'node:os'
import type { RequirementsBrief, StagedSnapshot, ReviewResult } from '../workflow/types.js'
import { gitIdSchema } from '../workflow/types.js'

const gitNull = process.platform === 'win32' ? 'NUL' : devNull

export interface GitLimits {
  gitExecutable: string
  timeoutMs: number
  /** Independent budget for full object integrity checks (default 120 seconds). */
  integrityTimeoutMs?: number
  maxOutputBytes: number
  maxFileBytes: number
  maxTreeEntries: number
  maxTreeBytes: number
  maxMetadataEntries: number
}
/** Resolved deployment budgets used by every operation. */
export interface ResolvedGitLimits extends GitLimits { integrityTimeoutMs: number }
/** Resolve optional legacy inputs once, before any Git command. @param limits Caller budgets. @returns Complete budgets. */
export function resolveGitLimits(limits: GitLimits): ResolvedGitLimits { return { ...limits, integrityTimeoutMs: limits.integrityTimeoutMs ?? 120000 } }
export type GitFailureKind = 'timeout' | 'aborted' | 'output-limit' | 'spawn' | 'exit'
export interface GitDiagnostic {
  readonly args: readonly string[]
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly elapsedMs: number
  readonly kind: GitFailureKind
}
const diagnosticBytes = 8192
function bounded(value: string, bytes = diagnosticBytes): string {
  let text = Buffer.from(value).subarray(0, bytes).toString('utf8')
  while (Buffer.byteLength(text) > bytes) text = text.slice(0, -1)
  return text
}
function diagnosticArgs(args: readonly string[]): readonly string[] {
  let configValue = false
  return Object.freeze(args.slice(0, 64).map((arg, index) => {
    const hidden = args[0] === 'config' && index > 1 && !arg.startsWith('--')
    const value = hidden ? '<redacted>' : configValue ? arg.split('=')[0] + '=<redacted>' : arg.replace(/^(-c|--config-env=|--config=)([^=]+)=.*$/s, '$1$2=<redacted>')
    configValue = arg === '-c' || arg === '--config-env'
    return bounded(value, 256)
  }))
}
/** Read-only Git failure. Child exit and pipe drain finish before this reaches callers.
 * Streams and argv are bounded; configuration command output is withheld, never values.
 * Consumers must stop the dependent phase; no repository recovery is implied.
 */
export class GitFailure extends Error implements GitDiagnostic {
  readonly args: readonly string[]
  readonly stdout: string
  readonly stderr: string
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly elapsedMs: number
  readonly kind: GitFailureKind
  readonly diagnostic: Readonly<GitDiagnostic>
  constructor(args: readonly string[], readonly exitCode: number | null, stderr: string, details: Partial<Omit<GitDiagnostic, 'args' | 'exitCode' | 'stderr'>> & { cause?: unknown } = {}) {
    const safeArgs = diagnosticArgs(args)
    const isConfig = args[0] === 'config'
    const configValues = args.flatMap((arg, index) => {
      const setting = args[index - 1] === '-c' ? arg : arg.startsWith('-c') && arg !== '-c' ? arg.slice(2) : ''
      const equal = setting.indexOf('=')
      return equal >= 0 && setting.slice(equal + 1) ? [setting.slice(equal + 1)] : []
    })
    const safeOutput = (value: string): string => {
      for (const secret of configValues) value = value.replaceAll(secret, '<redacted>')
      return bounded(value.replace(/^.*(?:bad (?:boolean|numeric|config|value)|invalid (?:config|value)|configuration|config file).*$/gim, '[Git configuration detail withheld]'))
    }
    const safeStderr = isConfig ? '[Git configuration output withheld]' : safeOutput(stderr)
    super('Git operation failed: ' + safeArgs.join(' ') + ': ' + safeStderr, { cause: details.cause })
    this.name = 'GitFailure'
    this.args = safeArgs
    this.stdout = isConfig ? '' : safeOutput(details.stdout ?? '')
    this.stderr = safeStderr
    this.signal = details.signal ?? null
    this.timedOut = details.timedOut ?? false
    this.aborted = details.aborted ?? false
    this.elapsedMs = details.elapsedMs ?? 0
    this.kind = details.kind ?? 'exit'
    this.diagnostic = Object.freeze({ args: this.args, stdout: this.stdout, stderr: this.stderr, exitCode, signal: this.signal, timedOut: this.timedOut, aborted: this.aborted, elapsedMs: this.elapsedMs, kind: this.kind })
  }
}

function environment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (['path', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'userprofile', 'homedrive', 'homepath', 'comspec'].includes(key.toLowerCase())) result[key] = value
  }
  return { ...result, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitNull, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' }
}

/** Approved repository-relative path; excludes traversal, Git internals, and pathspec syntax interpretation. */
export function validatePath(path: string, allowRoot = false): string {
  if (allowRoot && path === '.') return path
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\\') || /[\x00-\x1f\x7f\uFFFD*?\[\]{}]/.test(path)) throw new Error('Unsafe repository path')
  if (path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('Unsafe repository path')
  return path
}

/** A Git repository is bound to one canonical root, never a caller-selected cwd per operation. */
export class GitSnapshots {
  private readonly blobs = new Map<string, Buffer>()
  private cachedBytes = 0
  private constructor(readonly repository: string, private readonly limits: ResolvedGitLimits, private readonly signal?: AbortSignal) {}
  private async blob(id: string): Promise<Buffer> {
    const cached = this.blobs.get(id)
    if (cached) return cached
    const value = await this.run(['cat-file', 'blob', id]).catch(error => {
      if (error instanceof GitFailure && error.kind === 'output-limit') throw new Error('Snapshot file limit exceeded')
      throw error
    })
    if (this.cachedBytes + value.length > this.limits.maxTreeBytes) throw new Error('Snapshot total byte limit exceeded')
    this.cachedBytes += value.length
    this.blobs.set(id, value)
    return value
  }
  static async open(directory: string, limits: GitLimits, signal?: AbortSignal): Promise<GitSnapshots> {
    signal?.throwIfAborted()
    for (const [key, value] of Object.entries(limits)) if (key !== 'gitExecutable' && (!Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid Git resource limit')
    if (!isAbsolute(limits.gitExecutable)) throw new Error('Git executable must be resolved to an absolute host path')
    const canonical = await realpath(directory)
    const executable = await realpath(limits.gitExecutable)
    const offset = relative(canonical, executable)
    if (offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)) throw new Error('Git executable must be outside the task repository')
    const instance = new GitSnapshots(canonical, resolveGitLimits({ ...limits, gitExecutable: executable }), signal)
    await instance.assertMetadata()
    const root = await realpath((await instance.text(['rev-parse', '--show-toplevel'])).trim())
    if (root !== canonical) throw new Error('Use the repository root, not a subdirectory')
    const gitDir = await realpath((await instance.text(['rev-parse', '--absolute-git-dir'])).trim())
    const commonDir = await realpath(resolve(canonical, (await instance.text(['rev-parse', '--git-common-dir'])).trim()))
    if (gitDir !== commonDir || gitDir !== await realpath(join(canonical, '.git'))) throw new Error('External or linked Git metadata is unsupported: git-dir differs from common-dir')
    await instance.ensureNoOperation()
    return instance
  }
  private async assertMetadata(): Promise<void> {
    const root = join(this.repository, '.git')
    const rootStat = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') throw new Error('Use the repository root with regular Git metadata'); throw error })
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('External or linked Git metadata is unsupported')
    let count = 0
    const visit = async (directory: string): Promise<void> => {
      for (const name of await readdir(directory)) {
        this.signal?.throwIfAborted()
        if (++count > this.limits.maxMetadataEntries) throw new Error('Git metadata entry limit exceeded')
        const target = join(directory, name)
        const stat = await lstat(target)
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('Linked Git metadata is unsupported: ' + target)
        if (stat.isDirectory()) await visit(target)
        else if (!stat.isFile()) throw new Error('Unsupported Git metadata file type')
        if (target === join(root, 'objects', 'info', 'alternates') && stat.size) throw new Error('External Git object directories are unsupported')
      }
    }
    await visit(root)
  }
  private async assertObjectIntegrity(): Promise<void> {
    await this.assertMetadata()
    await this.run(['fsck', '--full', '--strict', '--no-reflogs'], this.limits.integrityTimeoutMs)
  }
  private async assertIndexFlags(): Promise<void> {
    const records = (await this.text(['ls-files', '-v', '-z'])).split('\0').filter(Boolean)
    for (const record of records) {
      if (record[0] === 'S' || /[a-z]/.test(record[0]!)) throw new Error('Hidden Git index flag: ' + record.slice(2))
    }
  }
  private async workspaceFiles(generatedPaths: readonly string[]): Promise<string[]> {
    const excluded = generatedPaths.map(path => validatePath(path))
    const files: string[] = []
    let count = 0
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const name of await readdir(directory)) {
        this.signal?.throwIfAborted()
        if (!prefix && name.toLowerCase() === '.git') continue
        const path = prefix ? prefix + '/' + name : name
        if (name.toLowerCase() === '.git') throw new Error('Nested repository boundary is unsupported: ' + path)
        validatePath(path)
        if (excluded.some(item => path === item || path.startsWith(item + '/'))) continue
        if (++count > this.limits.maxTreeEntries) throw new Error('Workspace entry limit exceeded')
        const stat = await lstat(join(directory, name))
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('Linked workspace paths are unsupported: ' + path)
        if (stat.isDirectory()) await visit(join(directory, name), path)
        else if (stat.isFile()) files.push(path)
        else throw new Error('Unsupported workspace file type: ' + path)
      }
    }
    await visit(this.repository, '')
    return files.sort()
  }
  private async assertWorkspaceTree(tree: string, generatedPaths: readonly string[], fileDigests?: StagedSnapshot['fileDigests']): Promise<void> {
    const entries = await this.entries(tree)
    const tracked = new Set(entries.map(entry => entry.path))
    await this.assertMaterializedChecked({ treeId: tree, ...fileDigests === undefined ? {} : { fileDigests } }, this.repository)
    for (const path of await this.workspaceFiles(generatedPaths)) {
      if (!tracked.has(path)) throw new Error('Unreviewed workspace file, including ignored files: ' + path)
    }
  }
  private async run(args: readonly string[], timeoutMs = this.limits.timeoutMs): Promise<Buffer> {
    await this.assertMetadata()
    // Git performs repository setup even for config --file: run the parser in an
    // empty private directory, so core.worktree/includes cannot redirect that setup.
    const parserRoot = await mkdtemp(join(tmpdir(), 'review-gated-config-'))
    try {
      for (const name of ['config', 'config.worktree']) {
        const config = join(this.repository, '.git', name)
        try { await lstat(config) } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT' && name === 'config.worktree') continue
          throw error
        }
        try {
          // Audit config.worktree even if currently dormant: it is repository metadata.
          // --name-only ensures refusal diagnostics contain keys/origins, never values.
          const programs = await this.invoke(['config', '--no-includes', '--file', config, '--null', '--show-origin', '--name-only', '--get-regexp', String.raw`^(filter\..*\.(clean|process|smudge)|diff\..*\.(command|textconv)|extensions\.partialclone|remote\..*\.promisor|fsck\..*|include.*\.path|core\.worktree)$`], this.limits.timeoutMs, parserRoot)
          if (programs.length) {
            const fields = programs.toString('utf8').split('\0').filter(Boolean)
            const rejected: string[] = []
            for (let index = 0; index < fields.length; index += 2) rejected.push(bounded(fields[index + 1] ?? '<unknown key>', 256) + ' (origin: ' + bounded(fields[index] ?? '<unknown origin>', 512) + ')')
            throw new Error('Repository-controlled Git configuration is unsupported: ' + bounded(rejected.join('; ')))
          }
        } catch (error) { if (!(error instanceof GitFailure && error.kind === 'exit' && error.exitCode === 1)) throw error }
      }
    } finally { await rm(parserRoot, { recursive: true, force: true }) }
    return this.invoke(args, timeoutMs)
  }
  private invoke(args: readonly string[], timeoutMs = this.limits.timeoutMs, cwd = this.repository): Promise<Buffer> {
    this.signal?.throwIfAborted()
    const started = performance.now()
    return new Promise((accept, reject) => {
      let closed = false, timedOut = false, exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null
      let outcome: { error: Error | null; stdout: Buffer; stderr: Buffer } | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = () => {
        if (!closed || !outcome) return
        clearTimeout(timer)
        const aborted = this.signal?.aborted ?? false
        if (outcome.error || timedOut || aborted) {
          const code = outcome.error && 'code' in outcome.error ? outcome.error.code : undefined
          const kind: GitFailureKind = aborted ? 'aborted' : timedOut ? 'timeout' : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit' : typeof code === 'string' && code !== 'ABORT_ERR' ? 'spawn' : 'exit'
          // execFile's error.message embeds raw argv and output. Preserve its class/code,
          // but not that unbounded, potentially sensitive message in the public cause.
          const cause = Object.assign(new Error('Git subprocess ' + kind), { name: outcome.error?.name ?? 'Error', code })
          reject(new GitFailure(args, exitCode, outcome.stderr.toString('utf8'), { stdout: outcome.stdout.toString('utf8'), signal: exitSignal, timedOut, aborted, elapsedMs: Math.max(0, performance.now() - started), kind, cause }))
        } else accept(outcome.stdout)
      }
      const child = execFile(this.limits.gitExecutable, ['--literal-pathspecs', '--no-pager', '--no-replace-objects', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + gitNull, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
        { cwd, env: { ...environment(), GIT_CEILING_DIRECTORIES: dirname(cwd) }, encoding: 'buffer', signal: this.signal, killSignal: 'SIGKILL', maxBuffer: args[0] === 'cat-file' ? this.limits.maxFileBytes : this.limits.maxOutputBytes },
        (error, stdout, stderr) => {
          outcome = { error, stdout, stderr }
          settle()
        })
      timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
      child.once('exit', (code, signal) => { exitCode = code; exitSignal = signal; clearTimeout(timer) })
      child.once('close', () => { closed = true; settle() })
    })
  }
  private async text(args: readonly string[]): Promise<string> { return (await this.run(args)).toString('utf8') }
  private async ensureNoOperation(): Promise<void> {
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge']) {
      const path = resolve(this.repository, (await this.text(['rev-parse', '--git-path', name])).trim())
      try { await lstat(path) } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
        throw error
      }
      throw new Error('Finish the existing Git operation before starting this workflow')
    }
  }
  async head(): Promise<string> { return gitIdSchema.parse((await this.text(['rev-parse', '--verify', 'HEAD'])).trim()) }
  private async commitTree(commit: string): Promise<string> {
    gitIdSchema.parse(commit)
    return gitIdSchema.parse((await this.text(['rev-parse', '--verify', commit + '^{tree}'])).trim())
  }
  async tree(): Promise<string> { return gitIdSchema.parse((await this.text(['write-tree'])).trim()) }
  async assertCleanBase(brief?: RequirementsBrief): Promise<string> {
    // Check approved ancestors first, including ignored/exempted nested repositories.
    for (const path of brief?.allowedPaths ?? []) {
      validatePath(path, true)
      if (path !== '.') await this.safeFile(path)
    }
    await this.ensureNoOperation()
    await this.assertIndexFlags()
    await this.assertObjectIntegrity()
    if ((await this.text(['status', '--porcelain=v1', '--untracked-files=all'])).length) throw new Error('Existing tracked, staged, or untracked changes must be preserved outside this task')
    const base = await this.head()
    await this.assertWorkspaceTree(base, brief?.generatedPaths ?? [])
    return base
  }
  /** Read-only admission identity; does not refresh/write the index or stage files. */
  async inspectBaseline(brief: RequirementsBrief): Promise<{ repository: string; head: string; treeId: string }> {
    const head = await this.assertCleanBase(brief)
    return { repository: this.repository, head, treeId: await this.commitTree(head) }
  }
  private async safeFile(path: string): Promise<void> {
    validatePath(path)
    let current = this.repository
    for (const segment of path.split('/')) {
      current = join(current, segment)
      try {
        const stat = await lstat(current)
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('Linked paths are unsupported: ' + path)
        if (stat.isDirectory() && (await readdir(current)).some(name => name.toLowerCase() === '.git')) throw new Error('Approved path crosses nested repository boundary: ' + relative(this.repository, current))
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
        throw error
      }
    }
  }
  private async changedFiles(baseCommit?: string): Promise<string[]> {
    const fields = (await this.text(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0')
    const paths = new Set<string>()
    for (let index = 0; index < fields.length; index++) {
      const record = fields[index]
      if (!record) continue
      if (record.length < 4) throw new Error('Malformed Git status')
      if (record[0] === 'U' || record[1] === 'U' || record.slice(0, 2) === 'AA' || record.slice(0, 2) === 'DD') throw new Error('Resolve conflicts before staging')
      paths.add(validatePath(record.slice(3)))
      if (/[RC]/.test(record.slice(0, 2))) {
        const oldPath = fields[++index]
        if (!oldPath) throw new Error('Missing rename source')
        paths.add(validatePath(oldPath))
      }
    }
    if (baseCommit) {
      for (const entry of await this.entries(baseCommit)) {
        const target = join(this.repository, entry.path)
        await this.safeFile(entry.path)
        try {
          const stat = await lstat(target)
          if (!stat.isFile() || stat.size > this.limits.maxFileBytes) throw new Error('Unsupported source type or size')
          const content = await readFile(target)
          const objectId = createHash(entry.object.length === 40 ? 'sha1' : 'sha256').update('blob ' + content.length + '\0').update(content).digest('hex')
          if (objectId !== entry.object || (process.platform !== 'win32' && Boolean(stat.mode & 0o111) !== (entry.mode === '100755'))) paths.add(entry.path)
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') paths.add(entry.path)
          else throw error
        }
      }
    }
    return [...paths].sort()
  }
  /** Check existing changes against the approved paths without touching the index. */
  async assertWithinScope(brief: RequirementsBrief, baseCommit: string): Promise<void> {
    await this.ensureNoOperation()
    await this.assertIndexFlags()
    await this.assertObjectIntegrity()
    if (await this.head() !== baseCommit) throw new Error('Base commit changed during implementation')
    const allowed = brief.allowedPaths.map(path => validatePath(path, true))
    const visible = new Set(await this.changedFiles(baseCommit))
    const tracked = new Set((await this.entries(baseCommit)).map(entry => entry.path))
    for (const path of await this.workspaceFiles(brief.generatedPaths ?? [])) {
      if (!tracked.has(path) && !visible.has(path)) throw new Error('Ignored source changes are unsupported: ' + path)
    }
    for (const path of visible) {
      if (!allowed.some(scope => scope === '.' || scope === path || path.startsWith(scope + '/'))) throw new Error('Change outside approved scope: ' + path)
      await this.safeFile(path)
    }
  }
  private async snapshotForTree(brief: RequirementsBrief, baseCommit: string, treeId: string, changedPaths: string[]): Promise<StagedSnapshot> {
    this.blobs.clear(); this.cachedBytes = 0
    const fileDigests = []
    for (const entry of await this.entries(treeId)) fileDigests.push({ path: entry.path, sha256: createHash('sha256').update(await this.blob(entry.object)).digest('hex') })
    const snapshot = { id: randomUUID(), briefRevision: brief.revision, baseCommit, treeId, repository: this.repository, changedPaths, generatedPaths: brief.generatedPaths ?? [], integrityVersion: 2 as const, fileDigests }
    await this.assertCurrentChecked(snapshot)
    return snapshot
  }
  /** Capture an unchanged clean baseline for verification-only execution.
   * @param brief Approved requirements.
   * @param baseCommit Clean repository HEAD.
   * @returns Snapshot containing the current tree without workspace writes.
   */
  async capture(brief: RequirementsBrief, baseCommit: string): Promise<StagedSnapshot> {
    if (await this.assertCleanBase(brief) !== baseCommit) throw new Error('Base commit changed during verification-only capture')
    return this.snapshotForTree(brief, baseCommit, await this.commitTree(baseCommit), [])
  }
  async stage(brief: RequirementsBrief, baseCommit: string): Promise<StagedSnapshot> {
    await this.ensureNoOperation()
    await this.assertIndexFlags()
    await this.assertObjectIntegrity()
    if (await this.head() !== baseCommit) throw new Error('Base commit changed during implementation')
    const allowed = brief.allowedPaths.map(path => validatePath(path, true))
    const changed = await this.changedFiles(baseCommit)
    if (!changed.length) throw new Error('No task changes to stage')
    for (const path of changed) {
      if (!allowed.some(scope => scope === '.' || scope === path || path.startsWith(scope + '/'))) throw new Error('Change outside approved scope: ' + path)
      await this.safeFile(path)
    }
    await this.assertWithinScope(brief, baseCommit)
    await this.run(['add', '--all', '--', ...changed])
    const treeId = await this.tree()
    const changedPaths = (await this.text(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', baseCommit, treeId, '--'])).split('\0').filter(Boolean)
    if (!changedPaths.length) throw new Error('Staged tree has no changes against the approved base')
    return this.snapshotForTree(brief, baseCommit, treeId, changedPaths)
  }
  async assertCurrent(snapshot: StagedSnapshot): Promise<void> {
    await this.assertObjectIntegrity()
    await this.assertCurrentChecked(snapshot)
  }
  private async assertCurrentChecked(snapshot: StagedSnapshot): Promise<void> {
    await this.ensureNoOperation()
    await this.assertIndexFlags()
    if (snapshot.integrityVersion === 2 && snapshot.fileDigests === undefined) throw new Error('Snapshot digest evidence is missing')
    if (snapshot.repository !== this.repository || await this.head() !== snapshot.baseCommit)
      throw new Error('Snapshot no longer matches repository or base')
    if (!snapshot.changedPaths.length) {
      if (await this.commitTree(snapshot.baseCommit) !== snapshot.treeId) throw new Error('Unchanged snapshot tree is not the approved baseline')
      if ((await this.text(['status', '--porcelain=v1', '--untracked-files=all'])).length) throw new Error('Existing tracked, staged, or untracked changes must be preserved outside this task')
    } else {
      if (await this.tree() !== snapshot.treeId) throw new Error('Snapshot no longer matches the index')
      await this.run(['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--'])
    }
    await this.assertWorkspaceTree(snapshot.treeId, snapshot.generatedPaths ?? [], snapshot.fileDigests)
  }
  async diff(snapshot: StagedSnapshot): Promise<string> {
    return this.text(['diff', '--no-ext-diff', '--no-textconv', snapshot.baseCommit, snapshot.treeId, '--'])
  }
  private async entries(tree: string): Promise<{ mode: string; object: string; path: string }[]> {
    gitIdSchema.parse(tree)
    const records = (await this.text(['ls-tree', '-r', '-z', '--full-tree', tree])).split('\0').filter(Boolean)
    if (records.length > this.limits.maxTreeEntries) throw new Error('Snapshot entry limit exceeded')
    return records.map(record => {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]+)\t(.+)$/s.exec(record)
      if (!match || !['100644', '100755'].includes(match[1]!) || match[2] !== 'blob') throw new Error('Symlinks and submodules are unsupported')
      return { mode: match[1]!, object: gitIdSchema.parse(match[3]), path: validatePath(match[4]!) }
    })
  }
  /** Check every original blob and executable bit; generated artifacts may coexist, never replace source. */
  async assertMaterialized(snapshot: Pick<StagedSnapshot, 'treeId' | 'fileDigests'>, directory: string): Promise<void> {
    await this.assertObjectIntegrity()
    await this.assertMaterializedChecked(snapshot, directory)
  }
  private async assertMaterializedChecked(snapshot: Pick<StagedSnapshot, 'treeId' | 'fileDigests'>, directory: string): Promise<void> {
    const root = await lstat(directory)
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Snapshot directory was replaced')
    const entries = await this.entries(snapshot.treeId)
    const digests = snapshot.fileDigests && new Map(snapshot.fileDigests.map(item => [item.path, item.sha256]))
    if (digests && (digests.size !== entries.length || snapshot.fileDigests!.length !== entries.length)) throw new Error('Snapshot digest coverage is incomplete')
    let total = 0
    for (const entry of entries) {
      let target = directory
      for (const segment of entry.path.split('/')) {
        target = join(target, segment)
        const item = await lstat(target)
        if (item.isSymbolicLink() || (item.isFile() && item.nlink > 1)) throw new Error('Snapshot source became a link')
      }
      const stat = await lstat(target)
      if (!stat.isFile() || stat.size > this.limits.maxFileBytes) throw new Error('Snapshot source type or size changed')
      if (process.platform !== 'win32' && Boolean(stat.mode & 0o111) !== (entry.mode === '100755')) throw new Error('Snapshot executable mode changed')
      total += stat.size
      if (total > this.limits.maxTreeBytes) throw new Error('Snapshot total byte limit exceeded')
      const content = await readFile(target)
      const digest = digests?.get(entry.path)
      if (digests ? digest !== createHash('sha256').update(content).digest('hex') : !content.equals(await this.blob(entry.object)))
        throw new Error('Snapshot source changed: ' + entry.path + '; checkout bytes must match the reviewed Git blobs, including line endings')
    }
  }
  /** Validate source citations against the actual reviewed export, not arbitrary paths.
   * @param snapshot Host-created candidate.
   * @param review Parsed role output.
   * @param directory Verified immutable review export.
   * @param runId Optional live Review identity for v5 bounded semantic rejection.
   */
  async assertReviewEvidence(snapshot: StagedSnapshot, review: ReviewResult, directory: string, runId?: string): Promise<void> {
    const reject = (message: string): never => {
      if (runId) throw boundedRoleResultError({ role: 'review', runId }, 'semantic-validation', [{ code: 'source-evidence', path: ['acceptance'], message }])
      throw new Error(message)
    }
    const paths = new Set((await this.entries(snapshot.treeId)).map(entry => entry.path))
    for (const item of review.acceptance ?? []) for (const evidence of item.evidence) {
      if (evidence.kind !== 'source') continue
      const path = validatePath(evidence.file)
      if (!paths.has(path)) reject('Acceptance cites a file outside the reviewed snapshot')
      const content = await readFile(join(directory, path))
      if (content.includes(0)) reject('Binary source evidence needs a verification check')
      const text = (() => {
        try { return new TextDecoder('utf-8', { fatal: true }).decode(content) } catch (decodeError) { return reject('Source citation requires valid UTF-8 text') }
      })()
      if (evidence.line > text.split('\n').length) reject('Acceptance cites a source line outside the reviewed snapshot')
    }
  }
  async materialize(snapshot: StagedSnapshot, parent: string): Promise<{ directory: string; dispose: () => Promise<void> }> {
    if (snapshot.repository !== this.repository) throw new Error('Snapshot belongs to another repository')
    await this.assertObjectIntegrity()
    const entries = await this.entries(snapshot.treeId)
    const parentRoot = await realpath(parent)
    const directory = await mkdtemp(join(parentRoot, 'review-gated-snapshot-'))
    try {
      for (const entry of entries) {
        const target = resolve(directory, entry.path)
        const path = relative(directory, target)
        if (path.startsWith('..') || isAbsolute(path)) throw new Error('Snapshot path escaped output directory')
        const blob = await this.blob(entry.object)
        if (blob.byteLength > this.limits.maxFileBytes) throw new Error('Snapshot file limit exceeded')
        await mkdir(resolve(target, '..'), { recursive: true })
        await writeFile(target, blob, { flag: 'wx' })
        if (entry.mode === '100755' && process.platform !== 'win32') await chmod(target, 0o755)
      }
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
    return { directory, dispose: async () => {
      const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (stat?.isSymbolicLink()) await unlink(directory)
      else if (stat) await rm(directory, { recursive: true, force: true })
    } }
  }
}
