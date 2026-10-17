# Upgrade alpha.12 → alpha.13 / 升级

Read the [repository-preflight guide](docs/upgrade-guide/v0.1.0-alpha.12/repository-preflight/guide.md) or [中文指南](docs/upgrade-guide/v0.1.0-alpha.12/repository-preflight/guide.zh.md). New repository-bound permissions and v8 facts require a compatible reader; preserve newer data on rollback.

阅读上述预检升级指南。新仓库绑定许可与 v8 事实要求兼容读取器，回退时保留更新的数据。

## Alpha.11 → alpha.12

Read the [unified-package guide](docs/upgrade-guide/v0.1.0-alpha.11/unified-package/guide.md) or [中文指南](docs/upgrade-guide/v0.1.0-alpha.11/unified-package/guide.zh.md). The main package includes the default-enabled observed-status panel. Split installations must remove the old UI dependency and bundle entry during a maintenance window. The offline planner creates candidates only; installation, lockfile updates, restart and GUI verification remain owner-controlled.

主包包含默认启用的状态观察面板。分包安装必须在维护窗口移除旧 UI 依赖和 bundle 条目。离线脚本只生成候选，安装、锁文件更新、重启与 GUI 验证仍由部署负责人控制。

## Earlier upgrades / 先前升级

- Alpha.10 → alpha.11: [English](docs/upgrade-guide/v0.1.0-alpha.10/managed-delegation/guide.md) | [中文](docs/upgrade-guide/v0.1.0-alpha.10/managed-delegation/guide.zh.md).
- Alpha.9 → alpha.10: [English](docs/upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.md) | [中文](docs/upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.zh.md).
- Alpha.8 → alpha.9: [English](docs/upgrade-guide/v0.1.0-alpha.8/button-confirmation/guide.md) | [中文](docs/upgrade-guide/v0.1.0-alpha.8/button-confirmation/guide.zh.md).
- Alpha.7 → alpha.8: [English](docs/upgrade-guide/v0.1.0-alpha.7/operation-permissions/guide.md) | [中文](docs/upgrade-guide/v0.1.0-alpha.7/operation-permissions/guide.zh.md).
- Alpha.6 → alpha.7: [English](docs/upgrade-guide/v0.1.0-alpha.6/audited-decisions/guide.md) | [中文](docs/upgrade-guide/v0.1.0-alpha.6/audited-decisions/guide.zh.md).
- Alpha.5 → alpha.6: [English](docs/upgrade-guide/v0.1.0-alpha.5/windows-verification-evidence/guide.md) | [中文](docs/upgrade-guide/v0.1.0-alpha.5/windows-verification-evidence/guide.zh.md).
- Alpha.3 → alpha.4: [English](docs/upgrade-guide/v0.1.0-alpha.3/managed-runtime-and-evidence/guide.md) | [中文](docs/upgrade-guide/v0.1.0-alpha.3/managed-runtime-and-evidence/guide.zh.md).
