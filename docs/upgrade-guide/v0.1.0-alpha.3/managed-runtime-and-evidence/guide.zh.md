---
kind: upgrade-guide
description: "Alpha.4 隔离受管理运行时，并为新交付要求当前快照及验收证据。"
---
# Alpha.3 → alpha.4：受管理运行时与证据

[English](guide.md) | 中文

## 变更

普通根 PTC 保留默认运行时。Main、Implementation、Review 和 Diagnostic 分别隔离本地 `fs`、`subprocess`、`sandbox` 及 `ptcRuntime`，不要求全局 native-runtime 替换或 SSH 运行时别名。捕获的根文件系统拒绝远端受管理工作区。Operation policy 仍归用户所有，即使 operation approval 为 `never`，需求批准也不可省略。Windows 隔离为 partial，不是完整 `.git`、读取、网络或进程隔离。

新快照以 SHA256 及原始 Git blob 字节绑定全部已跟踪源文件，包括 LF／CRLF，不规范化换行。Git 使用宿主解析且位于仓库外的绝对路径程序，执行完整严格对象 hash fsck，包括非根子树。拒绝索引隐藏标志、忽略源文件、链接元数据／源文件、alternate、filter、include、fsck 跳过项及 core.worktree，不支持 linked worktree／硬链接。`generatedPaths` 只允许额外产物。

Passed 要求唯一且完整验收覆盖，并引用真实导出文件／行或实际 checkIndex 证据。存储域／外壳版本 1 保留混合 v1／v2 条目。旧历史可重放，但不补缺失证据，旧完成仅为历史，`currentDeliverableVerified: false`，不能授权严格新交付。Alpha.3 不能读取 v2 条目。

## 迁移

1. 确认全部旧活动停止。一致备份 Session 存储及配置的 `aaronwu_review_gated` 存储域后端、完整日志、包及 profile。保留并发／无关 Session 数据。
2. 部署负责人安装匹配且已构建的 alpha.4 层。在 `cordis.yml`／profile override 中，只移除 alpha.3 Review-Gated 全局 native-runtime 替换及 `localFs`／`localSubprocess` 等旧运行时别名依赖，保留合法普通 SSH 路由及用户 operation／文件策略。对照 [Bundle](../../../bundle.zh.md)及 [overlay](../../../../cordis.patch.yml)，将受管理选项迁移到各预设本地 `native-runtime`，不迁移到根。
3. 使用常规本地独立仓库，明确解决原始字节 checkout 不匹配。新证据使用新的空 Main 任务，不编辑旧记录来提升信任。推荐 `rg_start` 加有界 `rg_wait`，任务 `maxOperationMs` 默认 1800000 ms。旧阻塞调用仍受外层 PTC 截止时间限制。
4. 负责人安装及用户重启后，确认普通 PTC 不变、内部角色隐藏及远端受管理准入拒绝。Running 历史要求 `rg_recover` 先取得用户进程完全停止确认，再单独恢复执行；未知角色耗时耗尽剩余预算。取消／释放等待活动完全结束。
5. 回滚前先保留完整升级后存储／日志。Alpha.3 需要隔离的升级前 Session／记录副本或后端支持的选择性恢复，不能覆盖并发／无关 Session 或后续用户策略。不提供逆向迁移。
