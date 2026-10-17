# Execution and snapshot verification

English | [中文](execution.zh.md)

## Main operations

Use `rg_start(operation=approval, revision=the submitted revision)` and bounded `rg_wait` to open the requirements decision. Main shows the exact `uiConfirmation.questions` with `ask_user_question`, then waits for the real card reply and records it with `rg_confirm_question`. Requested execution uses a separate operation card, `rg_confirm_operation` and one-use permission before `rg_start(operation=execution)`. Users do not copy JSON or manage child roles. Diagnostic is optional and read-only, not a runtime probe; `rg_cancel` cancels the entire workflow after draining owned activity.

`rg_wait` accepts zero for immediate observation; the host caps each wait with `maxWaitMs`. Observe again when status remains Running, rather than treating wait timeout as failed execution. Host task `maxOperationMs` defaults to 1800000 ms; `maxWaitMs` defaults to 10000 ms. Approved execution budgets and per-command/role deadlines still apply. Legacy `rg_approve` and `rg_execute` remain blocking compatibility calls; they do not make outer PTC calls unlimited or detach those calls from cancellation.

Execution requires a live admitted Main, current decision receipts, explicit command timeouts and distinct current one-use execution permission. Tool and direct-service entries refuse missing permission before a new execution task/window/role. Source, revision, phase, candidate, remaining runtime and latest logged user input bind the request. New input invalidates an old receipt. Consumption and window start are one durable fact. Success stops at Ready for Handoff; separate handoff permission and repository revalidation precede Completed. No operation commits, pushes or merges.

## Repository preflight

The host runs bounded read-only preflight before publishing an execution or handoff request. It records running, passed or blocked observations and separate cumulative preflightMs. A blocked observation has issues, no baseline and no usable Authorize card; its observed user reply is audit evidence, not a grant. Inspect operationEvidence.preflight and nextStep rather than repeatedly reopening a failed card.

Passed requests bind the canonical repository, HEAD and candidate tree shown on the card. Confirmation and execution recheck that identity; a different clean HEAD also refuses execution. Old unbound requests require a fresh request and genuine decision, not a reused receipt. Later ordinary user input still invalidates an old receipt.

Execution configuration defines ordinary Git timeoutMs (10000 ms), integrityTimeoutMs (120000 ms) and preflightTimeoutMs (180000 ms). Full object validation uses its independent integrity limit, capped by the total preflight deadline. Preflight before a window has its own accounting and starts no roles or acceptance commands; work after window start remains in execution wall time. Same-call duplicate object checks are removed, but separate phases still revalidate.

Git failures retain bounded stdout and stderr, exitCode, signal, timedOut, aborted, elapsedMs and a typed kind. Timeout, cancellation, output-limit, spawn and nonzero-exit outcomes remain distinct. Configuration refusals name keys and origins without values. No diagnostic permits automatic Git configuration changes, pruning or integrity bypass.

## Baseline, scope and byte integrity

The first run requires a clean regular standalone Git repository and records its immutable repository/base binding. HEAD changes, active Git operations, hidden index flags, linked metadata/source, unsupported repository configuration and out-of-scope changes refuse staging/handoff. Existing unrelated work is preserved, not discarded. An `Implemented` candidate with dirty files but no staged snapshot cannot pass the new operation preflight: it still needs a clean supported baseline. Repeated card requests do not stage or rescue that candidate. Preserve its files; do not discard/reset them or restart Implementation as an automatic workaround. Requirements revisions invalidate current approval and review.

Scope validation independently walks actual workspace files, including ignored source. `assume-unchanged` and `skip-worktree` cannot conceal modifications. Approved `generatedPaths` accept literal repository-relative disposable output paths, not globs or the repository root, and permit only additional generated artifacts; tracked source remains checked even beneath those paths. Ignored source is not silently accepted as reviewed content. See [Git restrictions](security.md).

New snapshots use `integrityVersion: 2` and a complete SHA256 `fileDigests` list for all source, not only changed files. Workspace and exports must match the raw Git blob bytes, including LF/CRLF, file type and supported executable bits. The plugin does not normalize line endings automatically. A mismatch pauses/refuses the candidate; the user must resolve checkout policy deliberately without overwriting unrelated work.

Git uses a trusted host-resolved absolute executable outside the repository and `fsck --full --strict --no-reflogs` object-hash validation, including non-root subtrees. [The execution configuration](../src/workflow/execution.ts) exposes `gitExecutable`, `timeoutMs`, `maxOutputBytes`, `maxFileBytes`, `maxTreeEntries`, `maxTreeBytes`, `maxMetadataEntries` and `snapshotParent`. Defaults include total tree bytes of 64 MiB and 100000 metadata entries. Adjust deployment limits for legitimate repository size, not to skip integrity checks.

