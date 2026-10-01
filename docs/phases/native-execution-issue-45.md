---
doc_kind: plan
created: 2026-10-01
---

# 原生执行接线与响应批次结算

> 状态:本地实现、离线门禁与两轴审查通过(2026-10-01)。operator 通过 `implement` 授权实现 [Issue #45](https://github.com/L-1ngg/forge-agent/issues/45)；任务范围及 AC-1–AC-12 以该 Issue 为准。本稿定义内部施工接口，不改变 ADR-030 的普通会话保存和 ADR-031 的交互职责。

## Why / Entry

基线为 `d02b2b808c1bd11abca7554a27062f75c21c2304`，工作树 clean，无已有 staged/unstaged/untracked 改动。`AgentSession` 目前了解原生 hook 跳过路径，并跨对象修改 `SessionResponse` 状态；响应结算散落在工具完成、下一轮判断及退出补救中。

设计依据为 Issue #45、ADR-010/025/026/028/029 的有效部分及 [ADR-030](../decisions/030-native-arguments-and-conversation-persistence.md)。已定方向直接实施，常规私有接口在本稿具体化；没有新增公共合同或改变路线，不新建 ADR。先确认受影响公开回归基线；如失败，查明原因后继续，不通过删测试获得绿色。

## What / 接口与所有权

- 新建 `packages/core/src/native-execution.ts`，只供 core 内部使用。`runNativeExecution` 拥有 `chat()`、middleware 链、routed adapter、当前响应及 native 工具集合、审批 interrupt/resume 和异常退出结算，不导入整个 `AgentSession`。
- 输入为此次原生执行的配置、已准备 Skills、显式技能集合、当前分支证据与初始上下文，以及既有 signal、RequestBus、TurnPolicy。这些是当前执行材料和既有协作对象，不复制主类的运行状态。
- 私有宿主接口提供请求准备、请求投影与预算检查、批次历史提交、工具上下文读取、存储故障查询及原生作用域释放。请求准备在安全边界应用配置、消费 steering，返回 applied 配置/版本与模型设置快照；投影在实际 prompts/tools 合成后完成预算，返回模型材料和完整领域历史。原生循环结束时释放 run-bound 配置阻挡，并返回退出边界的 applied 配置供合成故障消息使用；已开始响应继续保留自身快照。
- `AgentSession` 是唯一历史追加入口；批次提交操作按提案、调用顺序的结果保存并发布消息事件。`ResponseBatch.turnComplete` 区分正常完成与失败续接的补救保存，只有完整轮次发布轮次结束、应用配置并评估停止策略。有限重试、压缩恢复和整个 Invocation 结果留在会话层。
- `SessionResponse` 为执行模块的内部协作对象，审计、usage、候选消息、消息基准和一次性结算状态为私有。它从完整原生消息投影成功响应、从原始审计取得失败部分输出，并在同一处补齐尚未记录的本地工具结果。
- 各原生结束入口调用同一个响应结算操作；响应材料至多被提交一次。没有响应审计的准备失败仍保存既有故障消息；取消完整工具批次后保留已得结果，并按现有语义标记取消。provider 执行工具不补造本地结果。
- Skills、Memory 和 OTel 接线迁入执行模块，复用现有官方实现；signal 清理、run-bound 配置阻挡和末尾应用仍由执行/会话各自拥有。删除原 `runChat` 中的 hook 接线和旧响应结算方法，不保留第二条执行路径。

## Batches / Verify / Release

顺序为：施工图与公开回归基线 → 私有执行接口和共同结算迁移 → 有针对性的回归及反向验证 → 完整门禁 → Standards/Spec 两轴 WIP 审查 → 修复、复核与本地提交。依赖版本、公开导出和历史格式不变。

任务级出口引用 Issue #45 AC-1–AC-12，不复制定义。需要 `bun run check`、`bun run typecheck:examples`、`bun run build` 和 `bun run test:headless` 的本轮证据；类型检查及相关单文件回归在迁移中运行。外部供应商、其他 OS、崩溃/断电和长期人工使用不作为此次离线软件出口，也不标记通过。没有 push 或关闭 Issue 授权。

## Test plan / 合同映射

主要接口沿用 Issue Testing Decisions：真实 `createAgent` 与 run/continue/respond/abort/dispose，观察实际模型请求、工具效果、存储、事件及权威结果。结构封装通过审查证明，不添加私有字段镜像测试。

| Issue AC | 现有回归入口 | 观察证据 |
|---|---|---|
| 1–2、11 | 结构审查；`native-approval`、`runtime-session` | 共同结算归属；正常/原生错误/拒绝批次历史及轮次一次结束 |
| 3 | `native-approval`、`runtime-tools`、`tool-arguments` | 校验、编辑、答复归属、执行一次、provider 工具元数据 |
| 4–5 | `incremental-session`、`runtime-session`、integration cancellation | 存储等待/部分失败、停止续轮、已得结果、清理与 result/idle/dispose |
| 6 | `provider-stream`、`native-model`、`session-conversion` | 不完整协议、部分响应、历史恢复与不重放 |
| 7 | `runtime-configuration`、`input-ownership`、`native-approval` | applied 快照、审批期间输入及 processed 回执 |
| 8 | `runtime-turn-policy`、`runtime-retry`、compaction/request-budget/context-transform | 请求预算、停止策略、有限恢复与摘要 |
| 9 | `sdk-native-skills`、`sdk-native-memory`、`sdk-memory-organizer`、`sdk-mcp*`、`sdk-otel` | 扩展通过同一路径；审批续接、整理隔离与观测身份 |
| 10、12 | 正式 CLI/headless/PTY；全仓类型/build/test | 公开入口、stdout、退出、事件语义及新鲜门禁证据 |

增强既有公开用例中缺少的事件/下一请求前保存断言；增加原生错误批次在提案/结果追加失败时的 SDK 回归，检查原始错误、请求次数、零效果、部分历史、idle 与 faulted 复用拒绝。审查后补充配置已应用但输入准备失败的模型身份回归，并强化非法编辑审批参数时的停止策略和轮次事件断言。反向验证临时让全原生错误批次不追加其历史，公开行为回归应变红，恢复后通过；临时变异不进入提交。

## Rollback / Risk

本地提交可整体 revert；没有数据迁移、开关或双实现。既有 JSONL 仍可读，不会因回退重放工具，也不能补回崩溃前未保存的批次。

风险集中在终态 hook 被原生框架保护后的错误传播、审批 resume 的配置作用域、失败/取消结果补齐及记忆/OTel 顺序。通过真实 SDK、故障注入和现有 native middleware 组合验证。存储仍是普通串行追加，部分写入与已发生副作用不回滚；本次不改变这个实际限制。

## 实际证据

Ran(2026-10-01，Linux x64/WSL、Bun 1.3.12)：

- 改前审批/会话/增量保存/配置/停止策略 5 文件 61/61 通过；迁移后相同 61 项通过。协议、原生模型、重试、OTel、Skills、上下文变换及预算 7 文件 100/100 通过。新增保存故障回归后 `native-approval` 单文件 20/20 通过。
- 审查修复后相关 5 文件 64/64 通过，`native-approval` 为 21 项；新增配置身份与 JSON/Zod 非法编辑参数的 3 项公开行为用例先失败、修复后 3/3 通过，27 次断言。日志为 `.test-results/issue-45-mutation/review-{red,green}.log`。
- 最终 `bun run check` 退出 0：依赖边界、六包/automation/tests 类型检查及完整测试通过。新鲜证据为 `.test-results/run-9nQFBO/summary.json` 与三个 JUnit：contract 348、integration 627、CLI/PTY 49，共 1,024 项，0 失败/跳过。Linux network namespace 独立原生 socket 及子进程隔离探针通过。该报告的可执行输入 SHA-256 为 `427cada87fb408134c419eddd60fdc1a72b97f88b705ba77b34aebd2165bb48a`；审查前的 `.test-results/run-HSYHUF` 只覆盖前一版本，不作为最终出口。
- 最终 `bun run typecheck:examples`、六包 `bun run build` 通过。独立 `bun run test:headless` 为 1/1 通过，证据 `.test-results/run-UHPu1S/summary.json`，可执行输入 SHA-256 与最终完整检查一致，网络隔离探针同样通过。
- 反向验证：临时跳过全原生错误批次的共同结算，公开 SDK 用例 `native tool errors save their proposal before the next model request` 从 success 变为 error，测试退出 1；恢复后同一用例退出 0，9 次行为断言通过。日志位于 `.test-results/issue-45-mutation/{red,green}.log`；变异未保留。
- 初轮迁移将审批中断前的 `onShouldContinue` 误当作可保存批次，原生审批、实际编辑参数、记忆证据和保存顺序回归失败；将 eligibility 收入响应内部后全部相关回归通过，没有弱化原断言。新增故障夹具最初把 Zod 当作 `HarnessTool.parameters`，类型门禁拒绝；改用该工具接口要求的 JSON Schema 后检查通过。

实际职责变化：`AgentSession` 从 621 行降到 474 行；移出原生 chat/middleware/Skills/Memory/OTel 接线，删除原 `completeResponse`、`commitModelResponse`、`commitPartialResponse`、`completeTurn` 及三处结果补齐分支。会话以 `commitBatch` 唯一保存批次历史并评估策略。响应审计、native usage/tools、消息基准、候选消息和提交状态均为私有，正常/异常出口共用 `SessionResponse.finish`；存储故障仍由会话保留并传播。新增内部模块承接原生接线，全仓代码行数没有宣称减少。

Standards/Spec 两轴 WIP 审查覆盖本次 8 个文件及新文件。Spec 初轮发现两项 P2：输入准备失败时的旧配置身份、失败审批续接误触停止策略；已修复并用公开回归复核，最终两轴均无未解决问题。结构归属与任务级 AC 沿用 Issue 的定义；交付方式为当前分支本地提交，本次没有推送或关闭远端 Issue 的授权。

Not run / Why：未调用真实供应商或 collector，未在 macOS/Windows 运行，未进行进程崩溃/断电、模型质量/费用或长期人工使用评估。本次验证内部职责重构的软件合同，使用离线 fixtures、真实本地服务/存储与正式 CLI/PTY。

Risk：取消不回滚已开始的工具或文件 I/O；保存仍为非事务串行追加，失败可能已有副作用和部分写入，进程崩溃可能丢失最新批次。协议、平台和长期使用的外部行为不能由本次本地门禁推定通过。
