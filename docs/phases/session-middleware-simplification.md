---
doc_kind: plan
created: 2026-10-01
---

# 会话中间件简化

> 状态:实现与本地离线软件验收完成(2026-10-01)。operator 已批准；当前合同以 [ADR-030](../decisions/030-native-arguments-and-conversation-persistence.md) 为准。真实供应商、跨平台和崩溃恢复未测。

## 设计与范围

`forge-session` 保留会话历史、配置/输入边界、原始响应审计及请求预算接线。工具审批准备放到原生工具阶段的待审批结果中，直接消费原生已校验参数。动态 JSON Schema 复用官方 Ajv，通过 Standard Schema 接口供 TanStack 校验原参数和编辑参数；不另建编辑校验器。

`SessionResponse` 保存本批提案、审批决定及已完成结果。原生 `.server()` 收到的参数直接交给工具，不比对审批快照，不在工具执行函数内等待存储。批次结算按原调用顺序保存提案和结果；全原生错误批次仍在下一模型请求前同步历史。取消/错误保存完整提案及已经取得的结果，部分模型输出继续按既有合同保存。存储失败停用实例，结果不伪装成成功，也不重放副作用。

删除无生产使用的改参扩展和修订写入，保留原生 schema、业务校验、before 阻止/观察与 after 结果干预。MCP 资源模板展开属于工具自己的业务逻辑。旧 JSONL 中的参数修订记录继续兼容读取。

## 验收

- [x] AC-1: 提案保存等待或失败发生时，本批工具可以已经执行；保存失败仍停止下一模型请求并返回 error，实例 faulted。
- [x] AC-2: 合法编辑参数由原生 resume 执行，Forge 策略只评估原待审批参数；非法编辑由原生 schema 拒绝，不产生工具效果。
- [x] AC-3: 不再写空 assistant 参数修订记录；实际执行参数仍随普通工具结果保存，旧修订历史可读。
- [x] AC-4: 删除未用准备/改写/自定义校验接口，Zod 与动态 JSON Schema 仍拒绝非法输入；MCP 模板、Skills/Memory 功能保留。
- [x] AC-5: 原生 allow/deny/ask、全错误批次、取消清理、迟到答复、配置快照、下一轮历史与最终结果通过回归。
- [x] AC-6: `bun run check`、`bun run typecheck:examples`、`bun run build`、`bun run test:headless` 通过；本地 fixture 证据不代表真实供应商或崩溃恢复实测。

## 交付与回退

本地实现与证据同步后，operator 于 2026-10-01 授权本地 commit；本次不推送或改变远端任务状态。回退可恢复旧实现；没有数据迁移，普通消息格式兼容，恢复旧保证不会补回本次没有写入的执行前证据。

## 验证证据

Ran(2026-10-01，Linux/WSL、Bun 1.3.12)：

- `bun run check` 通过：依赖边界、全部 workspace/automation/tests 类型检查及离线测试；contract 333、integration 610、CLI/TUI 43，共 986 项通过，0 失败。证据在本地 `.test-results/run-zyYDKO/summary.json` 与各组日志；Linux network namespace 探针通过，外部 IPv4/IPv6 TCP/UDP 和继承子进程隔离有效。
- `bun run typecheck:examples` 和 `bun run build` 通过；全部 workspace 构建完成。
- `bun run test:headless` 通过，1 项正式 CLI smoke；证据在本地 `.test-results/run-qu7Lxb/summary.json`，同样通过 OS 断网探针。
- 反向验证：临时将动态 schema 的 Standard Schema `validate` 改为直接放行输入，`native json edited approval 42` 从预期 error 变成 success，测试按预期失败(exit 1)；恢复原校验后同一测试通过。没有保留变异代码。
- 有效行为由 `runtime-tools.test.ts`、`incremental-session.test.ts`、`runtime-session.test.ts`、`native-approval.test.ts`、`session-tools.test.ts`、MCP 与 `tests/integration/cancellation.test.ts` 验证。旧修订历史仍沿现有 codec/conversion 路径读取；没有新增 schema 或迁移。首轮完整检查唯一失败是取消/save 夹具仍声明零工具执行，修正为批次效果已完成、取消仍等待写入并保留结果后，全仓复跑通过。

Not run / Why：未调用真实供应商、未在 macOS/Windows 运行，未进行进程崩溃或断电实测。本次是固定 0.61.0 的软件合同简化，使用本地原生 adapter、HTTP/MCP fixture、故障注入和正式 CLI/TUI PTY 验证。

Risk：保存仍是非事务的串行追加，失败可能已有部分写入，副作用不回滚；整个最新批次可能在进程崩溃时没有记录。被删除的 SDK 参数扩展需要调用方将转换移入工具；`beforeToolCall` 参数修改不再影响执行。合法编辑由人工批准授权，不再重新应用 Forge 策略。本次交付包含本地 commit，没有推送、外部任务变更或依赖升级。
