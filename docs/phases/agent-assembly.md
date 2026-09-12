---
doc_kind: plan
created: 2026-09-12
---

# 完整 Agent 装配契约

> 状态:实现与自动化验证完成(2026-09-12)。operator 已确认创建阶段检查完整能力、失败清理已创建资源，并保留局部测试的小 interface。

## Why / Entry

`createAgent()` 接受的 `AgentPort` 把存储接入及若干已由 `Agent` 承诺的能力设为可选，导致存储可被静默跳过，其他缺失能力延迟到运行时才报错；`setStorage` 失败时已创建的执行实例未被释放。已有 ADR-010/014/015 的输入归属、增量保存及本地 runtime 职责保持不变。

核对生产 `AgentSession`、`createPiPort`、`createPiTestPort` 和 scripted session：均已有完整方法。两处 SDK 测试使用旧的最小替身，需要改为生产会话加可控模型。`AppPort`、headless 的 `Pick<AgentPort, "runTurn">` 等局部 interface 保留，不强迫局部测试经过 SDK 装配。

## Design / Batches

- `AgentPort` 的 `runTurn`、`continue`、`steer`、`followUp`、`abort`、`dispose`、`getUsage`、`setStorage`、`compact`、`configureContext`、`updateConfiguration` 均为完整执行实现的必需方法。`getUsage()` 可以返回 `undefined`；存在配置更新方法不保证任意配置都可接受。
- TypeScript 在 factory 返回值处约束完整类型；创建时再检查以上成员确实为函数，兼顾 JavaScript 和动态接入。检查不调用模型/工具或尝试压缩，不证明自定义实现的业务正确性。
- 检查通过后必须等待 `setStorage(storage)` 完成才返回 Agent，默认内存也不例外。`HostedAgent` 删除分散的可选能力探测，保留原有生命周期及 turn 归属。
- `setStorage` 是装配能力，不属于已创建 Agent 的宿主 interface；移除 Agent 类型中原有但实际不存在的可选成员，不新增运行中替换存储操作。
- factory 已成功返回后，检查或存储接入失败：关闭本次内部创建的 RequestBus；尝试可用的 `abort`，再等待可用的 `dispose`，即使 abort 失败也继续释放。外部传入的 RequestBus 不由失败装配关闭；adapter 自身的取消行为仍归其实现。成功返回 Agent 后的总线归属与 dispose 关闭规则不变。
- 清理成功时原样抛出装配错误；清理也失败时抛 `AggregateError`，`cause` 与首项保留原始错误，后续项保留清理失败。factory 自己在返回前抛错时，其未交付资源仍由 factory 清理。

## Acceptance / Verify

- [x] AC-ASSEMBLY-1：任何必需方法缺失或非函数都在创建时被拒绝，未调用 runTurn、模型、工具或存储写入。
- [x] AC-ASSEMBLY-2：创建等待真实存储接入完成；默认生产实现、scripted 实现继续支持保存、取消、恢复、压缩和配置更新。
- [x] AC-ASSEMBLY-3：失败后中止并等待已返回实例释放；内部总线关闭、外部总线仍可使用；清理异常不掩盖最初错误。
- [x] AC-ASSEMBLY-4：完整 SDK 测试不再用不完整执行替身；局部界面/headless 测试继续使用既有小 interface。
- [x] AC-ASSEMBLY-5：缺失存储反向验证命中，`bun run check`、headless smoke、示例类型检查及 `git diff --check` 通过。

## Release / Rollback / Risk

operator 于 2026-09-12 授权提交，并在提交后端到端验证及全仓检查通过后推送；不改变用户会话。自定义 factory 必须迁移到完整能力，这是明确授权的接入收紧。回退类型、创建检查、失败清理及对应测试为同一批次，不回退其他改动。没有新依赖或新的生产执行器。方法存在性检查无法证明其语义，依赖既有存储/生命周期合同测试；不合作的自定义 dispose 仍可能延迟创建失败的返回。

## 验证证据

- Ran：`bun test packages/core/test/sdk.test.ts packages/core/test/session.test.ts packages/core/test/input-ownership.test.ts`，37 pass / 0 fail。
- Ran：新增 `packages/core/test/agent-assembly.test.ts`，28 pass / 0 fail；覆盖全部 11 个方法缺失/非函数、动态无效返回值、等待存储接入、真实存储写入、等待失败释放、总线归属及错误保留。`@ts-expect-error` 同时验证不完整 factory 被类型拒绝。
- 反向验证：临时跳过 `assertPortCapabilities` 并将存储接入改回可选调用，运行 `bun test packages/core/test/agent-assembly.test.ts -t "SDK rejects missing setStorage"`，1 fail（预期拒绝却成功返回）。已在 finally 恢复源码，再执行完整检查。
- Ran：`bun run check`，依赖边界、五包类型检查、automation 类型检查全部通过；542 pass / 0 fail，74 个测试文件，含 PTY 交互回归。
- Ran：`bun run test:headless` 退出 0，受控 faux 模型输出 `replay ok` 并以 `agent_end: success` 结束；`bun run typecheck:examples` 与 `git diff --check` 通过。
- Not run / Why：未调用真实外部模型、未做人工 TUI 验收及其他操作系统实测；本次改变创建契约，使用生产会话和受控模型验证。既有人工验收豁免不变，不据此声明人工验收通过。
- Risk：外部自定义 factory 若缺少必需能力，现在会在创建时失败，须补齐真实能力或改用默认实现。方法存在性不能证明业务语义；自定义释放若不完成，创建失败也会等待。operator 原有文档改动保留，不纳入本批提交。
