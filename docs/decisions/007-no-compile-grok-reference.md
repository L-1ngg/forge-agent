---
doc_kind: decision
created: 2026-09-04
---

# ADR-007: 视觉回归不再编译 grok-build 取 reference

> 状态:已批准(2026-09-04,operator 指示「编译成本太高,换一个方案」)
> 修订:[ADR-006](./006-tui-cell-parity.md) 的 reference 获取路径与 AC-49 口径;cell 层验收与 PNG 辅证条款仍有效。

## 背景

ADR-006 把视觉出口定为锁定环境内、myh `TerminalFrame` 与 grok-build 运行时 cell dump 零差异。实现路径是编译 `xai-grok-pager`、用 ratatui `Buffer` 导出 JSON。operator 在施工中否定该路径,原话:

> 这样编译成本太高了,换一个方案

现场编 grok-build 会拉起整棵 Rust workspace(protoc、大量 crate),单次 `cargo run --release` 超过十分钟且易被环境中断,不适合作为日常门禁。

不编译 grok-build,就拿不到它**运行时**的格子。这不是换一种截图方式能绕开的。

## 决策

1. **禁止把编译或运行 grok-build 当作 CI / `bun run check` 的前置。** `scripts/grok-capture/` 删除,不再维护。
2. **cell 回归的参考答案改为本仓库锁定的 FrameDump golden**(由 `paintScenario` / `tui-frame dump-scenarios` 生成并 check-in)。同一 fixture 重跑 hash 必须一致;改 1 cell 必须变红。这锁的是**我们自己的输出不漂**,不是 grok 二进制。
3. **与 grok 的对齐改为规格不变量**,从 grok 源码与其单测转写,不跑其进程。至少锁定:rail 列宽 1、左右 padding 2、content 起点列 3、collapsed 去 rail 字形但留列、timestamp 整留 10 列或整藏。
4. **ADR-006 的「与 grok-build 运行时 dump 零差异」不再是出口条件。** 产品目标仍是 grok 的信息架构与交互;视觉靠齐以规格 + golden + 人工对照 `grokbuild.png` 为准。PNG 仍不作硬门禁。

## 被否方案

| 方案 | 否决理由 |
|---|---|
| 继续编 grok-build 出 reference | operator 明确否定编译成本 |
| PTY 驱动已安装的 grok 二进制截 ANSI | 本环境没有可用的预编译 grok;动画/时区/API 仍不稳 |
| 用 PNG 截图代替 cell dump | 已由 ADR-006 否决;且仍要跑 grok |

## 后果

- AC-49 改写为 in-repo golden 零差异 + grok 几何不变量;不再声称「格子等于当时跑出来的 grok-build」。
- 更新 golden 是有意识的视觉变更,走 `tui-frame dump-scenarios` 后人工看 diff 再合入。
- `~/dev/grok-build-spike` 只作读源码的参考,不进工具链。
