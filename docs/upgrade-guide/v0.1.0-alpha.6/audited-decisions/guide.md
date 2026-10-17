---
kind: upgrade-guide
description: "Upgrade to audited decisions and strict result instances."
---
# Upgrade alpha.6 → alpha.7

English | [中文](guide.zh.md)

## Summary

Alpha.7 records approval, workflow recovery and interrupted-host questions before asking. Service responses remain unattributed. Only an exact new logged user message commits a decision through `rg_confirm_question`; installation never starts execution or changes scope, snapshots or consumed runtime.

## Contents

- [Confirmation](#confirmation)
- [Existing tasks and data](#history)
- [Role results](#roles)
- [Deployment and rollback](#deployment)

<a id="confirmation"></a>
## Confirmation

Read `rg_status.decisionEvidence.pending` after the question operation returns. A Completed approval task means the question settled, not requirements approved. Original question text, detail, options, service selection, status and source limitation are recorded. Permission-approval policy `never` concerns sandbox escalation, not business-question approval.

Send one exact `confirmationTemplates` JSON as a new user message in the original Main conversation, without fences or added text. Main uses `availableUserConfirmation.userMessageSeq` for `rg_confirm_question`. Answers and claimed sources are not tool arguments. Other sessions, non-user messages, superseded input, stale bindings, unavailable options and duplicate confirmations are rejected. Latest logged user input is rechecked after awaited preflight immediately before the decision attempt. Repository baseline is verified where applicable; snapshot currency is required for approval/retry, not for abandoning or revising stale contents. Host-task quiescence does not require a Git repository.

Example (replace the placeholder from the current pending question):

```json
{"reviewGatedAnswer":{"questionId":"<current question ID>","selected":"Approve"}}
```

`session-user-message` identifies the recorded user-input channel, not independent natural-person authentication. A service-only response has source `user-questions-service-unattributed`; historical missing source is unknown. Both tool and direct service execution/handoff entry points require current approval and applicable recovery receipts.

<a id="history"></a>
## Existing tasks and data

Historical IDs remain `historical-unattributed`: missing question options and answer sources are not reconstructed. Request approval for the same inactive revision to confirm unchanged requirements. Re-question and confirm an unchanged historical Staged recovery without revising requirements. Each step preserves staged contents, checks, repair rounds and cumulative budget; neither starts Implementation, checks, Review or handoff. Execution needs separate authorization.

New records use version 4; readers accept ordered mixed versions 1/2/3/4 without rewriting historical entries. State remains replay-derived; domain and journal-envelope versions stay 1. Installation alone writes no workflow records. Alpha.6 cannot read new version 4 history; no reverse migration is supplied.

An explicitly repeated request can replace an interrupted or stale question without inferring its answer; a current returned question is reused without asking again. Restored Running host tasks need a separate logged quiescence confirmation before unresolved execution-window recovery. Unknown remaining runtime is consumed, not reset. Revisions retain consumed runtime.

<a id="roles"></a>
## Role results

Implementation, Review and Diagnostic receive logged result-instance instructions. Displayed schemas omit only root `$schema` metadata; actual strict schemas remain unchanged. Unknown keys, metadata, wrong types, malformed JSON, fences and missing evidence are rejected, not stripped or automatically retried.

Reports distinguish JSON parse from schema validation, naming role/run/session and bounded issue paths. A rejected `Passed` output never becomes accepted Review. Host required checks and writer auxiliary runs retain separate authority. Scripted-model Loader tests are not independent live-model acceptance.

<a id="deployment"></a>
## Deployment and rollback

Stage package and manual install assets outside the active profile. The user stops and restarts the service; the installer never does. With service stopped, consistently back up package/profile, ordinary Session logs and authoritative workflow storage. Verify archive digest, exact alpha.6 source specifier, protected configuration and shared provider links before replacement.

After restart, inspect status and report only. Verify current revision, staged snapshot, old checks, consumed budget and repair rounds remain; source gaps must be explicit. Do not auto-recover or execute. Perform unchanged approval/recovery confirmations only on explicit user request, then obtain separate authorization for fresh host checks and Review.

Before rollback preserve all post-upgrade stores and complete logs. Use an isolated matching pre-upgrade Session/journal copy or selective backend restore, never replace a shared global store or open version 4 records in alpha.6. The package installer does not alter workflow storage or supply data downgrade.
