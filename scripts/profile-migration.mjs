#!/usr/bin/env node
/** Offline candidate planner. Never loads plugins, installs, edits overlays/locks, or contacts a service.
 * Output is a proposal, NOT a deployed profile. The caller owns review and any later migration.
 */
import { readFile, realpath, stat, lstat, open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'

export const MAIN_PACKAGE = '@aaronwu/dsh-review-gated'
export const LEGACY_UI_PACKAGE = '@aaronwu/dsh-review-gated-ui'
const UI_ID = 'review-gated-observed-ui'
const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

export class ProfileMigrationError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'ProfileMigrationError'
    this.code = code
  }
}
const fail = (code, message, cause) => { throw new ProfileMigrationError(code, message, { cause }) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)

// Validate before cloning: JSON.stringify alone silently drops undefined/functions and converts NaN.
function jsonValue(value, active = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!value || typeof value !== 'object' || active.has(value)) fail('INVALID_INPUT', 'Expected acyclic JSON data.')
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_INPUT', 'Expected plain JSON objects.')
  active.add(value)
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) fail('INVALID_INPUT', 'JSON data cannot contain accessors.')
    jsonValue(descriptor.value, active)
  }
  active.delete(value)
}

/** Pure overlay inspection; JS-tagged expressions stay inert strings, never evaluated.
 * Only a top-level id/boolean-disabled override is automatically retained as known-safe.
 * All other legacy UI references require human review; the overlay is never rewritten/copied.
 */
export function inspectProfileOverlay(source) {
  if (source === undefined) return { manualMigrations: [], preservedDisabledOverrides: 0 }
  if (typeof source !== 'string') fail('INVALID_OVERLAY', 'Overlay input must be YAML text.')
  let rows
  try {
    const doc = parseDocument(source, { uniqueKeys: true, customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
    if (doc.errors.length || doc.warnings.length) throw new Error('Unsupported or malformed YAML')
    rows = doc.toJS({ maxAliasCount: 50 })
    if (rows === null) rows = []
    jsonValue(rows)
  } catch (cause) { fail('INVALID_OVERLAY', 'Cannot safely inspect the overlay; repair its YAML before planning.', cause) }
  if (!Array.isArray(rows) || rows.some(row => !record(row))) fail('INVALID_OVERLAY', 'Overlay must be a list of patch objects.')
  for (const row of rows) {
    if ((!text(row.id) && !Object.hasOwn(row, 'insert')) || (Object.hasOwn(row, 'id') && !text(row.id)) || (Object.hasOwn(row, 'insert') && (!Array.isArray(row.insert) || row.insert.some(entry => !record(entry))))) {
      fail('INVALID_OVERLAY', 'Overlay patches need a nonempty id or an insert list of entries.')
    }
  }
  const manualMigrations = []
  let preservedDisabledOverrides = 0
  const references = value => {
    if (typeof value === 'string') return value.includes(LEGACY_UI_PACKAGE) || value.includes(UI_ID)
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) => references(key) || references(child))
  }
  rows.forEach((row, index) => {
    if (row.id === UI_ID && typeof row.disabled === 'boolean' && Object.keys(row).every(key => key === 'id' || key === 'disabled')) {
      preservedDisabledOverrides++
    } else if (references(row)) {
      manualMigrations.push({ code: 'CUSTOM_UI_OVERLAY', location: 'cordis.patch.yml[' + index + ']', message: 'Legacy UI overlay reference needs manual migration; the original patch is unchanged.' })
    }
  })
  return { manualMigrations, preservedDisabledOverrides }
}

/** Pure, deterministic and idempotent over candidatePackageJson with the same targetSpec.
 * The target is an opaque package-manager spec: no resolution, fetch or lockfile claim.
 * Manual-required plans are diagnostic candidates only; the CLI refuses to write them.
 */
