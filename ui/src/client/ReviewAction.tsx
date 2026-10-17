/** Display-only modal using framework projection hooks and existing primitives. */
import { useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Observation } from '../summary.ts'
import { NS } from './locales.ts'
import css from './ReviewAction.module.css'

/** Plain navigation callback; the registration rechecks the current parent catalog. */
export interface ReviewActions { openChild(parentSessionId: SessionId, childSessionId: SessionId): boolean }
export type ReviewProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS> & ReviewActions

/** Pure body shared by renderer and locale snapshot tests. */
export function ReviewDetails({ observed, t }: { observed: Observation; t: TranslateNS<typeof NS> }) {
  const { state, recordCount } = observed.summary
  const unchecked = state.review?.unchecked
  const items = unchecked ? Array.isArray(unchecked) ? unchecked : unchecked.items : []
  const blockers = state.review?.findings?.filter(finding => finding.severity === 'blocking')
  const compact = state.review?.blockingFindings
  const compactItems = compact ? Array.isArray(compact) ? compact : compact.items : []
  const blockingCount = state.review?.blockingFindingCount ?? blockers?.length
  const findingCount = state.review?.findingCount ?? state.review?.findings?.length
  const uncheckedCount = unchecked ? Array.isArray(unchecked) ? unchecked.length : unchecked.count : undefined
  return <div>
    <p className={css.notice}>{t('notice')}</p>
    <p>{t('source', { tool: observed.tool, seq: String(observed.seq), time: new Date(observed.time).toISOString() })}</p>
    <p>{t('records', { count: String(recordCount) })}</p>
    <dl className={css.facts}>
      <dt>{t('phase')}</dt><dd>{t(`phase.${state.phase}`)}</dd>
      <dt>{t('requirements')}</dt><dd>{state.brief ? <>{state.brief.goal}<br />{state.brief.id} · {t('revision', { revision: String(state.brief.revision) })}</> : t('absent')}</dd>
      <dt>{t('approval')}</dt><dd>{state.approval ? t(state.approval.approved ? 'approved' : 'declined', { revision: String(state.approval.revision) }) : t('absent')}</dd>
      <dt>{t('candidate')}</dt><dd>{state.snapshot ? <>{state.snapshot.id}<br />{t('tree')}: <code>{state.snapshot.treeId}</code><br />{t('base')}: <code>{state.snapshot.baseCommit}</code></> : t('absent')}</dd>
      <dt>{t('verification')}</dt><dd>{state.verification ? <>{t('checks', { passed: String(state.verification.passedCount), total: String(state.verification.checkCount) })}<br />{state.verification.snapshotId}<br /><code>{state.verification.treeId}</code></> : t('absent')}</dd>
      <dt>{t('review')}</dt><dd>{state.review ? t(`review.${state.review.outcome}`) : t('absent')}</dd>
      <dt>{t('budget')}</dt><dd>{state.brief ? <>{t('repairs', { used: String(state.repairRounds), limit: String(state.brief.maxRepairRounds) })}<br />{state.remainingExecutionMs === null ? t('absent') : t('time', { remaining: String(state.remainingExecutionMs), total: String(state.brief.executionBudgetMs) })}</> : t('absent')}</dd>
      {state.hostOperation && <><dt>{t('operation')}</dt><dd>{t(`operation.${state.hostOperation.kind}`)} · {t(`operation.${state.hostOperation.status}`)}<br /><code>{state.hostOperation.id}</code>{state.hostOperation.error && <p>{state.hostOperation.error}</p>}</dd></>}
      <dt>{t('pause')}</dt><dd>{state.pauseReason ?? t('absent')}</dd>
    </dl>
    {state.phase === 'Approved' && <p>{t('approvalOnly')}</p>}
    <h3>{t('blockers')}</h3>
    <p>{t('findingCounts', { blocking: blockingCount === undefined ? t('absent') : String(blockingCount), total: findingCount === undefined ? t('absent') : String(findingCount), unchecked: uncheckedCount === undefined ? t('absent') : String(uncheckedCount) })}</p>
    {compactItems.map((item, index) => <p key={`compact-${index}`}>{item}</p>)}
    {((blockingCount ?? 0) > compactItems.length + (blockers?.length ?? 0) || (uncheckedCount ?? 0) > items.length) && <p>{t('partialDetails')}</p>}
    {blockers?.map((finding, index) => <p key={index}>{finding.file}:{finding.line} — {finding.trigger} — {finding.impact}</p>)}
    {items.map((item, index) => <p key={index}>{item}</p>)}
    {state.review?.reason && <p>{state.review.reason}</p>}
    {(!blockers?.length && !compactItems.length && !items.length) && <p>{t('unavailableBlockers')}</p>}
  </div>
}

/** Framework hooks own external state; local state owns only the open dialog and navigation notice. */
export function ReviewAction({ sessionId, useProjection, useSession, openChild, t }: ReviewProps) {
  const [open, setOpen] = useState(false)
  const [navigationError, setNavigationError] = useState(false)
  const observed = useProjection('observedReviewGated')
  const catalog = useProjection('subagentCatalog')
  const opening = useSession(s => s.openState === 'loading')
  const children = catalog?.filter(child => child.mode === 'one-shot') ?? []
  const activeRunId = observed?.summary.state.activeRunId
  return <>
    <Button variant="toolbar" size="sm" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setNavigationError(false); setOpen(true) }}>{t('trigger')}</Button>
    <Modal open={open} onClose={() => setOpen(false)} title={t('observed')} closeLabel={t('close')} className={css.dialog} contentClassName={css.scroll}>
      {opening ? <div className={css.loading} role="status" aria-label={t('pending')}><StateDot state="ongoing" /></div> : observed ? <ReviewDetails observed={observed} t={t} /> : <p>{t('empty')}</p>}
      {!opening && observed && <>
        <h3>{t('children')}</h3>
        {activeRunId && <p>{t('active')}: <code>{activeRunId}</code>{!children.some(child => child.id === activeRunId) && <><br />{t('undiscovered')}</>}</p>}
        <div className={css.children}>{children.map(child => <Button key={child.id} variant="outline" size="sm" aria-label={t('open', { label: child.label ?? child.id })} onClick={() => {
          try { setNavigationError(!openChild(sessionId, child.id)) } catch (error) { setNavigationError(true) }
        }}>{child.label ?? child.id}</Button>)}</div>
        {children.length === 0 && <p>{t('absent')}</p>}
        {navigationError && <p role="alert">{t('navigationFailed')}</p>}
      </>}
    </Modal>
  </>
}
