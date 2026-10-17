# Role execution and file permissions

English | [中文](security.zh.md)

## Admission and local authority

Main must be the exact live root Agent. Implementation, Review and Diagnostic require host admission before publication. A model tool, inherited preset or reused Session ID cannot grant a role. Disposal revokes admission. Implementation and Review receive fresh conversation contexts and execute sequentially for a reserved canonical repository.

Each managed preset owns isolated local filesystem, subprocess, sandbox and PTC services. Ordinary root PTC keeps its stock provider. The local-workspace guard uses a closure over the captured root filesystem to reject remote aliases before managed model/tool execution; a preset-local filesystem is not authoritative for that decision. No SSH alias convention is required. See [bundle](bundle.md).

## Process enforcement

Main, Review and Diagnostic use read-only file policy; Implementation uses workspace-write. Guards reject unassigned tools, stale identities, changed role policy and escalation arguments. Managed launches require native wrapped argv and retain the provider’s reported full/partial enforcement. Unavailable confinement and runner failure never fall back to unconfined execution. Deployment operation policy remains separate; no global full-access setting is required.

Windows ACL enforcement is partial. Restricted tokens constrain some writes/deletes, but reads, network access and process visibility are not isolated by these file policies. Hard links can alias objects across paths, and AppContainer-owned ACLs can make files unreadable. Repository admission rejects detected hard links, symlinks and junctions; that rejection is not a guarantee against every concurrent raw-API/native-command bypass. Use a separately validated stronger environment when these risks are unacceptable.

Workspace-write does not fully protect `.git` and is not approved-path-level kernel enforcement. Prompts and tool guards supplement native restrictions but cannot establish secret isolation or prevent all arbitrary Git/native operations. The workspace must remain externally quiescent; checks do not lock out external repository/config writers. Teardown drains host-managed Agents/processes, not every arbitrary detached native descendant.

## Git and source integrity

Git uses a trusted host-resolved absolute executable outside the task repository. Repository-local binaries are refused. Git operations disable hooks, fsmonitor, pager, replacement objects and lazy fetching, and reject repository-controlled helpers/filters/diff programs, config includes, worktree redirection and fsck skips. Full strict fsck checks Git object hashes, including non-root subtrees; a SHA256 file manifest alone does not authenticate Git object storage.

The host independently walks the actual workspace, including ignored source, and refuses assume-unchanged/skip-worktree flags. Approved `generatedPaths` exempt only additional artifacts, never tracked source. Linked metadata, symlinks, junctions, hard links, object alternates, linked worktrees and submodules are unsupported. A task needs a regular standalone repository, not a linked worktree. A regular standalone repository may enable `extensions.worktreeConfig`; the host audits both `.git/config` and `.git/config.worktree`, including a dormant worktree file, and still rejects dangerous keys.

New snapshots bind all source files with SHA256 and compare raw bytes, including LF/CRLF. The plugin does not normalize checkout contents automatically. Resource limits bound Git output, file/tree bytes, workspace entries, metadata entries and command time; see [execution](execution.md). These checks require trusted providers and no concurrent external writers.

## Diagnosis, results and cancellation

Diagnostic is host-created, read-only and bounded. Its result contains structured facts and limitations; it does not approve requirements, alter source, produce Passed review or accept the deliverable. It receives only admitted capabilities, not arbitrary tool dispatch.

`RoleRunner` accepts separate `reasoning` metadata but parses only the concatenated `text` blocks of the final assistant output, using strict JSON and the role schema. Reasoning is not part of the JSON result. Tool-call, image, file and every other block type remain rejected. Missing/blank text, text over configured UTF-8 `maxOutputBytes`, invalid JSON/schema, aborted or incomplete whole-Agent turns never produce success. Truncation, cancellation and budget exhaustion never produce success. Passed needs complete acceptance evidence tied to actual source/checks; see [execution](execution.md).

Host-owned tasks survive a single PTC observer abort or short wait timeout, not Main/preset disposal or explicit `rg_cancel`. Cancellation and shutdown drain owned roles/checks before releasing resources. Restart does not resume durable Running tasks automatically; [recovery](recovery.md) requires actual human confirmation of process quiescence.

This round provides scripted-model/component evidence only. Actual SSH-host end-to-end behavior, independent live-model review quality and all-platform OS isolation are unverified. Selected Windows ACL denials do not establish full isolation.

## Genuine decision input

Default button mode uses the shipped question cards and public continued-reply service. Receipts require the owning Main Session, exact logged tool arguments and continued result, displayed scope/options, latest fresh user reply, current workflow binding and one-use consumption. Ordinary JSON, assistant text and unattributed callbacks cannot authorize button-mode decisions; legacy grants cannot be consumed in button mode. Native unknown-outcome crash repair does not grant permission: only a new exact UI reply can confirm the continued card. The receipt identifies the user-input channel, not independent natural-person identity.
