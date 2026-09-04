---
doc_kind: decision
created: 2026-09-04
---

# ADR-005: TUI 自有 TerminalFrame compositor,移除 pi-tui

> 状态:已批准(2026-09-04,operator 确认 1A/2A/3A 与 phase-2.2 Key Decisions 4-7;批准审查补入 phase-2.2 的 B0 前置安全快照与 interim request 策略)。同日修订:决策 1(产品目标)被 [ADR-006](./006-tui-cell-parity.md) 升级为锁定环境内逐 cell 零差异出口;决策 2/3 与其余条款仍有效。
> 参与者:operator(发起,选择 1A/2A/3A)、Grok(起草)

## 背景

[plan.md](../plan.md) §0 决策 2 与 [design-rationale.md](../design-rationale.md) C.2 把 TUI 钉在 `pi-tui` 原语上:UX 概念自写成 `Component`,`render()` 返回 `string[]`。Phase 2 M3-M6 按这条路径落地;Phase 2.1 试图在同一底座上补 typed entry、EntryShell、row budget 和 cell/PNG zero-diff。

operator 原话(2026-09-04):当前 TUI「是基于 pi-tui 的包上进行改造的,我认为改造的效果很不好」,要求完全删掉现有 TUI 实现后重新设计。随后确认三项:

| # | 选择 | 含义 |
|---|---|---|
| 1A | grok 信息架构 + 交互 | 仍借 grok-build 的 typed entry、统一 chrome、dock/row budget、card park;视觉靠齐,但**不以** cell/PNG 零差异为出口 |
| 2A | 自有 cell compositor | `packages/tui` 自写 `TerminalFrame` 绘制与终端 I/O,不再依赖 `@earendil-works/pi-tui` |
| 3A | 批准后清空重写 | 删掉现有 src/test 的 pi-tui Component 实现,只保留 CLI 需要的 `App` / `scanFiles` 契约 |

根因不是 TypeScript 不如 Rust,也不是缺几个 widget。`pi-tui` 是行导向(`Component.render(): string[]`),grok-build 是单元格导向(typed entry → 共享 chrome → 预先算好的 rect → 写入 cell)。Phase 2.1 在前者上叠后者,两套模型并存。证据见 [grok-build-tui-gap.md](../research/grok-build-tui-gap.md) §1、[phase-2.1.md](../phases/phase-2.1.md) §2.9。

`pi-ai` / `pi-agent-core` 不在本决策范围内,继续 exact pin。

## 决策

**`packages/tui` 拥有自己的 cell compositor 与终端宿主,移除 `@earendil-works/pi-tui`。**

1. **唯一 paint 模型**是 `TerminalFrame`(二维 cell:grapheme / width / fg / bg / attributes / cursor)。高层产出 view state 与 layout plan,最终只写入 frame,再由 host 差分刷到终端。不再存在 `Component.render(): string[]` 这条路径。
2. **产品目标**是 grok-build 的信息架构与交互契约,不是 pixel parity。Phase 2.1 的 AC-38 / AC-39 / AC-40 / AC-42 不继承。`grokbuild.png` 只作定性参考。
3. **依赖铁律修正**([ADR-004](./004-single-process-protocol-isolation.md) 第 2 条):`tui` 只 import `@myh/protocol` 与 `node:` 内置。禁止再引入任何 TUI 框架(ink / blessed / ratatui-wasm / yoga 等)。Unicode 宽度、按键解码、markdown、editor 全部自写。
4. **CLI 契约冻结**,清空时不得顺手改 `packages/cli` 的接线形状:
   - 导出 `App`、`scanFiles`
   - `new App({ port, host, requestBus, completionSource, getStatus, cwd, homeDir, showWelcome })`
   - `start()` / `waitUntilStopped()` / `stop()`
5. **第一版只实现 alt-screen**。`ui.host = "main"` 不再承诺与 alt 共用一棵 Component 树(Phase 2 AC-13 退役)。config 键保留;`main` 在 inline host 落地前允许 alias 到 alt,并在施工图里标明这是暂缓,不是已实现。
6. **清空后重写**,不在现有 Component 树上继续打补丁。Phase 2.1 的 projector / layout / fold / theme 槽名 / request-card 语义可作为参考,不是运行时依赖。

施工批次、验收与回退见 [phase-2.2.md](../phases/phase-2.2.md)。

### 被否方案

| 方案 | 否决理由 |
|---|---|
| 继续 Phase 2.1,在 `pi-tui` 上补 FrameComposer | operator 明确否定改造效果;string[] 与 cell frame 双路径会长期并存 |
| `pi-tui` 只留宿主(raw mode / alt-screen / 按键),paint 自有 | 宿主 API 仍按 `Component` / `setFocus` / `addChild` 塑形,清空重写的收益被抵消。operator 选 2A |
| 换 ink / blessed / 其它框架 | 用另一套 widget 模型追 grok 的 cell 几何,是同一类错配;也违反「tui 零外部 TUI 依赖」 |
| 保留 pixel parity 出口(1B) | operator 选 1A。零差异要求锁定终端/字体/DPI,会把重写拖进环境工程 |
| 现在就清空、交互模式先断(3B) | operator 选 3A:设计批准后再删。headless `--json` 全程保持可用 |

## 后果

**变容易的:**

- paint、layout、chrome 共用一套 cell 几何,不再把 grok 的 rect 翻译成 pi 的行
- 差分刷新、alt-screen、按键解码的行为由本仓库测试锁定,不再跟 pi 的 0.84.x churn
- Phase 2.5 dashboard 的二维分栏不再赌 `pi-tui` `HStack` 在真实终端里够用

**变难的:**

- 必须自写:终端宿主(raw mode、alt-screen、resize、退出恢复)、editor、Unicode 宽度、按键解码、markdown、差分 paint
- 交互模式在 B0-B2 期间能力下降;headless 是唯一不受影响的入口
- [design-rationale.md](../design-rationale.md) D 节「不自己重写 TUI 差分渲染器」对本包作废,只保留「不重写 `pi-ai` / 不重写 Rust」

**需要同步的文档:**

- [plan.md](../plan.md) 决策 2、架构图、Phase 0 Plan B、下一步
- [ADR-004](./004-single-process-protocol-isolation.md) 依赖条款
- [phase-2.1.md](../phases/phase-2.1.md) 中止,改由 phase-2.2 接手
- [phase-2.md](../phases/phase-2.md) 人工 UX 入口改指 2.2;AC-13 退役
- [design-rationale.md](../design-rationale.md) C.2 标为历史论证
- `scripts/check-deps.ts` 的 tui 允许集去掉 `pi-tui`
- 根 `package.json` 不再声明 `@earendil-works/pi-tui`

**不改的:**

- `protocol` / `core` / `tools` / request bus / permission 流水线
- `pi-ai` 与 `pi-agent-core` 的分层取用
- core 不 import tui、tui 不 import core
