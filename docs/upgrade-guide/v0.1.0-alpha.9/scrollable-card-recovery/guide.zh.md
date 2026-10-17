---
kind: upgrade-guide
description: "确认事实移入可滚动卡片正文；alpha.9 不能读取 v7 恢复记录。"
---
# 可滚动卡片与中断窗口恢复：alpha.9 → alpha.10

[English](guide.md) | 中文

## 变更

卡片保留短标题，将完整需求、范围、命令及限额放入现有 GUI 可滚动的第一个选项说明。仅选择选项不会提交。Main 原样传入当前卡片参数；旧呈现不能授权当前决定。

按钮模式下，Main 将尚未提交的旧 JSON／服务提案替换为新的可读问题，并要求新的真实回复。已提交决定、原始条目、任务内容及已消耗限额保持不变。新需求引用旧提示文本，不会被视为旧确认通道。

新记录使用 v7。只有 v7 恢复允许对角色已到达 Implemented、Needs Changes 或 Ready for Handoff 的未结算窗口打开静止确认问题。确认保守扣除未知剩余预算，停在 Paused，不启动角色或检查。V1–v6 的 schema 和重放保持冻结。Alpha.9 不能读取 v7，不提供逆向迁移。见[持久化](../../../persistence.zh.md)与[恢复](../../../recovery.zh.md)。

## 迁移

1. 保留匹配的 Session 日志、配置的 `aaronwu_review_gated` 存储域、包和 profile 备份。保留升级后数据及无关 Session。不得编辑存储 JSON 来清除执行窗口或编造许可。
2. 新的版本／内容命名资产暂存在活跃 profile 外并核验 SHA256。安装／重启仍由部署负责人控制，不覆盖旧资产或自动重试既有任务。
3. 在权威任务中读取状态。恢复的 Running 宿主任务须先通过 `rg_recover` 取得真实宿主静止回复。旧需求提案由 Main 根据 `uiConfirmation.refreshDecision`，以 `rg_start(operation=approval)` 重开当前修订；恢复提案使用 `rg_recover`。无需新仓库、手工 JSON 或重置预算。
4. 若 `uiConfirmation.replaceCard` 为 true，即使历史保留旧卡，Main 仍打开当前 `uiConfirmation.questions`。阅读可滚动范围，选择后提交。执行与交付仍要求独立、准确的新一次性授权。
5. 宿主核对后，未结算窗口还须独立静止确认。核实状态变为 Paused、窗口已清除、未知剩余耗时已扣除。后续执行需要完整修订需求并重新批准。回滚时使用匹配的隔离升级前备份或受支持的选择性恢复；不得以 alpha.9 读取 v7 或覆盖并发 Session。
