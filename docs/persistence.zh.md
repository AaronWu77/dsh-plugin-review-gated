# 工作流持久化

[English](persistence.md) | 中文

## 存储与身份

插件使用 DSH 存储域 `aaronwu_review_gated` 与版本 1 的记录外壳。Alpha.13 按顺序读取 1–8，写入 v8，不改已发布的条目、schema 或重放规则。V7 保留 v6 回执字段，并允许在角色已完成的阶段对未结算窗口提问恢复。历史缺失的来源、摘要、超时与许可都不会被推断。

读取验证持久输入、重放条目，并拒绝状态不一致、不支持版本、降低版本的条目尾部、无效顺序或快照不匹配。版本 1 历史按原有阶段语义重放；重放不会补充缺失的源文件摘要、验收证据、命令超时或用户决定。旧需求超时可选仅用于读取历史，不代表允许执行。不得编辑记录 JSON 来提升旧信任。 旧需求可缺少 `executionIntent`，重放时按 implementation 处理；所有新提交的需求必须声明该字段。

新建或从未受管理的空 Main Session 在首次模型请求前持久保存初始 Clarifying 记录。已有受管理／已开始历史或带种子 Session 不能替换缺失的权威行。恢复后的已有行仍是权威，绑定原有 Session 身份；新建相同 ID 的 Session 不是有效替代。

部署选择现有 storage-domain 后端，插件不把工作流状态放进任务仓库。`maxRecords` 和 `maxBytes` 约束每份记录写入，超限会拒绝发布新状态。

## 历史阶段与当前证据

旧 Ready for Handoff 或 Completed 记录可以保留历史阶段。缺少逐项完整验收证据的旧 Passed，或缺少完整 v2 SHA256 源文件覆盖的旧快照，不是当前已验证交付。`rg_report` 将历史交付与 `currentDeliverableVerified` 分开，新的 `rg_handoff` 严格拒绝不完整证据。

历史任务保留阶段、内容、预算与反馈。缺少快照／验收证据需要新检查和 Review；缺少命令超时需要完整修订需求并重新批准。同修订重新确认不重置已消耗时间。当前操作输入必须在 Session 当前代次接收；即使同一活跃代次，按钮模式也拒绝旧许可。消费与窗口开始或交付一起提交；追加失败时均不发布。

## 模型可见记录

默认工具结果及动态上下文为已记录的精简投影；明确详情查询仍能访问完整事实。存储域记录仍是权威，Session 日志投影不是。不引入新的核心必需 Session 事件或目录改动。只有 Session 日志不是完整工作流备份。

## 备份、恢复与回滚

使用部署后端的一致备份流程，同时备份普通 Session 存储和配置的 storage-domain 后端。保留升级前包／profile 和两个存储备份。不得清除缺失／损坏记录或把受管理历史重置为 Clarifying。恢复两个存储，或确认旧进程停止后创建新的空 Session。

Alpha.4 无法读取版本 3 条目，alpha.3 无法读取版本 2 条目。产生版本 3 条目后，直接降级到 alpha.4 不安全。不提供降级兼容或逆向迁移。回滚前先保留所有升级后存储和完整日志，再使用隔离恢复副本，或后端支持的选择性恢复，并配对旧 Session／记录备份。不得覆盖无关或并发修改的 Session、其他存储、完整日志及用户 operation／文件策略选择。见[升级说明](../UPGRADE.md)。

重启后的 Running 任务、活跃角色／检查阶段及未解决执行窗口不会自动继续。`rg_recover` 要求真实用户确认旧进程完全停止，为旧宿主任务记录 Interrupted，再单独核对未解决窗口并保守扣除未知的全部剩余预算，之后新获批修订才能运行。修订批准保留已消耗时间。阅读[恢复](recovery.zh.md)；批准等待和关闭从不编造成功证据。

## 版本 8 仓库观察

V8 修改[工作流 schema](../src/workflow/types.ts)中的插件私有 `WorkflowRecord` 和 `WorkflowState`，不修改核心 Session 格式或其持久化清单。storage-domain 和 journal 外壳仍为版本 1；本文不声称完成核心 Session acknowledgement。V8 增加 `repository-preflight-recorded` 观察、累计 `preflightMs` 及[预检 schema](../src/workflow/preflight.ts)定义的操作请求 preflight 证明。观察记录请求、范围绑定、限额、状态、耗时、问题、可选真实回复观察及规范仓库／HEAD／tree，不授予许可。V1–v7 事件读取器保持冻结，旧未绑定请求和授权不能许可当前执行。缺少证明需要重新请求操作并由用户决定。Alpha.12 不能读取 v8；保留更新的存储并使用兼容读取器，不用旧备份覆盖新工作。见[升级](upgrade-guide/v0.1.0-alpha.12/repository-preflight/guide.zh.md)。

## 版本 7 恢复记录

Alpha.9 不能读取 v7 条目。回滚时保留升级后日志／存储，使用匹配的隔离升级前备份或受支持的选择性恢复，不覆盖无关或并发 Session。存储域／外壳保持 1，v1–v6 保持冻结，不提供逆向迁移。旧待确认问题通过新条目替代，不重写历史。native 崩溃修复的当前卡片必须取得新的准确公共 UI 回复。见[升级与回滚](upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.zh.md)。
