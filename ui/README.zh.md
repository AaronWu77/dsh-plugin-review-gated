---
description: "查看已记录的 Review-Gated 状态，不控制工作流执行。"
kind: "package-reference"
---

# Review-Gated 状态观察面板

[English](README.md) | 中文

## 概要

从会话标题栏查看最近成功记录的 Review-Gated 摘要。默认启用的面板以英文或中文显示需求、批准版本、候选标识、验证计数、审查阻碍、暂停原因与有限预算。面板不会批准、执行、重试、取消或交付工作流。观察记录可能过时，工作流日志仍是权威来源。

## 目录

- [使用面板](#use-the-panel)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-the-panel"></a>
## 使用面板

面板随[主 bundle](../README.zh.md)提供，默认启用，不再独立安装。面板本身没有配置字段；用 profile overlay 的 `review-gated-observed-ui` 条目设置 `disabled`，见[bundle 组合](../docs/bundle.zh.md)。关闭面板不改变工作流或已有批准卡。

主机端需要 `sessionProjections`；浏览器端需要 Session Controller、Conversation 标题栏插槽、UI Workspace 导航、UI Session、UI Renderer、Locale 与常规主题／基础组件平台。缺少必需服务时，Cordis fiber 会保持等待。

只有[主 overlay](../cordis.patch.yml)中的 `./ui/lib/index.js` 条目负责完整客户端发现。`@aaronwu/dsh-review-gated/observed-ui` 仅提供主机投影，不是完整界面的加载入口。不要添加 `/client` 主机条目，也不要保留旧 UI bundle。分包安装的迁移步骤见[升级指南](../docs/upgrade-guide/v0.1.0-alpha.11/unified-package/guide.zh.md)。

### 候选检查

构建与检查由[主包清单](../package.json)统一管理。`build` 组合核心与 UI 构建；`typecheck:ui`、`test:ui` 与 `check:ui` 提供针对性检查。请使用隔离检出和已审计依赖；声明脚本不代表检查通过或已经部署。

[UI 构建脚本](scripts/build.mjs)写入此目录的 `lib` 与 `dist`，生成 Host／Client 声明、主机 ESM，以及主包清单指定的单个延迟 CJS 浏览器工厂。工厂以主包名注册。此目录是主包的实现子目录，不拥有独立包清单或 bundle overlay。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

纯 [投影](src/projection.ts) 关联已有且已提交的工具开始／结果事件，忽略分叉继承前缀，仅读取包含有效摘要 JSON 的单个完整文本块。`rg_start` 与 `rg_wait` 使用已记录的 `workflow` 字段；操作结束不代表工作流完成。失败、格式错误、孤立或溢出结果不会更改最近观察记录。没有新增 Session 事件、日志读取、计时器、Remote 方法或工作流服务导入。

[面板](src/client/ReviewAction.tsx) 使用标准投影 Hook 与类型化[语言字典](src/client/locales.ts)。Button、Modal 与 StateDot 来自 UI Primitives；颜色、字体与滚动条使用语义主题令牌。子会话导航会重新检查当前直接父会话目录与精确保留的父会话代次。只有已发现的一次性子会话能够打开；仅观察到运行标识不会产生导航地址。

不发布运行时 invariant 配套模块：此 UI 子目录拥有纯日志事件折叠与显示贡献，不拥有独立工作流权威状态。Loader 与渲染器测试断言注册和卸载行为。

</details>

<a id="model-experience"></a>
## 模型体验

无。面板不注册工具、提示词或模型可见状态。

#### KV 缓存影响

无。面板不发起提供方请求，也不更改会话内容。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

- 观察记录不是实时权威状态。预算固定于观察时间，批准不代表完成，Passed 仅表示已记录的审查结果。面板不能证明交付资格。
- 精简结果可能省略或截断详情；总计数仍会显示，缺少详情从不代表阻碍已清除。候选与验证标识分别显示。
- 子会话区域列出所有已发现的一次性子会话，不声称这些标识属于 Review-Gated 角色。可续接与未知模式的子会话会被排除。未发现的运行仅显示为文本。
- 离线测试不验证实时服务器、完整配置档安装、浏览器视口适配、主题对比度、桌面窗口栏或产品／设计审查。这些检查在激活前仍由父级集成负责人承担。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>非权威工作背景</summary>

无。

</details>
