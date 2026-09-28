---
doc_kind: plan
created: 2026-09-29
---

# Issue #41 TUI 投影状态收敛

> 状态:本地实现与 Linux 离线验收已完成(2026-09-29)，外层终端人工体验和跨平台验收未执行。任务规格、测试决策和 AC 以 [Issue #41](https://github.com/L-1ngg/forge-agent/issues/41) 为准；浏览职责见 [记录浏览](transcript-browser.md)，主界面行为见 [主界面工作流](tui-main-workflow.md)。

## Entry 与 Design

起点 `88746032a05b132ca280aeccdfad99d6319d10a9`，`master` 工作区干净，无暂存、未暂存或未跟踪文件。Issue #41 已确定 `TranscriptProjector` 继续归约 `SessionEvent`，`TranscriptBrowser` 继续管理浏览状态；`SessionEvent`、`SessionMessage`、JSONL、SDK 与 CLI/headless 合同不变。

开工门槛为 Issue #41 的规格与 AC 可用、投影接口调用方已核对、起点改动归属明确；任一条件不满足时先补齐规格或分离既有改动，再实施本项。

1. 删除 `apply()` 对每个事件的克隆留存、`getEvents()`，以及没有仓内调用方的完整消息、工具和流式块读取 interface、专属类型与辅助逻辑。保留可见条目、通知、当前流式内容、消息身份、工具状态及手动显示状态。
2. 首次工具执行由现有 `tools` 状态判断，只在根时间线登记一次位置；删除重复的工具顺序数组。工具进度早于 assistant 提案时先显示占位，提案到达后沿现有身份和去重规则归位。
3. `message_end` 仍为完整消息的展示真相。保留流式条目身份、文本/thinking/工具相对顺序、工具结果合并、历史回放、`/clear` 与会话切换的原有路径，不添加缓存或第二份 transcript。

## Verify 与 Release

测试边界沿用 Issue #41 Testing Decisions：`App` 可见输出和 `TranscriptProjector` 可见条目验证行为；浏览、cell golden 与主界面 PTY 流程复用既有测试。静态引用与 diff 核对删除范围；反向验证临时破坏一次关键去重或稳定身份行为，对应测试必须失败，之后恢复。执行定向测试、类型与依赖检查，最终执行一次完整离线测试。没有性能基线，不声明吞吐或内存上界收益。

完成的出口为 Issue #41 的 AC、验证证据、双轴 WIP review 和本地 commit。外层终端人工体验、真实供应商与其他平台结果不由本地离线测试替代。

## Rollback

本次只改 TUI 内部投影与相应测试、文档，没有数据迁移。需要回退时按起点 SHA 核对并 revert 本次提交；不触碰会话历史或其他工作流。

## 验证记录

**Ran**：`bun run check` 通过依赖边界、五包类型检查、automation/tests 类型检查、Linux network namespace 断网探针和完整离线测试。当前 JUnit 汇总为 contract 536/536、integration 367/367、CLI/PTY 15/15，共 918/918；包括主界面 PTY 工具浏览、详情、清屏与会话切换。`bun run test:headless`、`bun run typecheck:examples`、TUI 定向测试 84/84 和 `git diff --check` 通过。`.test-results/contract.log` 是追加日志，尾部混有旧运行失败；本次结果以同轮 `contract.xml` 的 536 tests / 0 failures 及 `timings.json` 的成功状态为准。

**反向验证**：临时改为每次工具进度都登记根时间线时，新乱序工具行为测试出现重复 `tool-read-1` 并失败；恢复首次出现判断后，同一测试与 TUI 定向测试转绿。故障注入代码没有保留。

**结构核对**：移除原始事件数组及其逐事件克隆、`getEvents()`，完整消息/工具与有序流式块读取 interface、专属类型和重复的 `standaloneToolOrder`。`streamText`、`executed` 不再为已删除的 interface 维护；保留可见消息、工具、通知、根时间线、当前流式身份与手动显示状态。未改公共协议、JSONL、SDK、CLI/headless 接线或运行时依赖，未增加第二份 transcript。

**Not run / Why / Risk**：未执行真实供应商任务、外层终端人工体验及 macOS/Windows 验收；本次在 Linux 上以本地 fixture 和真实 PTY 验证 TUI 回归，不能扩展为上述环境的实测结论。未测性能基线，因此只确认删除了重复状态，不声明整条 TUI 的速度或内存上界收益。
