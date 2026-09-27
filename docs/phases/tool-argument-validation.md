---
doc_kind: plan
created: 2026-09-27
---

# 工具参数、授权与批次合同

> 状态:严格合同保留，已合并到单一工具批次路径，本轮离线软件验收已通过，外部验收单列(2026-09-27)。执行归属见 [ADR-025](../decisions/025-tanstack-agent-foundation.md)，验证见[基座验收](tanstack-foundation-acceptance.md)。

内置工具使用 Zod Standard Schema，TanStack 公开转换/解析能力生成 JSON Schema 和 validateArguments。自定义 JSON Schema 与 MCP 远端 schema 使用官方 Ajv，无类型转换；工具自身处理路径、文件和业务状态检查。模型可见定义通过 `toolDefinition().server()` 进入 TanStack，旧 onPayload/schema 恢复包装已删除。

`session-tools.ts` 是唯一副作用路径：prepareArguments → JSON Schema 初检/自定义校验及复检 → toolInputRewrites/复检 → beforeToolCall/最终复检 → 复制最终参数 → 权限 → execute → afterToolCall → 保存结果。宿主自定义校验器不能借由转换绕过初检，hook 或 rewrite 产生的非法值在权限之前拒绝。hooks 的调用身份和历史是隔离副本，只有 args 支持参数改写。授权视图冻结且与执行参数隔离，授权与执行观察同一份最终值；初始展示事件可以保留模型原参数。

TanStack 触发 beforeTools 时 Forge 准备整批并串行授权；默认并行执行，显式 toolExecution=sequential 或批次任意工具 executionMode=sequential 时整批串行。串行模式在每个结果保存后才开始下一个副作用；并行模式可同时执行，但结果按原调用顺序保存。原生 execute 只领取已经完成的结果，不再次执行工具。

beforeToolCall 可以阻断，afterToolCall 可以覆盖 content/details/isError/terminate。只有整个批次均 terminate 时自动停止；混合结果继续，让模型处理失败或剩余结果。取消不启动尚未开始的工具，已开始的工具等待清理并保存实际结果；迟到 onUpdate 忽略。取消不撤销已发生的外部副作用。

所有消息与工具结果保存失败都停用实例；不包装成成功，也不因重试重复已执行工具。恢复历史中的缺失结果只形成请求投影，不自动重放副作用。

验证保留非法类型/缺字段/额外字段、复杂 `$defs`/组合 schema、最终授权参数一致、并行/串行、hook干预、取消/迟到更新和存储屏障。入口为 `tool-arguments.test.ts`、`session-tools.test.ts`、`runtime-tools.test.ts`、`sdk-mcp.test.ts` 和 `tests/loop-contract/`。原始严格校验迁移与807项历史证据见[2026-09-26 归档](../archive/phases/tool-argument-validation-2026-09-26.md)。
