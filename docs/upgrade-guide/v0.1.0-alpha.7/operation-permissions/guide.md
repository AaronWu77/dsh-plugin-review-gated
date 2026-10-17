---
kind: upgrade-guide
description: "Separate requirement confirmation from one-use operation permission and audit rejected Review semantics."
---
# Upgrade alpha.7 → alpha.8

English | [中文](guide.zh.md)

## Summary

Alpha.8 preserves requirements confirmation but requires distinct exact new logged user input for each execution or handoff attempt. It writes v5 operation/semantic-rejection facts, reads ordered v1–v5 history without rewriting it, and never installs, restarts or resumes work automatically. This is a breaking change for direct execution/role callers and default model queries.

## Contents

- [Permission](#permission)
- [Review evidence](#review)
- [Queries and reports](#queries)
- [Existing data](#history)
- [Installation and rollback](#deployment)

<a id="permission"></a>
## Permission

Finish approval service response and exact question confirmation, then stop at Approved. A service answer alone does not approve; requirements/recovery confirmation alone does not execute. When further work is requested, Main calls rg_request_operation with kind execution, shows its mode and limits, then waits for the exact new JSON template from the user. rg_confirm_operation records Authorize or Decline using the actual logged sequence. Neither preparation nor confirmation launches a role or check. After an explicit Authorize, execution may start; it consumes permission with window start, once only, and stops at Ready for Handoff. Handoff requires a distinct request and new input. No operation authorizes commit or push.

Operation requests bind revision, approved scope, phase, candidate, budget/round counters and exact latest later user input in the owning Session. New input invalidates unused permission. Foreign, synthetic, stale or duplicate input and missing permission fail closed through tools, direct services and the durable Controller mutation seam; the Controller accepts current operation events only with Session-bound logged validation. Roles require consumed execution permission for their current window/mode and a live-generation receipt; restored activity must be reconciled rather than relaunched. Verify-review mode never writes or automatically repairs; an evidenced Needs Changes ends that attempt. Within implementation-capable mode, bounded approved repair renews checks and Review. Receipt source names the recorded user-input channel, not independent natural-person authentication. New briefs declare `executionIntent`; `verification-only` selects a zero-change snapshot path, skips Implementation and repair, and is enforced at the Controller, Execution Service and direct Role Runner.

A pending request returns templates in operationEvidence.templates; copy only the current request ID. Exact selected values are Authorize and Decline. The operation JSON is distinct from the reviewGatedAnswer question JSON; requirement IDs cannot authorize operations. To wait beyond that turn before starting, request fresh permission after any new user input.

<a id="review"></a>
## Review evidence

Review receives immutable source, diff, exact host checks and logged observations after the host actually checks source integrity and allowed scope. Digests alone do not establish integrity. Read-only Review never runs hash/test processes, enumerates the original worktree or invents other-environment requirements. Missing observations must not be inferred.

Checked means verified task facts. Unchecked means required acceptance/scope items still unverified. Passed needs complete evidenced acceptance, no blockers and no unchecked items; real missing required evidence means Inconclusive. General out-of-scope limitations may be stated in reason but cannot hide required uncertainty. Needs Changes requires findings describing evidenced changes. JSON, schema and semantic rejections are distinct, bounded facts with run/log references; submitted evidence is not an accepted Review. Original outputs are neither edited nor retried automatically. If audit append fails after role disposal, interruption/accounting are attempted independently; persistent settlement failure remains unresolved without claimed completion.

<a id="queries"></a>
## Queries and reports

rg_status and dynamic context return compact discovery views. rg_brief returns the complete brief; rg_question(questionId) returns a retained original question/detail/options/receipt; rg_status(detail=true) returns the full journal view. Original records remain authoritative and complete. Main configuration summaryTextChars defaults to 512 (64–8192), summaryItems to 8 (1–128). Compact projections reduce repeated detail/output bytes but do not prove live-model token, cache or latency savings.

Completion reports rename authorizationComplete to requirementsAuthorizationComplete, and separately expose operationPermissionCurrent, operationPermissionStatus and handoffPermissionRecorded. A historical handoff remains historical; missing v5 handoff permission is never inferred into current verified delivery. Direct callers must obtain exact operation permission; direct roles must run only inside an authorized live window. No core Session format, SDK event catalog or root PTC provider change is required.

<a id="history"></a>
## Existing data

The storage domain and journal envelope remain version 1. Journal shutdown drains in-flight Controller commits before closing the domain. Released v1–v4 event schemas and replay semantics remain supported; new events write v5 in monotonic order. Old decisions never create operation permission. Restored Running tasks/windows require separate logged quiescence/recovery, preserve limits and conservatively account unknown runtime. No consumed time or round is reset, and scope changes need a complete revised brief and approval.

For a paused unchanged candidate, preserve files/index/snapshot and recorded checks. After explicit recovery, obtain verify-review permission and run new host checks plus a fresh Review; do not rerun Implementation or edit the old rejected answer. Stale contents or unmet requirements need the normal approved revision/repair path. Cancelled remains terminal: start a genuinely separate Session, not another message or hand-edited store.

<a id="deployment"></a>
## Installation and rollback

Back up both the authoritative workflow domain and complete matching Session logs, plus the profile, before installation. Stage the frozen archive and installer outside the active profile. The owner stops the real service and verifies managed activities/package writers are quiescent. Use the alpha.8 installer with its exact alpha.7 predecessor/config/archive hash; check-only inspects without installation, and stopped-service guards refuse active service state. Installation neither stops nor starts the service, executes work nor rewrites old rows. The owner starts the existing profile and checks installed version before a new isolated Git-backed test.

Alpha.7 cannot read newly written v5 records. Before rollback, preserve all post-upgrade logs and stores; use matching pre-upgrade isolated copies or supported selective restore. Never replace the shared domain with a whole-file old backup that discards unrelated/concurrent Sessions. Archive replacement alone is not a downgrade migration; no reverse migration is provided. Active-role/window certainty and task recovery remain separate decisions.
