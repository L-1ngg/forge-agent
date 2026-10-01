---
doc_kind: plan
created: 2026-09-27
---

# 工具参数、授权与批次合同

> 状态:当前参数与保存时序按 [ADR-030](../decisions/030-native-arguments-and-conversation-persistence.md) 简化(2026-10-01)。施工与本次验收见[会话中间件简化](session-middleware-simplification.md)。原生审批首次证据见 [Issue #39 施工图](native-tool-approval.md)，旧基座证据见[基座验收](tanstack-foundation-acceptance.md)。

内置与官方工具直接使用 Standard Schema，由 TanStack 校验。自定义 JSON Schema 与 MCP 远端 schema 使用官方 Ajv 的薄 Standard Schema 接口进入原生校验，无类型转换；工具自身处理路径、文件和业务状态检查。模型可见定义通过 `toolDefinition().server()` 进入 TanStack。

`session-tools.ts` 保留单工具的判权和结果转换；副作用只在 TanStack native `.server()` 中执行。顺序为原生校验 → beforeToolCall 观察/阻止 → 权限决定 → 原生审批续接 → execute → afterToolCall → 批次会话保存。删除 `prepareArguments`、`toolInputRewrites`、`validateArguments` 与重复终检。hook 参数是观察副本，转换属于工具内部逻辑。

每个普通调用声明 `needsApproval`。Forge 对原生已校验参数按现有规则区分自动批准、自动拒绝和人工审批；只展示人工审批项，收齐整个批次的决定后用原生 snapshot/resume 继续。`editedArgs` 交给原生 schema 校验，不重新判权或记录修订；人工批准授权编辑后的调用。原生工具按模型调用顺序串行执行，批次完成后按提案与结果顺序保存。配置在审批及执行期间保留提案快照。

`beforeToolCall` 可以阻断，`afterToolCall` 可以覆盖 content/details/isError。单项拒绝或工具错误作为结果返回模型；停止整个 Invocation 使用 `abort()`。取消不启动尚未开始的工具，已开始的工具等待清理并保存实际结果；迟到 `onUpdate` 忽略。取消不撤销已发生的外部副作用。

所有消息与工具结果保存失败都停用实例；不包装成成功，也不因重试重复已执行工具。恢复历史中的缺失结果只形成请求投影，不自动重放副作用。

验证保留非法类型/缺字段/额外字段、复杂 `$defs`/组合 schema、hook 干预、原生串行、取消/迟到更新和保存错误。保存失败可能发生在本批副作用之后，进程崩溃可能丢失最新批次。入口为 `native-approval.test.ts`、`tool-arguments.test.ts`、`session-tools.test.ts`、`runtime-tools.test.ts`、`sdk-mcp.test.ts` 和 `tests/loop-contract/`。原始严格校验迁移与 807 项历史证据见[2026-09-26 归档](../archive/phases/tool-argument-validation-2026-09-26.md)。
