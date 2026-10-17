---
kind: upgrade-guide
description: "Alpha.6 报告命令兼容性提示，并区分宿主检查与角色自报。"
---
# Alpha.5 → alpha.6：Windows 验证与证据

[English](guide.md) | 中文

## 变更

状态及用户批准详情展示未执行探针的 Windows Node 测试提示。Provider 没有执行前能力查询，因此后端能力保持未知。不自动改变命令、权限、期限或验收标准。

角色收到已记录指令：Diagnostic 使用 read／glob／grep，不探测进程工具；Implementation 不替换命令、不声称失败的必需检查通过；Review 使用与快照绑定的宿主证据，不采信写者主张。这些指令补充执行器检查，不保证模型完全服从。

报告分别展示宿主任务状态、Implementation 完成、必需检查成功及匹配的独立审查。宿主任务 Completed 时工作流可能仍 Paused。程序输出是诊断文本，不是权威基础设施失败分类。

## 升级与复测

1. 一致备份普通 Session、完整日志、Review-Gated 存储及 profile。自行停服，确认受管理工作完全结束后再安装；安装不停止、启动或热重载服务。保留共享 provider 链接、嵌套依赖、存储和无关配置。

2. 仅在已核验的 alpha.5 上安装固定 alpha.6 归档。依赖、导出及 bundle 组合不变。工作流条目保持版本 3；读取混合 1／2／3 历史，不重写。没有迁移或预算返还。

3. 手动启动后核对安装版本、普通 PTC 及既有任务的权威记录。Paused 保持 Paused。不自动批准、重试、恢复或交付。

4. 如适配当前 finite-integer-add 检查，明确修订其验收命令为 `node --test --test-isolation=none test/add.test.js`，含 `timeoutMs: 60000`；提交完整下一版简报并取得新的用户批准。保留 `executionBudgetMs: 900000`、最多一次修复、原范围及已消耗预算。单独授权执行前不开始。

5. 修订简报清空当前派生的 Implementation／快照／检查／审查状态，不清空历史或已耗时。外部人工运行不能替代宿主验证证据。仍必须独立 Review，不授权提交或推送。

## 回滚与局限

Alpha.5 可读取未改变的 v3 数据，但回退会失去这些提示和角色／报告改进。保留全部较新 Session 日志及存储，不以全局旧存储覆盖并发数据。Alpha.4 无法读取 v3。

原默认 Node 测试命令仍不兼容 Windows ACL 带管道子进程限制。不提供 ACL、命名管道策略或沙箱扩权修改。没有平台提示不代表命令已兼容。脚本测试不证明真实模型端到端验收成功。
