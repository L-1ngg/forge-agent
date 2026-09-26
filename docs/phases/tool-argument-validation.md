---
doc_kind: plan
created: 2026-09-26
---

# 工具参数严格校验与 TanStack AI 接入

> 状态:已完成(2026-09-26)。迁移方向见 [ADR-024](../decisions/024-incremental-tanstack-ai-adoption.md)；本图只覆盖第一阶段。

## Why

`runtime/agent-loop.ts` 与 `session-tools.ts` 目前重复调用 pi-ai 校验器。pi-ai 对普通 JSON Schema 可能转换类型，MCP 则在授权前由官方 Ajv 原样校验。第一阶段把模型工具参数校验改成单一严格合同，并实际引入 TanStack AI 的 Standard Schema 能力，为后续模型传输迁移减少 pi-ai 职责。

## Entry Criteria

| # | 检查 | 通过标准 | 不通过怎么办 |
|---|---|---|---|
| E1 | 行为选择 | operator 确认普通工具类型不符直接拒绝 | 暂停行为变更 |
| E2 | TanStack 版本 | 锁定发布包的 schema 转换/解析 API，核对生成 JSON Schema | 不引入未经验证的 API |
| E3 | 工作区 | 保留现有上下文压缩相关改动 | 只编辑本阶段文件及必要文档入口 |

## What

- `@forge-agent/tools` 的内置工具以 Zod Standard Schema 为输入单一真相源；使用 TanStack AI 的公开转换与解析函数生成 `parameters` 和 `validateArguments`。工具自身仍负责文件存在、路径及业务状态等执行期检查。
- Forge 的默认 JSON Schema 校验改用官方 Ajv 严格校验。MCP 保留按不可变远端定义编译的校验器；宿主自定义 `validateArguments` 在 JSON Schema 初检后运行，其返回对象也必须通过同一 schema。
- 运行时准备、异步 `toolInputRewrites`、宿主 `beforeToolCall` 及授权按现有顺序工作；改写后、hook 后的最终参数再次校验并复制，权限与 `execute` 观察同一份值。初始 `tool_execution_start` 仍可显示模型原参数。
- provider payload 在现有 `onPayload` 接缝恢复全部宿主工具的原 JSON Schema，避免 pi-ai 的 Anthropic 转换遗漏 `additionalProperties` 等关键字。移除授权后改写参数的旧 `wrapTool`，由 `toolInputRewrites` 与 SDK 权限配置承接其用途。
- 不在本阶段迁移模型传输、`StreamFn` 公共类型、MCP 连接管理、会话存储或执行循环所有权。

## Acceptance Criteria

出口条件:以下 AC 通过并报告运行范围；未覆盖的真实供应商和平台保持未测。

- [x] AC-1:普通与 MCP 工具对错误类型、缺字段及非法额外字段在权限前拒绝，不执行工具；数值字符串不再自动转换。
- [x] AC-2:改写后或 hook 修改后的非法参数被拒绝；合法最终参数在授权请求、执行及 after hook 中一致。
- [x] AC-3:内置工具模型可见 schema 保留必填、数值上下限、描述及额外字段限制；文件/命令业务错误合同不变。
- [x] AC-4:复杂 MCP schema (`$defs`、组合、开放属性) 与配置快照仍正确；模型请求保留原 schema。
- [x] AC-5:工具路径不再 import pi-ai 的校验器或 `Type.Unsafe`；相关类型检查、离线测试及文档检查通过。

## Test plan

| 层 | 覆盖什么 | 跑在哪 |
|---|---|---|
| 工具与运行时测试 | 标准 schema、类型拒绝、准备/改写/授权/执行顺序和失败结果 | Bun 离线测试 |
| MCP 集成测试 | 复杂 JSON Schema、无 coercion、权限前拒绝、最终参数透传 | Bun 本地 HTTP fixture |
| 静态检查 | 工作区 typecheck、依赖边界、文档链接 | 仓库 `check` 与定向搜索 |

反向验证:将一个应被拒绝的数值字符串输入放行时，AC-1 的测试必须变红。

## 验收证据（2026-09-26）

- Ran: `bun run check` 通过，含依赖边界、工作区/自动化/测试类型检查及 Linux 离线网络隔离探针；contract 529、integration 264、CLI/PTY 14 项，合计 807 pass / 0 fail。`git diff --check` 通过。
- Ran: `tool-arguments.test.ts` 检查自定义校验器不能接收数值字符串或返回不符 schema 的结果；`session-port.test.ts` 检查改写/hook 后拒绝及授权、执行、after hook 参数一致；`sdk-integration.test.ts` 检查内置 `read` schema 在 Anthropic 请求中保留约束；`sdk-mcp.test.ts` 检查复杂远端 schema、无 coercion 和配置快照。
- 反向验证:临时跳过首次 JSON Schema 检查后，自定义校验器测试因收到 `"3"` 而变红；恢复后测试通过。
- Not run:真实供应商请求与 macOS 验证。Why:本阶段验收使用锁定版本、本地 HTTP fixture 与当前 Linux 环境。Risk:真实供应商对完整 JSON Schema 关键字的接受度及其他平台行为尚无本次证据；provider 拒绝会作为请求错误暴露。

## Rollback

本阶段不迁移会话数据。回退时整体撤销工具 schema、校验器与依赖改动，并恢复对应 SDK 文档；不能在失败时跳过本地校验继续执行。

## Risk

| 风险 | 缓解 |
|---|---|
| 生成 JSON Schema 与原内置定义不等价 | 对模型请求中的代表性 schema 做结构断言 |
| 严格校验改变既有宽松调用 | SDK 文档明示，测试覆盖数字字符串和可选字段 |
| Ajv dialect、引用或额外属性处理不一致 | 复用官方多 dialect 校验器，运行 MCP 复杂 schema 探针 |
