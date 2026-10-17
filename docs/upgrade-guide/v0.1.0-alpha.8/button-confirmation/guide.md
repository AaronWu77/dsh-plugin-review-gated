---
kind: upgrade-guide
description: "Button confirmation replaces manual JSON by default; v6 workflow receipts cannot be read by alpha.8."
---
# Button confirmation: alpha.8 → alpha.9

English | [中文](guide.zh.md)

## Change

Alpha.9 defaults the support plugin to `confirmationMode: buttons`. Users approve requirements and separately authorize execution through the existing question cards; Main records genuine replies and automatically coordinates real Implementation and Review child Agents. Generic subagent/Team tools remain blocked. Main is read-only; Implementation still has workspace-write permission. Host verification is not another Agent.

New journal records use v6 and accept the recorded `session-user-question-reply` source. Released v1–v5 validators and records remain unchanged. Alpha.8 cannot read v6; no reverse migration exists. Legacy grants never authorize a new button-mode execution/handoff, and operation input from a previous Session generation is not live permission. See [persistence](../../../persistence.md).

## Migration

1. Back up matching Session logs and the configured `aaronwu_review_gated` storage domain, package and profile. Preserve existing task contents, revisions, consumed limits and unrelated data.
2. Stage the new version/content-named candidate archive outside the active profile and verify its SHA256. Do not reuse or overwrite an older archive identity. Installation/restart remain owner-controlled; this guide does not claim either operation or ask for another repository.
3. Use the updated Main preset: its workflow plugin supplies scoped `ask_user_question`, so remove an additional same-scope generic provider. The `review-gated-support` configuration defaults `confirmationMode` to `buttons`; explicitly select `legacy-json` only for a headless deployment. Missing card support refuses confirmation, not a silent fallback.
4. In an existing authoritative task, inspect status and reconcile any interrupted processes first. Show the current requirements/recovery card, record the real reply, then request a separate fresh operation card only for requested further work. Approval alone starts no child. Confirm status reaches Approved before execution authorization; execution stops at Ready for Handoff, with no commit or push.
5. For rollback, preserve post-upgrade stores and complete logs first. Use an isolated matching pre-upgrade Session/journal backup or supported selective restore. Do not open v6 records with alpha.8, erase managed history, overwrite unrelated Sessions or automatically retry a task.
