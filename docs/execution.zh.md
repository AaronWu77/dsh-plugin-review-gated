# 执行与快照验证

[English](execution.md) | 中文

## Main 操作

以 `rg_start(operation=approval, revision=提交的修订号)` 和有界 `rg_wait` 打开需求决定。Main 通过 `ask_user_question` 展示准确的 `uiConfirmation.questions`，等待真实卡片回复，再用 `rg_confirm_question` 记录。请求执行须先取得独立操作卡回复、`rg_confirm_operation` 与一次性许可，才可 `rg_start(operation=execution)`。用户不复制 JSON 或管理子角色。Diagnostic 可选且只读，不是运行时探针；`rg_cancel` 排空自有活动后取消整个工作流。

`rg_wait` 接受零以立即观察，宿主通过 `maxWaitMs` 限制每次等待。状态仍为 Running 时再次观察，不把等待超时当作执行失败。宿主任务 `maxOperationMs` 默认 1800000 ms，`maxWaitMs` 默认 10000 ms。获批执行预算及各命令／角色截止时间仍适用。旧 `rg_approve` 和 `rg_execute` 保留为阻塞式兼容调用，不会让外层 PTC 调用不限时，也不会使这些调用脱离取消。

执行要求活跃获准 Main、当前决定回执、明确命令超时和独立当前一次性执行许可。工具及直接服务在新执行任务／窗口／角色启动前拒绝缺失许可。来源、修订、阶段、候选、剩余运行时间及最新日志用户输入绑定请求。新输入使旧回执失效。消费许可与窗口启动是一个持久事实。成功停在 Ready for Handoff；独立交付许可及仓库重新验证之后才 Completed。任何操作均不 commit、push 或 merge。

## 仓库预检

宿主在发布执行或交付请求前运行有界只读预检，记录 running、passed 或 blocked 观察及独立累计 preflightMs。阻塞观察包含问题、没有基线，也没有可用的 Authorize 卡；观察到的用户回复只是审计证据，不是授权。应查看 operationEvidence.preflight 和 nextStep，而不是反复打开失败卡片。

通过的请求绑定卡片所展示的规范仓库、HEAD 与候选 tree。确认及执行再次核对该标识；即使换成另一个干净 HEAD，也会拒绝执行。旧的未绑定请求需要新请求和真实决定，不能复用回执。后来的普通用户输入仍使旧回执失效。

执行配置定义普通 Git timeoutMs（10000 ms）、integrityTimeoutMs（120000 ms）及 preflightTimeoutMs（180000 ms）。完整对象校验使用独立完整性限额，同时受总预检截止时间限制。窗口开始前的预检独立计时，不启动角色或验收命令；窗口开始后的工作仍计入执行墙钟。同一调用内去除重复对象检查，但不同阶段仍重新验证。

Git 失败保留有界 stdout、stderr、exitCode、signal、timedOut、aborted、elapsedMs 及带类型的 kind。超时、取消、输出超限、启动失败与非零退出保持区分。配置拒绝只报告键和来源，不报告值。任何诊断都不允许自动修改 Git 配置、清理对象或绕过完整性检查。

## 基线、范围与字节完整性

首次运行要求干净的常规独立 Git 仓库，并记录不可变仓库／基线绑定。HEAD 改变、Git 操作正在进行、隐藏索引标志、链接元数据／源文件、不支持的仓库配置及超出范围的修改都会拒绝暂存／交付。保留而不丢弃既有无关工作。`Implemented` 候选已有脏文件但尚无暂存快照时，不能通过新的操作预检，仍需要干净且受支持的基线。反复请求卡片不会暂存或挽救此候选。必须保留文件，不得自动丢弃／reset 或重启 Implementation 来绕过限制。需求修订使当前批准和审查失效。

范围验证独立遍历实际工作区文件，包括被忽略的源文件。`assume-unchanged` 和 `skip-worktree` 不能隐藏修改。获批 `generatedPaths` 只接受仓库相对的可丢弃产物字面路径，不接受 glob 或仓库根目录，只允许新增生成产物，即使位于这些路径下，已跟踪源文件也必须检查。被忽略的源文件不能暗中当作已审内容。见 [Git 限制](security.zh.md)。

新快照使用 `integrityVersion: 2` 和完整 SHA256 `fileDigests` 列表，覆盖全部源文件，而不只改动文件。工作区和导出必须匹配 Git blob 原始字节，包括 LF／CRLF、文件类型及支持的可执行标志。插件不自动规范化换行。不匹配会暂停／拒绝候选，用户必须明确处理 checkout 策略，不覆盖无关工作。

Git 使用宿主解析且位于仓库外的可信绝对路径可执行文件，以及`fsck --full --strict --no-reflogs` 对象 hash 校验，包括非根子树。[执行配置](../src/workflow/execution.ts)提供 `gitExecutable`、`timeoutMs`、`maxOutputBytes`、`maxFileBytes`、`maxTreeEntries`、`maxTreeBytes`、`maxMetadataEntries` 和 `snapshotParent`。默认 tree 总字节上限为 64 MiB，元数据条目上限为 100000。可按合法仓库规模调整部署限额，但不能跳过完整性检查。

