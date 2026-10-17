# Bundle composition

English | [中文](bundle.zh.md)

## Summary

The opt-in [overlay](../cordis.patch.yml) adds local managed presets without replacing root PTC or the application. Read [alpha.11 → alpha.12](../UPGRADE.md) before replacement. Stage immutable version/content-named candidate artifacts outside the active profile. Installation and start remain owner-controlled; no current deployment change is claimed.

## Prerequisites

The profile must supply agents, Subagent, preset registry, tools, user questions with Session projections, system prompt, storage-domain and usable native confinement. Declared peers must match [compatibility](compatibility.md). Button mode uses the shipped question cards and public reply service; missing card support refuses confirmation rather than falling back to JSON. Managed workspaces are local only.

## Integrated panel and package entries

The main package contains the workflow and [observed-status panel](../ui/README.md); there is no separate UI package to install. The panel is enabled by default. To hide it, keep this override in the profile overlay; set `disabled: false` to enable it again:

```yaml
- id: review-gated-observed-ui
  disabled: true
```

The [bundle overlay](../cordis.patch.yml) owns the only browser-discovery row: `review-gated-observed-ui` names `./ui/lib/index.js`. The [main manifest](../package.json) exposes `./client` as `ui/lib/client.js` and `./observed-ui` as `ui/lib/index.js`; neither export is another row to insert. `./main-tools` retains the root entry's workflow tools. Internal core subpaths retain the preset's package-root `baseUrl`, so loading managed presets does not discover additional browser clients. Do not add a root-package or `/client` host row to expose the panel.

Disabling the panel does not disable the workflow or change approvals, storage, tools or permissions. Replacement of a split installation, custom overlay review, service restart and rollback belong to the [unified-package upgrade guide](upgrade-guide/v0.1.0-alpha.11/unified-package/guide.md).

## Provider ownership

The stock root Node PTC row stays enabled, and Standard/PTC Sessions retain their deployment providers, including any ordinary remote routing. There is no global Node runtime override. Main, Implementation, Review and Diagnostic each isolate `fs`, `subprocess`, `sandbox` and `ptcRuntime` and compose their own local runtime. Host verification also owns a separate local execution environment.

Local provider ownership does not depend on SSH aliases such as `localFs` or `localSubprocess`. The local-workspace admission check captures the root filesystem before preset isolation; that filesystem is authoritative for rejecting remote aliases. A preset-local identity mapping cannot turn a root-routed remote workspace into an admitted local workspace. Remote managed execution is unsupported.

Managed Node runtime options belong to each preset-local `native-runtime` declaration. The default bootstrap uses the peer package’s built process asset; missing assets refuse activation. Deployment root-runtime settings remain with ordinary PTC and are not copied automatically to managed presets. PTC call deadlines remain separate from approved workflow execution budgets. Host task `maxOperationMs` defaults to 1800000 ms and `maxWaitMs` to 10000 ms; short observation waits cannot cancel host-owned work.

## Presets and permissions

Only Main (`review-gated`) is available for root selection. The registry omits Implementation, Review and Diagnostic from its public roster while keeping host resolution available. Internal roles require host admission before publication; choosing their names or invoking arbitrary delegation tools cannot grant authority.

Main, Review and Diagnostic use read-only file policy; Implementation uses workspace-write. Implementation shell tools have their own strict role/sandbox group. Deployment operation approval policy is preserved, not forced to full access. Human requirements approval is a separate workflow decision and remains mandatory with operation approval `never`. Read [security](security.md).

## User task path

After owner-controlled installation/start, use an existing authoritative task or a genuinely new blank Main Session as appropriate. Describe the task naturally, approve its requirements card, and separately authorize requested execution. Main automatically coordinates the managed roles. Existing Sessions are not reset or automatically retried; users need neither another repository nor JSON templates. Diagnostic is optional.

<a id="selection-lifecycle"></a>
## Selection lifecycle

A new or never-managed blank Session can select Main, including after restoration before its first turn. Admission and the initial Clarifying journal precede the first model request. A Session with prior managed or started history cannot substitute a new journal for missing authoritative storage.

Before the first turn, switching to Standard/PTC releases the Main grant and restores the effective file mode captured at admission, unless a later explicit mode selection superseded it. Switch-away retains journal and preset history; switch-back requires the same authoritative row and grants no approval. A widened mode while Main remains selected rejects managed requests and tools.

Effect disposal and Agent teardown revoke their own admission and drain managed operations. Graceful teardown can record mode restoration; abrupt loss retains the last persisted mode as the next baseline. No live HMR activation, browser refresh result or restart-free migration is promised.

## Validation limits

This round uses scripted-model and component tests. Fresh role contexts do not establish different models or independent live-model review quality. Actual SSH-host end-to-end testing and all-platform OS confinement testing are not claimed. See [compatibility](compatibility.md).

## Confirmation configuration

The `review-gated-support` plugin owns `confirmationMode: buttons | legacy-json`, defaulting to buttons. Main provides its scoped `ask_user_question`; do not mount another same-scope provider of that name. Explicit legacy mode is for headless deployments. Main summary limits remain configurable and full evidence remains queryable. Only this opt-in plugin changes; generic subagent/Team tools remain unavailable to Main. See [upgrade](upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.md).
