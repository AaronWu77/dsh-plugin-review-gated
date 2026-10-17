---
kind: package-bundle
description: "Add approved implementation and snapshot-bound review to an opt-in DSH profile."
---
# Review-Gated Mode

English | [中文](README.zh.md)

## Summary

`@aaronwu/dsh-review-gated` lets Main clarify requirements, obtain logged-user confirmation, and request distinct one-use execution and handoff permissions. Fresh Implementation and Review Agents operate only within approved work; the host checks the exact snapshot. Ordinary PTC retains its providers. Read [security](docs/security.md) before activation.

## Contents

- [Use the mode](#use-the-mode)
- [Development](#development)
- [Model experience](#model-experience)
- [Known limitations](#known-limitations)

<a id="use-the-mode"></a>
## Use the mode

This opt-in bundle targets the [compatible DSH build](docs/compatibility.md). Read [bundle composition](docs/bundle.md) and the [alpha.12 → alpha.13 guide](UPGRADE.md). Candidate artifacts are staged outside the active profile; installation and service restart remain owner-controlled. This documentation does not claim either operation.

Only `review-gated` (Main) is selectable at the root. `review-gated-implementation`, `review-gated-review`, and `review-gated-diagnostic` are host-only. Select Main on a new or never-managed blank Session. Prior managed history needs its authoritative journal; see [selection lifecycle](docs/bundle.md#selection-lifecycle). Managed workspaces are local only, with the captured root filesystem deciding whether an alias is remote.

Follow [workflow](docs/workflow.md): describe the task naturally, approve the complete brief in its question card, then authorize requested execution in a separate card. Main records the actual replies and automatically coordinates Implementation, host checks and fresh Review. Users never copy JSON or manage child Agents. Execution stops at Ready for Handoff; handoff needs a distinct decision.

Explicit approved scope, acceptance IDs, commands with per-command `timeoutMs`, repair limits and execution budget are required. Passed, Needs Changes and Inconclusive are distinct outcomes. [Execution](docs/execution.md) defines effective command deadlines and whole-execute wall-clock accounting; [security](docs/security.md) defines final-text role parsing. [Recovery](docs/recovery.md) preserves feedback and consumed budget. Handoff never authorizes commit, push or merge. Back up both stores under [persistence](docs/persistence.md).

Repository preflight precedes every operation card. Blocked checks report exact diagnostics without requesting another click; successful cards display and bind the repository and HEAD/tree. See [preflight and budgets](docs/execution.md) and [history compatibility](docs/persistence.md).

<a id="development"></a>
## Development

Development requires Node.js 24+, pnpm 11 and matching built DSH peers. The scripts in [the package manifest](package.json) define source, integration, documentation and archive checks. A declared script is not a passing result. Run checks against the final assembled implementation; this revision records no test count or completed installation.

Artifact-plane tests also typecheck against the declared built `dsh-remote-ssh@0.2.4-aaron.12-sidebar.6` and AHP development peers through their public exports. `DSH_REMOTE_SSH_ARTIFACT_ROOT` selects the runtime for the optional in-memory composition smoke; omitting it skips execution, not those typing dependencies.

```powershell
pnpm test:docs
```

<a id="model-experience"></a>
## Model experience

Main receives stable rules and logged compact state. `rg_status` summarizes state; `rg_brief`, `rg_question` and `rg_status(detail=true)` retrieve complete details without changing authoritative records. `summaryTextChars` defaults to 512 and `summaryItems` to 8. Distinct permissions add explicit user turns and tools. Compact projections omit repeated original details and raw output; changing dynamic state still affects tokens and KV-cache reuse. Roles receive logged inputs and strict result-instance schemas; Review also receives actual host observations. Scripted tests and byte measurements do not establish live-model quality, token savings or response latency.

<a id="known-limitations"></a>
## Known limitations

Default Node test isolation uses piped child processes denied by Windows ACL restricted-token confinement. Status and approval include non-executed compatibility advisories with unknown backend capability; no argv substitution or permission expansion occurs. Any in-process test adaptation needs new explicit approval. Role instructions discourage auxiliary-check substitution, while host evidence remains authoritative; prompts do not guarantee model compliance. See [command compatibility](docs/execution.md).

Windows native partial confinement is accepted with disclosed read, network, process-visibility, hard-link and ACL limitations; workspace-write does not fully protect `.git`. It is not full isolation. Linked repositories and linked source/metadata are unsupported. This round uses scripted-model/component evidence; actual SSH-host end-to-end behavior, independent live-model review quality, and OS isolation across all platforms are unverified. Deployment operation policy is preserved; no global full-access mode is required. See [security](docs/security.md).

The license remains UNLICENSED until the owner chooses one. No default task budget or repair allowance substitutes for human approval.

## Dev Note

None.

## Button confirmation and managed subagents

The support plugin defaults `confirmationMode` to `buttons`; headless deployments may explicitly select `legacy-json`. Cards keep short titles and complete facts in the scrollable first-choice description; choosing alone does not submit. Main refreshes uncommitted legacy proposals without resetting work. Generic delegation remains blocked while managed roles are real child Agents. [Upgrade and rollback](docs/upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.md) explain v7 recovery and preserved v1–v6 history.

## Delegation and optional collaboration

Managed roles dispatch through public `startActivation` with explicit local `lifecycle: 'one-shot'`. The provider consumes one host-prepared admission keyed by the reserved child identity, grants the role and mounts its preset in creation setup, and probes the native sandbox before publication. The DSH manager owns the real child's execution, one-shot descriptor/catalog, cancellation, result and disposal; prompt identity alone never grants admission. Presets use the Host's logged working-directory context, not a persona `cwd` template variable. Their standard child identity and parent catalog support navigation without exposing generic delegation authority. Every review remains fresh and snapshot-bound. The [optional Team board](docs/team-board.md) provides advisory tasks only; it does not provide managed role membership, peer messages or another scheduler. Asynchronous `rg_start` and `rg_wait` results include the observed workflow summary; operation completion remains separate from review and handoff.

## Observed workflow panel

The integrated, default-enabled [observed-status panel](ui/README.md) shows the most recently logged successful workflow result, its requirement and candidate identities, verification, review blockers and recorded budgets. Existing approval cards still own human decisions. The panel cannot execute, approve or certify handoff and does not poll the workflow journal. New `rg_start` and `rg_wait` observations appear only when their actual tool results are logged.
