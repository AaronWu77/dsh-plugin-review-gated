import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, link, symlink } from 'node:fs/promises'
import { closeSync, openSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// The standalone .mjs CLI deliberately has no build/declaration dependency. Keep the
// dynamic script boundary typed here without widening the package tsconfig or adding files.
interface OverlayInspection { manualMigrations: { code: string; location: string; message: string }[]; preservedDisabledOverrides: number }
interface MigrationPlan extends OverlayInspection { status: 'ready' | 'manual-required'; changed: boolean; candidatePackageJson: Record<string, unknown>; changes: { code: string; location: string }[] }
interface CandidateOptions { profile: string; targetSpec: string; patch?: string; output?: string }
interface CliIO { stdout: (value: string) => void; stderr: (value: string) => void }
interface MigrationScript {
  MAIN_PACKAGE: string
  LEGACY_UI_PACKAGE: string
  ProfileMigrationError: new (...args: unknown[]) => Error
  planProfileMigration: (input: unknown, target: string, overlay?: string) => MigrationPlan
  inspectProfileOverlay: (source: string) => OverlayInspection
  parseMigrationArgs: (args: string[]) => unknown
  createProfileMigrationCandidate: (options: CandidateOptions) => Promise<MigrationPlan & { mode: string }>
  runCli: (args: string[], io: CliIO) => Promise<number>
}
const scriptUrl = new URL('../../scripts/profile-migration.mjs', import.meta.url)
const { MAIN_PACKAGE: main, LEGACY_UI_PACKAGE: ui, ProfileMigrationError, planProfileMigration, inspectProfileOverlay, parseMigrationArgs, createProfileMigrationCandidate, runCli }: MigrationScript = await import(scriptUrl.href)

const fsProbe = vi.hoisted(() => ({ linkedManifest: false }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, lstat: async (path: import('node:fs').PathLike) => {
    const stats = await fs.lstat(path)
    if (fsProbe.linkedManifest) stats.isSymbolicLink = () => true
    return stats
  } }
})

const targetSpec = 'file:D:/scratch/review-gated-unified.tgz'
const fixture = () => ({
  name: 'scratch-profile', private: true,
  dependencies: { [main]: 'file:old-main.tgz', [ui]: 'file:old-ui.tgz', other: '^1.0.0' },
  dsh: { profile: { bundles: ['base', main, ui, 'other', ui], extra: { keep: true } }, extension: 'unchanged' },
  scripts: { check: 'echo unchanged' }, custom: { nested: [1, null, false] },
})
const args = (profile: string) => ['--profile', profile, '--target-spec', targetSpec]

