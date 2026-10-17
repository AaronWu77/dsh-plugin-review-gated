import { describe, expect, it } from 'vitest'
import { RoleResultError, parseRoleResult } from '../../src/roles/output.js'
import { validateReviewResult } from '../../src/workflow/review-result.js'
import { reviewSchema } from '../../src/workflow/types.js'
import type { ReviewResult, VerificationEvidence } from '../../src/workflow/types.js'
import { brief, snapshot, verification, passed, finding } from '../fixtures/workflow.js'

const context = { brief, snapshot, verification }
const runId = 'review-host-run'
function reject(result: ReviewResult, inputs = context): RoleResultError {
  try { validateReviewResult(inputs, result, runId) } catch (error) {
    expect(error).toBeInstanceOf(RoleResultError)
    if (error instanceof RoleResultError) {
      expect(error).toMatchObject({ kind: 'semantic-validation', role: 'review', runId })
      expect(error).not.toHaveProperty('cause')
      expect(error).not.toHaveProperty('result')
      return error
    }
    throw error
  }
  throw new Error('Expected semantic rejection')
}
function evidenceResult(evidence: NonNullable<ReviewResult['acceptance']>[number]['evidence']): ReviewResult {
  return { ...passed, acceptance: [{ id: 'AC1', status: 'Passed', evidence }] }
}
function checkInputs(change: Partial<VerificationEvidence['checks'][number]>): typeof context {
  return { ...context, verification: { ...verification, checks: [{ ...verification.checks[0]!, ...change }] } }
}

