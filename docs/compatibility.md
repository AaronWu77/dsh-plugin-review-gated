# Compatibility

English | [中文](compatibility.zh.md)

This compatibility candidate targets the fixed DSH `0.2.1-alpha.2` commit `d743267388641bc76f17c45ce8b4c231aed1d32c` with the local-one-shot Host activation extension, Node 24+ and pnpm 11. Stock alpha2 does not support managed roles: its package version alone does not establish API compatibility. The role provider requires `supportsLocalOneShot` at load and fails explicitly when the extension is absent. The Host package version remains unchanged; the local extension must accompany this plugin. Exact peer declarations in [the package manifest](../package.json) are intentional; published older APIs are not substitutes. No cross-version compatibility or npm availability of unpublished prerelease peers is claimed.

Local links belong in ignored pnpm configuration, not developer drive paths in source or packed metadata. Managed roles require the matching Subagent service; optional advisory Team tasks require the matching experimental Agent Teams peer only when explicitly composed. ESM/NodeNext consumer checks require the matching built peers. A declared check is not a passing result for the final assembled revision. See [bundle prerequisites](bundle.md) for provider requirements.

Managed presets use local isolated providers, without a global root runtime replacement or SSH alias dependency. A captured remote root filesystem refuses managed workspaces, even if preset-local mappings look local. Ordinary remote PTC routing remains unchanged. Regular standalone Git repositories may use `extensions.worktreeConfig`, but dangerous keys in either repository config file remain unsupported. Linked worktrees and nested repositories remain unsupported; see [Git restrictions](security.md).

Windows native enforcement is partial. Available evidence uses scripted models and component/native fixtures; real remote end-to-end behavior and independent live-model quality are unverified. This revision claims no completed installation, activation, restart or final test success. See [verification limits](implementation-plan.md).
