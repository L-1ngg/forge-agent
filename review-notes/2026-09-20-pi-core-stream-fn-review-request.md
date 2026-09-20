---
doc_kind: review-request
created: 2026-09-20
---

# 交接：Pi Agent 内核对比、StreamFn 与装配入口收敛

Target: `master`，`/home/l1ngg/dev/forge-agent`
SHA-or-Doc-Version: `9f6c1ffae59676d1376096a00bf2026bb0f0ac50`（本轮实现及验收对应的源码）；本文版本 2026-09-20。

## What / 当前停点

本轮已完成 Pi Agent 内核对比中的第一项优化：SDK 采用 Pi `StreamFn`，随后按 operator 要求彻底删除公共 `portFactory`，模型测试迁移到流注入。后面的执行策略回调和新版消息历史设计只讨论过，尚未批准施工或实现。新窗口应从下一项设计讨论继续，不重复实现 StreamFn，也不恢复 factory。

本地提交：

- `74c6937`：原样保存本轮开始前已有的 5 个文档改动，operator 在交接前明确同意单独提交。
- `9f6c1ff`：本轮 StreamFn、SDK/CLI 装配入口收敛、测试迁移、双语文档与验收记录。
- 本交接文档另作一个文档提交。没有 push、远端发布或 Issue 修改；提交授权不等于推送授权。

## 原始需求

来源：2026-09-20 当前对话，operator 原话：

> 先只限制在Pi Agent 内核上，你认为当前系统和pi的设计差异是什么？有哪些可以挪用的技术和设计？
> 一个一个来，首先关于第一点，我认可Pi的StreamFn的方案，你可以直接迁移采用他的设计，
> 把那些“明明只是想模拟模型返回值，却兴师动众用了 portFactory”的老测试，全部改成用轻巧的 streamFn或删除。
> 把对外公开的 portFactory 彻底删掉。不要给外部开发者提供两个概念重复、一大一小的入口，避免大家用错。
> 以后规矩定死：定制模型就老老实实用 streamFn；定制数据库或工具，就走专门的 storage 或 tools 接口，权责分明。

## Why / 前面已得出的架构判断