describe('new runtime review result semantics', () => {
  it('rejects schema-valid real conflicting Passed JSON with A1–A9 and unchecked required scope facts', () => {
    const criteria = Array.from({ length: 9 }, (_, index) => ({ id: 'A' + (index + 1), description: 'Required task fact ' + (index + 1) }))
    const text = JSON.stringify({ ...passed,
      checked: ['A1–A9 checked against exported source and host checks'],
      unchecked: ['No independent hash verification', 'Original workspace enumeration unavailable', 'Other Node versions not tested'],
      acceptance: criteria.map(item => ({ id: item.id, status: 'Passed', evidence: [{ kind: 'verification', checkIndex: 0, explanation: 'Host check passed' }] })),
    })
    const result = parseRoleResult(text, reviewSchema, { role: 'review', runId })
    const error = reject(result, { ...context, brief: { ...brief, acceptanceCriteria: criteria } })
    expect(error.issues).toEqual([{ code: 'unchecked-items', path: ['unchecked'], message: 'Passed cannot contain unchecked required acceptance or scope items' }])
    expect(JSON.stringify(error)).not.toContain('Original workspace enumeration unavailable')
    expect(result.unchecked).toHaveLength(3)
  })
  it.each([
    { label: 'missing acceptance', result: { ...passed, acceptance: undefined }, code: 'acceptance-required' },
    { label: 'missing ID', result: { ...passed, acceptance: [] }, code: 'missing-acceptance' },
    { label: 'unknown ID', result: { ...passed, acceptance: [{ ...passed.acceptance![0]!, id: 'private-model-text' }] }, code: 'unknown-acceptance' },
    { label: 'duplicate ID', result: { ...passed, acceptance: [passed.acceptance![0]!, passed.acceptance![0]!] }, code: 'duplicate-acceptance' },
    { label: 'empty evidence', result: evidenceResult([]), code: 'acceptance-evidence' },
    { label: 'unverified criterion', result: { ...passed, acceptance: [{ ...passed.acceptance![0]!, status: 'Not Verified' as const }] }, code: 'acceptance-status' },
    { label: 'failed criterion', result: { ...passed, acceptance: [{ ...passed.acceptance![0]!, status: 'Failed' as const }] }, code: 'acceptance-status' },
    { label: 'inconclusive criterion', result: { ...passed, acceptance: [{ ...passed.acceptance![0]!, status: 'Inconclusive' as const }] }, code: 'acceptance-status' },
    { label: 'blocking finding', result: { ...passed, findings: [finding] }, code: 'blocking-finding' },
    { label: 'contradictory checked item', result: { ...passed, outcome: 'Inconclusive' as const, checked: ['same'], unchecked: ['same'] }, code: 'contradictory-items' },
  ])('rejects $label without exposing model text', ({ result, code }) => {
    const error = reject(result)
    expect(error.issues.map(issue => issue.code)).toContain(code)
    expect(JSON.stringify(error)).not.toContain('private-model-text')
  })
  it.each([
    { result: { ...passed, briefRevision: 2 }, inputs: context, code: 'brief-revision' },
    { result: { ...passed, snapshotId: 'another' }, inputs: context, code: 'snapshot-identity' },
    { result: { ...passed, treeId: 'd'.repeat(40) }, inputs: context, code: 'tree-identity' },
    { result: passed, inputs: { ...context, snapshot: { ...snapshot, briefRevision: 2 } }, code: 'brief-revision' },
    { result: passed, inputs: { ...context, verification: { ...verification, snapshotId: 'another' } }, code: 'verification-identity' },
    { result: passed, inputs: { ...context, verification: { ...verification, treeId: 'd'.repeat(40) } }, code: 'verification-identity' },
  ])('rejects wrong brief/snapshot/verification identity %#', ({ result, inputs, code }) => {
    expect(reject(result, inputs).issues.map(issue => issue.code)).toContain(code)
  })
  it.each([
    { evidence: [{ kind: 'source' as const, file: '../outside.ts', line: 1, explanation: 'claimed source' }] },
    { evidence: [{ kind: 'source' as const, file: 'src/not-exported.ts', line: 1, explanation: 'claimed source' }] },
    { evidence: [{ kind: 'verification' as const, checkIndex: 99, explanation: 'claimed check' }] },
  ])('rejects references not present in supplied snapshot files or approved host checks %#', ({ evidence }) => {
    expect(reject(evidenceResult(evidence)).issues.map(issue => issue.code)).toContain(evidence[0]!.kind === 'source' ? 'source-reference' : 'verification-reference')
  })
  it('does not treat changedPaths or digests as evidence that unobserved files/checks exist', () => {
    const result = evidenceResult([{ kind: 'source', file: snapshot.changedPaths[0]!, line: 1, explanation: 'claimed file' }])
    expect(reject(result, { ...context, snapshot: { ...snapshot, fileDigests: undefined } }).issues.map(issue => issue.code)).toContain('source-reference')
    expect(reject(passed, { ...context, verification: { ...verification, checks: [] } }).issues.map(issue => issue.code)).toContain('required-check')
  })
  it.each([
    { executable: 'substitute', args: ['--version'], timeoutMs: 60000 },
    { executable: 'node', args: ['different'], timeoutMs: 60000 },
    { executable: 'node', args: ['--version'], timeoutMs: 50000 },
  ])('rejects substituted host command fields %#', command => {
    const error = reject(passed, checkInputs({ command }))
    expect(error.issues.map(issue => issue.code)).toContain('verification-reference')
    expect(error.issues.map(issue => issue.code)).toContain('required-check')
  })
  it.each([{ exitCode: 1 }, { exitCode: null }, { signal: 'SIGTERM' }, { timedOut: true }])('rejects Passed evidence from a nonpassed host check %#', change => {
    const error = reject(passed, checkInputs(change))
    expect(error.issues.map(issue => issue.code)).toContain('verification-not-passed')
    expect(error.issues.map(issue => issue.code)).toContain('required-check')
  })
  it('requires all approved host checks even when acceptance cites only source', () => {
    const result = evidenceResult([{ kind: 'source', file: 'src/export.ts', line: 1, explanation: 'inspected source' }])
    const extraCommand = { executable: 'node', args: ['test.js'], timeoutMs: 60000 }
    const inputs = { ...context, brief: { ...brief, verificationCommands: [...brief.verificationCommands, extraCommand] } }
    expect(reject(result, inputs).issues.map(issue => issue.code)).toContain('verification-coverage')
    expect(reject(result, checkInputs({ exitCode: 1 })).issues.map(issue => issue.code)).toContain('required-check')
  })
  it('accepts Passed with matching successful host checks and actual unchanged snapshot source', () => {
    const inputs = { ...context, snapshot: { ...snapshot, fileDigests: [...snapshot.fileDigests!, { path: 'src/caller.ts', sha256: 'e'.repeat(64) }] } }
    const result = { ...evidenceResult([{ kind: 'source' as const, file: 'src/caller.ts', line: 1, explanation: 'inspected caller' }]),
      findings: [{ ...finding, severity: 'non-blocking' as const }], reason: 'Other Node versions are outside the approved task.' }
    const before = structuredClone({ inputs, result })
    expect(validateReviewResult(inputs, result, runId)).toBeUndefined()
    expect(validateReviewResult(context, passed, runId)).toBeUndefined()
    expect({ inputs, result }).toEqual(before)
  })
  it('accepts genuine Inconclusive with all acceptance criteria Inconclusive and no evidence', () => {
    const result: ReviewResult = { ...passed, outcome: 'Inconclusive', checked: [], unchecked: ['Required verification unavailable'], reason: 'Host check failed',
      acceptance: [{ id: 'AC1', status: 'Inconclusive', evidence: [] }] }
    expect(validateReviewResult(checkInputs({ exitCode: 1 }), result, runId)).toBeUndefined()
    expect(validateReviewResult({ ...context, verification: { ...verification, checks: [] } }, result, runId)).toBeUndefined()
  })
  it('rejects Needs Changes without an evidenced finding', () => {
    const result: ReviewResult = { ...passed, outcome: 'Needs Changes', findings: [], acceptance: [{ ...passed.acceptance![0]!, status: 'Failed' }] }
    expect(reject(result, checkInputs({ exitCode: 1 })).issues.map(issue => issue.code)).toContain('missing-findings')
  })
  it('accepts a non-Passed result citing the actual failed check without claiming it passed', () => {
    const result: ReviewResult = { ...passed, outcome: 'Needs Changes', findings: [finding], acceptance: [{ ...passed.acceptance![0]!, status: 'Failed' }] }
    expect(validateReviewResult(checkInputs({ exitCode: 1 }), result, runId)).toBeUndefined()
    const inconclusive = { ...result, outcome: 'Inconclusive' as const, acceptance: passed.acceptance }
    expect(reject(inconclusive, checkInputs({ exitCode: 1 })).issues.map(issue => issue.code)).toContain('verification-not-passed')
  })
  it('still requires complete criterion identity and real references for Inconclusive', () => {
    expect(reject({ ...passed, outcome: 'Inconclusive', acceptance: [] }).issues.map(issue => issue.code)).toContain('missing-acceptance')
    const result = { ...evidenceResult([{ kind: 'source' as const, file: 'outside', line: 1, explanation: 'claimed source' }]), outcome: 'Inconclusive' as const }
    expect(reject(result).issues.map(issue => issue.code)).toContain('source-reference')
  })
  it('returns deterministic bounded issues without result values, causes or mutation', () => {
    const inputs = { ...context, brief: { ...brief, acceptanceCriteria: Array.from({ length: 30 }, (_, index) => ({ id: 'private-' + index, description: 'required' })) } }
    const result = { ...passed, acceptance: undefined }
    const before = structuredClone({ inputs, result })
    const first = reject(result, inputs), second = reject(result, inputs)
    expect(first.issueCount).toBe(31)
    expect(first.issues).toHaveLength(8)
    expect(second.issues).toEqual(first.issues)
    expect(first.issues.every(issue => issue.path.length <= 8 && issue.code.length <= 64 && issue.message.length <= 160)).toBe(true)
    expect(JSON.stringify(first)).not.toContain('private-')
    expect({ inputs, result }).toEqual(before)
  })
})
