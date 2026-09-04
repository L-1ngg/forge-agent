---
doc_kind: decision
created: 2026-09-04
---

# ADR-006: TUI 视觉出口升级为锁定环境内逐 cell 零差异

> 状态:已批准(2026-09-04,operator 指示;同日先批准 [ADR-005](./005-tui-own-compositor.md),本 ADR 修订其决策 1)
> 参与者:operator(发起与拍板)、Grok(起草)

## 背景

[ADR-005](./005-tui-own-compositor.md) 决策 1 选了 1A:借 grok 信息架构与交互,不以 cell/PNG 零差异为出口。operator 同日追加指示,原话:

> 具体UI表现我也要求和grokbuild一模一样

经澄清,operator 确认验收口径为**锁定参考环境内逐 cell 零差异**(PNG diff 作辅证,不作硬门禁),并接受「跨终端不作像素承诺」的边界。

终端程序的物理控制面是 cell 层(grapheme / 宽度 / 前景 / 背景 / attributes / 光标);像素由终端模拟器的字体光栅化、DPI、抗锯齿决定,同一 cell 输出在不同终端渲染的像素必然不同——grok-build 自身也如此。因此「一模一样」可验证的最强形式是 cell 零差异;环境相同 + cell 相同,像素自然相同。

## 决策

1. **视觉出口 = 锁定参考环境内,myh `TerminalFrame` 与 grok-build reference cell dump 逐 cell 零差异**(grapheme、width/continuation、foreground、background、全部 attributes、cursor)。覆盖 [grok-build-tui-gap.md](../research/grok-build-tui-gap.md) §6.2 的 canonical scenarios 与 §6.3 的逐区域字段。
2. **PNG/RGBA diff 保留为辅证落盘,不作硬门禁**;跨 terminal/font/DPI 环境不作像素承诺,环境不一致标 `environment-mismatch`(沿用 gap 调研 §6.1)。
3. **ADR-005 的决策 2(自有 compositor)与决策 3(清空重写)不变**,pi-tui 不回归。cell 零差异要求完全控制 cell 输出,自有 compositor 是更配的底座。B0 已删的旧 harness(`scripts/tui-frame.ts`)仅以 git 历史作参考,按新 compositor 重写,不恢复旧文件。
4. reference capture 与 parity harness 进 [phase-2.2](../phases/phase-2.2.md):新增批次 B6;reference 获取路径(直接 PTY 驱动 grok-build vs 借其内部渲染测试)以 spike 结论为准,探测与 B1 并行。
5. 反向验证升格为出口纪律:人为改 1 个 cell,对应 scenario 测试必须变红;不得以跳过区域、后处理或放宽比较字段通过。

## 被否方案

| 方案 | 否决理由 |
|---|---|
| 维持 1A(定性靠齐,不设零差异出口) | operator 明确要求一模一样 |
| cell + PNG 双层零差异作硬门禁(phase-2.1 原规格) | operator 选 cell 单层;PNG 层把验收绑死在字体/光栅化环境工程上 |
| 跨终端像素一致承诺 | 物理不可行:字体光栅化不在程序控制面内 |

## 后果

**变容易的:**

- B1 的 frame diff 原语直接服务 parity 门禁;B2-B5 每批视觉施工都有可对 diff 的客观标尺,不再靠观感循环
- phase-2.1 的 AC-37/38/40/41 语义由 phase-2.2 新 AC 接手,gap 调研 §6 规格大部分复用

**变难的:**

- 多一块环境工程:锁定参考环境 manifest、驱动 grok-build 抓 reference、fixture 固化与防漂(同一 fixture 重跑 hash 一致)
- 时间线变长;B2-B5 的每个视觉区域从「行为对」升级为「逐 cell 对」
- reference capture 能否干净驱动 grok-build 进入 canonical states 是未探测的未知项,先在 spike 里回答

**需要同步的文档:**

- [phase-2.2.md](../phases/phase-2.2.md):出口条件、新增 B6 与 AC-48/49/50、退役清单调整
- [plan.md](../plan.md) 决策 2、状态行、§3 下一步
- [ADR-005](./005-tui-own-compositor.md) 状态行:决策 1 被本 ADR 修订
- [grok-build-tui-gap.md](../research/grok-build-tui-gap.md) 状态行:pixel parity 以 cell 口径回归
- [phase-2.1.md](../phases/phase-2.1.md) 状态行:AC-38 语义去向标注

**不改的:**

- protocol / core / tools / request bus / permission 流水线
- ADR-005 除决策 1 外的全部条款(CLI 契约冻结、依赖铁律、alt-screen 优先、清空重写)
