# 审查约束开发流程

[English](workflow.md) | 中文

## 概要

使用这个需明确启用的流程，在实现前确认需求，并在交付前对每个暂存版本进行独立审查。Main Agent（主智能体）严格按顺序协调 Implementation Agent（实现智能体）与 Review Agent（审查智能体）。可选受管理插件部署后检查准入、批准、顺序及证据。PTC 呈现工具，原生权限强制仍具有[安全说明](security.zh.md)中的限制。本文不声称模式已安装。

## 目录

- [适用范围与前提](#scope-and-prerequisites)
- [1. 确认需求](#1-confirm-requirements)
- [2. 实现与暂存](#2-implement-and-stage)
- [3. 独立审查](#3-review-independently)
- [4. 修复或暂停](#4-repair-or-pause)
- [5. 核对与交付](#5-verify-and-hand-off)
- [安装后复测提示](#after-install-retest)
- [进一步阅读](#further-exploration)
- [开发笔记](#dev-note)

<a id="scope-and-prerequisites"></a>

## 适用范围与前提

用户明确要求审查约束开发时采用这个流程，不自动将无关调研、文档或普通编码任务转换为该流程。Main Agent 必须阅读本文，并将相关要求写入每个委派任务。

| 角色 | 职责 | 限制 |
|---|---|---|
| Main Agent | 调研、澄清需求、调度任务、核对交付条件并汇报结果。 | 不代替用户批准需求，不以自审代替独立审查。 |
| Implementation Agent | 实现已批准需求、补充测试、验证修改并修复审查问题。 | 不扩大范围，不在未经授权时发布修改。 |
| Review Agent | 检查已批准需求、暂存修改、相关代码和验证证据。 | 不修改产品代码或暂存区，不将实现报告视为正确性证据。 |

使用常规独立仓库，只允许一个写入者，顺序进行实现与审查；不支持 linked worktree。开始前检查已跟踪、未跟踪、暂存及被忽略文件，保留无关工作。首次运行要求干净基线，且没有并发外部仓库／配置写入方。独立 clone 不是安全沙箱。

仅通过已部署 Main 模式运行宿主创建的角色，不能直接选择内部 Implementation／Review／Diagnostic。Main 使用 read-only，Implementation 使用 workspace-write；扩大模式会拒绝受管理操作。隔离不可用时暂停，不暗中替代角色。

实现前与用户约定有限的修复次数、时间或费用预算，以及阻止交付的问题和检查项。必要限制未指定时应提问，不自行假设。不同模型不是必需条件；独立审查必须使用包含原始需求的新上下文。

<a id="1-confirm-requirements"></a>

## 1. 确认需求

Main 调查并通过 `rg_submit_brief` 提交完整的版本化需求，以 `rg_start(operation=approval, revision)` 打开批准，再用有界 `rg_wait(id, waitMs)` 观察。默认按钮模式下，Main 读取 `rg_status.uiConfirmation.questions`，原样传给 `ask_user_question` 后结束回合。用户在现有问题卡中选择选项并提交。真实 UI 回复唤醒 Main，由它通过 `rg_confirm_question` 记录已发现的序号。仅需求批准停在 Approved；operation approval 为 `never` 不会绕过该决定。 标题保持简短；提交前在可滚动的第一个选项说明中阅读完整事实。若出现 `uiConfirmation.refreshDecision`，Main 重开旧提案，不要求用户复制旧 JSON 模板。

需求说明包含目标、非目标、允许修改的范围、约束、编号验收标准、验证计划及重要未决问题。`submittedBriefSchema` 要求每个 `verificationCommands` 条目明确包含 `timeoutMs`，值为不超过 2147483647 的正整数。持久读取器仅为读取旧历史允许省略；execute 拒绝此类旧需求。执行前修订并重新取得用户批准，不追溯补造批准。委派实现前，必须解决影响验收的问题，或取得用户对明确假设的批准。泛泛表示认可，不等于批准未明确的需求说明。 新提交还必须声明 `executionIntent: implementation` 或 `verification-only`；后者跳过 Implementation，捕获零改动快照，并禁止写入工作区或 index。

实现、审查或修复过程中出现新的不确定需求时，必须先交给 Main Agent，再向用户提出。暂停受影响的工作及后续阶段，不为继续执行而编造需求、扩大范围、添加可选功能或自行选择产品行为。记录用户答复；验收标准、范围或约束改变时，修订需求说明并重新取得批准，同时依据修订后的说明重新核对已有实现与审查证据。

**核对：**有标识的需求说明已获用户批准，重要问题已有获批答案，并且 Implementation Agent 未在批准前启动。

<a id="2-implement-and-stage"></a>

## 2. 实现与暂存

用户请求执行时，Main 准备 `rg_request_operation(kind=execution)`，打开对应的完整卡片，等待独立的 Authorize／Decline 回复。`rg_confirm_operation` 记录真实输入；只有当前一次性许可允许 `rg_start(operation=execution)`。用户不必输入 ID、消息序号或 JSON。明确设置 `confirmationMode: legacy-json` 可保留原无界面流程；按钮模式从不静默回退。

依据验收标准补充测试，运行相关检查，报告实际命令、结果和未验证事项。不删除测试、削弱断言或禁用检查来掩盖失败。

宿主在 Implementation 结束后只暂存获批候选，记录基础版本及 tree ID，不创建提交。检查运行于准确 tree 的无 Git 元数据导出，Review 接收另一份干净导出、diff 及实际检查证据。未跟踪及被忽略源文件不能暗中漏掉，`generatedPaths` 只豁免额外产物。

开始审查前停止 Implementation Agent 的写入。核对测试使用的产品文件与暂存快照一致，且没有漏掉必要文件。验证过程若产生修改，必须重新暂存，并在审查前重新验证。

**核对：**暂存差异仅包含已批准任务，快照有标识，验证证据对应相同内容，且没有仍在运行的写入者。

<a id="3-review-independently"></a>

## 3. 独立审查

获准执行开始后，宿主通过已准入的一次性 DSH Subagent 提供方调度 Implementation 和 Review；Main 不要求用户启动或管理它们。提供方在公共 Agent 工厂的创建阶段应用角色准入、准确 cwd 和 preset，再记录一次性子会话身份及父会话导航。Review 获得全新上下文、获批需求、原始验收条件、基线、快照和宿主证据。通用 `subagent` 与 Agent Teams 工具仍被阻止，因为任意子任务缺少受管理角色准入、固定 preset、快照及严格结果验证。宿主验证不是第四个 Agent。

对照基础版本审查暂存快照，再检查相关调用方与测试。工作目录与暂存区不一致时，仅读取工作目录不足以完成审查。检查需求覆盖、修改范围、正确性、安全、兼容性及相关失败路径，不要求超出批准范围的可选重构。

每个问题包含严重程度、准确文件位置、触发条件、影响、证据或复现步骤，以及最小修复建议。区分已确认缺陷与未解决的怀疑。返回以下结果之一，并标明审查所针对的需求说明和快照。 每个验收 ID 必须恰好覆盖一次，包含完整 `status` 及 `evidence`。Passed 要求全部标准为 Passed，证据引用已审导出的真实文件／存在的行，或实际获批检查的 `checkIndex`；自由文本 `checked` 不足以验收。

| 结果 | 含义 | 下一步 |
|---|---|---|
| Passed | 已完成约定范围的审查，必要检查通过，没有未解决的阻止交付问题。 | Main Agent 核对交付条件。 |
| Needs Changes | 有证据支持的问题需要在已批准任务范围内修复。 | 将问题返回 Implementation Agent。 |
| Inconclusive | 缺少信息、无法验证、执行失败、取消、超时或无效输出，导致无法形成结论。 | 暂停并报告原因，不视为 Passed。 |

Review Agent 不修改产品文件或暂存区。验证只能在已约定的位置产生可丢弃输出，且不能改变待审查输入。工具名称和提示词本身不提供只读强制约束；权限必须覆盖 Shell 等执行路径。Passed 不证明不存在任何缺陷。

**核对：**报告标明已批准需求说明与暂存快照，包含有效结果，没有以失败或自审替代独立审查。

<a id="4-repair-or-pause"></a>

## 4. 修复或暂停

Main Agent 先依据证据核实问题，再请求修复，不盲目接受审查者的每项建议。对有争议的阻止交付问题，应通过证据或用户澄清解决；记录决定前，该问题仍视为未解决。

结果为 Needs Changes 时，Implementation Agent 修复已接受的问题，重新运行相关检查，并暂存修订后的修改。记录新快照，在交付前重复独立审查。待审查内容或已批准需求一旦改变，之前的批准就不再适用于新的交付候选版本。不并行执行修复与审查。 Needs Changes 问题经过暂停／重试仍保留并传给下一次 Implementation，不能丢失修复反馈。

遇到 Inconclusive、未解决的需求不确定性、限制耗尽或取消时，停止后续执行，由 Main Agent 汇报最近快照、未解决问题，以及恢复所需的决定。不发布修改、不丢弃工作、不暗中增加限制，也不将任务标记为成功。

恢复时，先核对需求说明、工作目录、暂存区、快照和活动任务，再启动新的 agent。恢复后的对话摘要，不是当前内容已通过审查的证据。 重启不自动继续 Running，先通过 `rg_recover` 取得旧进程完全停止的真实确认，核对恢复的 Running 宿主任务并记录 Interrupted。随后单独恢复执行；即使没有活跃角色，未解决的 `executionWindow` 也要求用户确认进程完全停止。未知剩余耗时保守扣除全部剩余获批预算，修订批准从不重置已消耗时间。见[恢复](recovery.zh.md)。

**核对：**每个修复后的候选版本都已重新验证和审查，或者任务已明确暂停，工作得到保留且暂停原因具体。

<a id="5-verify-and-hand-off"></a>

## 5. 核对与交付

Main Agent 核对当前暂存快照和已批准需求说明与 Passed 报告一致，必要检查针对相同内容通过，且没有未解决的阻止交付问题或需求疑问。文件、暂存区或需求发生变化时，回到相应阶段。

执行停在 Ready for Handoff。只有用户请求的交付才获得独立问题卡与新一次性许可。执行结束后，`rg_handoff` 在 Completed 前复核批准、验收证据以及全部已跟踪源文件／原始字节完整性。交付不是 Git commit，也不授权 commit 或 push。

返回包含以下部分的简要报告，不编造期间问题，也不隐瞒缺失的验证。

1. **完成情况：**交付了什么，如何满足验收标准。
2. **本次更改：**受影响模块、行为变化及兼容性影响。
3. **期间问题：**实际实现或审查问题，以及处理结果。
4. **验证与审查：**命令与结果、审查及修复次数、最终需求说明与快照标识，以及 Git 暂存、提交和推送状态。
5. **剩余限制：**已知风险、未解决事项及未验证行为。
6. **后续选项：**可选优化方向、预期收益及优先级；它们只是建议，不是新获授权的工作。

**核对：**用户能确定交付版本、验证证据及限制，并知道哪些发布操作尚未发生。

<a id="after-install-retest"></a>

## 安装后复测提示

这些可选提示描述部署负责人完成安装后的观察，不是必须新增的现场测试，也不证明已安装。保留既有权威 Session、记录、仓库与获批命令。不要仅为使用按钮而再建仓库或重置任务。

需求批准与执行仍是不同决定。已完成的批准宿主任务可以让工作流停在 Approved，而不启动任何子角色。变更范围、命令或预算必须提交完整修订需求并重新批准。

1. **检查状态：**“读取 `rg_status`，报告 finite-integer-add 的准确需求修订、工作流阶段及宿主操作状态。保留所有工作。若恢复的宿主任务／窗口未解决，停止并单独取得恢复所需用户确认，不推断进程已退出，不执行。”
2. **只读状态先行：**“仅调用 rg_status 报告阶段、需求修订、宿主任务及未解决窗口。不要 Diagnostic、恢复、取消或执行；新任务若不是 Clarifying 就停止。既有任务只报告历史事实和缺口。”
3. **只批准需求：**“根据我的请求准备完整、准确的需求，并展示需求卡。我的批准后停止，不授权或启动执行。”

```text
Implement only the approved task. Use the approval and execution cards; automatically coordinate the managed roles. Do not hand off, commit or push.
```

4. **请求执行：**“准备独立执行卡，展示准确范围、命令和剩余限额。等待我的按钮选择。Authorize 后自动协调角色，停在 Ready for Handoff。不得替换命令或重置限额。”
5. **请求交付：**“仅对 Ready for Handoff 的当前 Passed 快照展示独立交付卡。我的授权后交付并报告实际证据与缺口。不得 commit、push 或重启服务。”

已有任务保留修订号和已消耗预算。新空白任务从 revision 1 开始。有效期限见[执行](execution.zh.md)，中断尝试见[恢复](recovery.zh.md)；任何示例超时都不构成隐式授权。

<a id="further-exploration"></a>

## 进一步阅读

- [兼容性](compatibility.zh.md)：部署目标及未验证事项。
- [项目说明](../README.zh.md)：模式及限制。

<a id="dev-note"></a>

## 开发笔记

<details>
<summary>非权威的实现方向</summary>

四个受管理预设分别组合本地独立 fs／subprocess／sandbox／ptcRuntime，普通根 PTC 不变。不依赖 SSH 别名。Diagnostic 只产生有界只读事实，不能代替 Review 或验收。

Windows 隔离为 partial，不完全保护 `.git`，不隔离读取／网络／进程可见性。脚本模型及组件／原生 fixture 不证明真实远端端到端或独立真实模型质量。本文不声称已安装、重启或最终测试通过。

</details>

## 决定卡与语义拒绝

需求／恢复回执从不授权执行。真实卡片回复绑定准确日志调用、显示事实、当前候选与最新用户输入。仅声称来源、按钮模式中的普通 JSON、过期输入和旧操作许可都不能授权执行或交付。必需 unchecked 证据禁止 Passed；语义拒绝从不提升旧输出或重置预算。见[升级](upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.zh.md)。
