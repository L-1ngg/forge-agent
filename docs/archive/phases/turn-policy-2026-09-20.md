---
doc_kind: plan
created: 2026-09-20
---

# 宿主逐轮停止策略

> 状态:已归档(2026-09-27)。执行基座与模型接缝已由 [TanStack 基座](../../phases/tanstack-foundation.md) 替代；当前合同与本次证据从该入口读取。下文按记录版本解释，未测和豁免保持原含义。

> 历史状态：已实现并通过本地离线验收（2026-09-20）。operator 已确认设计、统计口径及停止后阻断自动摘要，并授权施工。前置交付见 [StreamFn](stream-fn.md)。

## Entry / Why

交接 HEAD 为 `3be2176`，工作区干净。SDK 已统一使用 StreamFn/storage/tools；本项仅开放 `shouldStopAfterTurn`，复用固定 Pi runtime 的完整批次停止位置。宿主可在工具命中目标、轮数或费用达到阈值时结束 invocation，避免额外模型调用。

## Design

- `createAgent({ shouldStopAfterTurn })` 是创建时设置的可选回调，不新增动态配置入口。同步或异步返回 boolean，第二参数为 AbortSignal。
- 输入是隔离的深只读快照：`message`、`toolResults`、`model`、`configurationRevision`、`turnIndex`、`usage`。model/revision 在当前任务请求开始时捕获；不因 turn_end 已应用新配置而改变。
- 每次 runTurn/continue 独立计轮。正常 assistant 响应和完整工具批次算一轮；失败重试、摘要、error/aborted/length/deferred 不调用回调、不计完成轮数。
- usage 按实际任务/摘要请求累计，包含失败重试及无有效终态的尝试，不含历史和独立手动压缩。公开 requests、tokens、costUsd、missingUsageRequests、missingCostRequests；只要有缺失，对应总量为 null。Pi 全零 usage 无法区分未报告与实际零消耗，保守视为未知；正 token usage 配套明确零费用仍可为 0。不推测未知定价、不把缺失费用填零。
- 回调在消息、工具结果持久化完成后，消费下一批 steering/follow-up 前运行。返回 true：会话也停止后续重试、恢复、自动摘要；终态 success + terminationReason=policy，不改模型 stopReason，不补自然语言回答。未消费输入 processed=false；已完成结果与副作用保留。
- 抛错或非 boolean 返回是策略失败：error 结算，不走供应商重试/恢复。异步等待可取消；取消优先于迟到返回或异常；回调应响应 signal，框架不等待其不合作的后台工作。存储失败继续按原合同停用实例。
- 保留 accepted/applied 时序；不暴露 RuntimeOptions 或可变 AgentContext，不升级 Pi。澄清 transformContext 的层级合同：低层 loop 可传播异常，RuntimeAgent 将其结算为失败/取消；会话预算检查不得吞异常并继续发请求。

## Batches / Verify

1. 公共类型、结束原因和会话策略组合；完整请求用量统计。
2. SDK 集成测试覆盖生产装配、取消、慢存储、输入与配置交错；双语 SDK 文档。
3. 定向测试、完整 check、示例类型检查；反向注入额外续跑与异常重试，确认回归测试变红后恢复。

- [x] AC-1：工具命中/轮数策略只在完整批次保存后运行；命中后无任务或摘要模型调用，结果与 agent_end 标记一致。
- [x] AC-2：同步/异步异常安全结算，不重试、不重复工具；取消优先且实例可复用；存储失败不调用策略。
- [x] AC-3：未消费输入恰好返还，已处理输入不重放；配置生效不污染完成批次快照。
- [x] AC-4：轮数按 invocation 重置；任务/失败重试/摘要 usage 恰好累计一次，缺失为 null；历史与手动摘要不计入。
- [x] AC-5：全仓检查、示例类型检查和反向验证通过，更新接入合同及验证边界。

## Release / Rollback / Risk

出口为上述 AC 完成；真实供应商费用准确性、生产网关、macOS 与人工 TUI 不作为本次离线合同验收的出口。默认不设置回调时沿用既有执行行为。回退本项 SDK/协议/会话/测试/文档改动即可，无存储格式迁移；不得吞掉已启用策略的异常作为降级。费用仅是已报告值，批次后判断是软限制；任意工具和宿主回调的外部副作用不可回滚。

## 验证记录

- Ran：`bun run check` 通过，711 pass / 0 fail：contract 513、integration 185、CLI/PTY 13。Linux x64、Bun 1.3.12，network namespace 外网隔离探针通过；含依赖边界及 workspace/automation/tests 类型检查。
- Ran：新增 `packages/core/test/runtime-turn-policy.test.ts` 22 项通过。包含慢存储、整批工具结果、配置切换快照、processed 回执、重试/摘要累计与缺失统计、创建期配置限制、取消迟到回调隔离、存储失败、正常继续对照与策略失败后复用。
- Ran：`bun run typecheck:examples`、`bun examples/turn-policy.ts` 与 `git diff --check` 通过。可运行示例经公共 SDK 完成真实工具执行，结果为 success + policy，模型请求恰好 1 次。
- 反向验证：临时移除会话层 `turnPolicy.stopped` 保护，摘要对照用例发现多出的 summary 请求；临时移除 `turnPolicy.failed` 保护，同步抛错与异步拒绝用例均发现错误 retry 事件。均已恢复，随后完整 check 通过。
- Not run / Why：真实供应商、生产网关、macOS、人工 TUI 与独立 headless smoke 未运行。本次聚焦公共 SDK 生命周期与统计合同，使用本地 StreamFn、真实会话/工具/存储路径及现有 CLI/PTY 回归。
- Risk：费用是已报告值而非实际账单保证；Pi 全零 usage 无法证明免费，按未知处理。取消仅停止等待不合作回调，不能撤销其外部副作用。没有修改 runtime 主循环或存储格式。
- Release：本轮交付范围为本地实现、双语接入文档和离线示例；提交与交接以 Git 记录和 review-notes 为准。本轮未 push 或修改远端 Issue。
