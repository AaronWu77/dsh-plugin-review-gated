# Implementation and verification limits

English | [中文](implementation-plan.zh.md)

## Current behavior

The managed mode combines approved requirements, sequential Implementation/checks/Review, snapshot-bound evidence, bounded repair, cancellation and manual recovery. Main, Implementation, Review and Diagnostic each own isolated local providers; ordinary root PTC is unchanged. See [bundle](bundle.md), [execution](execution.md) and [recovery](recovery.md) for supported behavior. This page is not a completed-stage checklist.

## Evidence limits

Available evidence is limited to scripted-model tests and component/native fixtures. Scripted approval and review replies do not establish independent live-model quality. Native Windows fixtures can exercise actual PTC, PowerShell and selected ACL denials, but they do not establish full isolation. Real remote end-to-end behavior and live independent-model quality are unverified. Final assembled source validation belongs to the parent/deployment owner; no passing count is asserted here.

## User decisions and deployment

The license remains UNLICENSED. Task repair limits and execution budgets need explicit human approval. Diagnostic is bounded and read-only, not acceptance. Installation of alpha.5, activation, publication, commit and push are separate actions; this documentation does not perform or claim them.

Windows confinement is partial and does not fully protect `.git` or isolate reads, network and process visibility. Linked worktrees and hard links are unsupported. Keep the workspace externally quiescent. Preserve operation policy and later explicit mode changes; never replace them with a global full-access default. See [security](security.md).

## Persistence and upgrades

Persistence preserves ordered historical records without rewriting; missing current evidence or decision sources cannot authorize execution/handoff. Back up both Session and workflow data and preserve concurrent/unrelated data on rollback. See [persistence](persistence.md) and [upgrade guide](../UPGRADE.md).
