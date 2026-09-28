---
doc_kind: plan
created: 2026-09-27
---

# 原生模型 Adapter 合同

> 状态:已实现，Issue #40 响应边界的 Linux 离线验收已完成(2026-09-28)；外部验收单列。决策见 [ADR-028](../decisions/028-model-response-boundary.md)，当前证据见 [Issue #40 施工图](model-response-boundary.md)，公共示例见[SDK](../sdk.md)。

`createAgent({ model, adapter })` 接受 TanStack `AnyTextAdapter`，SDK 导出名称为 `ModelAdapter`。对象 `Model` 必须配 adapter；目录字符串可以覆盖 adapter，更新时 `adapter: null` 恢复内置传输。旧 `streamFn` 在创建和更新时显式拒绝，不提供兼容包装。任务与摘要均通过 `chat()` 和同一个 adapter 接缝，`sessionId` 映射到原生 `threadId`，请求取消使用 `TextOptions.request.signal`。

`model-adapter.ts` 集中目录协议到原生 adapter 的映射、认证和 modelOptions。当前目录为 37 个 provider、1314 个模型、7 种 api；无等价内置传输的 Mistral Conversations 和 Codex Responses 不在目录中。宿主可以通过对象模型与原生 adapter 接入其他能力。增加 provider 时只修改相关 adapter 工厂、目录和认证，不修改会话循环、工具策略或 UI。

`model-response.ts` 是唯一 provider/history 转换位置：TanStack 当前 `ModelMessage` 提供成功响应的 text、thinking 和完整工具调用；Forge 审计原始 chunks 的终态、事件配对和严格工具 JSON，并补足签名、redacted、内容顺序与错误 usage。失败和取消只保留恢复部分输出所需的临时缓冲。历史仅在请求时转换为 `ModelMessage`。`model-call.ts` 等迭代器完整结束或关闭，工具提案在 `beforeTools` 投影、参数准备和逐条持久化完成后才允许执行；原生错误结果也必须在续轮前保存提案。无工具最终回答由 `onFinish` 提交一次。`RUN_FINISHED` 本身不是 invocation 成功证据；最终以 `AgentTurn.result` 为准。

完整工具响应即使以 provider 的 `stop` 结束也可以执行工具；半截 `length`、`deferred`、error、aborted 不执行工具。工具阶段取消保留已开始的结果并记录 aborted；已经完成的普通响应在存储等待期间取消不重复追加同一响应。自定义 adapter 报告的 `TokenUsage.cost` 原样保留，缺费用仍是未知；内置目录使用价格元数据估算，估算不是账单保证。

当前保留三个已锁定补丁：`@tanstack/openai-base@0.11.1`、`@tanstack/ai-anthropic@0.19.1`、`@tanstack/ai-bedrock@0.3.15`。补丁处理协议终态、工具参数及 reasoning/continuation；已发布最新版比较见 [Issue #40 施工图](model-response-boundary.md#发布包与补丁核验)。升级必须用本地 HTTP fixture 重新验证，不能用上游 main 或已合并 PR 代替发布证据。原传输迁移的历史证据见[归档](../archive/phases/tanstack-provider-transport-migration.md)。

真实供应商 AC-7 仍未测：需在明确凭据、目标、请求数和时间/费用预算下逐 provider 验证普通回答、工具续轮、摘要、恢复及取消，保留实际 usage/成本证据。Linux 离线矩阵、自定义 adapter 和本地 HTTP 均不替代这项验收。
