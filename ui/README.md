---
description: "Inspect logged Review-Gated status without controlling workflow execution."
kind: "package-reference"
---

# Review-Gated observed-status panel

English | [中文](README.zh.md)

## Summary

Inspect the last successful logged Review-Gated summary from a conversation header. The default-enabled panel shows requirements, approval revision, candidate identities, verification counts, review blockers, pause reasons and finite budgets in English or Chinese. It never approves, executes, retries, cancels or hands off a workflow. Logged observations can be stale; the workflow journal remains authoritative.

## Table of Contents

- [Use the panel](#use-the-panel)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-the-panel"></a>
## Use the panel

The panel is included in the [main bundle](../README.md), enabled by default, and is not installed separately. The panel has no configuration fields; set `disabled` on the profile overlay's `review-gated-observed-ui` row as described in [bundle composition](../docs/bundle.md). Disabling it does not change the workflow or existing approval cards.

The host requires `sessionProjections`; the browser requires Session Controller, Conversation header slots, UI Workspace navigation, UI Session, UI Renderer, Locale and the ordinary theme/primitives platform. Missing required services leave the Cordis fiber pending.

Only the `./ui/lib/index.js` row in the [main overlay](../cordis.patch.yml) discovers the complete client. `@aaronwu/dsh-review-gated/observed-ui` provides only the host projection, not a complete UI loading entry. Do not add a `/client` host row or retain the old UI bundle. For split installations, follow the [upgrade guide](../docs/upgrade-guide/v0.1.0-alpha.11/unified-package/guide.md).

### Candidate checks

The [main manifest](../package.json) owns builds and checks. `build` combines core and UI builds; `typecheck:ui`, `test:ui` and `check:ui` provide focused checks. Use an isolated checkout and audited dependencies; a declared script does not establish a passing result or deployment.

The [UI build script](scripts/build.mjs) writes this directory's `lib` and `dist`. It emits Host/Client declarations, Host ESM and one lazy CJS browser factory named by the main manifest. The factory registers under the main package name. This directory is an implementation subtree of the main package, with no independent manifest or bundle overlay.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The pure [projection](src/projection.ts) correlates existing committed tool starts/results. It ignores inherited fork prefixes and reads only one complete text block containing valid summary JSON. `rg_start` and `rg_wait` use their logged `workflow` field; an operation ending does not imply workflow completion. Failed, malformed, orphaned or spilled results leave the last observation unchanged. There are no new Session events, journal reads, timers, Remote methods or workflow service imports.

The [panel](src/client/ReviewAction.tsx) consumes standard projection hooks and typed [locale dictionaries](src/client/locales.ts). Button, Modal and StateDot come from UI Primitives; colors, typography and scrollbars use semantic theme tokens. Child navigation rechecks the current direct-parent catalog and exact retained parent generation. Only discovered one-shot children can open; an observed run id alone never becomes a navigation address.

No runtime invariant companion is published: the UI subtree owns a pure logged-event fold and display contributions, not independent workflow authority. Registration and unload behavior are asserted by Loader and renderer tests.

</details>

<a id="model-experience"></a>
## Model Experience

None. The panel registers no tools, prompts or model-facing state.

#### KV Cache effect

None. The panel issues no provider requests and changes no conversation content.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Observations are not live authority. Budgets remain fixed at the observation time, approval is not completion, and Passed is only the recorded review outcome. The panel cannot certify handoff eligibility.
- Compact results can omit or truncate detail; total counts remain visible and missing detail never means clearance. Candidate and verification identities are shown separately.
- The child section lists all discovered one-shot children, not asserted Review-Gated role identities. Continuable and unknown-mode children are excluded. An undetected run stays text-only.
- Offline tests do not verify a live server, full-profile installation, browser viewport fitting, theme contrast, desktop chrome or product/design review. Those checks remain with the parent integration owner before activation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Non-authoritative working context</summary>

None.

</details>
