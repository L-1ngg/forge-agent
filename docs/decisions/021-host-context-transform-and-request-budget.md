---
doc_kind: decision
created: 2026-09-21
---

# ADR-021: 宿主上下文变换与分层请求预算

> 状态:核心预算决定仍生效；pi-ai 内置输出缩减预检已由 [ADR-024](024-incremental-tanstack-ai-adoption.md) 的传输迁移取代(2026-09-26)，尚未发布。
> 参与者:operator、Codex。施工与验收见[宿主上下文变换](../phases/context-transform.md)。

## 背景

[ADR-008](008-general-agent-positioning.md) 要求可嵌入的通用单 Agent。宿主需要选择、精简或注入本次请求的消息；仅在 streamFn 中改写会绕过会话预算。Forge 的内部 transformContext 已承担记忆与压缩，不能直接被宿主覆盖。

基线为 Forge `83550f5`、本地 runtime 固定来源 Pi `9767ba275f3e9a5ee0f5c5342249b629ab1b2282`、已安装 pi-ai `0.85.1`。Pi Agent 提供 transformContext → convertToLlm；自动压缩阈值属于其 coding-agent 会话层。Forge 当前预算和压缩以 [SDK](../sdk.md#上下文压缩状态与预算)、[ADR-017](017-evidence-backed-context-compaction.md)、[ADR-018](018-adaptive-default.md) 为准。

2026-09-21 operator 确认：

> 认可借鉴 Pi 的 transformContext 路线。
> 建议严格按实际配置的有效输出上限检查，首版不搞自动下调 maxTokens。
> transformContext 覆盖普通任务请求（包括工具调用的续轮），但不介入系统内置的摘要（Compact）请求。
> 整体链路 既有压缩 -> 宿主变换 -> 记忆装配 -> convertToLlm -> 硬卡口安检 -> streamFn 非常清晰顺畅。

## 决策

### 已确认的方向

1. 公开可选的宿主 transformContext，由会话层组合；支持选择、精简与外部上下文注入，不限定为 RAG。
2. 返回值只影响本次请求投影，不替换持久历史，不改变输入归属或 processed 回执。AgentTurn.result 继续负责最终结算。
3. 将压缩阈值与最终请求上限分开。软线保留当前公式，负责内置压缩及记忆额度；硬线按最终输入估算、实际有效输出上限与小额余量判断。允许宿主使用软线以上的部分空间，不自动缩减输出上限。
4. 最终检查位于 convertToLlm 之后、streamFn 之前，未设置回调或关闭自动压缩时仍生效。
5. 回调覆盖任务请求和工具续轮，不作用于自动或手动摘要。回调失败终止当前 invocation，不进入供应商重试/超限恢复；取消沿既有生命周期结算。
6. 变换后的投影不能使用旧 provider usage 锚点证明容量。最终检查覆盖实际传入 streamFn 的 system、工具 schema 和消息，按估算性质报告。
7. 保留配置 accepted/applied 时序。继续保留供应商 overflow 容灾，不把本地估算宣称为物理窗口保证。

### 本轮补充设计

固定硬线余量暂取 1024 tokens，不新增配置项；回调只在创建时配置，快照/返回值校验、重试重评估与取消等待按施工图定义。这些细节已获实施授权，交付状态以施工图为准。

原 pi-ai 内置传输有独立的 4096 tokens 输出缩减预检。当前受支持的内置传输已改用 TanStack AI，不再运行该预检；Forge 的一般硬线仍生效。历史原因与原验证见施工图。

### 被否方案

| 方案 | 不采用的原因 |
|---|---|
| 仅追加检索资料 | 将通用能力过早绑定单一用途，无法支持历史选择与内容精简 |
| 直接透传并覆盖内部 transformContext | 丢失内置记忆、压缩、配置和失败结算职责 |
| 压缩线兼作最终拒绝线 | 临时请求不能使用预留弹性空间，混淆提前压缩与最终可发送性 |
| 根据剩余空间自动下调 maxTokens | 改变宿主预期输出，增加意外截断；容量不足应显式失败 |
| 依靠上一次 usage 或把字符估算当上界 | 上一次请求不包含新投影，字符估算也不是精确 tokenizer |
| 超限后反复调用宿主、压缩、再变换 | 调用次数和外部副作用难以预测；首版一次准备失败即结束 |

## 后果

- 宿主定制内容，会话负责预算、持久化和结算；不扩展内核为检索或传输观测平台。
- 新统一检查改变默认实例和关闭压缩实例的超限行为，已显式回归并更新双语 SDK；内置传输迁移后只保留一般硬线。
- 精确预算、通用 tokenizer、自动调低输出、provider 全覆盖证明不在首版承诺中。
- 本 ADR 补充既有会话职责，不替代 ADR-010 的输入合同，也不改变 ADR-017/018 的压缩算法和原文保存规则。
- 双语 SDK 已同步公开接口与预算合同，验收证据见施工图。没有存储格式迁移，无需重做 Skills 或 shouldStopAfterTurn。
