# Workflow persistence

English | [中文](persistence.zh.md)

## Storage and identity

The plugin uses DSH storage domain `aaronwu_review_gated` and journal envelope version 1. Alpha.13 reads ordered versions 1–8 and writes v8 without rewriting released records, schemas or replay rules. V7 keeps v6 receipt fields and permits recovery questions for unresolved windows in settled-role phases. Historical missing sources, digests, timeouts and permissions are never inferred.

Parsing validates durable input, replays its records and rejects state disagreement, unsupported versions, lower-version record tails, invalid order or mismatched snapshots. Version 1 history replays with its original phase semantics; replay does not add absent source digests, acceptance evidence, command timeouts or human decisions. Optional legacy brief timeouts exist only for reading history, not permission to execute. Never edit journal JSON to promote old trust. Legacy briefs may omit `executionIntent` and resolve to implementation for replay only; every new submitted brief must declare it.

A new or never-managed blank Main Session persists its initial Clarifying journal before the first model request. Prior managed/started history or a seeded Session cannot replace a missing authoritative row. Existing restored rows remain authoritative and bind the original Session identity; a new Session with the same ID is not a valid replacement.

The deployment selects the existing storage-domain backend; the plugin does not put workflow state in the task repository. `maxRecords` and `maxBytes` bound each journal write. Overflow refuses publication of new state.

## Historical phase versus current evidence

Old Ready for Handoff or Completed records can retain their historical phase. An old Passed without complete per-acceptance evidence or an old snapshot without full v2 SHA256 source coverage is not a currently verified deliverable. `rg_report` keeps historical handoff separate from `currentDeliverableVerified`; new `rg_handoff` strictly rejects incomplete evidence.

Historical tasks retain phase, contents, budgets and feedback. Missing snapshot/acceptance evidence needs new checks and Review; missing command timeouts need a complete newly approved revision. Same-revision reconfirmation never resets consumed time. Live operation inputs must be admitted in the current Session generation; button mode also refuses legacy grants even within a live generation. Consumption commits with window start or handoff; append failure publishes neither.

## Model-visible records

Default tool results and dynamic context are logged compact projections; explicit detail queries retain access to full facts. The domain journal remains authoritative, not the Session-log projection. No new required core Session event or catalog change is introduced. Session logs alone are not a complete workflow backup.

## Backup, recovery and rollback

Back up ordinary Session storage and the configured storage-domain backend together, using the deployment backend’s consistent backup procedure. Keep the pre-upgrade package/profile and both-store backup. Do not clear missing/corrupt journals or reset managed history to Clarifying. Restore both stores or start a new empty Session after confirming old processes stopped.

Alpha.4 cannot read version 3 records; alpha.3 cannot read version 2 records. Once version 3 records exist, direct downgrade to alpha.4 is unsafe. No downgrade compatibility or reverse migration is supplied. For rollback, preserve all post-upgrade stores and complete logs first, then use an isolated recovery copy or backend-supported selective restore with matching old Session/journal backups. Never overwrite unrelated or concurrently changed Sessions, other stores, complete logs, or user operation/file-policy choices. See [upgrade instructions](../UPGRADE.md).

Restarted Running tasks, active role/check phases and unresolved execution windows are not automatically resumed. `rg_recover` requires actual human confirmation of old process quiescence, records Interrupted for the old host task, then separately reconciles the unresolved window and conservatively consumes its unknown remaining budget before a new approved revision can run. Revised approval retains consumed runtime. Read [recovery](recovery.md); approval waits and shutdown never manufacture successful evidence.

## Version 8 repository observations

V8 changes the plugin-private `WorkflowRecord` and `WorkflowState` in [the workflow schemas](../src/workflow/types.ts), not the core Session format or its persistence inventory. The storage-domain and journal envelope remain version 1; no core Session acknowledgement is claimed. V8 adds `repository-preflight-recorded` observations, cumulative `preflightMs` and operation-request preflight proofs defined in [the preflight schemas](../src/workflow/preflight.ts). Observations record their request, scope binding, limits, status, duration, issues, optional observed real reply and canonical repository/HEAD/tree. They grant nothing. V1–v7 event readers remain frozen; legacy unbound pending requests and grants cannot authorize current execution. Missing proof requires a new operation request and user decision. Alpha.12 cannot read v8; preserve newer stores and use a compatible reader, never overwrite newer work with an old backup. See [upgrade](upgrade-guide/v0.1.0-alpha.12/repository-preflight/guide.md).

## Version 7 recovery records

Alpha.9 cannot read v7 records. Preserve post-upgrade logs/stores and use isolated matching pre-upgrade backups or supported selective restore for rollback; never overwrite unrelated or concurrent Sessions. Domain/envelope remain 1, v1–v6 remain frozen, and no reverse migration is supplied. Legacy pending questions are superseded by new records, never rewritten. Native crash-repaired current cards require a fresh exact public UI reply. See [upgrade and rollback](upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.md).
