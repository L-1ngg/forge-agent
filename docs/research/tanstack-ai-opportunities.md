---
doc_kind: research
created: 2026-09-27
---

# TanStack AI 在 Forge Agent 中的候选应用

> 状态:待逐项讨论(2026-09-27)。本记录是重新核对当前实现后的候选清单，不批准迁移、不替代现行 ADR 或施工图。后续版本、收益和提供方行为须在实施前重新验证。

## 范围与证据

本次以仓库锁定的 `@tanstack/ai@0.61.0`、已安装包的源码，以及 Forge 当前实现为准。第一项还核对了已发布的 `@tanstack/ai-compaction@0.1.9` 源码；它当前未安装在 Forge。TanStack 包内 `skills/ai-core` 的说明自标面向 `0.42.0`，具体 API 判断以本地 `0.61.0` 源码为准。下面的“可用”仅表示存在相应 API 或扩展点，不表示已满足 Forge 合同或提升质量。其他未安装扩展包只列为待核验候选。

[ADR-024](../decisions/024-incremental-tanstack-ai-adoption.md) 已决定由 Forge 保留执行循环、会话、权限、输入归属与 MCP 宿主语义。这是当时的架构选择；已安装 TanStack `chat()` 实际包含工具循环与结构化输出流程，不能据 ADR 推断它技术上无法承担循环。是否改变该选择须另行比较并作新决策。

## 逐项讨论清单

| 顺序 | 候选与当前落点 | 已核对事实 | 待验证的收益与边界 |
|---|---|---|---|
| 1 | **会话上下文压缩**：`context/compact.ts`、`context/checkpoint.ts`、`session-configuration.ts` | `@tanstack/ai-compaction` 提供 `chat()` middleware 与裁剪、文本摘要、工具结果清理策略；`summarize()` 生成文本，`chat({ outputSchema })` 可生成结构化对象。 | 比较哪些策略可复用；TanStack 检查点只缓存压缩后的模型消息，不实现 Forge 的状态来源、预算和持久化证据合同。`chat()` 接入还会改变摘要请求路径和遥测。 |
| 2 | **语义检索**：`memory/store.ts` 的 `search_memory`、`context/search-context.ts` 的 `search_context` | 当前两者均是有界字面词搜索；`@tanstack/ai` 导出 `embed()`、`rerank()`。 | 比较语义召回、延迟、费用与索引刷新成本。向量或重排结果只能推荐原文；记忆文件版本、会话分支与 `entryId` 仍决定可读范围和证据身份。 |
| 3 | **Agent 循环**：`runtime/agent-loop.ts`、`agent-session.ts` | TanStack `chat()` 有工具循环；Forge 在请求边界提交配置，接收 steering/follow-up 并返回 `processed`，执行工具权限/并发调度，逐条保存消息。 | 做隔离原型并逐合同比较运行中切换模型、输入回执、并行工具、严格参数校验、取消及落盘时序。当前不能据功能名称相似就替换整条执行链。 |
| 4 | **Skills 来源**：`skills/catalog.ts`、`skills/load.ts` | Forge 扫描 workspace/user/builtin 层并实现遮蔽、元数据和路径规则；TanStack 有独立 `@tanstack/ai-skills` 包，当前未安装。 | 只有增加新来源或复用加载器时才核对该包版本的 `SkillSource`/加载接口；现有优先级、禁用和路径合同需保留。 |
| 5 | **模型目录**：`model-catalog.ts`、`model-data/` | Forge 使用本地模型快照及认证、价格、上下文与传输元数据；已安装 TanStack 原生 provider 包导出自己的模型元数据。 | 可用这些元数据交叉检查原生 provider 的模型 ID；其覆盖范围和字段不足以直接证明可替换完整 Forge 目录。 |
| 6 | **暂不列为直接替换**：MCP、持久记忆、会话存储、证据型压缩 | 当前对应实现还承担权限与凭据、Markdown 版本和范围、JSONL 分支与逐条保存、来源校验和预算等 Forge 合同。TanStack 有相关独立包或辅助能力。 | 仅在逐项能力与合同出现明确重叠、且收益可测时重评；不把包名相近当作替换理由。 |

### 第一项：会话上下文压缩的能力边界

#### 已同意方案的接入核对（2026-09-27）

operator 同意的目标行为是：会话历史保留原文；模型上下文使用有原文出处的任务状态检查点、必要原文和近期消息；发送前执行 Forge 的完整请求预算检查。TanStack `metadata` 只可作为压缩结果缓存，不能成为第二份任务状态真相源。

进一步核对发现，不能把 `withCompaction()` 直接放到当前压缩模块里完成该重构：

- `withCompaction()` 是 `chat()` 的 middleware，在模型调用前读取 `messages`，只改写 `providerMessages`。Forge 当前的内置传输直接调用 adapter `chatStream()`；`AgentSession.prepareRequestContext()` 已在请求前调用 Forge 压缩并重建 `runtime.state.messages`。若只在现有传输入口追加 middleware，它看到的已经是压缩投影，无法接管原始会话历史的压缩。
- 官方缓存以输入消息前缀哈希及策略 key 判断能否复用；要发挥作用，`chat()` 必须看到稳定的原始消息序列，且提供 `MetadataCapability`。Forge 当前的持久化任务检查点已能跨请求复用状态；额外缓存仅能避免重复计算，不能取代其原文出处、分支校验和落盘合同。
- 本地隔离探针使用已安装的 `@tanstack/ai@0.61.0`、Anthropic 本地 SSE fixture 和无执行函数的 `toolDefinition()`：`chat()` 输出工具调用后，终态为 `RUN_FINISHED`，`outcome.type` 为 `interrupt`，其中有 `tanstack:client_tool_execution`。Forge 当前把模型工具调用交给自身的运行循环。因此改用 `chat()` 还需重映射流终态、工具继续执行和 usage，并验证每个内置 provider、宿主自定义 `streamFn`、取消及逐条持久化。

