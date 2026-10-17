import { describe, expect, it } from 'vitest'
import { verificationCompatibility } from '../../src/verification/compatibility.js'
import { brief } from '../fixtures/workflow.js'

const command = (executable: string, args: string[]) => ({ executable, args, timeoutMs: 60000 })

describe('verification compatibility advisories without execution', () => {
  it.each(['node', 'node.exe', 'NODE.EXE', 'C:/Program Files/nodejs/node.exe', String.raw`C:\Program Files\nodejs\node.exe`])('warns about default Windows Node test isolation for %s', executable => {
    const requirements = { ...brief, verificationCommands: [command(executable, ['--test', 'tests/export.test.js'])] }
    const before = structuredClone(requirements)
    const advisory = verificationCompatibility(requirements, 'win32')
    expect(advisory).toMatchObject({ platform: 'win32', backendCapability: 'unknown', preflightExecuted: false,
      warnings: [{ commandIndex: 0, kind: 'windows-node-test-piped-children', authority: 'platform-advisory' }] })
    expect(advisory.warnings).toHaveLength(1)
    expect(advisory.warnings[0]!.message).toContain('piped stdio')
    expect(advisory.warnings[0]!.message).toContain('compatibility is not confirmed')
    expect(advisory.warnings[0]!.message).toContain('revised brief and new human approval')
    expect(requirements).toEqual(before)
  })
  it.each([
    { args: ['--test', '--test-isolation=none'] },
    { args: ['--test-isolation', 'none', '--test'] },
    { args: ['--version'] }, { args: ['--version', '--test'] }, { args: ['--help', '--test'] },
  ])('does not warn about inline isolation or a non-test invocation: $args', ({ args }) => {
    expect(verificationCompatibility({ ...brief, verificationCommands: [command('node', args)] }, 'win32')).toEqual({
      platform: 'win32', backendCapability: 'unknown', preflightExecuted: false, warnings: [],
    })
  })
  it.each([['script.js', '--test'], ['--', '--test'], ['--eval', '--test'], ['--require', '--test'], ['--import', '--test']].map(args => ({ args })))('does not classify script text, eval code or option operands as test flags: $args', ({ args }) => {
    expect(verificationCompatibility({ ...brief, verificationCommands: [command('node', args)] }, 'win32').warnings).toEqual([])
  })
  it.each([['--test', '--test-name-pattern', '--test-isolation=none', 'file.test.js'], ['--test', '--require', '--test-isolation=none'], ['--test', '--test-isolation=none', '--test-isolation=process']].map(args => ({ args })))('does not suppress a warning with an operand or overridden inline mode: $args', ({ args }) => {
    expect(verificationCompatibility({ ...brief, verificationCommands: [command('node', args)] }, 'win32').warnings).toHaveLength(1)
  })
  it('reads test options after a Node title operand without treating the title as a script', () => {
    expect(verificationCompatibility({ ...brief, verificationCommands: [command('node', ['--title', 'check', '--test', 'file.test.js'])] }, 'win32').warnings).toHaveLength(1)
  })
  it('keeps indexes in the original approved list rather than renumbering warnings', () => {
    const requirements = { ...brief, verificationCommands: [
      command('node', ['--version']), command('node', ['--test']),
      command('node', ['--test', '--test-isolation=none']), command('node.exe', ['--test-isolation=process', '--test']),
    ] }
    const before = structuredClone(requirements)
    expect(verificationCompatibility(requirements, 'win32').warnings.map(warning => warning.commandIndex)).toEqual([1, 3])
    expect(requirements).toEqual(before)
  })
  it.each(['linux', 'darwin'] as const)('does not infer a Windows restriction or backend capability on %s', platform => {
    expect(verificationCompatibility({ ...brief, verificationCommands: [command('node', ['--test'])] }, platform)).toEqual({
      platform, backendCapability: 'unknown', preflightExecuted: false, warnings: [],
    })
  })
  it('does not classify another executable as Node', () => {
    expect(verificationCompatibility({ ...brief, verificationCommands: [command('custom-runner', ['--test'])] }, 'win32').warnings).toEqual([])
  })
  it('reports an empty or absent plan without claiming that preflight ran', () => {
    for (const requirements of [null, { ...brief, verificationCommands: [] }]) {
      expect(verificationCompatibility(requirements)).toEqual({ platform: process.platform, backendCapability: 'unknown', preflightExecuted: false, warnings: [] })
    }
  })
})
