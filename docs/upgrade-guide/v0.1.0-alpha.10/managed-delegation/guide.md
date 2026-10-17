---
kind: upgrade-guide
description: "Managed roles now require the DSH Subagent service and publish standard one-shot discovery records."
---

# Managed role delegation

English | [中文](guide.zh.md)

## Change

Managed role execution requires the DSH Subagent service. The private host-admitted provider owns role setup through the public Agent factory and keeps the approved workspace, preset and permission checks. Each role publishes one-shot identity, parent catalog and lifecycle records. Generic delegation cannot create a managed role by choosing the provider name. Existing workflow journal generations retain their original records; no data rewrite or automatic execution is introduced.

## Migration

1. Preserve the active profile and back up Session and Review-Gated workflow data before owner-controlled replacement. Prepare a candidate package outside the active profile; do not overwrite a running deployment.
2. Ensure the profile composes the matching DSH Subagent service and Session projection prerequisites listed in [bundle composition](../../../bundle.md). Profiles without Subagent refuse role-plugin activation; they do not fall back to unmanaged factory execution.
3. The roles plugin exposes optional configuration `providerName`, defaulting to `review-gated-managed`. Keep the default unless another deployment provider uses that registry name; duplicate names fail at activation.
4. After the owner activates the candidate, use a new isolated task to verify requirement approval, one-shot child navigation, cancellation and snapshot-bound review. Generic provider calls must be refused. A finished child still does not establish Passed or authorize handoff.
5. Retain the previous package and data backup for rollback. New Sessions containing standard Subagent records require a DSH version that understands those records; do not remove the Subagent plugin while relying on its discovery projection.
