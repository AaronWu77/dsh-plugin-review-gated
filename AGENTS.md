# Agent instructions

This repository owns the standalone Review-Gated plugin; do not change the DSH checkout to hide integration failures. Read [the workflow guide](docs/workflow.md) before changing behavior. Use public DSH APIs, keep PTC presentation, and never implement another agent loop.

Do not commit or push without authorization. Do not invent requirements; return unresolved product choices to the user. Preserve existing work. Require actual approval evidence and a matching staged snapshot before successful handoff. Never label a failed, cancelled, or incomplete review as Passed.

Keep source under strict TypeScript, validate model and durable inputs, and use effect-scoped registrations. Changes to behavior require focused tests; cover cancellation, restore, tool bypass, and real Loader entry paths. Read existing files before edits. Documentation describes verified behavior and keeps English and Chinese counterparts aligned. Report checks actually run and distinguish scripted-model tests from independent live-model review.
