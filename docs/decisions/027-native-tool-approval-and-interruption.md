---
doc_kind: decision
created: 2026-09-28
---

# ADR-027: 原生工具审批与 Invocation 取消

> 状态:已批准(2026-09-28；[Issue #39](https://github.com/L-1ngg/forge-agent/issues/39) 已授权自主确定施工取舍)。施工与证据见[权限审批施工图](../phases/native-tool-approval.md)。

> 部分被 [ADR-030](030-native-arguments-and-conversation-persistence.md) 取代(2026-10-01):改参复判、通用参数处理链与保存屏障。下文保留原决策及当时证据，其余合同继续有效。

## 决定

普通模型工具统一声明 TanStack `needsApproval: true`。Forge 在模型工具提案产生后、审批展示前完成参数规范化、严格校验、宿主参数准备和现有五层权限策略判断。`allow` 与 `deny` 自动形成原生审批答复，只有 `ask` 交给宿主；整批答复收齐后，使用原生 `resume` 和 `parentRunId` 继续执行。获批工具的副作用发生在原生 `.server()`，按原生串行顺序执行。拒绝是工具结果，允许模型继续；停止是 Invocation 的 abort，清除待批次并阻止续接。

`AgentSession` 只保存当前进程内的待审批批次及一次提交状态。`RequestBus` 继续传输人机交互和超时终态，但模型工具授权不再逐项通过 `ask()` 等待与预执行。SDK、CLI、TUI 保留请求/答复的公共形状，并支持一次性 `editedArgs`；新参数重新校验与判权。旧 ID、重复答复、失效批次和停止后的答复均不接受。审批期间普通输入由宿主暂存，不生成第二执行分支。

一个 Invocation 可包含多个原生 run。只有模型、工具、必要保存和清理真正结束时，`AgentTurn.result` 才结算。原生 run 的关联只供内部续接，不成为另一份持久化任务状态。会话恢复只加载原文和上下文，不重放未完成工具。

## 取舍

原生 `needsApproval` 是工具级布尔值，逐调用的 `allow / deny / ask` 仍由 Forge 现有策略计算；保持原规则优先级和记住范围。原生审批前会先验证 Standard Schema；无 `prepareArguments` 的自有工具直接使用 Zod，有 `prepareArguments` 的工具先以 JSON Schema 描述进入原生阶段，再由 Forge 在审批前执行规范化和严格终检，避免原始输入过早被拒绝。动态 JSON Schema 和最终 `editedArgs` 同样由 Forge 集中严格校验。批准后不配置可改写参数的 native hook，执行入口仅校验和消费已决定的参数。

保留必要的单工具结果转换、进度事件和提交屏障；删除整批预执行、缓存结果转交及并行调度配置。串行性能是明确接受的取舍。Skills/Memory 的受信来源继续静默授权；同名普通工具不能取得该身份。OAuth、MCP elicitation 和显式资源操作仍走各自交互路径。

沿用已验证且与当前 Skills/Memory companion peer 兼容的精确锁定 `@tanstack/ai@0.61.0`。0.63.0 的 denied 元信息不是本次行为所必需，避免无关 provider 升级。已发布两版原生审批能力与缺口的探针结论见 Issue #39；Forge 最终验收以正式测试为准。

## 替代范围

本决定替代 [ADR-025](025-tanstack-agent-foundation.md) 的 Forge 批次预执行和并行选择，以及 [ADR-026](026-native-skills-and-markdown-memory.md) 对该批次调度的引用。两者关于唯一 `chat()` 循环、会话历史、受信来源与存储职责的决定继续有效。持久化审批、跨进程续接、防重放账本和外部副作用回滚均不在范围内。
