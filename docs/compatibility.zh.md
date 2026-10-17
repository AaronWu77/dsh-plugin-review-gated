# 兼容性

[English](compatibility.md) | 中文

此兼容候选面向固定 DSH `0.2.1-alpha.2` commit `d743267388641bc76f17c45ce8b4c231aed1d32c` 及本地 one-shot Host activation 扩展、Node 24+ 和 pnpm 11。原版 alpha2 不支持受控角色，仅包版本不能证明 API 兼容。角色 provider 在加载时要求 `supportsLocalOneShot`，缺少扩展会明确报错。Host 包版本保持不变，此插件必须搭配本地扩展。[包清单](../package.json)明确固定 peer，已发布的旧 API 不能替代。不声称跨版本兼容，也不保证未发布的预发布 peer 可从 npm 获取。

本地联接属于被忽略的 pnpm 配置，不把开发者盘符路径写入源码或打包元数据。受控角色需要匹配的 Subagent 服务；可选辅助 Team 任务仅在明确组合时需要匹配的实验性 Agent Teams peer。ESM／NodeNext 调用方检查需要匹配且已构建的 peer。声明检查不代表最终组合版本通过。Provider 要求见 [Bundle 前置条件](bundle.zh.md)。

受管理预设使用独立本地 provider，不全局替换根运行时，也不依赖 SSH 别名。捕获的远端根文件系统会拒绝受管理工作区，即使预设本地映射看似本地。普通远端 PTC 路由保持不变。常规独立 Git 仓库可使用 `extensions.worktreeConfig`，但两个仓库配置文件中的危险键仍不支持。链接工作树和嵌套仓库仍不支持，见 [Git 限制](security.zh.md)。

Windows 原生权限强制为 partial。可用证据使用脚本模型及组件／原生 fixture，真实远端端到端行为和独立真实模型质量未验证。本次不声称完成安装、启用、重启或最终测试通过。见[验证限制](implementation-plan.zh.md)。
