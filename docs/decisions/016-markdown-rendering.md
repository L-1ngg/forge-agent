---
doc_kind: decision
created: 2026-09-09
---

# ADR-016: Markdown 解析与高亮使用纯数据依赖

> 状态:已批准(2026-09-09,operator 在 #28 规格对齐中确认解析器、高亮依赖与原文复制方向)。仅修订 ADR-005 的 Markdown 自写及相关依赖限制。

## 决策

assistant 正文和详情使用 `marked` 解析 Markdown,高亮使用 `lowlight` 的结构化 AST;继续由 Forge 自有 `TerminalFrame` compositor 和终端宿主完成所有绘制。低层宽度、输入、布局仍由本项目维护;禁止外部 TUI 框架。

直接依赖允许集仅新增 `marked` 与 `lowlight`。后者基于 highlight.js,可将语法节点转成现有主题色,不产生需要反向解析的 HTML/ANSI。使用 common 语言集,显式语言选择,不自动检测;未知或失败回退普通代码。选型与固定版本见锁文件。

原文不变,解析/布局是派生数据。显示 cell 可携带源文本快照与范围,用于复制;链接目标是绘制元数据,由宿主编码 OSC 8,不写入消息。复制语义及能力范围以 [#28](https://github.com/L-1ngg/forge-agent/issues/28) 为准。

## 取舍

自写完整 Markdown 语法成本高且已经发生折行后解析失效;采用纯解析器可维护结构语义。直接复用 pi-tui 或其他框架会引入第二套布局/宿主,继续禁止。允许纯数据依赖与保留 compositor 是独立决策。

LaTeX、图片和浏览器排版不在本次范围。施工与证据见 [Markdown 渲染](../phases/markdown-rendering.md)。
