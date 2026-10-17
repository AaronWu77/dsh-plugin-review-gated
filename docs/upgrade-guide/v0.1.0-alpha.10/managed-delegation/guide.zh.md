---
kind: upgrade-guide
description: "受控角色现在需要 DSH Subagent 服务，并发布标准一次性子会话导航记录。"
---

# 受控角色委派

[English](guide.md) | 中文

## 变更

受控角色执行需要 DSH Subagent 服务。仅接受宿主准入的私有提供方通过公共 Agent 工厂完成角色设置，保留已批准工作目录、preset 与权限检查。每个角色发布一次性身份、父会话目录与生命周期记录。普通委派不能仅凭提供方名称创建受控角色。已有 workflow journal 代际保留原记录；不会重写数据或自动执行。

## 迁移

1. 在用户自行替换前保留活动 profile，并备份 Session 与 Review-Gated 工作流数据。在活动 profile 之外准备候选包；不要覆盖运行中的部署。
2. 确认 profile 加载匹配的 DSH Subagent 服务，以及[组合说明](../../../bundle.zh.md)列出的 Session projection 前提。缺少 Subagent 时，角色插件拒绝激活，不会退回不受管理的工厂执行。
3. roles 插件提供可选配置 `providerName`，默认值为 `review-gated-managed`。除非部署中的其他提供方占用该名称，否则保留默认值；重复名称在激活时失败。
4. 用户激活候选版本后，使用新的隔离任务验证需求批准、一次性子会话导航、取消与快照绑定审查。普通提供方调用必须被拒绝。子会话结束仍不代表 Passed，也不授权交付。
5. 保留旧包与数据备份以便回滚。包含标准 Subagent 记录的新 Session 需要能够识别这些记录的 DSH 版本；依赖子会话导航投影时，不要移除 Subagent 插件。
