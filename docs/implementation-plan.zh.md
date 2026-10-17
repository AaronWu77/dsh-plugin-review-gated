# 实现与验证限制

[English](implementation-plan.md) | 中文

## 当前行为

受管理模式组合已批准需求、顺序 Implementation／检查／Review、快照绑定证据、有界修复、取消及手动恢复。Main、Implementation、Review 和 Diagnostic 各自拥有独立本地 provider，普通根 PTC 不变。受支持行为见 [Bundle](bundle.zh.md)、[执行](execution.zh.md)及[恢复](recovery.zh.md)。本文不是阶段全完成清单。

## 证据限制

可用证据仅为脚本模型测试及组件／原生 fixture。脚本批准和审查答复不证明独立真实模型质量。原生 Windows fixture 可以运行实际 PTC、PowerShell 及特定 ACL 拒绝，但不能证明完整隔离。真实远端端到端行为及独立真实模型质量未验证。最终组合源码的验证由父线程／部署负责人完成，本文不声称通过数量。

## 用户决定与部署

许可证保持 UNLICENSED。任务修复次数及执行预算需用户明确批准。Diagnostic 为有界只读角色，不是验收。alpha.5 安装、启用、发布、提交及推送是独立操作，本文不执行或声称已完成。

Windows 隔离为 partial，不完全保护 `.git`，不隔离读取、网络及进程可见性。不支持 linked worktree 和硬链接。工作区必须没有外部活动。保留 operation policy 及后续明确模式变更，不以全局 full-access 默认值替代。见[安全说明](security.zh.md)。

## 持久化与升级

持久化保留有序历史条目，不重写；缺失当前证据或决定来源不能授权执行／交付。备份 Session 及工作流数据，回滚保留并发／无关数据。见[持久化](persistence.zh.md)及[升级说明](../UPGRADE.md)。
