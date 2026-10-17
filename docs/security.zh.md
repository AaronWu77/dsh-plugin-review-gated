# 角色执行与文件权限

[English](security.md) | 中文

## 准入与本地权威

Main 必须是实际存活的根 Agent。Implementation、Review 和 Diagnostic 在发布前要求宿主准入。模型工具、继承预设或复用 Session ID 都不能授予角色。释放时撤销准入。Implementation 与 Review 接收全新对话上下文，并在独占的规范化仓库上顺序执行。

各受管理预设拥有隔离的本地文件系统、subprocess、sandbox 和 PTC 服务。普通根 PTC 保留默认 provider。本地工作区 guard 通过捕获根文件系统的闭包，在受管理模型／工具执行前拒绝远端别名；预设本地文件系统不对此决定具有权威性。不依赖 SSH 别名约定。见 [Bundle](bundle.zh.md)。

## 进程权限强制

Main、Review 和 Diagnostic 使用 read-only 文件策略，Implementation 使用 workspace-write。Guard 拒绝未分配工具、过期身份、改变的角色策略及提权参数。受管理启动必须使用原生封装 argv，并保留 provider 报告的 full／partial 权限强制。隔离不可用和 runner 失败时从不回退到无隔离执行。部署的 operation policy 保持独立，不要求全局 full-access 设置。

Windows ACL 权限强制是 partial。受限令牌约束部分写入／删除，但这些文件策略不隔离读取、网络访问和进程可见性。硬链接可能使不同路径指向同一对象，AppContainer 拥有的 ACL 可能使文件无法读取。仓库准入拒绝检测到的硬链接、symlink 及 junction，但这不保证阻止所有并发原始 API／原生命令绕过。无法接受这些风险时，应使用另行验证的更强环境。

workspace-write 不完全保护 `.git`，也不是针对获准路径的内核级强制。提示词和工具 guard 补充原生限制，但不能证明秘密隔离，也无法阻止全部任意 Git／原生操作。工作区必须没有外部活动；检查不会锁住外部仓库／配置写入方。清理完全结束宿主管理的 Agent／进程，不涵盖所有任意分离的原生后代进程。

## Git 与源文件完整性

Git 使用宿主解析的可信绝对路径可执行文件，且必须位于任务仓库外。拒绝仓库内 binary。Git 操作禁用 hooks、fsmonitor、pager、替换对象及惰性获取，并拒绝仓库控制的 helper／filter／diff 程序、配置 include、worktree 重定向和 fsck 跳过项。完整严格 fsck 检查 Git 对象 hash，包括非根子树，仅有 SHA256 文件清单不能认证 Git 对象存储。

宿主独立遍历实际工作区，包括被忽略的源文件，并拒绝 assume-unchanged／skip-worktree 标志。获批 `generatedPaths` 只豁免新增产物，不豁免已跟踪源文件。不支持链接元数据、symlink、junction、硬链接、对象 alternate、linked worktree 和子模块。任务需要常规独立仓库，而不是 linked worktree。常规独立仓库可以启用 `extensions.worktreeConfig`；宿主检查 `.git/config` 和 `.git/config.worktree`，包括尚未生效的工作树配置文件，仍拒绝危险键。

新快照以 SHA256 绑定全部源文件，并比较包括 LF／CRLF 在内的原始字节。插件不自动规范化 checkout 内容。资源限制约束 Git 输出、文件／tree 字节、工作区条目、元数据条目及命令时间，见[执行](execution.zh.md)。这些检查要求可信 provider，且没有并发外部写入方。

## 诊断、结果与取消

Diagnostic 仅由宿主创建，为只读且有界。结果包含结构化事实及限制；它不批准需求、不改变源文件、不产生 Passed 审查，也不验收交付。它只获得准入能力，不允许任意工具分派。

`RoleRunner` 接受独立 `reasoning` 元数据，但仅拼接最终 assistant 输出的 `text` 块，再严格解析 JSON 和角色 schema。推理不属于 JSON 结果。仍拒绝 tool-call、image、file 及所有其他类型的块。缺失／空白文本、超过配置 UTF-8 `maxOutputBytes` 的文本、无效 JSON／schema、中止或未完成的整个 Agent turn 都不能产生成功。截断、取消和预算耗尽不能产生成功。Passed 要求绑定实际源文件／检查的完整验收证据，见[执行](execution.zh.md)。

宿主拥有的任务不受单次 PTC 观察调用中止或短等待超时影响，但受 Main／预设释放或明确 `rg_cancel` 影响。取消和关闭在释放资源前等待所拥有角色／检查完全结束。重启不会自动继续持久 Running 任务；[恢复](recovery.zh.md)要求真实用户确认进程完全停止。

本轮仅提供脚本模型／组件证据。实际 SSH 主机端到端行为、独立真实模型审查质量和所有平台 OS 隔离均未验证。特定 Windows ACL 拒绝不能证明完整隔离。

## 真实决定输入

默认按钮模式复用现有问题卡与公共继续回复服务。回执必须匹配所属 Main Session、准确日志工具参数与继续结果、所展示范围／选项、最新且新接收的用户回复、当前工作流绑定及一次性消费。普通 JSON、assistant 文本与无来源回调不能授权按钮模式决定；按钮模式不能消费旧许可。native 未知结果崩溃修复不授予许可，只有新的准确 UI 回复才能确认继续卡片。回执标识用户输入通道，不独立认证自然人身份。
