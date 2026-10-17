/** Advisory command compatibility; no provider probe, process execution, argv mutation or acceptance evidence. */
import { basename } from 'node:path'
import type { RequirementsBrief } from '../workflow/types.js'

/** Explain known Windows restricted-token limits without claiming the selected backend was observed.
 * @param brief Submitted or approved commands, including historical briefs.
 * @param platform Host platform; injectable for deterministic tests.
 * @returns Platform advisories with explicit unknown backend capability and unchanged command indexes.
 */
export function verificationCompatibility(brief: RequirementsBrief | null, platform: NodeJS.Platform = process.platform) {
  const warnings = brief?.verificationCommands.flatMap((command, commandIndex) => {
    const executable = basename(command.executable.replaceAll(String.fromCharCode(92), '/')).toLowerCase()
    const flags: string[] = []
    const paired = new Set(['--title', '--require', '-r', '--import', '--loader', '--experimental-loader', '--test-isolation', '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern', '--test-concurrency', '--conditions', '-C', '--inspect-port'])
    for (let index = 0; index < command.args.length; index++) {
      const value = command.args[index]!
      if (['--version', '-v', '--help', '-h'].includes(value)) return []
      if (value === '--' || !value.startsWith('-')) break
      if (['--eval', '-e', '--print', '-p'].includes(value) || value.startsWith('--eval=') || value.startsWith('--print=')) return []
      flags.push(value)
      if (paired.has(value)) { const next = command.args[++index]; if (value === '--test-isolation' && next !== undefined) flags.push(value + '=' + next) }
    }
    const test = flags.includes('--test')
    const inline = flags.filter(value => value.startsWith('--test-isolation=')).at(-1) === '--test-isolation=none'
    if (platform !== 'win32' || !['node', 'node.exe'].includes(executable) || !test || inline) return []
    return [{ commandIndex, kind: 'windows-node-test-piped-children' as const, authority: 'platform-advisory' as const,
      message: 'Default Node test isolation creates child processes with piped stdio. Windows ACL restricted-token confinement denies that named-pipe boundary. The selected provider exposes no pre-execution capability query, so compatibility is not confirmed. Preserve the exact approved command; changing to --test-isolation=none requires a revised brief and new human approval. Never widen confinement or treat auxiliary checks as acceptance evidence.' }]
  }) ?? []
  return { platform, backendCapability: 'unknown' as const, preflightExecuted: false, warnings }
}