export function planProfileMigration(packageJson, targetSpec, overlayText) {
  jsonValue(packageJson)
  if (!record(packageJson)) fail('INVALID_INPUT', 'Profile package.json must contain an object.')
  if (!text(targetSpec) || targetSpec.startsWith('-')) fail('INVALID_TARGET_SPEC', 'Provide a nonempty target package spec without control characters.')
  if (targetSpec.startsWith('npm:') && !targetSpec.startsWith('npm:' + MAIN_PACKAGE + '@')) fail('INVALID_TARGET_SPEC', 'A package alias must target the same Review-Gated main package.')
  for (const section of sections) {
    if (Object.hasOwn(packageJson, section) && (!record(packageJson[section]) || Object.values(packageJson[section]).some(spec => !text(spec)))) {
      fail('INVALID_INPUT', 'Dependency sections must map names to nonempty spec strings.')
    }
  }
  if (!Object.hasOwn(packageJson.dependencies ?? {}, MAIN_PACKAGE)) fail('MISSING_MAIN_PACKAGE', 'Profile dependencies must already contain the Review-Gated main package.')
  if (Object.hasOwn(packageJson, 'dsh') && !record(packageJson.dsh)) fail('INVALID_INPUT', 'dsh must be an object.')
  if (packageJson.dsh && Object.hasOwn(packageJson.dsh, 'profile') && !record(packageJson.dsh.profile)) fail('INVALID_INPUT', 'dsh.profile must be an object.')
  const bundles = packageJson.dsh?.profile?.bundles
  if (bundles !== undefined && (!Array.isArray(bundles) || bundles.some(bundle => !text(bundle)))) fail('INVALID_INPUT', 'dsh.profile.bundles must be an array of nonempty strings.')
  const candidatePackageJson = JSON.parse(JSON.stringify(packageJson))
  const changes = []
  for (const section of sections) {
    const dependencies = candidatePackageJson[section]
    if (!dependencies) continue
    if (Object.hasOwn(dependencies, MAIN_PACKAGE) && dependencies[MAIN_PACKAGE] !== targetSpec) {
      dependencies[MAIN_PACKAGE] = targetSpec
      changes.push({ code: 'REPLACE_MAIN_SPEC', location: section })
    }
    if (Object.hasOwn(dependencies, LEGACY_UI_PACKAGE)) {
      delete dependencies[LEGACY_UI_PACKAGE]
      changes.push({ code: 'REMOVE_LEGACY_UI_DEPENDENCY', location: section })
    }
  }
  if (bundles?.includes(LEGACY_UI_PACKAGE)) {
    candidatePackageJson.dsh.profile.bundles = bundles.filter(bundle => bundle !== LEGACY_UI_PACKAGE)
    changes.push({ code: 'REMOVE_LEGACY_UI_BUNDLE', location: 'dsh.profile.bundles' })
  }
  const overlay = inspectProfileOverlay(overlayText)
  const manualMigrations = [...overlay.manualMigrations]
  // References outside the precisely owned dependency/bundle slots are not deleted silently.
  const visit = (value, path) => {
    if (typeof value === 'string' && value.includes(LEGACY_UI_PACKAGE)) manualMigrations.push({ code: 'OTHER_LEGACY_UI_REFERENCE', location: path, message: 'Review this retained legacy UI reference manually.' })
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (key.includes(LEGACY_UI_PACKAGE)) manualMigrations.push({ code: 'OTHER_LEGACY_UI_REFERENCE', location: path, message: 'Review this retained legacy UI key manually.' })
      visit(child, path + '.' + key)
    }
  }
  visit(candidatePackageJson, 'package.json')
  return {
    status: manualMigrations.length ? 'manual-required' : 'ready',
    changed: changes.length > 0,
    candidatePackageJson,
    changes,
    manualMigrations,
    preservedDisabledOverrides: overlay.preservedDisabledOverrides,
    limitations: ['Candidate only: no lockfile migration, dependency installation, deployment or runtime verification.', 'Only the supplied profile overlay is inspected; other overlay layers require owner review.'],
  }
}

export const usage = 'Usage: node scripts/profile-migration.mjs --profile <directory|package.json> --target-spec <spec> [--patch <file>] [--output <new-file>]\nDefault: dry-run JSON report. Output must be a new file outside the input profile directory; its parent must exist. No overlay or credential files are copied.'

export function parseMigrationArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const options = {}
  const names = { '--profile': 'profile', '--target-spec': 'targetSpec', '--patch': 'patch', '--output': 'output' }
  for (let i = 0; i < args.length; i++) {
    const name = Object.hasOwn(names, args[i]) ? names[args[i]] : undefined
    if (!name || Object.hasOwn(options, name) || !text(args[i + 1]) || args[i + 1].startsWith('--')) fail('INVALID_ARGUMENTS', usage)
    options[name] = args[++i]
  }
  if (!options.profile || !options.targetSpec) fail('INVALID_ARGUMENTS', usage)
  return options
}