比较范围是标准 Pi `Agent` 内核，不是 coding-agent Extensions，也不是 AgentHarness。Forge 固定移植基线为 `9767ba275f3e9a5ee0f5c5342249b629ab1b2282`，见 [runtime/upstream.json](../packages/core/src/runtime/upstream.json)。前面调查的上游快照为 [`19451accdeec671c1f4da9eafac8fc270f510ef4`](https://github.com/earendil-works/pi/tree/19451accdeec671c1f4da9eafac8fc270f510ef4/packages/agent/src)，这是当时核对的版本，不是对未来上游 main 的保证。

最初的 hook 数量澄清：`ToolHooks` 的 `beforeToolCall`、`afterToolCall` 是两个回调，`toolExecution` 是调度配置；另有 `permission.hooks[].evaluate`、`toolInputRewrites`，内部 runtime 还有更多回调。不能把“三个字段”说成“整个系统只有三个 hook”，也不要把 coding-agent 的事件清单混进内核范围。

主要结论：Forge 已复用 Pi 大部分执行机制，主循环没有重做必要。差异重点是公共 SDK 开放边界，以及较新 Pi 的上下文表示方式。

| 维度 | 已确认判断 |
|---|---|
| 机制与策略 | Pi runtime 负责循环、状态、工具调度；Forge 会话层拥有权限、存储、压缩、重试、输入回执，这个分层保留 |
| 宿主扩展 | 之前模型注入粒度过大，必须替换整个 AgentPort；本轮已改为 StreamFn |
| 配置修改 | Forge 的 `updateConfiguration` 排队，accepted/applied 分离，完整批次/摘要后生效，优于任意时刻修改共享 state，保留 |
| 完成与输入 | `AgentTurn.result`、`expectedTurnId`、processed receipt 有真实宿主用途，保留；消费事件后读取最终 result |
| prompt/tools | Forge 仍通过独立 systemPrompt/tools 配置构建请求；调查时的新 Pi 将指令与工具声明变化放入 system messages，这是后续独立设计候选 |

已经借用、不要误报为待实现的能力：`transformContext → convertToLlm` 两阶段投影；整批工具先准备再并发执行、结果按调用顺序进入历史；工具 `content/details` 分离；状态归约后等待 listener，让持久化参与结算。

本地 runtime 的 `shouldStopAfterResponse` 用于 length/deferred 的工具准备前栅栏，`prepareInputMessage` 用于消费显式 Skill 前的异步校验，均有具体会话需求，见 [local-changes.md](../packages/core/src/runtime/local-changes.md)。不要为追求表面上游一致而删除。

## 本轮已完成的实现

1. `createAgent({ model, streamFn, ... })` 支持完整 `Model<string>`、同步或异步 `StreamFn`，直接复用本地 Pi 类型；未知模型不必注册 catalog。字符串 provider/model 默认路径保持可用。
2. 任务、任务重试、压缩摘要使用同一生效流函数。传递 signal、apiKey、sessionId、输出预算与推理设置；模型流遵守 Pi 终态协议，失败/取消通过 error/aborted AssistantMessage 表达。
3. `updateConfiguration({ model, streamFn })` 在现有生效边界应用；模型对象快照；失败更新不污染当前配置。`streamFn: null` 恢复内置传输，必须配套 catalog 字符串模型。
4. `createAgent` 只接受一个 options 参数；TypeScript 拒绝第二参数，JavaScript 多余实参在任何装配/存储读取前抛 TypeError。删除 `assertPortCapabilities`、CLI main/SessionHost 的 factory 参数与透传。
5. 包入口不再导出 `createPiPort`、`createPiTestPort`、`AgentPort`、`PiPortOptions`、`ModelPortOptions` 等内部装配接口。内部 `createPiPort/AgentSession` 仍负责生产装配。
6. 旧 SDK/宿主/PTY 模型替身改用 `fauxModel` 或 `scriptedModel`，二者只返回 model/streamFn。storage/tools 故障由各自选项注入；headless CLI smoke 改成本地 HTTP fixture。删除 create-test-agent/scripted-session 两个旧 helper。
7. 底层模块测试直接测试会话所需的 `createPiTestPort` 移到 `tests/support/test-port.ts`，复用 `fauxModel`；它不是公共 SDK factory，也没有 SDK 注入通道。
8. 旧装配测试 28 项改为 4 项现行合同测试，保留真实存储等待、失败与外部 RequestBus 归属覆盖；取消、恢复、输入、压缩、工具副作用继续经过生产路径验证。

`AgentSession` 内部 streamFn 包装仍保留：它检查取消、记录响应所属 driver、设定请求预算与 `maxRetries: 0`。这层具有会话职责，不能把它误认成已删除的最外层 factory。

主要入口：

- [施工与完整验收](../docs/phases/stream-fn.md)、[装配契约](../docs/phases/agent-assembly.md)、[中文 SDK](../docs/sdk.md)、[英文 SDK](../docs/sdk.en.md)。
- [createAgent](../packages/core/src/agent.ts)、[配置准备/摘要](../packages/core/src/session-configuration.ts)、[AgentSession](../packages/core/src/agent-session.ts)。
- [流契约测试](../packages/core/test/runtime-stream-fn.test.ts)、[装配测试](../packages/core/test/agent-assembly.test.ts)、[可运行示例](../examples/custom-stream.ts)。

## Tradeoff / 尚未实施的候选项（保留原讨论顺序）

### 2. 少量执行策略回调

候选：`shouldStopAfterTurn`、`onPayload/onResponse`、宿主上下文变换。

- `shouldStopAfterTurn`：完成工具批次后按轮次、成本或业务条件停止；先定义正常停止/结果状态及未消费输入归还。只能提供软限制，不能承诺严格不超预算。
- `onPayload/onResponse`：请求诊断、provider 参数定制和响应信息；先定义任务/摘要覆盖范围及对预算、usage 的影响。
- 上下文变换：宿主检索/消息选择；先确定与记忆投影、压缩、预算检查的顺序，注入内容必须计入最终预算。
- 不直接把整套 `RuntimeOptions` 暴露出去，也不让宿主覆盖内置 `transformContext`。由 session 组合回调并说明时序。

### 3. 新版 Pi 的 system/tool transcript

调查时的 Pi 把 prompt、工具声明及 `toolsAdded/toolsRemoved` 变化写入 system messages，可按消息序列解释动态配置位置。源码依据：[types.ts](https://github.com/earendil-works/pi/blob/19451accdeec671c1f4da9eafac8fc270f510ef4/packages/agent/src/types.ts)、[agent-loop.ts](https://github.com/earendil-works/pi/blob/19451accdeec671c1f4da9eafac8fc270f510ef4/packages/agent/src/agent-loop.ts)。

价值：历史可解释性、动态声明重建、稳定前缀的基础。缓存收益取决于 provider，尚未实测。成本：Forge 的消息协议/存储/投影/压缩/预算与 pi-ai 类型需一起调整，不能只替换 agent-loop。历史只能重建声明，不能恢复可执行工具函数、权限或外部环境。未批准升级 runtime/pi-ai 或迁移存储格式。

### 4. prepareNextTurn 返回新增 messages

新版 `AgentLoopTurnUpdate.messages` 可在下一轮前追加消息并产生正常消息事件，比任意修改 state.messages 更易保证时序。与第 3 项关联较强；考虑把配置生效与对应历史记录放在同一提交点。尚未实现。

## Open Questions

- 技术 OQ：本地 `transformContext` 类型注释沿用上游“不得抛错”，但会话预算不足、压缩失败、取消会抛错。公开此类回调前应明确异常/取消/最终 result 结算；这是待澄清的合同差异，不是已经证明的运行 bug。
- 方向 OQ：第 2 项先开放哪一个具体能力，operator 尚未选择；按“一个一个来”讨论，不一次性实现全部候选项。
- 不把 #34 已完成的职责收敛（InputFlow、CompactionCoordinator、Scenario 等）算成本轮新实现。

## 验证证据

- Ran：本轮最后一次 `bun run check` 为 689 pass / 0 fail（contract 513、integration 163、CLI/PTY 13），包括依赖边界、workspace/automation/tests 类型检查。Linux、Bun 1.3.12，network namespace 外网隔离探针通过。
- Ran：`bun run test:headless` 成功，真实 CLI 访问本地 HTTP fixture 输出 replay ok 与 agent_end success；`bun run typecheck:examples`、`bun examples/custom-stream.ts`、`git diff --check` 均通过。
- 反向验证：移除摘要 `await streamFn` 时配置时序测试失败；移除 createAgent 实参数量检查时旧 API 拒绝测试失败，finally 恢复后装配测试 4 pass。
- StreamFn 第一批曾为 713 项，通过删除 factory 后最终为 689 项，减少的 24 项来自 28→4 装配测试收敛，不要混用数量。
- Not run / Why：真实供应商、生产网关、macOS、人工 TUI 验收；本轮使用 Linux 离线流、HTTP 与真实 PTY 测试验证接入合同。提交前源码未再更改，未重复跑全仓测试。
- Risk：旧 factory 调用是明确授权的 API 破坏；具体宿主网关兼容性不由离线测试保证。

## 工作区与 Next Action

5 个原有文档按 operator 指令原样提交，不代表重新验收其中陈述。尤其 `docs/phases/skills.md` 仍标草稿/未实现，`docs/plan.md` 仍有 Skills 待施工行；但 HEAD 祖先 `7a8fbff` 已包含 Skills 实现。这些是历史文档状态滞后，不要据其重复实现 Skills。本轮没有擅自改写它们。

新窗口先读 AGENTS.md、本文及 StreamFn/SDK 当前合同，运行 `git status --short` 与 `git log -3 --oneline` 确认交接。继续只围绕 Pi Agent 内核，从候选第 2 项讨论具体场景与接口时序；已确认的 StreamFn/storage/tools 边界不要重新开放双入口。新功能在明确范围后推进，尚未授权推送或直接落地剩余候选项。