## Checks on immutable source

After Implementation, the host stages and exports the exact tree without Git metadata. Approved commands run in one export; Review receives a separate clean export, brief, diff, actual check evidence and logged host observations after source-integrity and allowed-scope checks. Digest presence alone is not an observation. Required missing evidence must remain unverified; Review does not run processes, enumerate the original worktree or test other environments outside the approved requirements. A brief with `executionIntent: verification-only` skips Implementation, captures the unchanged clean baseline as a zero-change snapshot, runs the approved checks, and permits fresh Review without workspace or index writes.

Commands use exact approved executable/argv, host executable resolution, scrubbed environment and DSH-managed subprocesses. No shell is inserted implicitly. A shell must be explicitly approved with all arguments. Git-dependent checks cannot rely on metadata in the export. Native workspace-write confines verification to the export with reported full/partial enforcement; no unconfined fallback is allowed.

Each check uses min(approved timeoutMs, deployment commandTimeoutMs, remaining execution budget), recording effectiveTimeoutMs. `rg_status(detail=true).effectiveLimits` gives complete deployment limits; the default summary gives remaining budget and command count. Nonzero exit, signal, timeout, oversized/truncated evidence, runner failure or changed source prevents Review. Managed processes are drained before accepting evidence; no fallback or alternate command is inferred.

## Windows command compatibility

`rg_status(detail=true).effectiveLimits.verification.compatibility` and approval details contain non-executed advisories, without changing argv. Implementation receives those advisories in logged input. Unknown backend capability is not a failed check and does not require an optional Diagnostic. Read-only Diagnostic cannot establish runtime command support.

Default `node --test` creates piped child processes, which Windows ACL restricted-token confinement denies. Explicitly approved `node --test --test-isolation=none test/add.test.js` avoids that isolation path; changing the acceptance command requires a complete revised brief and fresh human approval. Never widen confinement, silently substitute argv, or claim a writer-reported auxiliary check satisfies the original acceptance criterion.

The report separates host-task completion, Implementation completion, approved checks and snapshot-matched independent review. Program output remains reported diagnostics, not authoritative failure classification. A Completed host task can leave the workflow Paused with failed checks and no recorded review.

## Acceptance evidence and repairs

Every Review covers all approved acceptance IDs once with structured status/evidence. `checked` lists verified task facts; `unchecked` lists required acceptance or scope items still unverified. Passed requires every criterion Passed with evidence, no required unchecked item or blocking finding, and matching brief/snapshot/passed checks. Real missing required evidence means Inconclusive; general out-of-scope limitations belong in reason and cannot conceal required uncertainty.

Evidence is either `kind: source` with a real exported `file`, existing `line` and explanation, or `kind: verification` with an approved command’s zero-based `checkIndex` and explanation of its actual result. Source citations must exist in the reviewed export; arbitrary paths, nonexistent lines and fabricated checks cannot support Passed. Binary source needs check evidence rather than a text-line citation.

Implementation-capable permission allows bounded Needs Changes repair within approved limits, with renewed staging/checks/fresh Review. A verify-review permission for an existing Implemented/Staged candidate never starts Implementation or repairs: Needs Changes ends that attempt and requires a new implementation-capable permission. Inconclusive and requirement uncertainty pause. JSON/schema/semantic rejection is not Needs Changes and never triggers automatic repair or Review retry. New briefs must declare `executionIntent`; `verification-only` is enforced by the controller, execution service and direct Role Runner, and cannot start Implementation or repair.

The execution wall-clock window spans the entire execute attempt: Git and baseline work, snapshots/exports, role turns, checks and cleanup. Human approval waits are excluded. Failed/cancelled attempts retain consumed runtime, including cleanup after the deadline; no handoff succeeds after budget exhaustion. `executionWallMs` accumulates settled windows; an unresolved `executionWindow` prevents another execute or handoff. Budget checks retain at least `max(executionMs, executionWallMs)`, preserving legacy consumed time without double-counting it. Revised approval never resets either consumed counter. Shutdown drains owned activity; restart never resumes an active phase automatically. [Recovery](recovery.md) defines unknown-window reconciliation; [persistence](persistence.md) defines ordered mixed v1–v8 history; alpha.9 cannot read newly written v7 records.

## Rejected Review evidence

Current semantic validation rejects conflicting outcomes, incomplete acceptance and invalid references. Current bounded summaries use v8 and identify kind semantic-validation, issue paths and the original role log; submitted evidence is not accepted Review. Original outputs remain unchanged and no new Review runs without permission. Released replay remains generation-specific. See [upgrade](upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.md).
