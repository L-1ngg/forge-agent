---
doc_kind: plan
created: 2026-09-27
---

# 工具参数、授权与批次合同

> 状态:严格参数校验合同保留；预执行、并行调度和 `terminate` 语义于 2026-09-28 被 [ADR-027](../decisions/027-native-tool-approval-and-interruption.md) 取代。当前审批与执行证据见 [Issue #39 施工图](native-tool-approval.md)，旧基座证据见[基座验收](tanstack-foundation-acceptance.md)。

内置工具使用 Zod Standard Schema，TanStack 公开转换/解析能力生成 JSON Schema 和 validateArguments。自定义 JSON Schema 与 MCP 远端 schema 使用官方 Ajv，无类型转换；工具自身处理路径、文件和业务状态检查。模型可见定义通过 `toolDefinition().server()` 进入 TanStack，旧 onPayload/schema 恢复包装已删除。

`session-tools.ts` 保留单工具的准备、校验、判权和结果转换；副作用只在 TanStack native `.server()` 中执行。顺序为 prepareArguments → JSON Schema 初检/自定义校验及复检 → toolInputRewrites/复检 → beforeToolCall/最终复检 → 复制最终参数 → 权限决定 → 原生审批续接 → execute → afterToolCall → 保存结果。宿主自定义校验器不能借由转换绕过初检，hook 或 rewrite 产生的非法值在权限之前拒绝。hooks 的调用身份和历史是隔离副本，只有 args 支持参数改写。授权视图冻结且与执行参数隔离，授权与执行观察同一份最终值；初始展示事件可以保留模型原参数。

每个普通调用声明 `needsApproval`。Forge 对最终参数按现有规则区分自动批准、自动拒绝和人工审批；只展示人工审批项，收齐整个批次的决定后用原生 snapshot/resume 继续。合法 `editedArgs` 重新校验与判权，不在批准后再次改写参数。原生工具按模型调用顺序串行执行，每项结果提交后才开始下一项。配置在审批及执行期间保留提案快照。

`beforeToolCall` 可以阻断，`afterToolCall` 可以覆盖 content/details/isError。单项拒绝或工具错误作为结果返回模型；停止整个 Invocation 使用 `abort()`。取消不启动尚未开始的工具，已开始的工具等待清理并保存实际结果；迟到 `onUpdate` 忽略。取消不撤销已发生的外部副作用。

所有消息与工具结果保存失败都停用实例；不包装成成功，也不因重试重复已执行工具。恢复历史中的缺失结果只形成请求投影，不自动重放副作用。

验证保留非法类型/缺字段/额外字段、复杂 `$defs`/组合 schema、最终授权参数一致、hook 干预、原生串行、取消/迟到更新和存储屏障。入口为 `native-approval.test.ts`、`tool-arguments.test.ts`、`session-tools.test.ts`、`runtime-tools.test.ts`、`sdk-mcp.test.ts` 和 `tests/loop-contract/`。原始严格校验迁移与 807 项历史证据见[2026-09-26 归档](../archive/phases/tool-argument-validation-2026-09-26.md)。
