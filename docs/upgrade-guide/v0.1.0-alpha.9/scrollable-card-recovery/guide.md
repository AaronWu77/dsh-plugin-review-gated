---
kind: upgrade-guide
description: "Confirmation facts move to the scrollable card body; v7 recovery records cannot be read by alpha.9."
---
# Scrollable cards and interrupted-window recovery: alpha.9 → alpha.10

English | [中文](guide.zh.md)

## Change

Cards keep a short title and carry complete requirements, scope, commands and limits in the first option description, which the existing GUI scrolls. Selecting an option alone does not submit it. Main passes the exact current card arguments; an older presentation does not authorize the current decision.

In button mode, Main replaces an uncommitted legacy JSON/service proposal with a fresh readable question and requires a new genuine reply. Committed decisions, original records, task contents and consumed limits remain intact. Quoted legacy prompt text in a new brief is not a legacy channel.

New records use v7. Only v7 recovery can open a quiescence question for an unresolved window after the role has reached Implemented, Needs Changes or Ready for Handoff. Confirmation conservatively consumes unknown remaining budget and stops Paused; it starts no role or check. V1–v6 schemas and replay remain frozen. Alpha.9 cannot read v7; no reverse migration is supplied. See [persistence](../../../persistence.md) and [recovery](../../../recovery.md).

## Migration

1. Preserve matching Session logs, the configured `aaronwu_review_gated` domain, package and profile backups. Keep post-upgrade data and unrelated Sessions. Never edit stored JSON to remove an execution window or manufacture permission.
2. Stage the new version/content-named archive outside the active profile and verify its SHA256. Installation/restart remain owner-controlled; do not overwrite an earlier archive or automatically retry an existing task.
3. Read status in the authoritative task. A restored Running host first needs `rg_recover` and the actual host-quiescence reply. For a legacy approval, Main follows `uiConfirmation.refreshDecision` and reopens the current revision with `rg_start(operation=approval)`; recovery proposals use `rg_recover`. No new repository, manual JSON or budget reset is needed.
4. If `uiConfirmation.replaceCard` is true, Main opens the current `uiConfirmation.questions` even when an older card remains in history. Read the scrollable scope, choose and submit. Execution and handoff still need distinct fresh one-use authorization.
5. An unresolved window needs its own quiescence confirmation after host reconciliation. Confirm status becomes Paused, the window is absent, and unknown remaining time is consumed. Further execution needs a complete revised brief and new approval. For rollback, use isolated matching pre-upgrade backups or supported selective restore; never give v7 records to alpha.9 or overwrite concurrent Sessions.
