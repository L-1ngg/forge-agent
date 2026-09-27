---
doc_kind: historical
archived: 2026-09-27
superseded_by: ../../../phases/tanstack-foundation.md
---

> 历史记录：Pi 执行内核已由 TanStack `chat()` 替代，以下“当前”与验证结果属于当时版本；旧源码、测试和差分脚本只可在历史提交复现。当前执行合同见 [TanStack 基座](../../../phases/tanstack-foundation.md)，本目录只保留来源、合法许可与历史行为证据。

# 基线之后的接入差异

> 状态：会话接入实现（2026-09-08），基线提交 `3b4d961`，不是标准上游的新行为。验收归 [#21](https://github.com/L-1ngg/forge-agent/issues/21)。

增加可选 `shouldStopAfterResponse` 栅栏：assistant 的 `message_end` listeners 已结算，工具准备尚未开始。返回 true 时发送当前 `turn_end` 和 `agent_end`，不形成工具结果。默认未设置，原有上游分支不变。

Forge 使用此栅栏处理 `length` 与 `deferred`。前者保留已有“不执行截断调用、不为截断调用保存错误工具结果”的上下文合同，再由会话层决定是否单次恢复；后者结束 invocation，保留未消费输入回执，不引入后台 polling。原样上游 length+tools 的错误结果与续轮仍由独立基线及未设置栅栏的同源测试覆盖。

会话级存储、压缩、重试及输入回执均位于 `agent-session.ts`，不复制到 Core。差分脚本 `--behavior-only` 验证未设置新增栅栏时的默认轨迹；基线的逐字执行代码核对以独立基线提交为准。

工具结果的 JSON 可持久化检查和快照在会话工具 execute/after hook 内完成；坏结果成为该调用的错误，仍等待同批其他工具。进度也使用快照，Core 忽略结算后的迟到进度。Forge 将原生 `details` 独立保存，只将 `content` 投影给模型。

取消保留上游已准备调用的错误记录以及必要 aborted assistant；不会启动新模型请求或未启动工具。完整历史保留记录，请求投影排除错误/取消响应，不重放不确定效果。会话关闭时返回未消费的 steering/follow-up 回执。

配置通过会话队列在完整批次结束时应用；对上一响应的 overflow/length/retry 判定固定使用生成该响应的 driver。摘要与任务重试计数相互独立，不改 Core 的普通调度分支。

## #35：异步输入准备（2026-09-19）

新增可选 `prepareInputMessage(message, signal)`，在初始输入与 steering/follow-up 消费点、上下文变更和 user 事件之前等待宿主准备。默认未设置时保持原有循环；不新增队列或 Agent loop。Forge 使用它检查显式 Skill 输入的权限、取消、版本和预算，再形成一条 user message；失败沿 runtime 原有错误结算，未准备输入不进入 user 历史。Skill 的 processed 回执在 user 保存成功后结算，普通文本保持原有确认语义。输入 id 和拒绝事件归 session/SDK，不写入上游 AgentMessage 协议。

## 回调异常合同澄清（2026-09-20）

`types.ts` 的 transformContext/shouldStopAfterTurn 注释明确区分低层 loop 的异常传播与 RuntimeAgent 的失败生命周期。会话预算或取消失败必须阻止请求，宿主停止策略异常还必须阻断会话层的供应商重试/恢复。仅修正文档合同，不修改移植主循环；SDK 组合见 [逐轮停止策略](../../../phases/turn-policy.md)。

## #36：宿主精确参数校验（2026-09-21）

新增可选 `AgentTool.validateArguments`，参数准备后优先使用宿主校验器，未设置时保持 Pi 默认校验。MCP 使用官方 Ajv 多 dialect 校验且不做 coercion，避免授权前后参数漂移；权限与最终参数冻结继续归 `session-tools.ts`，执行内核不识别 MCP 协议。

## 工具参数统一严格校验（2026-09-26）

上述 #36 记录的是初始实现。现行工具参数合同见 [第一阶段施工与验收](../../../phases/tool-argument-validation.md)：运行时改用 Forge 入口，对原始参数及宿主校验器返回值均使用 JSON Schema 严格校验；内置工具从 Zod Standard Schema 生成模型可见 schema。`session-tools.ts` 在改写和 hook 后再次校验，授权与执行使用同一参数快照，并在 provider payload 恢复完整工具 schema。
