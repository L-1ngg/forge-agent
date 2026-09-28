---
doc_kind: plan
created: 2026-09-28
---

# Issue #39 权限审批与 interrupt 施工图

> 状态:已完成(2026-09-28)。任务范围与 AC 以 [Issue #39](https://github.com/L-1ngg/forge-agent/issues/39) 为准；架构取舍见 [ADR-027](../decisions/027-native-tool-approval-and-interruption.md)。

## Why

现有 `AgentSession` 在 native 工具阶段前由 Forge 逐项等待权限、预执行整个批次，再让 `.server()` 读取缓存结果。Issue #39 要把执行和审批续接交回 TanStack，并使拒绝、停止和最终结算各有明确语义。

## Entry Criteria

| 检查 | 通过标准 | 不通过怎么办 |
| --- | --- | --- |
| 规格 | Issue #39 已确定原生串行、进程内续接及公共测试边界 | 停在设计，不扩大权限产品范围 |
| 原生能力 | 已发布 0.61.0/0.63.0 探针覆盖多项审批、editedArgs 与缺项拒绝 | 按原生 API 核对或调整接缝，不自建工具循环 |
| 工作区 | 记录起点 HEAD、暂存、未暂存与未跟踪改动 | 保留原有工作，按任务 hunk 隔离 |

上述入口在 `9593a98`、干净工作区和 Issue #39 的现行规格下通过。探针只证明技术可行性，不作为 Forge 验收。

## What

1. `session-tools.ts` 保留单工具参数准备、最终校验、权限判断、结果转化和事件保存。普通与受信工具在提案阶段取得各自来源，普通工具按现有策略判权。无效参数自动拒绝；改写后的参数在展示前冻结。
2. `AgentSession` 把受控工具登记为 `needsApproval`，从原生 interrupt 读取当批描述，自动填写 `allow/deny`，只向宿主送 `ask`。收到全部有效答复后封闭入口，用原生 snapshot、`parentRunId`、`resume` 继续；异常或 abort 清除批次。配置在审批和工具执行期间沿用提案快照。
3. 工具副作用与逐项保存位于原生 `.server()`。native 工具阶段补齐拒绝、无效工具和其它未执行项的结果；后续模型使用持久化原文构造请求。移除 `executeToolBatch`、结果 Map 和并行/顺序选择分支。
4. `RequestBus` 仅为权限卡投递及交互终态提供非阻塞入口，`AgentSession` 管理批次。SDK `respond`、CLI/headless、TUI 接到统一入口；旧请求/答复仍服务独立 MCP/OAuth 操作。宿主提交 `editedArgs` 时重新校验并按现有权限规则复判，必要时再次请求人工决定。
5. 更新 SDK、中英文 README、术语与受影响决策/施工合同。只迁移有效的行为测试；删除锁定旧预执行或并行实现的测试与 helper。

## Acceptance And Testing

Issue #39 的 AC-1 至 AC-15 是唯一任务级验收清单。公共测试使用 `createAgent`、`runTurn/continue`、`AgentTurn.result`、请求/答复、abort/dispose、输入回执和 `SessionStorage`，由确定性 native adapter 驱动真实 `chat()`；不 mock 内部调度。CLI/headless 使用进程测试，TUI 使用 PTY 交互测试。策略纯函数测试只补复杂规则边界。先做单文件红绿，再定期 typecheck，最后运行一次完整离线套件；对授权或取消路径注入一次故障，确认测试变红并恢复。

外部真实 provider、长期使用、跨平台与跨重启审批不从离线测试推断；没有单独凭据和预算时不调用真实 provider。完成后记录 Ran / Not run / Why / Risk 及被删、迁移、保留的测试。

### 本地验收证据(2026-09-28)

- **Ran:** `bun install --frozen-lockfile` 无依赖变动；`bun run check:deps`、`bun run typecheck`、`bun run typecheck:tests`、`bun run typecheck:automation`、`bun run typecheck:examples`、`bun run build`、`bun run test:headless` 均通过。`bun run test` 在 Linux network namespace 隔离下通过，contract 526、integration 367、CLI/PTY 15，共 908 项、0 失败；离线网络探针通过。此前失败的 `length` 工具提案、`stop` 携带完整工具调用及拒绝后的续接已修复并纳入该结果。
- **Ran:** `native-approval.test.ts` 使用公开 SDK 和真实 `chat()` 驱动确定性 adapter，覆盖混合/全自动决定、多项收齐、`editedArgs` 复判、Zod 工具原始参数规范化、授权记忆故障结算、重复/迟到答复、停止、配置快照与 memory save。CLI headless 进程测试验证无交互时拒绝；PTY 测试验证真实批准/拒绝及停放卡停止并发送。存储屏障、会话恢复、Skills/Memory、OAuth/MCP 和输入归属由完整套件回归。AC-15 的反向验证曾临时移除“收齐审批”门禁，目标测试变红，恢复后变绿。
- **Not run / Why:** 未调用真实 provider，未做长期人工使用、macOS/Windows 或跨重启审批验证；Issue #39 将真实 provider 及这些环境排除在本地代码交付证据之外，第一版仅支持进程内续接。
- **Risk:** 离线 fixture 与 Linux PTY 不能证明所有供应商或跨平台终端行为；外部工具已发生的副作用无法由 `abort()` 回滚，不合作工具的取消仍需等待其自身结束。

测试迁移：`owned-core.test.ts` 与 `sdk-integration.test.ts` 改为断言拒绝后原生续接及 steer/followUp 的可观察顺序；`native-lifecycle.test.ts`、`runtime-session.test.ts` 改为串行执行和逐项保存断言。删除了仅服务旧批次 `terminate` 与 `executionMode` 的场景及配置；保留参数校验、持久化故障、生命周期、会话恢复及宿主交互回归，并新增 `native-approval.test.ts` 的公共边界验证。

## Release And Rollback

出口要求 Issue #39 的适用 AC、类型检查、完整离线测试、CLI/TUI 交互证据、反向验证和提交前双轴审查均有记录；真实 provider 和人工长期使用不作为本地代码交付出口。按起点 SHA 和任务 diff 可在审查后逐项 revert；授权失败一律拒绝，不自动放行。此变更不保留旧执行双轨。

## Risk

| 风险 | 对应验证 |
| --- | --- |
| native run 续接导致输入、usage 或 memory 重复 | 同一 Invocation 的历史、回执、用量及多 run 生命周期断言 |
| 存储故障后已有副作用继续启动 | 保存屏障故障注入与执行顺序断言 |
| 迟到答复误命中新任务 | abort/dispose/重复点击与跨 Invocation 请求 ID 断言 |
| JSON Schema / editedArgs 绕过校验 | 动态 MCP/SDK、内置 Zod 和重新判权断言 |
