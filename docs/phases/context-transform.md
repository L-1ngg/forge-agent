---
doc_kind: plan
created: 2026-09-27
---

# 宿主上下文变换与最终请求预算

> 状态:合同保留，已迁入 TanStack 请求边界；自动压缩的本轮有效固定材料预算见 [Issue #43](https://github.com/L-1ngg/forge-agent/issues/43) (2026-09-29)。离线软件验收以对应版本证据为准，外部验收单列。预算决策见 [ADR-021](../decisions/021-host-context-transform-and-request-budget.md)，执行接线由 [ADR-025](../decisions/025-tanstack-agent-foundation.md) 替代，接入见 [SDK](../sdk.md#宿主上下文变换)。

`transformContext(context, signal)` 在创建时配置，对每次任务请求收到深只读的 `SessionMessage[]`、model、configurationRevision 和预算快照，返回完整的请求投影。动态更新回调被类型和运行时拒绝。返回值经复制与结构校验，不能改变 SessionStorage 原文或下一请求；新增资料不是新的用户授权，provider 的不透明签名由宿主保持。

TanStack middleware 的 `onConfig(beforeModel)` 统一执行以下顺序：

1. 在输入准备前应用到期配置，锁定该请求的模型、system、tools、Skills、reasoning、输出和 revision；读取本轮 Memory/Skills middleware 的有效提示词及完整工具定义。
2. 用该请求的固定材料和输出设置，基于当前分支原文判断软线、选择近期原文并结算压缩事件。固定材料或必留原文无法放入预算时，在模型 I/O 前失败且不保存检查点；摘要不调用宿主变换。
3. 对压缩后的规范化消息调用一次宿主回调，并校验角色、内容、工具调用/结果配对及可序列化参数。
4. 将宿主临时投影与本轮有效 system、完整工具 schema 合并，检查最终预算；工具 details 不作为模型内容。`model-response.ts` 统一转换成 native `ModelMessage`，请求副本不带历史 usage。
5. 检查取消后调用原生 adapter；实际请求进入本轮用量统计。工具续轮、排队输入、有限重试均重新准备投影。手动压缩和 overflow 恢复使用各自发起时的预算，不借用旧任务请求快照。

软硬线保持分离，W 为 contextWindow，O 为实际有效输出（包含适用 reasoning 预算）：

```text
softMargin = max(1024, ceil(W * 0.02))
inputBudget = W - max(reserveTokens, O + softMargin)
maxInputTokens = W - O - 1024
```

最终输入 I 同时覆盖 system、工具/schema、文本、图片、reasoning 和工具参数；I 大于 maxInputTokens 时拒绝，等于时放行。不使用旧 provider usage 证明容量，不因窗口不足悄悄缩小输出。普通任务在关闭自动压缩时仍检查硬线；摘要有独立输入/输出预检和调用次数限制。

固定余量和字符估算不是供应商物理窗口的精确保证，因此继续保留有界 overflow 恢复。旧 pi-ai 的 `clampMaxTokensToContext` 及 4096 余量预检已撤下。自定义 adapter 的二次改写、额外限额及宿主精简后质量由宿主承担。

回调异常、非法返回、预算失败属于准备失败，以 error 结算，禁止进入供应商重试或压缩救援。取消优先于迟到 resolve/reject，框架不等待不合作宿主回调；不能撤销其外部副作用。已 processed 输入不返还或重放，未消费队列 processed=false。存储失败仍停用实例。

配置在回调等待期间可以 accepted，当前请求保持原快照，完整响应和工具批次后再 applied。不要在回调内等待当前 turn.result、waitForIdle 或依赖本轮结束的 applied。压缩事件中的前后 token 估算使用本轮固定材料；getUsage 在请求准备完成后反映最终投影估算，历史/配置变更后清理该临时快照。

当前验证入口为 `request-compaction-budget.test.ts`、`context-transform.test.ts`、`request-budget.test.ts`、`context-http.test.ts`、`runtime-turn-policy.test.ts` 与基座[验收记录](tanstack-foundation-acceptance.md)。原始施工、752 项历史测试及旧预检的反向验证见[2026-09-21 归档](../archive/phases/context-transform-2026-09-21.md)，不作为本次或真实供应商的新证据。