async function readInput(path, optional = false) {
  try { return await readFile(path, 'utf8') } catch (cause) {
    if (optional && cause.code === 'ENOENT') return undefined
    fail('INPUT_READ_FAILED', 'Cannot read the requested profile input; check its path and access.', cause)
  }
}

/** I/O boundary. Reads only package.json and one overlay, writes at most one explicit new file.
 * Open uses wx/0600: existing files, symlinks and hardlinks cannot be overwritten. No mkdir.
 * On write/close failure a partial new candidate may remain; inputs remain untouched and
 * the caller must inspect/remove that candidate before explicitly retrying elsewhere.
 */
export async function createProfileMigrationCandidate(options) {
  let input
  try {
    const requested = resolve(options.profile)
    const packagePath = (await stat(requested)).isDirectory() ? resolve(requested, 'package.json') : requested
    if ((await lstat(packagePath)).isSymbolicLink()) throw new Error('Linked package manifests require manual review')
    input = await realpath(packagePath)
  } catch (cause) { fail('INPUT_READ_FAILED', 'Cannot locate the requested profile package.json.', cause) }
  if (basename(input) !== 'package.json') fail('INVALID_INPUT', 'The profile input must be a package.json file or its directory.')
  const packageText = await readInput(input)
  let packageJson
  try { packageJson = JSON.parse(packageText) } catch (cause) { fail('INVALID_INPUT', 'Profile package.json is not valid JSON.', cause) }
  const patchPath = options.patch ? resolve(options.patch) : resolve(dirname(input), 'cordis.patch.yml')
  const overlay = await readInput(patchPath, !options.patch)
  const plan = planProfileMigration(packageJson, options.targetSpec, overlay)
  if (!options.output) return { ...plan, mode: 'dry-run' }
  if (plan.status !== 'ready') fail('MANUAL_MIGRATION_REQUIRED', 'Candidate not written: migrate the reported legacy UI references manually, then plan again.')
  let output
  try {
    const requested = resolve(options.output)
    // Refuse Windows device/alternate-stream names even on a POSIX planning host.
    const name = basename(requested)
    if (name.includes(':') || /[. ]$/u.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) {
      fail('INVALID_OUTPUT', 'Output must name an ordinary new file, not a device or alternate data stream.')
    }
    output = resolve(await realpath(dirname(requested)), name)
  } catch (cause) { fail('INVALID_OUTPUT', 'Output parent must already exist; choose a new candidate file outside the input profile.', cause) }
  const inside = relative(dirname(input), output)
  if (inside === '' || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep))) fail('UNSAFE_OUTPUT', 'Output must be outside the input profile directory; in-place migration is forbidden.')
  let handle
  try { handle = await open(output, 'wx', 0o600) } catch (cause) {
    fail(cause.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_CREATE_FAILED', 'Candidate not written: choose a new writable output file; existing targets are never overwritten.', cause)
  }
  try {
    try { await handle.writeFile(JSON.stringify(plan.candidatePackageJson, null, 2) + '\n', 'utf8') }
    finally { await handle.close() }
  } catch (cause) { fail('OUTPUT_WRITE_FAILED', 'Candidate write failed; a partial new file may remain. Inputs are unchanged. Inspect the candidate before retrying.', cause) }
  return { ...plan, mode: 'candidate-written', output }
}

/** Exit 0: ready candidate/help; 2: manual review needed; 1: invalid input/I/O failure. */
export async function runCli(args, io = { stdout: value => process.stdout.write(value), stderr: value => process.stderr.write(value) }) {
  try {
    const options = parseMigrationArgs(args)
    if (options.help) { io.stdout(usage + '\n'); return 0 }
    const result = await createProfileMigrationCandidate(options)
    io.stdout(JSON.stringify(result, null, 2) + '\n')
    return result.status === 'manual-required' ? 2 : 0
  } catch (error) {
    io.stderr(JSON.stringify({ status: 'error', code: error instanceof ProfileMigrationError ? error.code : 'UNEXPECTED_ERROR', message: error instanceof ProfileMigrationError ? error.message : 'Unexpected planner failure; no successful migration is claimed. Inspect inputs and any candidate before retrying.' }) + '\n')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runCli(process.argv.slice(2))
