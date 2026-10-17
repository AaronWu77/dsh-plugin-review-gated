---
kind: upgrade-guide
description: "区分需求确认与一次性操作许可，并审计被拒绝 Review 的语义。"
---
# 升级 alpha.7 → alpha.8

[English](guide.md) | 中文

## 摘要

Alpha.8 保留需求确认，但每次执行或交付尝试均须独立准确的新日志用户输入。它写入 v5 操作／语义拒绝事实，读取有序 v1–v5 历史而不重写，从不自动安装、重启或恢复工作。这会破坏直接执行／角色调用及默认模型查询的既有用法。

## 目录

- [许可](#permission)
- [Review 证据](#review)
- [查询与报告](#queries)
- [既有数据](#history)
- [安装与回滚](#deployment)

<a id="permission"></a>
## 许可

完成批准服务回答及准确问题确认后，停在 Approved。只有服务回答不批准，需求／恢复确认也不执行。用户要求进一步工作时，Main 以 kind execution 调用 rg_request_operation，展示模式及限额，等待用户发出准确的新 JSON 模板。rg_confirm_operation 用实际日志序号记录 Authorize 或 Decline。准备及确认均不启动角色或检查。明确 Authorize 后才可执行，与窗口启动一起仅消费许可一次，并停在 Ready for Handoff。交付要求独立请求及新输入。任何操作都不授权 commit 或 push。

操作请求绑定修订、获批范围、阶段、候选、预算／轮次计数和所属 Session 准确的最新后续用户输入。新输入使未使用许可失效。外会话、合成、过期、重复输入及缺失许可，通过工具、直接服务和 durable Controller 写入点均拒绝；当前操作事件只有经过所属 Session 日志校验才能写入。角色要求当前窗口／模式的已消费执行许可及本次活跃日志代的回执；恢复活动先协调，不直接重新启动。Verify-review 模式不写入或自动修复；有证据的 Needs Changes 结束该尝试。允许 Implementation 的模式内，获批有界修复重新做检查和 Review。回执来源标识日志用户输入通道，不独立认证自然人。 新需求声明 `executionIntent`；`verification-only` 选择零改动快照路径，跳过 Implementation 和修复，并由 Controller、Execution Service 及 direct Role Runner 共同强制。

待确认请求在 operationEvidence.templates 中返回模板，只复制当前请求 ID。准确 selected 值为 Authorize 和 Decline。操作 JSON 与 reviewGatedAnswer 问题 JSON 不同，需求问题 ID 不能授权操作。若要跨新用户轮次等待后再启动，取得新的许可。

<a id="review"></a>
## Review 证据

Review 接收不可变源、diff、准确宿主检查，以及宿主实际检查源完整性和允许范围后的日志观察。只有摘要不证明完整性。只读 Review 不运行哈希／测试进程、不枚举原工作树、不创造其他环境要求。缺少观察不能推断。

Checked 是已验证任务事实，Unchecked 是仍未验证的必需验收／范围项。Passed 要求完整有证据验收、无阻塞发现且 unchecked 为空；真正缺失必需证据应为 Inconclusive。普通范围外局限可写 reason，但不能隐藏必需不确定性。Needs Changes 要求描述有证据修改的 findings。JSON、schema、语义拒绝是独立有界事实，带运行／日志引用；已提交证据不是有效 Review。原始输出不编辑或自动重试。角色关闭后审计追加失败，仍独立尝试中断／计时；持续无法保存结算则保持未解决，不声称完成。

<a id="queries"></a>
## 查询与报告

rg_status 及动态上下文返回精简发现视图。rg_brief 返回完整需求，rg_question(questionId) 返回保留的原始问题／详情／选项／回执，rg_status(detail=true) 返回完整记录视图。原始记录仍完整且权威。Main 配置 summaryTextChars 默认 512（64–8192），summaryItems 默认 8（1–128）。精简投影减少重复详情／输出字节，不证明真实模型 token、缓存或延迟收益。

完成报告将 authorizationComplete 改名为 requirementsAuthorizationComplete，另行显示 operationPermissionCurrent、operationPermissionStatus 和 handoffPermissionRecorded。历史交付仍是历史，缺失 v5 交付许可不推断为当前有效交付。直接调用方必须取得准确操作许可，直接角色仅在已获准活跃窗口中运行。不要求修改核心 Session 格式、SDK 事件目录或根 PTC provider。

<a id="history"></a>
## 既有数据

存储域及记录外壳保持版本 1。Journal 关闭会先等待进行中的 Controller 提交，再关闭存储域。已发布 v1–v4 事件 schema 和重放语义仍受支持，新事件按单调顺序写 v5。旧决定不产生操作许可。恢复的 Running 任务／窗口须独立日志停止确认／恢复，保留限额并保守计入未知耗时。已消费时间或轮次不重置，范围变化须完整修订需求并批准。

暂停且未变化的候选保留文件／索引／快照／已记录检查。明确恢复后取得 verify-review 许可，运行新宿主检查和全新 Review，不重做 Implementation 或编辑旧拒绝输出。内容过期或需求未满足应走正常获批修订／修复路径。Cancelled 仍为终态：真正新建独立 Session，不续发消息或手改存储。

<a id="deployment"></a>
## 安装与回滚

安装前备份权威工作流域和匹配完整 Session 日志及 profile。固定归档与安装器在活跃 profile 外暂存。负责人停下真实服务并核实受管理活动／包管理写进程已静止。使用 alpha.8 安装器及其准确 alpha.7 前代／配置／归档摘要；check-only 仅检查不安装，停服护栏拒绝活跃服务。安装从不停服、启动服务、执行任务或改写旧行。负责人启动原 profile，核实安装版本，再做独立 Git 基线测试。

Alpha.7 不能读取新写入的 v5。回滚前保留所有升级后日志和存储，使用匹配升级前隔离副本或支持的选择性恢复。不能用整份旧备份替换共享存储域而丢失无关／并发 Session。只替换归档不是降级迁移，不提供逆向迁移。角色／窗口已停止确定性与任务恢复仍分别决定。
