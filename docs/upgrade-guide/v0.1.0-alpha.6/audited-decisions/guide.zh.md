---
kind: upgrade-guide
description: "升级到可审计决定和严格结果实例。"
---
# 升级 alpha.6 → alpha.7

[English](guide.md) | 中文

## 概要

Alpha.7 提问前记录批准、工作流恢复及中断宿主任务问题。服务回答保持来源未证实。只有由 `rg_confirm_question` 核对的准确新日志用户消息才提交决定；安装不启动执行，不改范围、快照或累计耗时。

## 目录

- [确认](#confirmation)
- [既有任务和数据](#history)
- [角色结果](#roles)
- [部署和回滚](#deployment)

<a id="confirmation"></a>
## 确认

提问操作返回后读取 `rg_status.decisionEvidence.pending`。批准任务 Completed 表示提问结束，不表示需求已批准。记录原始问题、详情、选项、服务选择、状态及来源局限。权限批准策略 `never` 管理沙箱升级，不管理业务问答批准。

在原 Main 对话发送准确的 `confirmationTemplates` JSON 作为新用户消息，不加围栏或说明。Main 用 `availableUserConfirmation.userMessageSeq` 调用 `rg_confirm_question`。答案和来源声明不是工具参数。其他会话、非用户消息、已被后续输入替代的消息、过期绑定、不可用选项及重复确认被拒绝。异步预检后、尝试提交决定前重新核对最新日志用户输入。适用时核对仓库基线；批准／重试要求快照仍为当前，放弃或修订过期内容不要求此条件。宿主任务停止确认不要求 Git 仓库。

示例（占位符必须替换为当前待确认问题 ID）：

```json
{"reviewGatedAnswer":{"questionId":"<current question ID>","selected":"Approve"}}
```

`session-user-message` 标识日志用户输入通道，不代表独立自然人认证。仅服务回答来源为 `user-questions-service-unattributed`；历史缺失来源保持未知。工具及直接服务 execution／handoff 入口均要求当前批准和适用的恢复回执。

<a id="history"></a>
## 既有任务和数据

历史 ID 保持 `historical-unattributed`，不重建缺失问题选项或回答来源。同一非活动 revision 可重新请求批准以确认不变需求。历史 Staged 可重新提问、确认不变恢复，不修订需求。各步骤保留暂存内容、检查、修复轮次及累计预算，均不启动 Implementation、检查、Review 或 handoff。执行需单独授权。

新记录使用版本 4；读取器接受有序混合版本 1／2／3／4，不重写历史条目。状态仍由日志重放；存储域及外壳仍为版本 1。安装本身不写工作流记录。Alpha.6 无法读取新增版本 4，不提供逆向迁移。

显式重复请求可替换中断或过期问题，不推断答案；当前已返回问题复用，不再次提问。恢复的 Running 宿主任务需先单独取得日志中进程停止确认，再处理未解决执行窗口。未知剩余耗时被扣除，不重置。修订保留累计耗时。

<a id="roles"></a>
## 角色结果

Implementation、Review、Diagnostic 收到已记录的结果实例说明。展示 schema 仅省略根 `$schema` 元数据；真实严格 schema 不变。未知键、元数据、错误类型、无效 JSON、围栏或缺失证据被拒绝，不剥离、不自动重试。

报告区分 JSON 解析和 schema 校验，含角色／运行／会话及有界问题路径。被拒绝的 `Passed` 不成为有效 Review。宿主要求检查与写者辅助运行保持不同权威。脚本模型 Loader 测试不是独立真实模型验收。

<a id="deployment"></a>
## 部署和回滚

包和人工安装资产在活跃 profile 外暂存。用户自行停服、启动；安装器不代做。停服后一致备份包／profile、普通 Session 日志及权威工作流存储。替换前核对归档摘要、准确 alpha.6 来源引用、受保护配置及共享 provider 链接。

重启后仅检查状态和报告。核对当前 revision、暂存快照、旧检查、累计预算及修复轮次保留，来源缺口明确。不自动恢复或执行。仅在用户明确请求后确认不变批准／恢复，再单独授权全新宿主检查及 Review。

回滚前保留所有升级后存储及完整日志。使用隔离匹配的升级前 Session／记录副本或后端选择性恢复，不替换共享全局存储，不以 alpha.6 打开版本 4。包安装器不改工作流存储，不提供数据降级。
