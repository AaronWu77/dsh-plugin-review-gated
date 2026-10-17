# 恢复与 Main 报告

[English](recovery.md) | 中文

## 概要

可以停止拥有的任务、在暂停后请用户决定如何继续，并取得六项报告；不会把中断尝试或过期交付当作成功。恢复不会自动执行工作。

## 目录

- [暂停的任务](#paused-tasks)
- [宿主中断](#interrupted-hosts)
- [取消](#cancellation)
- [报告含义](#report-meaning)

<a id="paused-tasks"></a>

## 暂停的任务

Main 通过 `rg_recover` 打开重试、修订或保持暂停的选择。按钮模式下展示准确的恢复卡，并记录真实日志回复；无来源服务回调从不授权选择。未提供的选项、自定义文本、过期输入与已取消的决定都不能授权重试。限额耗尽、过期快照、Implementation 澄清和 Inconclusive Review 阻止重试。修订范围需要下一版完整需求与新批准。

获准重试回到不活跃阶段，从不启动工作，也不续用已消费操作许可。Needs Changes 反馈及累计时间保留。Main 请求并确认新的一次性许可后才执行；Implemented／Staged 仅允许 verify-review。恢复重新检查基线／当前性，从不变基或丢弃无关工作。

<a id="interrupted-hosts"></a>

## 宿主中断

重启不恢复 Running 宿主任务。`rg_recover` 打开宿主静止确认卡；只有真实用户确认才记录 Interrupted，不推断结果。Leave unresolved 保留 Running。独立恢复核对执行阶段／窗口，并拒绝仍注册的旧 Agent 或其他工作流的仓库所有权。单独核对宿主不会清除窗口或授权执行。终结工作流允许仅核对宿主，不改变终结阶段。

活跃 Implementing、Verifying 或 Reviewing 记录及未解决窗口不能证明旧进程退出。窗口也可能留在 Implemented、Needs Changes 或 Ready for Handoff；后继版本支持这三个阶段恢复，不重新启动旧工作。真实用户静止确认保守扣除未知的剩余获批预算，停在 Paused，不编造成功证据。后续执行需要修订需求并批准累计预算；两个耗时计数及修复轮次均不重置。旧活跃角色恢复也扣除未知耗时。普通 Session 日志不代替权威记录。见[持久化](persistence.zh.md)。

<a id="cancellation"></a>

## 取消

`rg_cancel` 排空 Main 所拥有宿主任务／执行，记录终态 Cancelled，保留工作树和索引。它取消整个工作流，不是单个 Diagnostic；重复发消息不能重新打开。新任务必须真正新建独立 Session。未解决的恢复活动先需日志停止确认。取消解释来自 Main，不是用户授权；关闭会排空自身工作。

<a id="report-meaning"></a>

## 报告含义

`rg_report` 返回完成情况、改动、问题、验证／审查、局限及后续选项。原生调用将其呈现为六项 Markdown 章节；PTC 接收相同的结构化 JSON 值。Main 必须使用这些事实，不能编造更强证据。记录的 Passed 意味着全新 Review Agent 返回了与快照绑定的该结果；它不能证明用了不同模型或真实外部 provider 审查。脚本测试仍只是脚本验证证据。

历史交付完成与当前快照验证是独立字段。报告核对 HEAD、索引、完整已跟踪原始字节及实际工作区文件（包括忽略源文件；额外获准产物除外）。检查失败或缺少 v2 摘要／完整验收证据会使 `currentDeliverableVerified` 为 false。旧 Completed 保留历史事实，不改变终态，也不能授权新交付。

## 开发说明

宿主突然丢失后要求用户确认旧进程完全停止；检查不阻止外部并发写入。平台限制见[安全说明](security.zh.md)，执行顺序见[执行](execution.zh.md)，部署见 [Bundle](bundle.zh.md)。脚本模型及组件／原生 fixture 不证明真实远端端到端或独立真实模型质量。

## 决定与操作回执

需求／恢复卡与执行／交付卡记录不同的真实回复。需求批准之外仍必须取得当前一次性操作许可。按钮模式拒绝手动 JSON 和旧操作许可；明确的 `legacy-json` 是部署选择，不是回退。缺失历史来源仍为未知，计数器不重置。语义拒绝需要明确授权的全新 Review。见[升级](upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.zh.md)。
