---
kind: upgrade-guide
description: "默认按钮确认取代手动 JSON；alpha.8 不能读取 v6 工作流回执。"
---
# 按钮确认：alpha.8 → alpha.9

[English](guide.md) | 中文

## 变更

Alpha.9 的 support 插件默认 `confirmationMode: buttons`。用户通过现有问题卡批准需求并单独授权执行；Main 记录真实回复，自动协调真实的 Implementation 和 Review 子 Agent。通用 subagent／Team 工具仍被阻止。Main 为只读，Implementation 仍有 workspace-write 权限。宿主验证不是另一名 Agent。

新记录使用 v6，接受已记录的 `session-user-question-reply` 来源。已发布 v1–v5 的校验器和条目保持不变。Alpha.8 不能读取 v6，不提供逆向迁移。旧许可不能授权新按钮模式执行／交付，上一 Session 代次的操作输入也不构成当前许可。见[持久化](../../../persistence.zh.md)。

## 迁移

1. 备份匹配的 Session 日志和配置的 `aaronwu_review_gated` 存储域、包与 profile。保留既有任务内容、修订号、已消耗限额及无关数据。
2. 按版本／内容命名的新候选包暂存在活跃 profile 外，并核验 SHA256。不要复用或覆盖旧资产标识。安装／重启仍由部署负责人控制；本文不声称已执行，也不要求再建仓库。
3. 使用更新后的 Main preset：workflow 插件提供作用域内 `ask_user_question`，因此移除同一作用域的额外通用提供方。`review-gated-support` 配置的 `confirmationMode` 默认 `buttons`；仅无界面部署明确选择 `legacy-json`。缺少卡片支持时拒绝确认，不静默回退。
4. 对已有权威任务先检查状态，并先核对中断进程。展示当前需求／恢复卡，记录真实回复；仅对用户请求的后续工作再申请独立的新操作卡。仅批准需求不启动子角色。核实执行授权前状态到达 Approved；执行停在 Ready for Handoff，不 commit 或 push。
5. 如需回滚，先保留升级后存储与完整日志。使用匹配的隔离升级前 Session／记录备份，或受支持的选择性恢复。不得以 alpha.8 打开 v6、删除受管理历史、覆盖无关 Session 或自动重试任务。
