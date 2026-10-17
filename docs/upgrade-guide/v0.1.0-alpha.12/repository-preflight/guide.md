---
kind: upgrade-guide
description: "Repository preflight and baseline-bound permissions require fresh operation authorization."
---
# Upgrade alpha.12 → alpha.13: repository preflight

English | [中文](guide.zh.md)

## Change

Execution and handoff requests run bounded read-only repository preflight before a card is offered. A blocked observation publishes diagnostics, not permission. Cards bind the canonical repository, HEAD and candidate tree; confirmation and execution recheck them. New plugin-private workflow records use v8; the storage-domain and journal envelope stay at version 1. This is not a core Session-format change or a core persistence-inventory acknowledgement. [Persistence](../../../persistence.md) identifies the changed types and reader rules. Existing v1–v7 readers stay frozen and those records remain readable without rewriting; old requests or grants without preflight proof require a new operation request and user decision.

## Migration

1. Finish or cancel active work and stop all writers before replacing the plugin. Preserve both authoritative stores and the current package/configuration for rollback.
2. Install the validated candidate through the existing source-Host-compatible package layout. Do not edit journals, reset consumed budgets or replay an old Authorize sequence.
3. Inspect the operation preflight status. Resolve exact incompatibilities before requesting a new card. Regular standalone repositories may enable `extensions.worktreeConfig`; dangerous keys in `.git/config` or `.git/config.worktree` still refuse execution. Linked worktrees and nested repositories remain unsupported.
4. Review the repository and HEAD/tree on the new card, then decide. Approve and Authorize remain distinct; new user input can invalidate a receipt.
5. Keep generatedPaths to literal disposable output paths. Glob patterns and excluding the whole repository are rejected for new briefs. Revise and reapprove affected briefs; do not rewrite historical inputs.

Git timeout diagnostics distinguish process outcomes. Configuration provides ordinary-command, integrity-check and total-preflight budgets. Do not infer corruption from elapsed time or automatically change Git configuration, run pruning, or bypass checks.

Alpha.12 rejects v8 records. After a v8 write, stop dependent operations and preserve the newer Session/workflow stores. Use a compatible reader or an isolated matching pre-upgrade backup for rollback; never overwrite newer stores with old backups. A code downgrade alone does not establish data compatibility.
