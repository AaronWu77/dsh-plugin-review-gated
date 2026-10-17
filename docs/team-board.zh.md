# 可选辅助 Team 任务板

[English](team-board.md) | 中文

## 概要

可选入口 `@aaronwu/dsh-review-gated/team-board` 仅向准确准入的 Main Agent 提供 `rg_team_board`。它复用 Agent Teams 服务保存辅助任务、版本比较更新、依赖与说明。任务板的完成不等于需求批准、审查 Passed、执行权限或交付。适配器不创建队友、不发送成员消息，也不把受控角色名称分配为 Team 任务负责人。

## 组合

用户安装匹配的可选 peer 后，在宿主根加载 `@deepseek-ai/dsh-experimental-agent-team`，并在 Main 受控 preset 中加载 `@aaronwu/dsh-review-gated/team-board`。根服务需要持久 Session 存储。可选的 `@deepseek-ai/dsh-experimental-client-ui-agent-team` 提供已有只读 Team 面板。此集成不要应用普通 Team profile 或加载普通 Team 工具：它们引入另一条委派路径与共享目录协作策略。默认 overlay 不启用这些新增项。

明确启用后缺少 Team 服务会拒绝任务板激活。Review、Implementation 和 Diagnostic 不能通过复制工具获得任务板权限。受控角色仍是具有准确角色准入和工作目录的独立一次性 Subagent，不是 Team 成员。完整成员协作需要额外的 Teams 生命周期及隔离目录支持，适配器不声称提供此能力。

## 操作与限制

使用 `list` 及可选的从零开始 `cursor`、`limit`，`get` 及 `taskId`，`create` 及 `subject`、`description`，或 `update` 及 `taskId`、`expectedRevision` 和以下动作之一：`claim`、`release`、`edit`、`set_dependencies`、`complete`、`reopen`。更新前读取当前任务；版本冲突不覆盖较新工作。依赖与写入范围仍是辅助信息，不启动或锁定角色。

配置 `pageSize` 默认为 20，范围 1–100；`maxOutputBytes` 默认为 16384，范围 1024–1048576。限制覆盖完整 UTF-8 响应。创建或更新响应过大时，仍返回已提交的任务 id、版本与状态，并包含 `detailsOmitted: true`；不要因省略详情而重试修改。过大的读取失败，需要缩小分页或提高配置的字节限制。宿主 Team 限制另行生效。

## 恢复与验证

任务复用已有持久 Team 事件类型。移除适配器不删除任务，也不恢复受控执行。显示任务板时，Session 读取器必须保留能识别 Team 事件的版本与所属投影。工作流决定和证据仍在原 journal 中。Loader 回归覆盖显式准入、关闭或缺失依赖、版本冲突、有限修改回执、角色拒绝与 effect 清理，不代表独立真实模型质量或完整成员协作。
