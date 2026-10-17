---
kind: upgrade-guide
description: "The separate Review-Gated UI package is replaced by the main package's integrated panel."
---
# Upgrade alpha.11 → alpha.12: unified Review-Gated package

English | [中文](guide.zh.md)

## Change

`@aaronwu/dsh-review-gated@0.1.0-alpha.12` includes the observed-status panel previously installed as `@aaronwu/dsh-review-gated-ui`. Split installations must remove the old dependency and bundle entry. The panel is enabled by default; the existing `review-gated-observed-ui` id supports `disabled` overrides. Approval, storage, tools and permissions are unchanged. See [composition and entry points](../../../bundle.md).

## Migration

1. Stop active tasks and wait for managed operations to finish. Schedule a maintenance window and stop the existing service before changing its installation. Preserve the current package specs, lockfile and overlays; back up both stores under [persistence](../../../persistence.md). Do not copy credentials into candidate directories.
2. From the unified package root, inspect a candidate using [the offline planner](../../../../scripts/profile-migration.mjs):

   ```text
   node scripts/profile-migration.mjs --profile <directory-or-package.json> --target-spec <verified-package-spec>
   ```

   The default is a dry-run JSON report. `--patch <file>` selects one overlay instead of the adjacent `cordis.patch.yml`. Optional `--output <new-file>` writes only a candidate package manifest outside the input profile; its parent must exist and the file must not exist. The planner does not install dependencies, update locks, copy credentials, rewrite overlays or restart services. The target spec is not resolved or verified.
3. Resolve every `manual-required` report before proceeding; the planner refuses output for these plans. Custom legacy UI references require manual review. A top-level `{id: review-gated-observed-ui, disabled: <boolean>}` override stays untouched. Inspect other overlay layers yourself, including hand-written root-package and direct `file://.../dist/...` entries that can duplicate client discovery. Migrate internal core entries to explicit main-package subpaths; `/main-tools` preserves the root tool entry. Keep only the bundle's `./ui/lib/index.js` discovery row; `/observed-ui` is host-only.
4. Review and apply the candidate during the maintenance window: update the main dependency spec, remove `@aaronwu/dsh-review-gated-ui` from dependency sections and `dsh.profile.bundles`, and preserve unrelated configuration. Update the profile lockfile and installed dependencies with the deployment's package manager. To keep the panel hidden, retain the `disabled: true` override from [composition](../../../bundle.md).
5. Restart the original service and refresh its existing GUI URL. The deployment owner must verify one panel, no legacy UI client, unchanged approval cards, and disable/re-enable behavior without duplicate registration. Inspect retained workflow state; do not reset or automatically retry tasks. Offline checks do not establish deployment success.
6. If verification fails, stop tasks and the service again. Restore the prior code/package specs, lockfile and configuration, including the old UI dependency/bundle if previously present, then restart and verify. Rollback does not restore old storage over newer Session or workflow data; preserve both current stores.
