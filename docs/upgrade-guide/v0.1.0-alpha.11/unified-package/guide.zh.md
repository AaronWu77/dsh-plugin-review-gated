---
kind: upgrade-guide
description: "独立 Review-Gated UI 包由主包的集成面板取代。"
---
# 升级 alpha.11 → alpha.12：统一 Review-Gated 包

[English](guide.md) | 中文

## 变更

`@aaronwu/dsh-review-gated@0.1.0-alpha.12` 包含原先由 `@aaronwu/dsh-review-gated-ui` 独立安装的状态观察面板。分包安装必须移除旧依赖和 bundle 条目。面板默认启用，原有 `review-gated-observed-ui` id 支持 `disabled` 覆盖。审批、存储、工具和权限不变。见[组合与入口](../../../bundle.zh.md)。

## 迁移

1. 停止活动任务，等待受管理操作结束。安排维护窗口，在更改安装前停止原有服务。保留当前包规格、锁文件和 overlay，并按[持久化说明](../../../persistence.zh.md)备份两个存储。不要将凭据复制到候选目录。
2. 从统一包根目录使用[离线规划脚本](../../../../scripts/profile-migration.mjs)检查候选：

   ```text
   node scripts/profile-migration.mjs --profile <directory-or-package.json> --target-spec <verified-package-spec>
   ```

   默认输出 dry-run JSON 报告。`--patch <file>` 可指定一个 overlay，替代相邻的 `cordis.patch.yml`。可选 `--output <new-file>` 只将候选包清单写到输入 profile 外；父目录必须已存在，目标文件必须不存在。脚本不安装依赖、不更新锁文件、不复制凭据、不改写 overlay，也不重启服务。目标包规格不会被解析或验证。
3. 继续前解决所有 `manual-required` 报告；脚本拒绝为此类计划写出文件。自定义旧 UI 引用需要人工审查。顶层 `{id: review-gated-observed-ui, disabled: <boolean>}` 覆盖保持原样。自行检查其他 overlay 层，包括可能重复发现客户端的手写主包根入口和直接 `file://.../dist/...` 入口。将内部核心入口迁移为明确的主包子路径；`/main-tools` 保留根工具入口功能。仅保留 bundle 的 `./ui/lib/index.js` 发现条目；`/observed-ui` 仅用于主机端。
4. 在维护窗口中审查并应用候选：更新主包依赖规格，从依赖字段及 `dsh.profile.bundles` 移除 `@aaronwu/dsh-review-gated-ui`，保留无关配置。使用部署所用包管理器更新 profile 锁文件与已安装依赖。若需继续隐藏面板，保留[组合说明](../../../bundle.zh.md)中的 `disabled: true` 覆盖。
5. 重启原有服务，刷新原 GUI 地址。部署负责人必须确认只有一个面板、没有旧 UI 客户端、原批准卡不变，且关闭／重开不会重复注册。检查保留的工作流状态，不重置或自动重试任务。离线检查不能证明部署成功。
6. 验证失败时，再次停止任务与服务。恢复先前代码／包规格、锁文件和配置；若原来存在旧 UI 依赖／bundle，也一并恢复，然后重启验证。回滚不能用旧存储覆盖较新的 Session 或工作流数据；保留两个存储的当前数据。
