---
doc_kind: plan
created: 2026-09-27
---

# 原生模型 Adapter 合同

> 状态:已实现，本轮离线软件验收已通过，外部验收单列(2026-09-27)。决策见 [ADR-025](../decisions/025-tanstack-agent-foundation.md)，本次证据见[基座验收](tanstack-foundation-acceptance.md)，公共示例见[SDK](../sdk.md)。

`createAgent({ model, adapter })` 接受 TanStack `AnyTextAdapter`，SDK 导出名称为 `ModelAdapter`。对象 `Model` 必须配 adapter；目录字符串可以覆盖 adapter，更新时 `adapter: null` 恢复内置传输。旧 `streamFn` 在创建和更新时显式拒绝，不提供兼容包装。任务与摘要均通过 `chat()` 和同一个 adapter 接缝，`sessionId` 映射到原生 `threadId`，请求取消使用 `TextOptions.request.signal`。

`model-adapter.ts` 集中目录协议到原生 adapter 的映射、认证和 modelOptions。当前目录为 37 个 provider、1314 个模型、7 种 api；无等价内置传输的 Mistral Conversations 和 Codex Responses 不在目录中。宿主可以通过对象模型与原生 adapter 接入其他能力。增加 provider 时只修改相关 adapter 工厂、目录和认证，不修改会话循环、工具策略或 UI。

`model-response.ts` 是唯一 provider/history 转换位置：原生 chunks 聚合成 `SessionMessage`，保留 text/thinking/tool continuation、usage 和错误；历史仅在请求时转换为 `ModelMessage`。它拒绝非法工具 JSON、孤立事件、缺失终态和未知结束原因。`model-call.ts` 等迭代器完整结束或关闭并完成保存屏障，之后才允许工具阶段或下一请求。`RUN_FINISHED` 本身不是 invocation 成功证据；最终以 `AgentTurn.result` 为准。

完整工具响应即使以 provider 的 `stop` 结束也可以执行工具；半截 `length`、`deferred`、error、aborted 不执行工具。工具阶段取消保留已开始的结果并记录 aborted；已经完成的普通响应在存储等待期间取消不重复追加同一响应。自定义 adapter 报告的 `TokenUsage.cost` 原样保留，缺费用仍是未知；内置目录使用价格元数据估算，估算不是账单保证。

当前保留三个已锁定补丁：`@tanstack/openai-base@0.11.1`、`@tanstack/ai-anthropic@0.19.1`、`@tanstack/ai-bedrock@0.3.15`。补丁处理协议终态、工具参数及 reasoning/continuation，升级必须用本地 HTTP fixture 重新验证，不能用上游 main 或已合并 PR 代替发布证据。原传输迁移的历史证据见[归档](../archive/phases/tanstack-provider-transport-migration.md)。

真实供应商 AC-7 仍未测：需在明确凭据、目标、请求数和时间/费用预算下逐 provider 验证普通回答、工具续轮、摘要、恢复及取消，保留实际 usage/成本证据。Linux 离线矩阵、自定义 adapter 和本地 HTTP 均不替代这项验收。