## 基于不可变源文件的检查

Implementation 后宿主暂存并准确导出 tree，不含 Git 元数据。获批命令在一份导出运行；Review 接收单独干净导出、需求、diff、实际检查证据，以及完成源完整性／允许范围检查后的日志宿主观察。存在摘要不等于观察事实。缺失必需证据仍保持未验证；Review 不运行进程、不枚举原工作树，也不测试获批需求之外的其他环境。 需求中的 `executionIntent: verification-only` 会跳过 Implementation，把未变化的干净基线捕获为零改动快照，运行获批检查，并允许全新 Review，同时不写入工作区或 index。

命令使用准确获批的 executable／argv、宿主可执行文件解析、清理后的环境和 DSH 受管理子进程。不隐式插入 shell，shell 及其全部参数必须明确获批。依赖 Git 的检查不能依赖导出中的元数据。原生 workspace-write 为验证导出提供报告的 full／partial 权限强制，不允许回退到无隔离执行。

每条检查采用 min(获批 timeoutMs, 部署 commandTimeoutMs, 剩余执行预算)，记录 effectiveTimeoutMs。`rg_status(detail=true).effectiveLimits` 给出完整部署限额；默认摘要给出剩余预算和命令数。非零退出、信号、超时、证据超限／截断、runner 失败或源变化都阻止 Review。接受证据前排空受管理进程，不推断回退或替代命令。

## Windows 命令兼容性

`rg_status(detail=true).effectiveLimits.verification.compatibility` 和批准详情给出未执行的提示，不改变 argv。Implementation 在日志输入中收到提示。未知后端能力不是检查失败，也不要求可选 Diagnostic。只读 Diagnostic 不能证明运行时命令支持。

默认 `node --test` 创建带管道的子进程，Windows ACL restricted-token 隔离拒绝此行为。明确获批的 `node --test --test-isolation=none test/add.test.js` 避免该测试隔离路径；改变验收命令需要完整修订简报及新的真实用户批准。不扩大隔离权限、不静默替换 argv，也不声称写者自报的辅助检查满足原验收标准。

报告区分宿主任务完成、Implementation 完成、获批检查及与快照匹配的独立审查。程序输出仅是所报告的诊断，不是权威失败分类。宿主任务 Completed 时，工作流仍可能 Paused，检查失败且没有已记录审查。

## 验收证据与修复

每次 Review 用结构化 status／evidence 恰好覆盖每个获批验收 ID 一次。`checked` 列出已验证任务事实，`unchecked` 列出仍未验证的必需验收或范围项。Passed 要求每项均有证据且 Passed、没有必需 unchecked 或阻塞发现，并匹配需求／快照／成功检查。真正缺少必需证据应为 Inconclusive；普通范围外限制写入 reason，不得隐藏必需不确定性。

证据可以是 `kind: source`，包含真实导出的 `file`、存在的 `line` 和解释；或 `kind: verification`，包含获批命令从零开始的 `checkIndex` 及对实际结果的解释。源引用必须真实存在于已审导出，任意路径、不存在的行和编造的检查不能支持 Passed。二进制源文件需要检查证据，而不是文本行引用。

允许 Implementation 的许可仅在获批限制内允许 Needs Changes 修复，并重新暂存／检查／全新 Review。既有 Implemented／Staged 候选的 verify-review 许可从不启动 Implementation 或修复：Needs Changes 结束该尝试，需新的实现许可。Inconclusive 和需求不确定性暂停。JSON／schema／语义拒绝不是 Needs Changes，不自动修复或重试 Review。 新需求必须声明 `executionIntent`；`verification-only` 由 controller、execution service 和 direct Role Runner 强制，不能启动 Implementation 或修复。

执行墙钟窗口覆盖整个 execute 尝试：Git 及基线工作、快照／导出、角色 turn、检查和清理，不含用户批准等待。失败／取消尝试保留已消耗时间，包括截止后清理；预算耗尽后不能成功交付。`executionWallMs` 累计已结束窗口，未解决的 `executionWindow` 阻止再次 execute 或交付。预算检查至少保留 `max(executionMs, executionWallMs)`，保留旧已消耗时间而不重复计数。修订批准从不重置任一已消耗计数。关闭会等待所拥有活动完全结束，重启不会自动继续活跃阶段。[恢复](recovery.zh.md)定义未知窗口核算；[持久化](persistence.zh.md)定义有序混合 v1／v2／v3／v4／v5／v6／v7／v8 历史；alpha.9 不能读取新写入的 v7。

## 被拒绝 Review 的证据

当前语义验证拒绝矛盾结论、不完整验收和无效引用。当前有界摘要使用 v8，标明 semantic-validation、问题路径及原角色日志；已提交证据不是有效 Review。原始输出保持不变，没有许可不运行新 Review。已发布重放仍依版本规则。见[升级](upgrade-guide/v0.1.0-alpha.9/scrollable-card-recovery/guide.zh.md)。
