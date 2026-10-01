---
doc_kind: decision
created: 2026-09-28
---

# ADR-028: TanStack 聚合成功响应，Forge 审计原始协议

> 状态:已批准(2026-09-28)。施工与证据见 [Issue #40 施工图](../phases/model-response-boundary.md)；工具审批与执行继续按 [ADR-027](027-native-tool-approval-and-interruption.md)。

> 部分被 [ADR-030](030-native-arguments-and-conversation-persistence.md) 取代(2026-10-01):工具前提交时序。下文保留原决策及当时证据，其余合同继续有效。

## 决定

每次成功模型请求以 TanStack `chat()` 当前产生的 `ModelMessage` 为文本、thinking 和工具调用的主要来源。Forge 在原始 adapter 流旁只记录协议终态、事件配对、严格工具 JSON、失败时的部分输出，以及 TanStack 消息未表达的签名、redacted 标记和顺序索引。原始迭代器及其 `finally` 完成后才能判断成功；正常 EOF 不是成功终态。成功消息投影为原有 `SessionMessage`，而不是另存一份 TanStack transcript。

有工具的响应在 `beforeTools` 投影、准备最终参数并逐条提交 JSONL；全部工具已由 TanStack 生成错误结果的批次在下一次模型请求前执行同样的提交门禁。无工具回答在 run 的 `onFinish` 提交一次。`onError`/`onAbort` 仅结算未提交的部分响应，存储故障不再追加掩盖原错误的消息。每个模型请求的提交状态负责审批等待、原生 `resume` 和策略停止时的去重；`AgentTurn.result` 仍由整个 Invocation 结算。

正常 usage 优先取 TanStack 生命周期，错误响应取原始终态。Forge 保留目录价格估算和自定义 adapter 的显式费用/未知费用区别。历史 `SessionMessage` 只在下一请求投影为 `ModelMessage`；provider 执行工具后继续产生 reasoning 时，投影保留分段顺序。旧 JSONL schema、流式 `SessionEvent`、工具 `details` 和证据/分支格式不变。

## 取舍

保留原始流审计，是因为 TanStack 可能把缺少 provider 终态的 EOF 当作正常 run 结束，且 provider 扩展字段并未全部进入 `ModelMessage`。失败缓冲只为原有部分输出合同服务，不参与成功响应聚合。`withPersistence` 与 UI `StreamProcessor` 无逐条工具前提交屏障，会新增另一份可恢复状态，故不接入。发布版与三个补丁的逐项核验见施工图；本次维持精确锁定。

本决定收窄 [ADR-025](025-tanstack-agent-foundation.md) 的响应收集器职责，不改变其唯一 `chat()` 循环、领域历史和摘要证据验证选择。
