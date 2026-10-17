---
kind: package-bundle
description: "为可选 DSH profile 添加获批实现和与快照绑定的审查。"
---
# Review-Gated Mode

[English](README.md) | 中文

## 概要

`@aaronwu/dsh-review-gated` 让 Main 澄清需求、取得日志用户确认，再分别请求一次性执行和交付许可。全新 Implementation 与 Review Agent 仅处理获准工作；宿主检查准确快照。普通 PTC 保留其 provider。启用前阅读[安全说明](docs/security.zh.md)。

## 目录

- [使用模式](#use-the-mode)
- [开发](#development)
- [模型体验](#model-experience)
- [已知限制](#known-limitations)

<a id="use-the-mode"></a>
## 使用模式

这是面向[兼容 DSH 构建](docs/compatibility.zh.md)的 opt-in bundle。请阅读[bundle 组合](docs/bundle.zh.md)与 [alpha.12 → alpha.13 指南](UPGRADE.md)。候选资产暂存在活跃 profile 外；安装和服务重启仍由部署负责人控制。本文不声称已执行这些操作。

根代理只能选择 `review-gated`（Main）。`review-gated-implementation`、`review-gated-review` 和 `review-gated-diagnostic` 仅由宿主创建。在新建或从未受管理的空 Session 中选择 Main。已有受管理历史必须具有权威记录，见[选择生命周期](docs/bundle.zh.md#selection-lifecycle)。受管理工作区仅支持本地，由捕获的根文件系统判定别名是否为远端。

遵循[工作流](docs/workflow.zh.md)：用自然语言描述任务，在问题卡中批准完整需求，再在另一张卡中授权所请求的执行。Main 记录真实回复，自动协调 Implementation、宿主检查和全新 Review。用户无需复制 JSON 或管理子 Agent。执行停在 Ready for Handoff；交付需要独立决定。

必须明确批准范围、验收 ID、含逐条 `timeoutMs` 的命令、修复次数及执行预算。Passed、Needs Changes 和 Inconclusive 是不同结果。[执行](docs/execution.zh.md)定义命令有效截止时间及整个 execute 的墙钟核算；[安全说明](docs/security.zh.md)定义角色最终文本解析。[恢复](docs/recovery.zh.md)保留反馈和已消耗预算。交付从不授权提交、推送或合并。按[持久化](docs/persistence.zh.md)同时备份两个存储。

每张操作卡前都运行仓库预检。阻塞检查报告准确诊断，不要求再次点击；成功卡片展示并绑定仓库和 HEAD/tree。见[预检及预算](docs/execution.zh.md)与[历史兼容](docs/persistence.zh.md)。

<a id="development"></a>
## 开发

开发需要 Node.js 24+、pnpm 11 及匹配且已构建的 DSH peer。[包清单](package.json)中的脚本定义源码、集成、文档和归档检查。存在检查脚本不代表检查通过。必须针对最终组合的实现运行检查，本次文档不记录测试数量或已完成安装。

资产面测试还通过公开导出使用声明的已构建 `dsh-remote-ssh@0.2.4-aaron.12-sidebar.6` 和 AHP 开发依赖进行类型检查。`DSH_REMOTE_SSH_ARTIFACT_ROOT` 为可选内存组合 smoke 选择运行资产；未提供此变量只跳过执行，不免除这些类型依赖。

```powershell
pnpm test:docs
```

<a id="model-experience"></a>
## 模型体验

Main 接收稳定规则及已记录的精简状态。`rg_status` 返回摘要，`rg_brief`、`rg_question` 和 `rg_status(detail=true)` 获取完整详情，不改变权威记录。`summaryTextChars` 默认 512，`summaryItems` 默认 8。独立许可增加明确用户轮次和工具。精简投影不重复原始详情及原始输出；动态状态变化仍影响 token 与 KV-cache 复用。角色接收日志输入及严格结果实例 schema；Review 还接收宿主实际观察。脚本测试及字节测量不证明真实模型质量、token 节省或响应延迟。

<a id="known-limitations"></a>
## 已知限制

默认 Node 测试隔离使用带管道子进程，Windows ACL restricted-token 隔离拒绝此行为。状态和批准包含不执行探针、后端能力未知的兼容性提示，不替换 argv、不扩大权限。任何进程内测试适配都需要新的明确批准。角色指令禁止辅助检查替代，但以宿主证据为准，提示词不保证模型服从。见[命令兼容性](docs/execution.zh.md)。

接受 Windows 原生 partial 隔离，并披露读取、网络、进程可见性、硬链接及 ACL 局限，workspace-write 不完全保护 `.git`。这不是完整隔离。不支持链接仓库和链接源文件／元数据。本轮仅使用脚本模型／组件证据，实际 SSH 主机端到端行为、独立真实模型审查质量和所有平台 OS 隔离均未验证。保留部署的 operation policy，不要求全局 full-access 模式。见[安全说明](docs/security.zh.md)。

所有者选择许可证前保持 UNLICENSED。默认任务预算或修复次数不能替代用户批准。

## 开发笔记

无。

## 按钮确认与受管理 subagent

support 插件默认 `confirmationMode: buttons`；无界面部署可明确选择 `legacy-json`。卡片保留短标题，完整事实放在可滚动的第一个选项说明中，仅选择不会提交。Main 刷新未提交的旧提案，不重置工作。通用委派仍被阻止，受管理角色则是真实子 Agent。[升级与回滚](docs/upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.zh.md)说明 v7 恢复及保留的 v1–v6 历史。

## 委派与可选协作

受控角色通过公开 `startActivation` 及显式本地 `lifecycle: 'one-shot'` 执行。provider 按预留子会话身份消费一次宿主准入，在创建 setup 中授予角色并挂载 preset，在发布前探测原生 sandbox。DSH manager 管理真实子级执行、one-shot descriptor/catalog、取消、结果和销毁，单凭 prompt 身份不授予准入。preset 使用 Host 日志中的工作目录上下文，不依赖 persona 的 `cwd` 模板变量。标准子会话身份与父会话目录支持导航，但不开放普通委派权限。每次审查仍使用全新上下文并绑定快照。[可选 Team 任务板](docs/team-board.zh.md)仅提供辅助任务，不提供受控角色成员身份、成员消息或另一套调度器。异步 `rg_start` 与 `rg_wait` 结果包含已观察的工作流摘要；操作完成仍与审查和交付分开。

## 工作流观察面板

集成且默认启用的[状态观察面板](ui/README.zh.md)显示最近成功记录的工作流结果、需求和候选标识、验证、审查阻断问题及记录时的预算。用户决定仍由已有批准卡处理。面板不能执行、批准或证明交付资格，也不轮询工作流 journal。只有实际工具结果写入日志后，新的 `rg_start` 和 `rg_wait` 观察才会出现。
