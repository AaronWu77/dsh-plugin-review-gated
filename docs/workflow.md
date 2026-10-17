# Review-gated development

English | [中文](workflow.zh.md)

## Summary

Use this opt-in workflow to confirm requirements before implementation and independently review each staged revision before handoff. The Main Agent coordinates an Implementation Agent and a Review Agent in strict sequence. The opt-in managed plugin enforces admission, approval, ordering and evidence checks when deployed. PTC presents tools; native enforcement retains the limits in [security](security.md). This guide does not claim the mode is installed.

## Table of Contents

- [Scope and prerequisites](#scope-and-prerequisites)
- [1. Confirm requirements](#1-confirm-requirements)
- [2. Implement and stage](#2-implement-and-stage)
- [3. Review independently](#3-review-independently)
- [4. Repair or pause](#4-repair-or-pause)
- [5. Verify and hand off](#5-verify-and-hand-off)
- [After-install retest prompts](#after-install-retest)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

<a id="scope-and-prerequisites"></a>

## Scope and prerequisites

Apply this workflow when the user explicitly requests review-gated development. Do not turn unrelated research, documentation, or ordinary coding requests into this workflow automatically. The Main Agent must read this guide and include the relevant requirements in each delegated task.

| Role | Responsibility | Restrictions |
|---|---|---|
| Main Agent | Research, clarify requirements, dispatch tasks, verify handoff, report results. | Do not approve requirements for the user or replace independent review with self-review. |
| Implementation Agent | Implement approved requirements, add tests, validate changes, repair findings. | Do not expand scope or publish changes without authorization. |
| Review Agent | Check the approved requirements, staged changes, related code, and verification evidence. | Do not edit product code or the index, and do not accept the implementation report as proof. |

Use one writer and sequential implementation/review in a regular standalone repository; linked worktrees are unsupported. Inspect existing tracked, untracked, staged and ignored files; preserve unrelated work. The first run requires a clean baseline and no concurrent external repository/config writers. A separate clone is not a security sandbox.

Use deployed Main to run host-created roles; internal Implementation/Review/Diagnostic are not root-selectable. Main uses read-only and Implementation workspace-write; widening the mode refuses managed operations. Pause when confinement or independent review is unavailable.

Before implementation, agree with the user on a finite repair-round limit, a time or cost budget, and the findings and checks that block handoff. If a required limit is unspecified, ask rather than assume. Model diversity is optional; independent review requires a fresh context with the original requirements.

<a id="1-confirm-requirements"></a>

## 1. Confirm requirements

Main investigates and submits a complete versioned brief with `rg_submit_brief`, opens approval with `rg_start(operation=approval, revision)`, and observes it with bounded `rg_wait(id, waitMs)`. In default button mode, Main reads `rg_status.uiConfirmation.questions`, passes them unchanged to `ask_user_question`, and finishes the turn. The user selects an option and submits the existing question card. The genuine UI reply wakes Main, which records its discovered sequence with `rg_confirm_question`. Approval alone stops at Approved; operation approval `never` does not bypass this decision. The title stays short; read the complete facts in the scrollable first-choice description before submitting. Main reopens legacy proposals when `uiConfirmation.refreshDecision` is present; it never asks users to copy their old JSON template.

The brief includes the goal, non-goals, allowed change scope, constraints, numbered acceptance criteria, verification plan, and material open questions. `submittedBriefSchema` requires every `verificationCommands` entry to include an explicit `timeoutMs`: a positive integer no greater than 2147483647. The durable reader permits omission solely to read old history; execute refuses such legacy briefs. Revise and obtain new human approval before execution, never add retroactive approval. Resolve acceptance-affecting questions or obtain approval for explicit assumptions before dispatching implementation. A general acknowledgment is not approval of an unspecified brief. New submissions also declare `executionIntent: implementation` or `verification-only`; the latter skips Implementation, captures a zero-change snapshot and forbids workspace/index writes.

New uncertainty during implementation, review, or repair returns to the Main Agent and then to the user. Pause affected work and downstream stages. Do not invent requirements, broaden scope, add optional features, or choose a product behavior merely to keep execution moving. Record the answer; revise and reapprove the brief when acceptance, scope, or constraints change. Reassess earlier implementation and review evidence against the revised brief.

**Verify:** an identified brief has user approval, material questions have approved answers, and no Implementation Agent has started before that approval.

<a id="2-implement-and-stage"></a>

## 2. Implement and stage

When the user requests execution, Main prepares `rg_request_operation(kind=execution)`, opens its exact card, and waits for the separate Authorize/Decline reply. `rg_confirm_operation` records that genuine input; only current one-use permission permits `rg_start(operation=execution)`. No IDs, message sequences or JSON need user input. Explicit `confirmationMode: legacy-json` retains the former headless flow; button mode never silently falls back.

Add tests derived from the acceptance criteria, run relevant checks, and report actual commands, outcomes, and unverified items. Do not delete tests, weaken assertions, or disable checks to hide failures.

After Implementation finishes, the host stages only the approved candidate and records the base and tree ID without committing. Checks run in an exact export without Git metadata; Review receives a second clean export, diff and actual check evidence. Untracked/ignored source cannot be silently omitted; `generatedPaths` exempts only additional artifacts.

Stop the Implementation Agent's writes before review starts. Check that the product files used for tests match the staged snapshot and that no required file is omitted. Changes produced by validation require restaging and renewed validation before review.

**Verify:** the staged diff contains only the approved task, the snapshot has an ID, verification evidence names the same contents, and no writer remains active.

<a id="3-review-independently"></a>

## 3. Review independently

After admitted execution starts, the host dispatches Implementation and Review through its admitted one-shot DSH Subagent provider; Main does not ask the user to launch or manage them. The provider applies role admission, exact cwd and preset inside the public Agent factory creation window, then records one-shot child identity and parent discovery. Review receives a fresh context, the approved brief, original acceptance criteria, baseline, snapshot and host evidence. Generic `subagent` and Agent Teams tools remain blocked because arbitrary children would lack the managed role admission, fixed preset, snapshot and strict result validation. Host verification is not a fourth Agent.

Review the staged snapshot against the base revision, then inspect related callers and tests. Reading only the working directory is insufficient when it differs from the index. Check requirement coverage, scope, correctness, security, compatibility, and relevant failure paths. Do not require optional refactoring outside the approved scope.

Each finding includes severity, an accurate file location, triggering conditions, impact, evidence or reproduction steps, and a minimal repair suggestion. Distinguish confirmed defects from unresolved suspicions. Return one of these outcomes and identify the reviewed brief and snapshot. Every acceptance ID must occur exactly once with complete `status` and `evidence`. Passed requires every criterion Passed with real exported file/existing line evidence or an actual approved check’s `checkIndex`; free-form `checked` text is insufficient.

| Outcome | Meaning | Next action |
|---|---|---|
| Passed | Review is complete for the agreed scope, required checks passed, and no unresolved blocking finding remains. | Main Agent verifies handoff conditions. |
| Needs Changes | An evidenced issue requires repair within the approved task. | Return findings to the Implementation Agent. |
| Inconclusive | Missing information, unavailable validation, execution failure, cancellation, timeout, or invalid output prevents a conclusion. | Pause and report the cause; do not treat it as Passed. |

The Review Agent does not edit product files or the index. Validation may create disposable outputs only in an agreed location that does not change the reviewed inputs. Tool names and prompts alone do not provide read-only enforcement; permissions must cover shell and other execution paths. Passed does not prove the absence of every defect.

**Verify:** the report identifies the approved brief and staged snapshot, contains a valid outcome, and does not substitute a failure or self-review for independent review.

<a id="4-repair-or-pause"></a>

## 4. Repair or pause

The Main Agent evaluates findings against the evidence before requesting repairs. Do not blindly accept every reviewer suggestion. Resolve disputed blocking findings with evidence or user clarification; they remain unresolved until that decision is recorded.

For Needs Changes, the Implementation Agent repairs accepted findings, reruns relevant checks, and stages the revised changes. Record a new snapshot and repeat independent review before handoff. Any change to reviewed contents or approved requirements invalidates the previous approval for the resulting candidate. Do not run repair and review concurrently. Needs Changes findings survive pause/retry and reach the next Implementation; recovery must not lose repair feedback.

For Inconclusive, unresolved requirement uncertainty, exhausted limits, or cancellation, stop downstream execution and let the Main Agent report the last snapshot, outstanding issues, and the decision needed to resume. Do not publish changes, discard work, silently increase limits, or label the task successful.

On resume, verify the brief, workspace, index, snapshot, and active jobs before starting another agent. A restored conversation summary is not evidence that the current contents passed review. Restart never resumes Running automatically: `rg_recover` first reconciles a restored Running host task through actual human quiescence confirmation and records Interrupted. A separate execution recovery requires human quiescence confirmation for an unresolved `executionWindow`, even without an active role. Unknown remaining runtime conservatively consumes the remaining approved budget; revised approval never resets consumed time. See [recovery](recovery.md).

**Verify:** every repaired candidate has renewed verification and review, or the task is explicitly paused with preserved work and a concrete reason.

<a id="5-verify-and-hand-off"></a>

## 5. Verify and hand off

The Main Agent verifies that the current staged snapshot and approved brief match the Passed report, required checks passed for those contents, and no blocking findings or requirement questions remain. If a file, the index, or the requirements changed, return to the corresponding stage.

Execution stops at Ready for Handoff. Only requested handoff gets its own question card and new one-use permission. After execution settles, `rg_handoff` rechecks approval, acceptance evidence and full tracked-source/raw-byte integrity before Completed. Handoff is not a Git commit; it authorizes neither commit nor push.

Return a concise report with these sections; do not invent incidents or hide missing verification.

1. **Completion:** what was delivered and how it meets the acceptance criteria.
2. **Changes:** affected modules, behavior changes, and compatibility implications.
3. **Problems encountered:** actual implementation or review issues and their resolution.
4. **Verification and review:** commands and outcomes, review/repair rounds, final brief and snapshot identifiers, and Git staging/commit/push state.
5. **Remaining limitations:** known risks, unresolved items, and unverified behavior.
6. **Follow-up options:** optional optimization directions, expected benefits, and priority; these are suggestions, not newly authorized work.

**Verify:** the user can identify the delivered revision, its evidence and limitations, and which publication actions have not occurred.

<a id="after-install-retest"></a>

## After-install retest prompts

These optional prompts describe observations after owner-controlled installation; they are not a required new live test or evidence of installation. Preserve existing authoritative Sessions, journals, repositories and approved commands. Do not create another repository or reset a task merely to use the buttons.

Approval and execution remain distinct decisions. A completed approval host task can leave workflow phase Approved without starting any child. Any changed scope, command or budget needs a complete revised brief and fresh approval.

1. **Inspect status:** “Read `rg_status` and report the exact brief revision, workflow phase and host-operation status for finite-integer-add. Preserve all work. If a restored host task/window is unresolved, stop and use the separate human-confirmed recovery decisions; do not infer process exit or execute.”
2. **Read status first:** “Only call rg_status for phase, revision, host task and unresolved window. No Diagnostic, recovery, cancellation or execution. A new task must be Clarifying; otherwise stop. Existing tasks only report historical facts and gaps.”
3. **Approve only:** “Prepare the exact complete brief from my request and show the requirements card. Stop after my approval; do not authorize or start execution.”

```text
Implement only the approved task. Use the approval and execution cards; automatically coordinate the managed roles. Do not hand off, commit or push.
```

4. **Requested execution:** “Prepare the separate execution card, showing exact scope, commands and remaining limits. Wait for my button choice. After Authorize, coordinate the roles automatically and stop at Ready for Handoff. Never substitute commands or reset limits.”
5. **Requested handoff:** “Only for the current Passed snapshot at Ready for Handoff, show the separate handoff card. After my authorization, hand off and report actual evidence and gaps. Do not commit, push or restart the service.”

Existing tasks keep their revisions and consumed budgets. New blank tasks begin at revision 1. Read [execution](execution.md) for effective deadlines and [recovery](recovery.md) for interrupted attempts; no sample timeout is an implicit authorization.

<a id="further-exploration"></a>

## Further Exploration

- [Compatibility](compatibility.md): deployment target and unverified behavior.
- [Project overview](../README.md): mode and limitations.

<a id="dev-note"></a>

## Dev Note

<details>
<summary>Non-authoritative implementation direction</summary>

Four managed presets independently compose local fs/subprocess/sandbox/ptcRuntime; ordinary root PTC is unchanged. No SSH alias convention is required. Diagnostic returns bounded read-only facts, not Review or acceptance.

Windows confinement is partial: it does not fully protect `.git` or isolate reads/network/process visibility. Scripted models and component/native fixtures do not establish real remote end-to-end behavior or independent live-model quality. This page claims no installation, restart or final test success.

</details>

## Decision cards and semantic rejection

Requirements/recovery receipts never authorize execution. Genuine card replies bind the exact logged call, displayed facts, current candidate and latest user input. Source-only claims, ordinary JSON in button mode, stale input and legacy operation grants cannot authorize execution or handoff. Required unchecked evidence forbids Passed; semantic rejection never upgrades old output or resets budget. See [upgrade](upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.md).
