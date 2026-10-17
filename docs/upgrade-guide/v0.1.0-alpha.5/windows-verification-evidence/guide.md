---
kind: upgrade-guide
description: "Alpha.6 reports command compatibility advisories and separates host checks from role claims."
---
# Alpha.5 → alpha.6: Windows verification and evidence

English | [中文](guide.zh.md)

## Changes

Status and human approval detail expose non-executed Windows Node test advisories. Backend capability remains unknown because the provider has no pre-execution query. No command, permission, timeout or acceptance criterion is changed automatically.

Roles receive logged instructions: Diagnostic uses read/glob/grep without process probes; Implementation does not substitute commands or claim failed required checks passed; Review uses snapshot-bound host evidence rather than writer claims. These instructions supplement executor guards, not guaranteed model compliance.

Reports separately expose host-task status, Implementation completion, required-check success and matching independent review. A Completed host task may leave Paused. Program output is diagnostic text, not an authoritative infrastructure-failure classification.

## Upgrade and retest

1. Back up ordinary Sessions, complete logs, the Review-Gated store and profile consistently. Stop the service yourself and confirm all managed work settled before installation; installation never stops, starts or hot-reloads it. Preserve shared provider links, nested dependencies, stores and unrelated configuration.

2. Install the pinned alpha.6 artifact only over its verified alpha.5 source. Dependencies, exports and bundle composition are unchanged. Workflow records remain version 3; mixed 1/2/3 history is read without rewriting. No migration or budget refund is performed.

3. After manually starting the service, inspect the installed version, ordinary PTC and authoritative existing task. Paused stays Paused. No approval, retry, recovery or handoff occurs automatically.

4. To adapt the current finite-integer-add check, explicitly revise its acceptance command to `node --test --test-isolation=none test/add.test.js` with `timeoutMs: 60000`, submit the complete next brief revision and obtain new human approval. Preserve `executionBudgetMs: 900000`, at most one repair, original scope and consumed budget. Do not start execution until separately authorized.

5. A revised brief clears current derived Implementation/snapshot/check/review state, not history or consumed runtime. External manual runs cannot replace host verification evidence. Independent Review remains required; no commit or push is authorized.

## Rollback and limitations

Alpha.5 can read unchanged v3 data, but reverting removes these advisories and role/report improvements. Preserve all newer Session logs and stores; do not restore a global old store over concurrent data. Alpha.4 cannot read v3.

The original default Node test command remains incompatible with Windows ACL piped-grandchild confinement. No ACL, named-pipe policy or sandbox expansion is supplied. Platform advisory absence is not proof of command compatibility. Actual live-model end-to-end acceptance is not established by scripted tests.