async function scratch<T>(run: (root: string, profile: string) => Promise<T>) {
  const root = await mkdtemp(join(tmpdir(), 'rg-profile-migration-'))
  try {
    const profile = join(root, 'profile')
    await mkdir(profile)
    await writeFile(join(profile, 'package.json'), JSON.stringify(fixture(), null, 2) + '\n')
    return await run(root, profile)
  } finally {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}

function capture() {
  let stdout = '', stderr = ''
  return { io: { stdout: (text: string) => { stdout += text }, stderr: (text: string) => { stderr += text } }, out: () => stdout, err: () => stderr }
}

describe('pure profile migration planner', () => {
  it('changes only main spec, legacy UI dependencies and exact bundle entries without mutating input', () => {
    const input = fixture(), before = structuredClone(input)
    const plan = planProfileMigration(input, targetSpec)
    expect(input).toEqual(before)
    expect(plan).toMatchObject({ status: 'ready', changed: true, manualMigrations: [] })
    const expected = structuredClone(input)
    expected.dependencies[main] = targetSpec
    delete (expected.dependencies as Record<string, string>)[ui]
    expected.dsh.profile.bundles = ['base', main, 'other']
    expect(plan.candidatePackageJson).toEqual(expected)
    expect(plan.candidatePackageJson.custom).not.toBe(input.custom)
  })

  it('is idempotent, preserves absent bundle selection and removes all legacy dependency slots', () => {
    const input = { dependencies: { [main]: 'old' }, devDependencies: { [ui]: 'old', helper: '1' }, optionalDependencies: { [ui]: 'old' }, peerDependencies: { [main]: 'old', [ui]: 'old' } }
    const first = planProfileMigration(input, targetSpec)
    expect(first.candidatePackageJson).toEqual({ dependencies: { [main]: targetSpec }, devDependencies: { helper: '1' }, optionalDependencies: {}, peerDependencies: { [main]: targetSpec } })
    const second = planProfileMigration(first.candidatePackageJson, targetSpec)
    expect(second).toMatchObject({ status: 'ready', changed: false, changes: [] })
    expect(second.candidatePackageJson).toEqual(first.candidatePackageJson)
  })

  it('preserves unknown configuration and reports retained legacy references', () => {
    const input = { ...fixture(), overrides: { [ui]: 'old' }, custom: { plugin: ui + '/client' } }
    const plan = planProfileMigration(input, targetSpec)
    expect(plan.status).toBe('manual-required')
    expect(plan.candidatePackageJson.overrides).toEqual(input.overrides)
    expect(plan.candidatePackageJson.custom).toEqual(input.custom)
    expect(plan.manualMigrations).toHaveLength(2)
  })

  it.each([null, [], {}, { dependencies: { [ui]: 'old' } }, { devDependencies: { [main]: 'old' } }].map(input => ({ input })))('rejects missing main or malformed root $input', ({ input }) => {
    expect(() => planProfileMigration(input, targetSpec)).toThrow(ProfileMigrationError)
  })

  it.each([
    { dependencies: [] }, { dependencies: { [main]: 1 } }, { devDependencies: null },
    { dsh: [] }, { dsh: { profile: false } }, { dsh: { profile: { bundles: 'wrong' } } },
    { dsh: { profile: { bundles: [null] } } }, { extra: undefined }, { extra: NaN },
  ])('rejects invalid profile input %j', extra => {
    expect(() => planProfileMigration({ ...fixture(), ...extra }, targetSpec)).toThrow(ProfileMigrationError)
  })

  it.each(['', ' ', ' x', 'x\ny', '-flag', 'npm:another-package@1'])('rejects invalid target %j', spec => {
    expect(() => planProfileMigration(fixture(), spec)).toThrow(expect.objectContaining({ code: 'INVALID_TARGET_SPEC' }))
  })

  it.each([true, false])('retains a valid disabled=%s override without changing the overlay', disabled => {
    const source = '- id: review-gated-observed-ui\n  disabled: ' + disabled + '\n'
    expect(inspectProfileOverlay(source)).toEqual({ manualMigrations: [], preservedDisabledOverrides: 1 })
    expect(planProfileMigration(fixture(), targetSpec, source).status).toBe('ready')
  })

  it.each([
    '- insert:\n    - id: review-gated-observed-ui\n      name: ./custom.js',
    '- id: review-gated-observed-ui\n  disabled: true\n  name: "' + ui + '"',
    '- id: review-gated-observed-ui\n  disabled: "true"',
    '- id: custom\n  config:\n    nested: "' + ui + '/client"',
    '- id: custom\n  name: "' + ui + '"',
  ])('flags custom legacy overlay rather than dropping it: %s', source => {
    const plan = planProfileMigration(fixture(), targetSpec, source)
    expect(plan.status).toBe('manual-required')
    expect(plan.manualMigrations).toContainEqual(expect.objectContaining({ code: 'CUSTOM_UI_OVERLAY' }))
    expect(plan.preservedDisabledOverrides).toBe(0)
  })

  it('does not treat comments as references or evaluate JS expressions', () => {
    expect(inspectProfileOverlay('# ' + ui + '\n- id: other\n  disabled: !!js "(() => { throw new Error() })()"')).toEqual({ manualMigrations: [], preservedDisabledOverrides: 0 })
  })

  it.each(['[', 'plain text', '- null', '- {}', '- id: a\n  id: b', '- insert: nope', '- id: a\n  config: !unknown x', '- &loop { id: a, config: *loop }'])('rejects malformed or uninspectable YAML %s', source => {
    expect(() => inspectProfileOverlay(source)).toThrow(expect.objectContaining({ code: 'INVALID_OVERLAY' }))
  })

  it.each([[], ['--profile'], ['--wat', 'x'], ['--profile', 'x', '--profile', 'y'], ['--profile', 'x', '--target-spec', '1', 'toString', 'oops']].map(argv => ({ argv })))('rejects CLI arguments $argv', ({ argv }) => {
    expect(() => parseMigrationArgs(argv)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
  })
})

describe('profile candidate I/O and CLI', () => {
  it('dry-runs by default, never touches inputs, lockfiles or credential files', async () => scratch(async (_root, profile) => {
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: review-gated-observed-ui\n  disabled: true\n')
    await writeFile(join(profile, 'pnpm-lock.yaml'), 'synthetic-lock-sentinel')
    await writeFile(join(profile, 'credentials.json'), 'synthetic-secret-sentinel')
    const names = await readdir(profile)
    const before = await Promise.all(names.map(name => readFile(join(profile, name))))
    const sink = capture()
    expect(await runCli(args(profile), sink.io)).toBe(0)
    expect(JSON.parse(sink.out())).toMatchObject({ mode: 'dry-run', status: 'ready', preservedDisabledOverrides: 1 })
    expect(sink.out()).not.toContain('synthetic-secret-sentinel')
    expect(sink.err()).toBe('')
    expect(await readdir(profile)).toEqual(names)
    expect(await Promise.all(names.map(name => readFile(join(profile, name))))).toEqual(before)
  }))

  it('writes only a candidate package JSON exclusively and refuses repeated writes', async () => scratch(async (root, profile) => {
    const output = join(root, 'candidate.json'), input = await readFile(join(profile, 'package.json'))
    const result = await createProfileMigrationCandidate({ profile, targetSpec, output })
    expect(result.mode).toBe('candidate-written')
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(planProfileMigration(fixture(), targetSpec).candidatePackageJson)
    await expect(createProfileMigrationCandidate({ profile, targetSpec, output })).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' })
    expect(await readFile(join(profile, 'package.json'))).toEqual(input)
    expect((await readdir(root)).sort()).toEqual(['candidate.json', 'profile'])
  }))

  it('rejects in-place, profile-local, missing-parent and hardlink outputs without mutations', async () => scratch(async (root, profile) => {
    const input = join(profile, 'package.json'), before = await readFile(input)
    for (const output of [input, join(profile, 'new.json')]) {
      await expect(createProfileMigrationCandidate({ profile, targetSpec, output })).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT' })
    }
    await expect(createProfileMigrationCandidate({ profile, targetSpec, output: join(root, 'missing', 'candidate.json') })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' })
    const alias = join(root, 'alias.json')
    await link(input, alias)
    await expect(createProfileMigrationCandidate({ profile, targetSpec, output: alias })).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' })
    expect(await readFile(input)).toEqual(before)
    expect(await readdir(profile)).toEqual(['package.json'])
  }))

  it('rejects a linked input manifest instead of changing the profile root', async () => scratch(async (root, profile) => {
    // File symlink creation needs a Windows privilege; inject only its lstat fact.
    fsProbe.linkedManifest = true
    try {
      await expect(createProfileMigrationCandidate({ profile, targetSpec, output: join(profile, 'candidate.json') })).rejects.toMatchObject({ code: 'INPUT_READ_FAILED' })
      expect(await readdir(profile)).toEqual(['package.json'])
      expect(await readdir(root)).toEqual(['profile'])
    } finally { fsProbe.linkedManifest = false }
  }))

  it('allows only one concurrent exclusive candidate writer', async () => scratch(async (root, profile) => {
    const output = join(root, 'candidate.json')
    const outcomes = await Promise.allSettled([createProfileMigrationCandidate({ profile, targetSpec, output }), createProfileMigrationCandidate({ profile, targetSpec, output })])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'OUTPUT_EXISTS' } })
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(planProfileMigration(fixture(), targetSpec).candidatePackageJson)
  }))

  it('rejects device and alternate-stream output names before opening them', async () => scratch(async (root, profile) => {
    for (const name of ['NUL', 'CON.json', 'candidate.json:stream', 'trailing.']) {
      await expect(createProfileMigrationCandidate({ profile, targetSpec, output: join(root, name) })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' })
    }
    expect(await readdir(root)).toEqual(['profile'])
  }))

  it('resolves parent directory junctions before refusing a disguised in-place write', async () => scratch(async (root, profile) => {
    const alias = join(root, 'profile-alias')
    await symlink(profile, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(createProfileMigrationCandidate({ profile, targetSpec, output: join(alias, 'new.json') })).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT' })
    expect(await readdir(profile)).toEqual(['package.json'])
  }))

  it('reports manual migration on dry-run and refuses output for custom overlays', async () => scratch(async (root, profile) => {
    const patch = join(profile, 'cordis.patch.yml'), source = '- id: custom\n  name: "' + ui + '"\n'
    await writeFile(patch, source)
    const sink = capture(), output = join(root, 'candidate.json')
    expect(await runCli(args(profile), sink.io)).toBe(2)
    expect(JSON.parse(sink.out()).manualMigrations[0].code).toBe('CUSTOM_UI_OVERLAY')
    await expect(createProfileMigrationCandidate({ profile, targetSpec, output })).rejects.toMatchObject({ code: 'MANUAL_MIGRATION_REQUIRED' })
    expect(await readdir(root)).toEqual(['profile'])
    expect(await readFile(patch, 'utf8')).toBe(source)
  }))

  it('distinguishes optional missing overlay from explicit missing or unreadable overlay', async () => scratch(async (root, profile) => {
    expect((await createProfileMigrationCandidate({ profile, targetSpec })).status).toBe('ready')
    await expect(createProfileMigrationCandidate({ profile, targetSpec, patch: join(root, 'missing.yml') })).rejects.toMatchObject({ code: 'INPUT_READ_FAILED' })
    await mkdir(join(profile, 'cordis.patch.yml'))
    await expect(createProfileMigrationCandidate({ profile, targetSpec })).rejects.toMatchObject({ code: 'INPUT_READ_FAILED' })
  }))

  it('returns structured errors without leaking malformed input text', async () => scratch(async (_root, profile) => {
    await writeFile(join(profile, 'package.json'), '{ synthetic-private-sentinel')
    const sink = capture()
    expect(await runCli(args(profile), sink.io)).toBe(1)
    expect(sink.out()).toBe('')
    expect(JSON.parse(sink.err())).toMatchObject({ status: 'error', code: 'INVALID_INPUT' })
    expect(sink.err()).not.toContain('synthetic-private-sentinel')
  }))

  it('executes the real node entry point with scratch inputs and file-backed stdio', async () => scratch(async (root, profile) => {
    const stdout = join(root, 'stdout.json'), stderr = join(root, 'stderr.txt')
    const out = openSync(stdout, 'wx', 0o600), err = openSync(stderr, 'wx', 0o600)
    try {
      const child = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/profile-migration.mjs', import.meta.url)), ...args(profile)], {
        cwd: root, env: { SystemRoot: process.env.SystemRoot, PATH: dirname(process.execPath) }, stdio: ['ignore', out, err], timeout: 20000,
      })
      expect(child.error).toBeUndefined()
      expect(child.signal).toBeNull()
      expect(child.status).toBe(0)
    } finally { closeSync(out); closeSync(err) }
    expect(JSON.parse(await readFile(stdout, 'utf8'))).toMatchObject({ mode: 'dry-run', status: 'ready' })
    expect(await readFile(stderr, 'utf8')).toBe('')
    expect(await readdir(profile)).toEqual(['package.json'])
  }))
})
