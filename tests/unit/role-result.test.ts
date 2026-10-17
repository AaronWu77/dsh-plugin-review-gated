import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RoleResultError, boundedRoleResultError, parseRoleResult } from '../../src/roles/output.js'
import { RoleResultError as PublicRoleResultError, boundedRoleResultError as publicBoundedRoleResultError } from '../../src/roles/runner.js'
import { implementationSchema, reviewSchema, diagnosticSchema } from '../../src/workflow/types.js'
import { passed } from '../fixtures/workflow.js'

const context = { role: 'implementation' as const, runId: 'host-run-id' }
const completed = { outcome: 'Completed', summary: 'implemented', problems: [], limitations: [] }
function rejected(parse: () => unknown): RoleResultError {
  try { parse() } catch (error) {
    expect(error).toBeInstanceOf(RoleResultError)
    if (error instanceof RoleResultError) return error
    throw error
  }
  throw new Error('Expected role result rejection')
}

describe('classified role result rejection without repair', () => {
  it('exports the same classifier through the public roles entry', () => {
    expect(PublicRoleResultError).toBe(RoleResultError)
    expect(publicBoundedRoleResultError).toBe(boundedRoleResultError)
  })
  it('accepts lawful Implementation, Review and Diagnostic instances', () => {
    expect(parseRoleResult(JSON.stringify(completed), implementationSchema, context)).toEqual(completed)
    expect(parseRoleResult(JSON.stringify(passed), reviewSchema, { ...context, role: 'review' })).toEqual(passed)
    const diagnostic = { summary: 'inspected', findings: [], limitations: ['not executed'] }
    expect(parseRoleResult(JSON.stringify(diagnostic), diagnosticSchema, { ...context, role: 'diagnostic' })).toEqual(diagnostic)
  })
  it.each(['sensitive model content '.repeat(1000), '```json\n{}\n```', '{} {}', '{} trailing'])('classifies malformed JSON without retaining parser diagnostics %#', text => {
    const error = rejected(() => parseRoleResult(text, implementationSchema, context))
    expect(error).toMatchObject({ name: 'RoleResultError', ...context, kind: 'json-parse', issueCount: 0, issues: [] })
    expect(error.message).toBe('Role implementation result is not valid JSON')
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(error)).not.toContain(text)
    expect(error.stack).not.toContain(text)
  })
  it.each([
    { label: 'copied $schema', value: { ...completed, $schema: 'https://json-schema.org/draft/2020-12/schema' }, code: 'unrecognized_keys', path: [] },
    { label: 'wrong type', value: { ...completed, summary: 42 }, code: 'invalid_type', path: ['summary'] },
    { label: 'unknown field', value: { ...completed, extra: true }, code: 'unrecognized_keys', path: [] },
    { label: 'schema document', value: z.toJSONSchema(implementationSchema), code: 'invalid_union', path: ['outcome'] },
  ])('rejects $label with host identity and validation issues', ({ value, code, path }) => {
    const text = JSON.stringify(value)
    const error = rejected(() => parseRoleResult(text, implementationSchema, context))
    expect(error).toMatchObject({ ...context, kind: 'schema-validation', issues: [{ code, path }] })
    expect(error.message).toBe('Role implementation result failed schema validation')
    expect(error.issueCount).toBeGreaterThan(0)
    expect(error).not.toHaveProperty('cause')
    expect(JSON.parse(text)).toEqual(value)
  })
  it.each([
    { ...passed, $schema: 'copied' }, { ...passed, findings: 'not an array' }, { ...passed, extra: true },
    { ...passed, acceptance: [{ id: 'A1', status: 'Passed', evidence: [], extra: true }] },
  ])('does not accept an invalid Review claiming Passed %#', value => {
    const error = rejected(() => parseRoleResult(JSON.stringify(value), reviewSchema, { ...context, role: 'review' }))
    expect(error.kind).toBe('schema-validation')
    expect(error.role).toBe('review')
  })
  it('applies the same bounds to semantic issues without retaining input or cause', () => {
    const issues = Array.from({ length: 100 }, () => ({ code: 'c'.repeat(100), path: Array.from({ length: 20 }, () => 'p'.repeat(100)), message: 'm'.repeat(200) }))
    const error = boundedRoleResultError({ ...context, role: 'review' }, 'semantic-validation', issues)
    expect(error).toMatchObject({ kind: 'semantic-validation', role: 'review', runId: context.runId, issueCount: 100 })
    expect(error.message).toBe('Role review result failed semantic validation')
    expect(error).not.toHaveProperty('cause')
    expect(error).not.toHaveProperty('result')
    expect(error.issues).toHaveLength(8)
    for (const issue of error.issues) {
      expect(issue.code).toHaveLength(64)
      expect(issue.path).toHaveLength(8)
      expect(issue.path.every(part => typeof part === 'string' && part.length === 80)).toBe(true)
      expect(issue.message).toHaveLength(160)
    }
    issues[0]!.message = 'mutated input'
    expect(error.issues[0]!.message).toBe('m'.repeat(160))
  })
  it('bounds issue count, paths and messages instead of retaining huge validation diagnostics', () => {
    const segment = 'private-key-'.repeat(1000), path = Array.from({ length: 20 }, () => segment)
    const schema = z.any().superRefine((_value, ctx) => {
      for (let i = 0; i < 100; i++) ctx.addIssue({ code: 'custom', path, message: 'private-result-'.repeat(1000) })
    })
    const error = rejected(() => parseRoleResult('{}', schema, context))
    expect(error.issueCount).toBe(100)
    expect(error.issues).toHaveLength(8)
    for (const issue of error.issues) {
      expect(issue.path).toHaveLength(8)
      expect(issue.path.every(part => typeof part === 'string' && part.length <= 80)).toBe(true)
      expect(issue.message).toHaveLength(160)
      expect(issue.code.length).toBeLessThanOrEqual(64)
    }
    expect(JSON.stringify(error).length).toBeLessThan(8000)
  })
})
