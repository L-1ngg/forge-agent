---
doc_kind: plan
created: 2026-09-26
---

# OpenAI 模型传输试点：TanStack AI

> 状态:离线桥接已实现，真实 API 验收未测(2026-09-26)。operator 已确认 OpenAI 为首个供应商，并授权在开发阶段使用本地补丁施工。上位决策见 [ADR-024](../decisions/024-incremental-tanstack-ai-adoption.md)。

## Why

工具参数已按[第一阶段施工图](tool-argument-validation.md)迁出 pi-ai。下一步用 OpenAI 官方 Responses API 验证 TanStack `TextAdapter.chatStream()` 能否承担 Forge 的单次模型请求，同时保留 Forge 的 Agent 循环、会话、工具授权与摘要所有权。试点只切换 `provider: "openai"` 的内置模型传输；外部注入的 `streamFn` 仍由宿主负责。

## 已核对的边界

- Forge 的 `StreamFn` 返回 pi-ai `AssistantMessageEventStream`，请求错误与取消须作为 `error` 终态和 `AssistantMessage` 返回。普通任务经 `agent-session.ts` 包装流函数，摘要经 `session-configuration.ts` 直接调用。现有 OpenAI catalog、认证、预算辅助和公共流类型仍依赖 pi-ai。
- `@tanstack/ai-openai@0.24.1` 的 `createOpenaiChat(model, apiKey, config)` 使用 Responses API，`chatStream()` 只产出 adapter chunks，不执行 TanStack 的 Agent 循环。`@tanstack/openai-base@0.11.1` 提供工具格式转换、无状态历史重放、reasoning signature 与函数调用 `itemId` 元数据；请求取消经 `TextOptions.request.signal` 传给 OpenAI SDK。
- 本次锁定 `@tanstack/ai@0.61.0`、`@tanstack/ai-openai@0.24.1`、`@tanstack/openai-base@0.11.1`，后者解析 OpenAI SDK `6.49.0`。发布版 `responses-text.ts` 在未见 `response.completed` 而流 EOF 时仍合成 `RUN_FINISHED`；仓库的 Bun 补丁 `patches/@tanstack%2Fopenai-base@0.11.1.patch` 移植上游终态修复，并使格式错误或非对象的工具参数成为 `RUN_ERROR`，避免适配器以 `{}` 执行工具。上游修复见 [#1489](https://github.com/TanStack/ai/pull/1489)、[#1494](https://github.com/TanStack/ai/pull/1494)、[#1497](https://github.com/TanStack/ai/pull/1497)；包升级时需重新核对并移除已不需要的补丁。
- OpenAI 官方文档允许把完整历史作为下一次 Responses `input`，也支持 `previous_response_id`。[Conversation state](https://platform.openai.com/docs/guides/conversation-state)；流成功由 `response.completed` 表达，[Streaming Responses](https://platform.openai.com/docs/guides/streaming-responses)。本试点选择完整历史重放，避免引入服务器端续接 ID 的会话一致性问题。reasoning 的加密签名及工具调用标识仍须跨落盘、恢复与压缩保留。

## Entry Criteria

| # | 检查 | 通过标准 | 不通过怎么办 |
|---|---|---|---|
| E1 | 锁定包与补丁流终态 | 实际安装的 adapter 经本地 SSE fixture 证明：`response.completed` 即成功且不等 EOF，提前 EOF 为 `RUN_ERROR`，`response.failed` / `response.incomplete` 不成功；补丁经冻结安装重放 | 修补或更换锁定包，不能把未确认 EOF 当成功 |
| E2 | 版本和依赖 | 核对 `@tanstack/ai-openai`、`@tanstack/openai-base` 与 OpenAI SDK 的实际解析版本，Bun typecheck 通过 | 固定可验证的兼容版本；不以宽松依赖范围代替解析检查 |
| E3 | 凭据与模型 | 离线 fixture 使用假 key；真实验收通过环境变量提供用户自己的 OpenAI API key，并选账号可访问的模型 | 无凭据时只完成离线验收，真实 API 项标记未测，不能宣称试点通过 |
| E4 | 工作区 | 保留现有工具校验、压缩和文档改动；试点 diff 限于 OpenAI 传输及其必要合同 | 先核对冲突，再继续施工 |

## What

1. **单次请求桥接**：在 `packages/core/src/` 增加 OpenAI 专属 `StreamFn`。每次请求将 Forge `Context` 映射为 TanStack `ModelMessage[]`、`Tool[]`、`systemPrompts` 与 `modelOptions`，调用 `createOpenaiChat(...).chatStream()`；将文本、reasoning、工具调用、usage、模型名及成功/错误/取消 chunk 映射回原有 pi 流事件。只消费一次模型响应，不让 TanStack 执行工具或循环。桥接必须在所有异常路径完成 `result()`，且不得在未确认的 EOF 上返回成功。
2. **请求选路**：`session-configuration.ts` 对内置 OpenAI catalog 模型选择该桥，其他供应商继续使用 pi-ai。`AgentSession` 普通任务与 `createSummaryDriver` 摘要读取同一生效 `streamFn`，配置更新仍按现有原子提交边界生效。OpenAI 不保留第二条生产 pi-ai 传输路径；宿主提供的自定义 `streamFn` 不属于内置选路。
3. **认证和请求参数**：沿用 SDK/CLI 的显式 key 与 `OPENAI_API_KEY` 入口、模型目录及 `baseUrl`；缺 key 在配置准备期按现有方式拒绝。`maxTokens` 映射到 `max_output_tokens`，`reasoning` 映射到目标模型可用的 `reasoning.effort`，`signal` 与零 SDK 重试送入请求，避免绕开 Forge 的重试/压缩策略。默认 `store: false` 并重放完整上下文；不启用 `previous_response_id`、background 或内建 OpenAI 工具。
4. **会话续接**：Forge 历史仍为真相源。`thinkingSignature` 映射 TanStack thinking signature；OpenAI 函数调用的 `call_id` 保持 Forge tool call ID，`itemId` 经已有 `thoughtSignature` 的带版本编码保存并还原为 TanStack tool-call metadata。现有 `SessionMessage` 投影、`SessionStore`、`projectMessages` 和压缩后的请求投影均须验证，不保存供应商服务端 response ID 作为续接依据。未知签名格式按无签名重放，不丢工具结果或重新执行历史工具。
5. **工具 schema 与 payload**：Forge 原 JSON Schema、最终本地严格校验和权限判定继续生效。TanStack OpenAI 转换器对可兼容 schema 生成 strict 定义，对复杂 schema 使用 non-strict；本地 fixture 比对普通和 MCP 工具在实际 OpenAI 请求中的约束与参数回传。当前 `AgentSession` 注入的 `onPayload -> preserveToolSchemas` 用于 pi 传输恢复 schema：切换时仅对仍走 pi 的请求注入该回调，OpenAI 桥直接使用 TanStack 转换后的定义，避免原 schema 覆盖 strict 定义。外部注入的 `streamFn` 继续收到现有 `onPayload`，其合同不变。
6. **失败语义**：`RUN_FINISHED(tool_calls)` 映射 `toolUse`，`stop` 映射 `stop`，长度上限映射 `length`；`RUN_ERROR`、拒绝、协议不完整和请求异常映射 `error`，AbortSignal 映射 `aborted`。发布版对 `response.incomplete` 发出 `code: "incomplete"`，并以 `incomplete_details.reason` 作无上游错误时的 message；只在 fixture 证明 `max_output_tokens` 可辨认时映射为 `length`，其余不完整响应保守映射 `error`。usage 缺失保持未知，不从已流出的文本推算；成本沿用当前模型目录定价辅助。

## Batches

1. 锁定包、Bun 补丁和 OpenAI SSE fixture：验证协议终态与非法工具参数，再改生产选路。
2. 桥接与请求投影：完成事件、历史、工具和失败分类的局部测试；独立检查任务、摘要路径。
3. OpenAI 单路径切换及文档：同步 SDK 中英文指南、README 依赖描述和受影响测试；真实 API 试点验收完成后再记录模型与实际用量。

## Acceptance Criteria

出口条件：E1-E4 通过，以下 AC 全部勾选，记录实际版本、命令、fixture 和真实 API 证据。未经真实 API 验证仅可称为离线桥接完成，不能称为 OpenAI 试点通过。

- [ ] AC-1: OpenAI 内置模型的普通多轮任务、一次工具调用及工具结果继续请求，仅走 TanStack 传输；其他供应商和自定义 `streamFn` 选路不变。
- [ ] AC-2: 手动与自动摘要通过同一 OpenAI 桥，预算、reasoning、取消、配置更新和存储行为与现有合同一致。
- [ ] AC-3: 文本、reasoning、工具参数/ID、模型名、usage 与终态事件正确投影；中断、429/5xx、`response.failed`、`response.incomplete`、提前 EOF 不产生成功或工具副作用。
- [ ] AC-4: reasoning signature、函数调用 `itemId`、`call_id` 及结果经 JSONL 落盘、重开和下一轮请求仍可重放；缺失历史结果只生成现有错误投影，不执行旧工具。
- [ ] AC-5: 内置与复杂 MCP schema 的实际请求语义、本地严格校验和授权快照正确；pi 路径的 `onPayload` 恢复与 OpenAI 路径的 TanStack 转换各有请求体断言。
- [ ] AC-6: 至少一个用户账号可访问的 OpenAI 模型真实完成普通回答、多轮工具和摘要；记录模型、请求数和费用/usage 边界，不保存 key 或原始敏感内容。
- [x] AC-7: `bun run check`、定向 fixture、`git diff --check` 通过；反向验证将非法工具参数回退为 `{}` 时对应测试变红。

## Test plan

| 层 | 覆盖什么 | 跑在哪 |
|---|---|---|
| 发布版 adapter | 完成、失败、不完整、提前 EOF、终态后连接不关闭、取消、非 2xx | Bun 本地 HTTP/SSE fixture，实际锁定包 |
| 桥接单元与 SDK 集成 | 事件顺序、工具授权与结果、重试和压缩、配置更新、JSONL 恢复、schema 请求体 | Bun 离线测试 |
| 真实 OpenAI API | 普通回答、多轮工具、摘要和取消；验证账号可用模型的参数兼容性 | 用户 key，手动受控 smoke |
| 静态检查 | 类型、依赖边界、文档与旧 OpenAI 选路清零 | 仓库现有 check |

## 明确不做

- 不迁移 Anthropic、xAI、Azure OpenAI、OpenAI Codex 或 OpenAI-compatible 网关；各自另定供应商施工图。
- 不让 TanStack `chat()`、`@tanstack/ai-mcp` 或 `@tanstack/ai-persistence` 接管 Forge 循环、MCP 或会话存储。
- 不在本批替换 pi-ai 公共类型、全局模型目录和预算辅助；这些属于 ADR-024 的后续清零阶段。

## Rollback

单路径切换与桥接作为独立批次回退；若未过真实 API 或终态门禁，不发布 OpenAI 切换。回退必须撤销整个 OpenAI 传输切换并恢复对应依赖/文档，不能在同一版本中静默回落到 pi-ai，也不能把未确认的流结束当成功。会话历史不做破坏性迁移；版本化 `thoughtSignature` 必须允许旧记录缺失该字段。

## Risk

| 风险 | 约束与验证 |
|---|---|
| npm 发布版落后于已合并修复 | 锁定 Bun 补丁，并以冻结安装和 SSE fixture 验证实际安装包；升级后重新评估补丁 |
| TanStack 工具 schema 转换与 Forge 原 schema 语义不同 | 检查请求体、工具回传与本地严格校验；复杂 MCP schema 走 non-strict 且仍在本地拒绝非法值 |
| provider metadata 在会话投影中丢失 | 版本化编码及落盘/恢复/压缩后重放 fixture |
| adapter 错误事件信息不足以恢复长度与重试分类 | 对 `incomplete/max_output_tokens` 和 429/5xx 分别做 fixture；不能可靠分类时按错误处理并记录行为差异 |
| 真实账号模型与 fixture 支持范围不同 | 真实 API smoke 作为试点出口，并记录未覆盖模型 |

## Sources

- 已发布 npm 包源码：`@tanstack/ai-openai@0.24.1` 的 `src/adapters/text.ts`、`src/utils/client.ts`；`@tanstack/openai-base@0.11.1` 的 `src/adapters/responses-text.ts`、`src/adapters/responses-tool-converter.ts`、`src/usage.ts`。发布版本以 `npm view` 核对，实际实施时重新查询。
- [OpenAI Streaming Responses](https://platform.openai.com/docs/guides/streaming-responses)、[Conversation state](https://platform.openai.com/docs/guides/conversation-state)。
- Forge 当前合同：`packages/core/src/runtime/types.ts`、`agent-session.ts`、`session-configuration.ts`、`event-projection.ts`、`session-storage.ts`、`packages/protocol/src/events.ts`。

## 当前证据(2026-09-26)

- Ran: `bun run check`、`git diff --check`、`bun install --frozen-lockfile` 通过。`packages/core/test/openai-stream.test.ts` 的 16 项离线测试通过，覆盖成功/失败/不完整/提前 EOF、终态后 HTTP 不关闭、流式 reasoning 签名与工具参数、未完成工具调用拒绝、JSONL 续接、摘要重试、复杂 schema、本地拒绝、429/503、取消及格式错误或非对象工具参数。
- 反向验证:在实际解析的 `@tanstack/openai-base` 安装副本中临时恢复非对象参数到 `{}` 的旧行为，`OpenAI invalid function arguments 3` 从预期 `error` 变成 `stop` 并测试失败；恢复补丁后定向测试及全量检查重新通过。
- Not run:真实 OpenAI API 普通回答、多轮工具与摘要。Why:当前环境没有 `OPENAI_API_KEY`。Risk:真实账号的模型权限、参数兼容性、usage 与费用仍待验证，AC-6 未满足，因此不能称试点通过。
