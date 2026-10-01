# 完整 Agent 装配契约

> 状态:原生 TanStack 装配已实现；内部执行职责已按 [Issue #45](native-execution-issue-45.md) 收敛并通过本地离线门禁(2026-10-01)。设计见 [ADR-025](../decisions/025-tanstack-agent-foundation.md)，原版本验证见[基座验收](tanstack-foundation-acceptance.md)；外部验收单列。

`createAgent(options)` 创建唯一的生产 `AgentSession`，直接实现公开 `Agent`。SDK、CLI 和 TUI 共用此路径；`session-assembly.ts` 只准备模型、Skills 和 MCP 资源，不持有第二份运行状态。`HostedAgent`、`AgentPort`、`session-port`、Pi runtime 已删除。

2026-10-01 的 [Issue #45](native-execution-issue-45.md) 将原生执行接线与响应批次结算收敛到内部 `runNativeExecution`。`AgentSession` 提供请求快照、投影预算、历史提交及作用域释放操作，继续拥有输入、配置、存储故障和 Invocation 结果；不直接操作 `SessionResponse`。没有新增公共执行接口或第二个 runner。

宿主注入模型使用原生 `adapter`，会话数据使用 `storage`，工具使用 `tools`，上下文与停止策略使用对应回调。模型、工具和存储的扩展不需要替换整个执行实例。JavaScript 多余创建实参、旧 `streamFn` 也在存储读取或请求前拒绝。

创建先复制配置、读取 `SessionStorage.load()` 一次并等待完成，再准备资源和实例。历史只以 `SessionState` 为恢复真相源，MCP/Skills 的装配不会再次加载或重写用户数据。创建失败释放本次创建的 MCP 资源，关闭内部 `RequestBus`；宿主提供的外部总线保持可用。清理失败时保留原错误与清理错误。

运行中的配置经串行准备返回 accepted revision，在完整响应和工具批次结束后 applied。输入准备、任务请求、工具批次及正在执行的摘要使用一致快照；accepted 不等于提前替换当前材料。销毁取消未应用配置，等待正在进行的存储、工具和资源释放，并结算同一个权威 result。

验收覆盖公开 SDK、真实会话存储与本地 HTTP：创建读取屏障/故障、参数快照、完整批次、配置切换、取消、存储失败停用、idle/dispose、CLI/PTY。历史装配实施记录见[2026-09-20 归档](../archive/phases/agent-assembly-2026-09-20.md)，该版本内部 API 不再是当前接入方式。数据格式未变；本地回退需同时恢复实现、公开接口、调用方和文档，不自动改写真实数据。
