# Bundle 组合

[English](bundle.md) | 中文

## 概要

opt-in [overlay](../cordis.patch.yml)添加本地受管理 preset，不替换根 PTC 或应用。替换前阅读 [alpha.11 → alpha.12](../UPGRADE.md)。按版本／内容命名的不可变候选资产暂存在活跃 profile 外。安装与启动仍由部署负责人控制；本文不声称已更改当前部署。

## 前置条件

profile 必须提供 agents、Subagent、preset registry、tools、含 Session projection 的 user questions、system prompt、storage-domain 与可用原生约束。已声明 peer 必须匹配[兼容性](compatibility.zh.md)。按钮模式复用现有问题卡与公共回复服务；缺少卡片支持时拒绝确认，不回退为 JSON。受管理工作区仅限本地。

## 集成面板与包入口

主包包含工作流和[状态观察面板](../ui/README.zh.md)，无需安装独立 UI 包。面板默认启用。要隐藏面板，在 profile overlay 中保留以下覆盖；改为 `disabled: false` 可重新启用：

```yaml
- id: review-gated-observed-ui
  disabled: true
```

[bundle overlay](../cordis.patch.yml)拥有唯一的浏览器发现条目：`review-gated-observed-ui` 指向 `./ui/lib/index.js`。[主包清单](../package.json)将 `./client` 导出为 `ui/lib/client.js`，将 `./observed-ui` 导出为 `ui/lib/index.js`；不要为这些导出另外插入条目。`./main-tools` 保留根入口原有的工作流工具。内部核心子路径保留 preset 的包根 `baseUrl`，因此加载受管理 preset 不会发现额外浏览器客户端。不要为显示面板添加主包根入口或 `/client` 主机条目。

关闭面板不会关闭工作流，也不改变审批、存储、工具或权限。替换分包安装、自定义 overlay 审查、服务重启和回滚见[统一包升级指南](upgrade-guide/v0.1.0-alpha.11/unified-package/guide.zh.md)。

## Provider 归属

默认根 Node PTC 行保持启用，Standard／PTC Session 保留部署 provider，包括普通远端路由。不设置全局 Node 运行时覆盖。Main、Implementation、Review 和 Diagnostic 分别隔离 `fs`、`subprocess`、`sandbox` 和 `ptcRuntime`，组合各自本地运行时。宿主验证也拥有独立的本地执行环境。

本地 provider 的归属不依赖 `localFs` 或 `localSubprocess` 等 SSH 别名。本地工作区准入检查在预设隔离前捕获根文件系统，该文件系统权威判定并拒绝远端别名。预设本地的恒等映射不能把根文件系统路由的远端工作区变为获准本地工作区。不支持受管理远端执行。

受管理 Node 运行时选项属于各预设本地的 `native-runtime` 声明。默认 bootstrap 使用 peer 包已构建的进程资产，缺少资产时拒绝启用。部署根运行时设置仍属于普通 PTC，不自动复制到受管理预设。PTC 调用截止时间仍与获批工作流执行预算分别计算。宿主任务 `maxOperationMs` 默认 1800000 ms，`maxWaitMs` 默认 10000 ms，短时观察等待不会取消宿主拥有的工作。

## 预设与权限

只有 Main（`review-gated`）可供根代理选择。注册表在公开列表中隐藏 Implementation、Review 和 Diagnostic，但保留宿主解析。内部角色在发布前要求宿主准入；选择它们的名称或调用任意委派工具都不能授予权限。

Main、Review 和 Diagnostic 使用 read-only 文件策略，Implementation 使用 workspace-write。Implementation shell 工具具有独立的严格角色／沙箱组合。保留部署的 operation approval policy，不强制 full access。用户需求批准是独立工作流决定，即使 operation approval 为 `never` 也不可省略。阅读[安全说明](security.zh.md)。

## 用户任务路径

部署负责人安装／启动后，按任务情况使用既有权威任务或真正的新空白 Main Session。自然描述任务，批准需求卡，再单独授权所请求的执行。Main 自动协调受管理角色。已有 Session 不重置或自动重试；用户无需另建仓库或使用 JSON 模板。Diagnostic 可选。

<a id="selection-lifecycle"></a>
## 选择生命周期

新建或从未受管理的空 Session 可以选择 Main，包括首次轮次前恢复的会话。首次模型请求前完成准入并保存初始 Clarifying 记录。已有受管理或已开始历史的 Session 不能用新记录替代缺失的权威存储。

首次轮次前切换到 Standard／PTC 会释放 Main 授权，恢复准入时捕获的有效文件模式，但后续明确模式选择会阻止恢复。切换离开保留记录及预设历史，切换回来要求同一权威行且不会授予批准。Main 仍被选中时扩大模式会导致受管理请求和工具被拒绝。

Effect 清理及 Agent 结束撤销自身准入，并等待受管理操作完全结束。正常结束可以记录模式恢复，异常丢失则保留最后持久模式作为下次基准。不承诺实时 HMR 启用、浏览器刷新结果或无需重启的迁移。

## 验证限制

本轮使用脚本模型及组件测试。全新角色上下文不能证明使用不同模型或独立真实模型审查质量。不声称实际 SSH 主机端到端测试及所有平台 OS 隔离测试。见[兼容性](compatibility.zh.md)。

## 确认配置

`review-gated-support` 插件拥有 `confirmationMode: buttons | legacy-json`，默认 buttons。Main 提供作用域内的 `ask_user_question`；不要在同一作用域再挂载同名提供方。明确 legacy 模式用于无界面部署。Main 摘要限额仍可配置，完整证据仍可查询。仅 opt-in 插件改变；Main 仍不可使用通用 subagent／Team 工具。见[升级](upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.zh.md)。
