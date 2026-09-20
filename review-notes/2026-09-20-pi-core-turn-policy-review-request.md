---
doc_kind: review-request
created: 2026-09-20
---

# 交接：Pi Agent 逐轮停止策略交付与下一项设计

Target: `master`，`/home/l1ngg/dev/forge-agent`
SHA-or-Doc-Version: `298dece44d90fea40b656cc66f8190b914e2c81e`（本轮实现；本文另作后续文档提交）。

## What / 当前停点

`shouldStopAfterTurn` 已实现、通过本地离线验收并提交。下一窗口继续 Pi 标准 Agent 内核设计优化，按“一个一个来”讨论第 2 项剩余的 `onPayload/onResponse`，随后再讨论宿主上下文变换。这些剩余能力尚未批准施工；先明确场景和接口契约，不自动实现整个候选清单。

前一窗口上下文见 [StreamFn 交接](2026-09-20-pi-core-stream-fn-review-request.md)。其候选清单中 shouldStopAfterTurn 的“未实施”及 transformContext 注释的“待澄清”已被本文取代；其余范围约束仍有效。

## 原始需求

来源：2026-09-20 当前对话，operator 原话：

> 1. 我认可shouldStopAfterTurn的设计，赋予宿主业务在每轮任务结束时根据自定义策略（如工具已命中目标、费用阈值、轮数限制等）优雅截停 Agent 的能力，避免不必要的大模型续跑开销。
> 方案完全认可，契约定义、统计口径（轮数与用量缺失处理）以及阻断后续自动摘要的细节都非常严谨。可以按照这个方案推进施工，验收时重点关注命中后的‘零额外续跑’及回调异常时的安全结算。
> commit, 然后给我交接下一窗口需要完成的任务

## Why / 沿用的设计范围

- 只比较 Pi 标准 Agent 内核，不涉及 coding-agent Extensions、AgentHarness 或 Team。
- Forge 固定移植基线 `9767ba275f3e9a5ee0f5c5342249b629ab1b2282`；此前调查上游快照 `19451accdeec671c1f4da9eafac8fc270f510ef4`，不代表当前上游 main。本轮没有升级 Pi 或依赖。
- 主循环无需重做。保留 Forge 的 AgentTurn.result、输入归属与 processed 回执、配置 accepted/applied 时序。
- 定制模型统一用 streamFn，持久化用 storage，工具用 tools；公共 portFactory 已删除，不恢复，不直接暴露 RuntimeOptions。

## 已完成契约与代码入口

