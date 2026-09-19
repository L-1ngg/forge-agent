---
doc_kind: plan
created: 2026-09-19
---

# 架构职责收敛施工记录

> 状态:实现中(2026-09-19)。需求与验收唯一来源为 [Issue #34](https://github.com/L-1ngg/forge-agent/issues/34)，本文件记录内部组织、批次证据与回退。

## Entry 与边界

基线 `c2f9aeae7ee1c872946bdfac3508e5e85fe42265`。已核对 Issue、CONTEXT、SDK 与 ADR-004/005/010/013/015/017/018/019 的有效合同。原有 `docs/README.md`、`docs/phases/testing-system.md`、`docs/plan.md` 修改不纳入本任务。

测试沿用 Issue 的 Testing Decisions：公开 SDK、App/headless 小接口、正式 CLI/PTY、Scenario/HttpFixture；本地模型、工具、存储与屏障控制交错。结构目标另外通过源码与依赖检查验证，不新增生产测试开口。Linux 强制网络隔离与 macOS fixture 兼容性分开报告。

## 批次设计

1. **B1 / AC-ARCH-01–03**：protocol 提供只含事件迭代与结算的结构接口；AgentTurn 保留身份，宿主消费完整事件流后读取 result。展示、JSON 和输入处理确认仍用事件。局部替身显式提供结算，覆盖事件与最终结果不一致、延迟结算、异常及各终态。
2. **B2 / AC-ARCH-04–06**：配置准备模块拥有快照、校验、模型解析及摘要 driver；工具桥接独立于创建入口。准备材料不提前创建最终工具集合，AgentSession 在历史/记忆信息齐备时唯一装配工具；仍控制 revision、响应/工具批边界与 applied 回执。准备材料没有需释放的执行资源，工具授权缓存只由实际应用的会话拥有。
3. **B3 / AC-ARCH-07–09**：TUI 内部 InputFlow 拥有队列、替换、暂停许可和当前输入处理状态，以动作与执行反馈返回发送/恢复决定。App 保留异步执行、命令、编辑器与重绘；会话切换明确清空旧输入调度状态，草稿仍归原会话。
4. **B4 / AC-ARCH-10–12**：选择独立内部压缩协调模块，组织预算、调用既有算法、等待保存、重建与 usage 更新。单纯重组算法文件无法减少会话对上述顺序的了解；协调器不接管触发策略、重试循环或持久记忆。重建投影从计算模块提取，公共定义不再运行时依赖计算，保持算法与模型调用数不变。
5. **B5 / AC-ARCH-13–15**：Scenario 创建和登记 fixture；close 先释放屏障，再等待执行资源清理，检查最终请求，关闭所有 fixture，最后清理目录。每个阶段失败仍继续后续阶段；close 共用一次结算，withScenario 保留业务主错误及次要诊断。请求完成性独立于响应完整送达。

## Verify / Release

每批目标测试与类型检查完成后记录证据，按 AC-ARCH-16 注入失败并恢复。最后按 AC-ARCH-17 运行一次 `bun run check`、`bun run test:headless`、`bun run typecheck:examples` 和 `git diff --check`；按 AC-ARCH-18 更新受影响文档。提交前以起点 SHA、本次文件及原有改动记录做 Standards/Spec 两轴审查。

不将真实模型质量、费用、未运行平台或人工验收计为通过。不改 schema、压缩算法、输入归属合同、网络隔离策略或远端 Issue 状态。

## Rollback

按 B1 → B5 顺序实施并分别提交代码、测试和对应文档；每批可单独审查。回退按依赖逆序 revert，B3 依赖 B1、B4 衔接 B2。无数据迁移，不撤销用户原有文档修改。

## 验证证据

### B1

- 反向验证：先增加 headless 事件成功但 result 为 error/length/aborted 的用例，旧实现 3 fail；切换结算后通过。
- 目标验证：headless/request/App 72 pass；加入 TUI 五终态延迟结算后，App + SDK input-ownership 74 pass。包类型检查、测试类型检查、依赖门禁通过。
- 结构审查：宿主不再归约终态；6 个 PTY adapter 透传同一 result。Standards 与 Spec 并行审查均无待修发现。SDK 指南原有 result 合同无需改写。
- 回退：本批 protocol 结构类型、两个宿主、局部替身、PTY adapter 和装配说明共同回退。

### B2

- `session-configuration.ts` 统一初始/更新准备与快照，`session-tools.ts` 负责工具桥接；SessionAssembly 只含模型材料与 driver，最终工具集合在 AgentSession 装配。准备阶段无 server、工具授权缓存或其他需 dispose 的执行资源；应用前取消只结算回执，已应用工具缓存由会话释放。
- 目标验证：runtime-configuration、agent-assembly、memory-session 共 43 pass；覆盖旧工具整批执行、下一请求配置、手动摘要期间更新、存储接入与失败清理、记忆与历史工具。新增初始 storage 等待期间的快照隔离、两次 revision 与失败更新不污染有效配置。
- 反向验证：移除 createAgent 入口快照，新快照用例 1 fail（请求泄漏宿主修改后的 prompt）；恢复后目标文件 5 pass。类型与依赖门禁通过。
- 回退：本批准备/工具模块、会话装配、SDK 入口快照及对应测试共同回退，不改会话数据。

B3–B5 及最终门禁待记录。
