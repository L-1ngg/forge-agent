# 基线之后的接入差异

> 状态：会话接入实现（2026-09-08），基线提交 `3b4d961`，不是标准上游的新行为。验收归 [#21](https://github.com/L-1ngg/forge-agent/issues/21)。

增加可选 `shouldStopAfterResponse` 栅栏：assistant 的 `message_end` listeners 已结算，工具准备尚未开始。返回 true 时发送当前 `turn_end` 和 `agent_end`，不形成工具结果。默认未设置，原有上游分支不变。

Forge 使用此栅栏处理 `length` 与 `deferred`。前者保留已有“不执行截断调用、不为截断调用保存错误工具结果”的上下文合同，再由会话层决定是否单次恢复；后者结束 invocation，保留未消费输入回执，不引入后台 polling。原样上游 length+tools 的错误结果与续轮仍由独立基线及未设置栅栏的同源测试覆盖。

会话级存储、压缩、重试及输入回执均位于 `agent-session.ts`，不复制到 Core。差分脚本 `--behavior-only` 验证未设置新增栅栏时的默认轨迹；基线的逐字执行代码核对以独立基线提交为准。

工具结果的 JSON 可持久化检查和快照在会话工具 execute/after hook 内完成；坏结果成为该调用的错误，仍等待同批其他工具。进度也使用快照，Core 忽略结算后的迟到进度。Forge 将原生 `details` 独立保存，只将 `content` 投影给模型。

取消保留上游已准备调用的错误记录以及必要 aborted assistant；不会启动新模型请求或未启动工具。完整历史保留记录，请求投影排除错误/取消响应，不重放不确定效果。会话关闭时返回未消费的 steering/follow-up 回执。

配置通过会话队列在完整批次结束时应用；对上一响应的 overflow/length/retry 判定固定使用生成该响应的 driver。摘要与任务重试计数相互独立，不改 Core 的普通调度分支。
