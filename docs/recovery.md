# Recovery and Main reports

English | [中文](recovery.zh.md)

## Summary

You can stop an owned task, ask the human how to proceed after a pause, and obtain a six-part report without treating an interrupted attempt or a stale delivery as success. Recovery never executes work automatically.

## Contents

- [Paused tasks](#paused-tasks)
- [Interrupted hosts](#interrupted-hosts)
- [Cancellation](#cancellation)
- [Report meaning](#report-meaning)

<a id="paused-tasks"></a>

## Paused tasks

Main uses `rg_recover` to open retry, revise or leave-paused choices. In button mode it shows the exact recovery card and records its genuine logged reply; an unattributed service callback never authorizes a choice. Unavailable options, custom text, stale input and cancelled decisions cannot authorize retry. Exhausted limits, stale snapshots, Implementation clarification and Inconclusive review prevent retry. Revised scope needs the next complete brief and new approval.

An accepted retry returns to an inactive phase, never starts work and never renews consumed operation permission. Needs Changes feedback and runtime remain. Main requests and confirms new one-use permission before execution; Implemented/Staged uses verify-review only. Recovery rechecks baseline/currency, never rebases or discards unrelated work.

<a id="interrupted-hosts"></a>

## Interrupted hosts

Restart never resumes a Running host task. `rg_recover` opens a host-quiescence card; only actual user confirmation records Interrupted, without inferring a result. Leave unresolved retains Running. A separate recovery reconciles execution phases/windows and refuses registered old Agents or another workflow’s repository ownership. Host reconciliation alone never clears a window or authorizes execution. Terminal workflows permit host-only reconciliation without changing their terminal phase.

Active Implementing, Verifying or Reviewing records and unresolved windows do not establish old process exit. The window can also remain after Implemented, Needs Changes or Ready for Handoff; successor recovery supports all three without reopening old work. Actual human quiescence confirmation conservatively consumes unknown remaining approved budget and stops Paused, without inventing successful evidence. Further execution needs a revised, newly approved cumulative budget; neither runtime counter nor repair rounds reset. Legacy active-role recovery also consumes unknown runtime. Ordinary Session logs do not replace the authoritative journal. See [persistence](persistence.md).

<a id="cancellation"></a>

## Cancellation

`rg_cancel` drains Main-owned host tasks/execution and records terminal Cancelled, preserving worktree and index. It cancels the entire workflow, not only one Diagnostic; repeated messages cannot reopen it. Start a genuinely separate Session for a new task. Unresolved restored activity requires logged quiescence first. Cancellation explanations are Main input, not user authorization; disposal drains owned work.

<a id="report-meaning"></a>

## Report meaning

`rg_report` returns completion, changes, problems, verification/review, limitations, and follow-up options. Native calls render these as six Markdown sections; PTC receives the same structured JSON values. Main must use those facts rather than invent stronger evidence. A recorded Passed result means a fresh Review Agent returned that snapshot-bound outcome; it does not identify a different model or prove live external-provider review. Scripted tests remain scripted evidence.

Historical completion and current snapshot verification are separate fields. Reporting checks HEAD, index, complete tracked raw bytes and actual workspace files, including ignored source except approved additional artifacts. Failed observation or absent v2 digests/complete acceptance evidence makes `currentDeliverableVerified` false. Old Completed remains historical, without changing terminal state or authorizing new handoff.

## Dev note

Abrupt host loss requires human process-quiescence confirmation; checks do not prevent concurrent external writers. See [security](security.md) for platform limits, [execution](execution.md) for ordering and [bundle](bundle.md) for deployment. Scripted-model/component/native fixtures do not establish real remote end-to-end behavior or independent live-model quality.

## Decision and operation receipts

Approval/recovery cards and execution/handoff cards record distinct genuine replies. Current one-use operation permission is required in addition to requirements approval. Button mode refuses manual JSON and legacy operation grants; explicit `legacy-json` is a deployment choice, not a fallback. Missing historical sources remain unknown; counters never reset. Semantic rejection needs an explicitly authorized fresh Review. See [upgrade](upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.md).
