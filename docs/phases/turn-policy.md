---
doc_kind: plan
created: 2026-09-27
---

# 宿主逐轮停止策略

> 状态:合同保留，已迁入 TanStack 完整响应/工具阶段，本轮离线软件验收已通过，外部验收单列(2026-09-27)。模型接缝见[原生 Adapter](model-adapter.md)，当前验证见[基座验收](tanstack-foundation-acceptance.md)。

`createAgent({ shouldStopAfterTurn })` 配置创建期可选回调。它收到隔离的深只读 message、toolResults、model、configurationRevision、turnIndex、usage 及 AbortSignal；模型/revision 取自当前请求快照，不因边界应用新配置而变化。

正常 assistant 响应和完整工具批次在持久化之后算一轮；失败重试、摘要、error/aborted/length/deferred 不计完成轮数，也不调用回调。每次 runTurn/continue 独立计数。策略位于下一批 steering/follow-up 消费前，返回 true 后阻断任务续轮、重试、恢复和自动摘要，以 success + terminationReason=policy 结算；不改原模型 stopReason，不补自然语言回答，未消费输入 processed=false。

usage 按实际任务与摘要请求累计，包括失败尝试，不含历史及独立手动压缩。requests 始终可计数；缺失 tokens/cost 对应总量为 null，并记录 missingUsageRequests/missingCostRequests。自定义 native adapter 显式的零费用保留为零，缺失费用不伪造免费。内置目录价格仅用于估算，不保证真实账单；批次结束后的判断属于软限制。

同步抛错、异步拒绝、非 boolean 返回按策略失败结算 error，禁止供应商重试或恢复。取消优先于迟到回调结果，框架停止等待并隔离迟到异常；不承诺撤销宿主副作用。存储失败不调用策略，并停用实例。

TanStack `onShouldContinue` 读取会话策略结果；无工具回答后排队新输入的会话调度同样遵守停止结果。没有第二套工具续轮。验证入口 `runtime-turn-policy.test.ts` 保留完整批次/慢存储、配置切换、输入回执、取消、费用与未知用量断言；离线示例 `bun examples/turn-policy.ts`。原始施工和711项历史证据见[2026-09-20 归档](../archive/phases/turn-policy-2026-09-20.md)。