结论：已同意的**用户可见行为**仍合理，但“只为会话压缩接入 `withCompaction()` 和 `metadata`”不是局部重构。要让官方 middleware 成为压缩所有者，须把完整模型请求路径与会话投影一并改造；这比第一项压缩模块的范围大。目前不应把该路径写成已可直接实施的替换。较小的研究切入点是独立验证 TanStack 的结构化摘要生成能否改善有效检查点率，同时保留 Forge 的原文校验、会话存储及预算；未通过对照实验前，不替换现行生产压缩。

已发布的 `@tanstack/ai-compaction@0.1.9` 提供 `withCompaction({ maxTokens, strategy })`，在 `chat()` 的模型调用前改写 `providerMessages`，完整 canonical transcript 不变。内置 `evictOldest` 丢弃旧消息并留标记，`summarizeOldest` 通过调用方提供的异步回调生成文本摘要，`clearToolResults` 清理旧工具结果；`composeStrategies` 和自定义 `CompactionStrategy` 可组合或替换策略。默认估算是消息字符数除以 4，可注入 `estimateTokens`。事件与 `onCompact` 报告前后估算。配合 metadata store 时，检查点以原消息前缀哈希和 `strategyKey` 校验并复用压缩后的模型消息；这不是 Forge 的证据型状态检查点。

`withCompaction` 的 `maxTokens` 检查只加总传入消息的估算值，源码没有在策略运行后强制保证结果低于阈值；Forge 还预留 system、工具定义、输出与余量，并在不能形成可用投影时明确失败。当前 Forge 通过 `streamFn` 直接调用 TanStack adapter 的 `chatStream()`，没有 `chat()` middleware 层，因此不能直接挂上 `withCompaction`。若只复用裁剪策略，需要在 Forge 的请求准备边界适配并保留现有预算、分支与证据校验。

TanStack `summarize()` 提供文本摘要、焦点/风格/长度选项，不生成带引用的状态检查点；`summarizeOldest` 本身也只接收返回字符串的回调。结构化提取仍需考虑 `chat({ outputSchema })` 或既有摘要模型请求。

当前 `createSummaryDriver()` 通过 Forge `streamFn` 完成一次摘要请求，`compactContext()` 再解析文本 JSON；`parseCheckpoint()` 检查来源确为当前历史中的原文片段，关键状态引用用户消息，并保留旧状态和合法替换关系。`validateCompactionCheckpoint()` 还检查持久化投影。TanStack 的 `outputSchema` 只能提供输出形状与 Standard Schema 校验，不会自动实现这些语义合同。

可比较的最小试验是：固定同一批历史、模型与压缩预算，把摘要生成改为 `chat({ outputSchema })` 的隔离原型，再调用原有 `parseCheckpoint()` 和投影选择。分别记录有效检查点率、实际模型请求数、usage、耗时、取消与错误分类；用无效来源、旧状态静默丢失、截断响应及存储失败检验拒绝路径。`chat()` 直接返回的对象不含 Forge 的 `usage`、`stopReason`；须核对 TanStack `onUsage` 等事件能否完整映射现有计数与失败分类。当前摘要预算只计 system/prompt 与输出预留；提供方请求中的 schema 也需计入新路径的预算。对内置 provider 和宿主自定义 `streamFn` 分别说明能否接入，因为后者当前不提供 TanStack adapter。只有质量和合同均达到现行基线，才讨论是否纳入生产；若摘要改走 `chat()` 而任务仍走现有 `streamFn`，还须重新评估 ADR-024 对同一供应商单一生产传输路径的决定。

这一步尚未实现或运行模型实验。2026-09-12 的[上下文压缩验收](../phases/adaptive-context-compaction-acceptance.md)记录了单 provider 旧实现的任务质量和费用，但早于当前传输实现，也没有单列摘要格式失败率；不能作为新方案的当前基线。当前不能宣称 TanStack 策略或 `outputSchema` 会降低成本、减少幻觉，或替代 Forge 的来源校验。

## 核对入口

- Forge：[摘要生成与预算](../../packages/core/src/context/compact.ts)、[检查点校验](../../packages/core/src/context/checkpoint.ts)、[摘要传输](../../packages/core/src/session-configuration.ts)、[AgentSession](../../packages/core/src/agent-session.ts)、[模型传输](../../packages/core/src/provider-stream.ts)。
- Forge：[记忆搜索](../../packages/core/src/memory/store.ts)、[历史搜索](../../packages/core/src/context/search-context.ts)、[Skills 扫描](../../packages/core/src/skills/catalog.ts)、[模型目录](../../packages/core/src/model-catalog.ts)。
- TanStack `0.61.0` 本地源码（依赖安装后可读）：`packages/core/node_modules/@tanstack/ai/src/activities/chat/index.ts` 的 `chat` / structured output 分支、`src/activities/chat/middleware/types.ts` 的 `onUsage`，以及 `packages/core/node_modules/@tanstack/ai/src/index.ts` 的 `embed` / `rerank` 导出；模型元数据见已安装 provider 包的 `src/model-meta.ts`。扩展包能力须在具体讨论时核对其实际版本源码。
- TanStack [Compaction 官方文档](https://tanstack.com/ai/latest/docs/advanced/compaction)及 npm 已发布的 `@tanstack/ai-compaction@0.1.9` 包内 `src/index.ts`；上游 `main` 的 `packages/ai-compaction/package.json` 已标 `0.1.10`，本项 API 判断以已发布的 `0.1.9` 为准。
