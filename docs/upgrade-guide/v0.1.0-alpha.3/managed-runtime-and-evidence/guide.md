---
kind: upgrade-guide
description: "Alpha.4 isolates managed runtimes and requires current snapshot and acceptance evidence for new handoff."
---
# Alpha.3 → alpha.4: managed runtime and evidence

English | [中文](guide.zh.md)

## Change

Ordinary root PTC retains its stock runtime. Main, Implementation, Review and Diagnostic each isolate local `fs`, `subprocess`, `sandbox` and `ptcRuntime`; global native-runtime replacement and SSH runtime aliases are not required. The captured root filesystem rejects remote managed workspaces. Operation policy remains user-owned; requirements approval remains mandatory even with operation approval `never`. Windows confinement is partial, not full `.git`, read, network or process isolation.

New snapshots bind every tracked source file with SHA256 and raw Git blob bytes, including LF/CRLF without normalization. Git uses a host-resolved absolute executable outside the repository and full strict object-hash fsck, including non-root subtrees. Hidden index flags, ignored source, linked metadata/source, alternates, filters, includes, fsck skips and core.worktree are rejected; linked worktrees/hard links are unsupported. `generatedPaths` permits only additional artifacts.

Passed requires unique complete acceptance coverage with real export file/line or actual checkIndex evidence. Domain/envelope version 1 retains mixed v1/v2 records. Old history replays but gains no missing evidence; old completion is historical with `currentDeliverableVerified: false` and cannot authorize a strict new handoff. Alpha.3 cannot read v2 records.

## Migration

1. Confirm all old activity stopped. Consistently back up both Session storage and the configured `aaronwu_review_gated` storage-domain backend, complete logs, package and profile. Preserve concurrent/unrelated Session data.
2. The deployment owner installs the matching built alpha.4 layer. In `cordis.yml`/profile overrides, remove only alpha.3 Review-Gated global native-runtime replacement and obsolete runtime alias dependencies such as `localFs`/`localSubprocess`; retain legitimate ordinary SSH routing and user operation/file policy. Compare the [bundle](../../../bundle.md) and [overlay](../../../../cordis.patch.yml); migrate managed options to each preset-local `native-runtime`, not the root.
3. Use a regular local standalone repository and resolve raw-byte checkout mismatches deliberately. Start a fresh blank Main task for new evidence; do not edit old journals to promote trust. Prefer `rg_start` plus bounded `rg_wait`; task `maxOperationMs` defaults to 1800000 ms. Legacy blocking calls remain limited by outer PTC deadlines.
4. After owner installation and user restart, confirm ordinary PTC is unchanged, internal roles are hidden and remote managed admission refuses. Running history requires `rg_recover` human quiescence confirmation, then separate execution recovery; unknown role runtime exhausts remaining budget. Cancel/dispose drains activity.
5. For rollback, preserve complete post-upgrade stores/logs first. Alpha.3 needs an isolated pre-upgrade Session/journal copy or backend-supported selective restore; never overwrite concurrent/unrelated Sessions or later user policy. No reverse migration is supplied.
