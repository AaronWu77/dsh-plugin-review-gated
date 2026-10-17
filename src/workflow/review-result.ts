/** Semantic checks for newly returned reviews; durable replay retains its generation's rules. */
import { isDeepStrictEqual } from 'node:util'
import { boundedRoleResultError } from '../roles/output.js'
import type { RoleResultIssue } from '../roles/output.js'
import type { RequirementsBrief, ReviewResult, StagedSnapshot, VerificationEvidence } from './types.js'

/** Reject inconsistent review claims without reading files, executing checks or changing the result.
 * @param context Approved brief, actual snapshot file inventory and host verification evidence.
 * @param result Strict-schema-parsed Review result from a newly completed role.
 * @param runId Host-assigned Review run identity for the bounded rejection.
 * @returns Nothing when the result is consistent; throws RoleResultError with semantic-validation otherwise.
 */
export function validateReviewResult(context: { brief: RequirementsBrief; snapshot: StagedSnapshot; verification: VerificationEvidence }, result: ReviewResult, runId: string): void {
  const { brief, snapshot, verification } = context
  const issues: RoleResultIssue[] = []
  const issue = (code: string, path: (string | number)[], message: string): void => { issues.push({ code, path, message }) }
  const passed = result.outcome === 'Passed'
  if (result.outcome === 'Needs Changes' && result.findings.length === 0) issue('missing-findings', ['findings'], 'Needs Changes requires an evidenced finding describing required code changes')
  if (result.briefRevision !== brief.revision || snapshot.briefRevision !== brief.revision)
    issue('brief-revision', ['briefRevision'], 'Review and snapshot must identify the approved brief revision')
  if (result.snapshotId !== snapshot.id)
    issue('snapshot-identity', ['snapshotId'], 'Review must identify the supplied snapshot')
  if (result.treeId !== snapshot.treeId)
    issue('tree-identity', ['treeId'], 'Review must identify the supplied snapshot tree')
  if (verification.snapshotId !== snapshot.id || verification.treeId !== snapshot.treeId)
    issue('verification-identity', ['acceptance'], 'Host verification must identify the supplied snapshot and tree')
  if (passed && result.unchecked.length)
    issue('unchecked-items', ['unchecked'], 'Passed cannot contain unchecked required acceptance or scope items')
  for (let index = 0; index < result.checked.length; index++) {
    if (result.unchecked.includes(result.checked[index]!))
      issue('contradictory-items', ['checked', index], 'An item cannot be both checked and unchecked')
  }
  for (let index = 0; index < result.findings.length; index++) {
    if (passed && result.findings[index]!.severity === 'blocking')
      issue('blocking-finding', ['findings', index, 'severity'], 'Passed cannot contain a blocking finding')
  }
  const matchingCheck = (index: number): boolean => {
    const check = verification.checks[index]
    const command = brief.verificationCommands[index]
    return !!check && !!command && isDeepStrictEqual(check.command, command)
  }
  const passedCheck = (index: number): boolean => {
    const check = verification.checks[index]
    return !!check && check.exitCode === 0 && check.signal === null && !check.timedOut
  }
  if (passed) {
    if (verification.checks.length !== brief.verificationCommands.length)
      issue('verification-coverage', ['acceptance'], 'Passed requires every approved host verification check exactly once')
    for (let index = 0; index < brief.verificationCommands.length; index++) {
      if (!matchingCheck(index) || !passedCheck(index))
        issue('required-check', ['acceptance'], 'Passed requires matching successful approved host verification checks')
    }
  }
  const required = new Set(brief.acceptanceCriteria.map(item => item.id))
  const observed = new Set<string>()
  const files = new Set(snapshot.fileDigests?.map(file => file.path))
  if (!result.acceptance) issue('acceptance-required', ['acceptance'], 'Every approved acceptance criterion requires a structured result')
  for (const [index, item] of (result.acceptance ?? []).entries()) {
    if (!required.has(item.id)) issue('unknown-acceptance', ['acceptance', index, 'id'], 'Acceptance ID is not in the approved brief')
    if (observed.has(item.id)) issue('duplicate-acceptance', ['acceptance', index, 'id'], 'Acceptance ID must occur exactly once')
    observed.add(item.id)
    if (passed && item.status !== 'Passed')
      issue('acceptance-status', ['acceptance', index, 'status'], 'Passed requires every acceptance criterion to be Passed')
    if ((passed || item.status === 'Passed') && !item.evidence.length)
      issue('acceptance-evidence', ['acceptance', index, 'evidence'], 'A Passed acceptance criterion requires source or host verification evidence')
    for (const [evidenceIndex, evidence] of item.evidence.entries()) {
      const path = ['acceptance', index, 'evidence', evidenceIndex]
      if (evidence.kind === 'source') {
        if (!files.has(evidence.file))
          issue('source-reference', [...path, 'file'], 'Source evidence must name an actual supplied snapshot file')
      } else {
        if (!matchingCheck(evidence.checkIndex))
          issue('verification-reference', [...path, 'checkIndex'], 'Verification evidence must reference the matching approved host check')
        else if ((passed || item.status === 'Passed') && !passedCheck(evidence.checkIndex))
          issue('verification-not-passed', [...path, 'checkIndex'], 'Passed evidence cannot cite a failed, signalled or timed-out host check')
      }
    }
  }
  for (const [index, criterion] of brief.acceptanceCriteria.entries()) {
    if (!observed.has(criterion.id))
      issue('missing-acceptance', ['acceptance', index, 'id'], 'An approved acceptance criterion is missing from the review')
  }
  if (issues.length) throw boundedRoleResultError({ role: 'review', runId }, 'semantic-validation', issues)
}
