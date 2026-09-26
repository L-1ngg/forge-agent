---
doc_kind: decision
created: 2026-09-26
---

# ADR-024: 逐步引入 TanStack AI 并移除 pi-ai 依赖

> 状态:已批准(2026-09-26)。operator 确认逐步迁移方向，并选择工具参数统一严格校验；首项施工见[工具参数校验](../phases/tool-argument-validation.md)。
> 参与者:operator 确定目标与类型校验策略；Codex 调研当前边界并提出迁移顺序。

## 背景

Forge 自己维护单 Agent 执行循环和会话策略，但工具校验、模型目录/传输、流事件类型、预算辅助及错误分类仍直接依赖 `@earendil-works/pi-ai`。当前工具参数先在 `runtime/agent-loop.ts` 校验，再在 `session-tools.ts` 的改写及授权路径重复校验；普通 JSON Schema 使用 pi-ai 的转换语义，MCP 使用官方 Ajv 严格校验。operator 希望逐步引入 TanStack AI，最终移除 pi-ai 包，而不是只整理现有代码。

## 决策

1. Forge 继续拥有执行循环、会话、权限、输入归属和 MCP 宿主语义。按职责逐步替换 pi-ai；任何时点同一供应商只使用一条生产模型传输路径。TanStack `chat()` 不接管 Forge 的 Agent 循环。
2. 第一阶段迁移工具参数层。Forge 本地工具使用 TanStack AI 支持的 Standard Schema 模式，从 Zod schema 生成模型可见 JSON Schema 并校验运行时输入；动态 JSON Schema（包括 MCP）使用现有官方 Ajv 校验器。移除工具路径对 pi-ai `validateToolArguments` 和 `Type.Unsafe` 的依赖。模型工具调用统一严格校验，不强制转换类型；这是有意的行为变更。参数改写之后和授权之前必须校验最终值，授权与执行使用同一份快照。具体合同与验收见施工图。
3. 后续按供应商将 TanStack `TextAdapter.chatStream()` 接入 Forge 当前 `StreamFn` 边界，并同时覆盖普通请求和摘要请求。传输事件、取消、usage、模型元数据、工具 schema、provider continuation 和失败分类必须按供应商验证。迁完一个供应商即撤下其 pi-ai 传输路径。
4. 所有传输迁移后，将公共模型/消息/流类型、目录/鉴权、预算和错误辅助函数改为 Forge 所有；清零 pi-ai import，删除依赖和补丁。保留本仓库维护的 Pi 来源 Agent 循环不等于保留 pi-ai 包。

## 备选方案

| 方案 | 取舍 |
|---|---|
| 只整理现有 `validateToolArguments` 调用 | 无法推进移除 pi-ai 的目标 |
| 直接用 TanStack `chat()` 和 `@tanstack/ai-mcp` 替换整条链 | 会同时改写循环、会话、权限及 MCP 所有权；当前原始 JSON Schema 路径也不能直接满足本地校验后授权的合同 |
| 同一供应商长期并行保留 pi-ai 与 TanStack 传输 | 增加两套成功/失败语义和回归面，不采用 |

## 后果

- 第一阶段会拒绝此前可能被 pi-ai 自动转换的参数；SDK 中英文指南及受影响测试必须同步。
- 阶段间暂时同时安装两个包，但每项职责只有一个生产实现。最终移除 pi-ai 以依赖清单和源码 import 清零为出口，而非只切换默认供应商。
- 本决策修订 [ADR-015](015-pi-core-source-migration.md) 中保留 pi-ai 的历史结论，以及 [ADR-022](022-mcp-host-integration.md) 对 Issue #36 施工期不替换 pi-ai 的范围限定；两者其余内核与 MCP 所有权决定仍生效。

## 实施状态

2026-09-26：工具参数严格校验、内置 TanStack 传输及 Forge 自有目录、认证、公共类型、费用和错误辅助已接入。根包与 core 的 `pi-ai` 依赖及补丁已移除，依赖门禁拒绝重新引入。无等价传输的 Mistral Conversations 与 Codex Responses 模型已从当前目录移除；内部装配层改名为 `session-port`。完整离线门禁及逐协议 AC-2 至 AC-5 的离线矩阵已通过；真实供应商 AC-7 因无凭据保持未测，证据见[传输施工图](../phases/tanstack-provider-transport-migration.md)。
