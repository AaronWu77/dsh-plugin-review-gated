/** Owner-local model-visible guidance and exact card snapshots. */
import { describe, expect, it } from 'vitest'
import { mainInstructions } from '../../src/main-instructions.js'
import { briefDetails, decisionCard, operationCard, recoveryDetails } from '../../src/workflow/interaction.js'
import { PreflightId } from '../../src/workflow/preflight.js'
import { OperationRequestId } from '../../src/workflow/authorization.js'
import { questionBinding } from '../../src/workflow/questions.js'
import { atEvent, brief } from '../fixtures/workflow.js'

describe('Main guidance and readable decision facts', () => {
  it.each(['buttons', 'legacy-json'] as const)('pins stable role and human-channel instructions (%s)', mode => {
    const text = mainInstructions(mode)
    expect(text).toContain('automatically creates an Implementation child Agent')
    expect(text).toContain('fresh independent Review child Agent')
    expect(text).toContain('Your read-only policy does not imply that Implementation cannot write')
    expect(text).toMatchSnapshot()
  })
  it('pins complete approval, operation and recovery cards without manual JSON templates', () => {
    const state = atEvent(8), request = { id: OperationRequestId('operation'), kind: 'handoff' as const, mode: 'handoff' as const, revision: 1, binding: questionBinding(state), preflight: { id: PreflightId('00000000-0000-4000-8000-000000000013'), repository: '/fixture/repository', head: state.snapshot!.baseCommit, treeId: state.snapshot!.treeId }, askedAt: 1, afterSeq: -1, status: 'pending' as const }
    const cards = { approval: decisionCard({ id: 'approval', kind: 'approval', revision: 1, binding: 'binding', phase: 'Awaiting Approval', askedAt: 1, afterSeq: -1, question: 'Approve this exact brief?', detail: briefDetails(brief), options: [{ label: 'Approve' }, { label: 'Reject and revise' }], status: 'pending' }),
      handoff: operationCard(request, brief, 1000, state), recovery: recoveryDetails({ ...state, phase: 'Paused', pauseReason: 'Interrupted review' }, state.snapshot!.baseCommit) }
    expect(JSON.stringify(cards)).not.toContain('reviewGatedAnswer')
    expect(JSON.stringify(cards)).not.toContain('reviewGatedOperation')
    expect(cards).toMatchSnapshot()
  })
})