施工与验收真相源：[turn-policy.md](../docs/phases/turn-policy.md)。公共合同：[中文 SDK](../docs/sdk.md#每轮停止策略shouldstopafterturn)、[英文 SDK](../docs/sdk.en.md#stop-after-a-completed-round-shouldstopafterturn)。

- `createAgent({ shouldStopAfterTurn })` 仅在创建时设置；同步或异步返回 boolean，第二参数为 AbortSignal。updateConfiguration 在类型和运行时均拒绝修改该回调。
- 当前 assistant 响应、整批工具及必要持久化结束后，消费下一批 steering/follow-up 前调用。无工具正常响应也调用。error/aborted/length/deferred、失败重试、摘要不计完成轮、不调用回调。
- 参数是隔离的只读快照：message、toolResults（SessionMessage 协议）、model、configurationRevision、turnIndex、usage。model/revision 在任务请求开始时捕获；turn_end 可以已应用新配置，但回调仍观察刚完成批次。
- 每次 runTurn/continue 独立计轮和累计用量。usage 包括任务、失败重试与自动摘要请求，排除历史和独立手动摘要。requests 计请求；tokens/costUsd 只要有缺失就为 null，并提供 missingUsageRequests/missingCostRequests。Pi 全零占位 usage 保守视为未知；正 token usage 的明确零费用仍是 0。
- 返回 true 后内核和会话层都停止后续模型请求，包括重试、恢复、自动摘要；agent_end.outcome 与 AgentTurn.result.status 为 success，并附 terminationReason=policy。不改模型 stopReason，不补最终自然语言回答，不回滚已完成结果或工具副作用。
- 回调抛错、拒绝或非 boolean 返回结算 error，不套用供应商重试；存储健康时可复用。取消优先，停止等待不合作回调，迟到返回/拒绝不影响新 invocation；无法撤销宿主回调的外部副作用。未消费输入 processed=false，已处理输入不重放。存储失败沿用实例停用合同。
- `transformContext` 与内核停止回调的类型注释已澄清：低层 loop 可传播异常，RuntimeAgent 负责失败/取消生命周期，会话策略还需阻断外层重试。没有修改移植主循环；预算失败不能被吞掉后继续发请求。

主要入口：

- [turn-policy.ts](../packages/core/src/turn-policy.ts)：公共回调类型、invocation 用量统计、只读快照、取消与失败分类。
- [agent-session.ts](../packages/core/src/agent-session.ts)：请求统计、摘要 driver 包装、配置快照、停止/异常阻断及最终事件。
- [agent.ts](../packages/core/src/agent.ts)、[protocol/turn.ts](../packages/protocol/src/turn.ts)、[protocol/events.ts](../packages/protocol/src/events.ts)：SDK 选项及最终结束原因。
- [runtime-turn-policy.test.ts](../packages/core/test/runtime-turn-policy.test.ts)：22 项公共 SDK 回归；[可运行示例](../examples/turn-policy.ts)。

## Tradeoff / 下一窗口需要完成的任务

### 下一步：讨论第 2 项中的 onPayload/onResponse

先核对当前 pi-ai 类型、runtime 转发及任务/摘要两条路径，再给出是否值得独立开放的结论与最小契约。

1. 区分具体目的：请求诊断、provider 参数定制、HTTP 响应元数据。`onResponse` 当前接收 HTTP status/headers，不是模型答案或 usage 回调；模型答案已有事件流。
2. 比较独立 SDK 选项与在现有 streamFn 内组合的实际收益。后者已可用；不要为了凑齐上游字段机械增加公共接口。
3. 如建议开放，定义任务/重试/摘要覆盖范围、与宿主 streamFn 的组合责任、异常/取消与等待时序。任务传输包装和摘要 driver 都要核对，不能只往 RuntimeAgent 透传字段。
4. `onPayload` 可在 provider 编码后替换 payload；修改 messages、tools 或输出限制会影响本地预算和 usage 的可解释性。先明确支持范围及保证边界，不声称任意 payload 改写仍受原预算保证。
5. 本步产出为可审查的场景与接口设计；沿用 operator“一个一个来”的节奏，在确认范围后实施。不要重复询问或重做已批准的 shouldStopAfterTurn。

### 随后：第 2 项中的宿主上下文变换

讨论检索/历史消息选择与现有记忆投影、压缩、convertToLlm 和最终预算检查的顺序。由 session 组合宿主能力，不能覆盖内置 transformContext；注入内容必须计入最终预算。错误/取消合同注释已澄清，但新的公共上下文回调尚未设计或实现。

### 后续独立候选：第 3、4 项

- 第 3 项：新版 Pi 的 system/tool transcript，把指令和工具声明变化放入消息历史。需整体考虑消息协议、存储、投影、压缩、预算；历史只能解释声明，不能恢复可执行工具、权限和外部环境。
- 第 4 项：prepareNextTurn 返回新增 messages，与配置生效和历史记录同一提交点一起设计。与第 3 项关联较强。
- 以上均未获施工或升级 Pi 的授权。原上游源码链接与调查判断见前一份交接。

## 验证证据

- Ran：实现完成后 `bun run check` 为 711 pass / 0 fail（contract 513、integration 185、CLI/PTY 13），包含新策略 22 项、依赖边界与 workspace/automation/tests 类型检查。Linux x64、Bun 1.3.12，network namespace 外网隔离通过。
- Ran：`bun run typecheck:examples`、`bun examples/turn-policy.ts`、`git diff --check` 通过。示例经公共 SDK 执行工具，模型请求恰好 1 次，结果 success + policy。
- 反向验证：移除 turnPolicy.stopped 会多出 summary 请求；移除 turnPolicy.failed 会将同步/异步策略异常错误重试；对应测试均变红。恢复后完整 check 通过。
- Not run / Why：真实供应商、生产网关、macOS、人工 TUI、独立 headless smoke 未运行；本次使用离线流及真实会话/工具/存储路径验证 SDK 合同。提交前仅更新文档交付状态，未再更改源码，因此未重复跑完整检查。
- Risk：费用是已报告值，批次后软限制不保证账单绝不超额；无法强制撤销任意宿主回调或工具的外部副作用。

## 工作区 / 提交 / Next Action

- 本轮实现提交：`298dece44d90fea40b656cc66f8190b914e2c81e`；本文另作文档提交，最新 HEAD 以 git log 为准。均未 push、修改远端 Issue 或发布。
- 前置提交：`3be2176` 为 StreamFn 交接；`9f6c1ff` 为 StreamFn/factory 收敛；`74c6937` 单独保存原有文档。
- 注意历史文档滞后：Skills 已在 `7a8fbff` 实现；docs/phases/skills.md 的旧草稿和 docs/plan.md 的旧待施工行不能作为重复实施依据。
- 新窗口先读 AGENTS.md、本文和所引 SDK 合同，执行 git status --short 与 git log -4 --oneline 核对现场；随后从 onPayload/onResponse 的场景与接口讨论继续。提交授权不等于推送或所有剩余候选项施工授权。
