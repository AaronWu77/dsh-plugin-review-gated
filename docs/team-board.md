# Optional advisory Team board

English | [中文](team-board.zh.md)

## Summary

The optional `@aaronwu/dsh-review-gated/team-board` entry exposes `rg_team_board` only to the exact admitted Main Agent. It reuses the Agent Teams service for durable advisory tasks, revision compare-and-set updates, dependencies and descriptions. A board task's completion is not requirement approval, review Passed, execution permission or handoff. The adapter never creates teammates, sends peer messages or assigns managed role names as Team owners.

## Composition

After the owner installs matching optional peers, compose `@deepseek-ai/dsh-experimental-agent-team` at the host root and `@aaronwu/dsh-review-gated/team-board` inside Main's managed preset. The root service requires durable Session persistence. Optional `@deepseek-ai/dsh-experimental-client-ui-agent-team` supplies the existing read-only Team panel. Do not apply the generic Team profile or mount generic Team tools for this integration: they introduce a separate delegation surface and shared-workspace collaboration policy. The stock overlay leaves all these additions disabled.

Missing explicitly required Team service refuses board activation. Review, Implementation and Diagnostic cannot gain board authority by copying the tool. Managed role children remain independent one-shot Subagents with exact role admission and workspace; they are not Team roster members. Full peer collaboration would require additional Teams lifecycle and isolated-workspace support and is not claimed by this adapter.

## Operations and limits

Use `list` with optional zero-based `cursor` and `limit`, `get` with `taskId`, `create` with `subject` and `description`, or `update` with `taskId`, `expectedRevision` and one of `claim`, `release`, `edit`, `set_dependencies`, `complete`, `reopen`. Read the current task before updating; revision conflicts do not overwrite newer work. Dependencies and write scopes remain advisory and do not start or lock roles.

Configuration `pageSize` defaults to 20 and accepts 1–100; `maxOutputBytes` defaults to 16384 and accepts 1024–1048576. Limits cover complete UTF-8 responses. An oversized create/update response still returns its committed task id, revision and status with `detailsOmitted: true`; do not retry a mutation because details were omitted. Oversized reads fail and require a smaller page or a larger configured byte limit. Host Team limits still apply independently.

## Recovery and verification

Tasks use the existing durable Team event vocabulary. Removing the adapter does not erase tasks and does not resume managed execution. Session readers must retain a version that recognizes Team events and the owning projection when displaying the board. Workflow decisions and evidence remain in the original journal. Loader regression coverage exercises opt-in admission, disabled/missing dependencies, revision conflicts, bounded mutation receipts, role denial and effect cleanup; it does not establish independent live-model quality or full peer collaboration.
