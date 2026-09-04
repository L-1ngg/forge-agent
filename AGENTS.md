# AGENTS.md — AI 协作者入口

> 任何 AI 协作者(Grok / Claude / Codex / 未来的 harness 自身)先读本文件,再读它指向的文档。

## 项目是什么

个人 coding harness(TypeScript + Bun)。当前状态:**Phase 2.2 自有 TerminalFrame TUI 已批准,B0-B5 施工中**。Phase 2 M1-M6 代码与自动化验收已完成;Phase 2.1 pixel parity 已中止,施工真相源为 [docs/phases/phase-2.2.md](docs/phases/phase-2.2.md) 与 [docs/decisions/005-tui-own-compositor.md](docs/decisions/005-tui-own-compositor.md)。Phase 1 人工验收与 Phase 2 E1-E3 按 operator 2026-09-01 指示暂缓实测并按豁免处理,AC-14 未实测。

## 真相源层级

拿不准哪个文档说了算时按此表;文档与代码冲突时**先修文档,再对齐代码**:

| 问题 | 真相源 |
|---|---|
| 要做什么、做到哪了 | [docs/plan.md](docs/plan.md)(只放行动项) |
| 当前 Phase 怎么施工 | [docs/phases/](docs/phases/) 下的 phase 施工图(路径 / tradeoff / 验收) |
| 为什么这样设计 | [docs/design-rationale.md](docs/design-rationale.md)、[docs/cat-cafe.md](docs/cat-cafe.md) |
| 已定的架构决策 | [docs/decisions/](docs/decisions/)(ADR) |
| 踩过的坑 | [docs/lessons.md](docs/lessons.md) |
| 怎么协作、怎么写文档 | [docs/SOP.md](docs/SOP.md)、[docs/README.md](docs/README.md) |

## 工作规则

详见 [docs/SOP.md](docs/SOP.md)。摘要:方向 > 速度;最小改动;证据说话(报告 Ran / Not run / Why / Risk);中/大走流程骨架(Entry → Design → Batches → Verify → Release → Rollback → Learn);保留能说「不」的环节,裁掉仪式;引用 cat-cafe 结论连证据标签一起引;单一真相源,发现矛盾先指出;状态行同步。

## 写文档时

- 目录分工、命名规范、模板:[docs/README.md](docs/README.md)
- 新决策 → ADR(docs/decisions/);新教训 → docs/lessons.md;跨 session 交接 → review-notes/
- 文档用中文;标识符、路径、命令、配置 key 用英文,不翻译标识符。

## 硬约束(来自 operator)

- 不覆盖、不回滚 operator 的改动
- 不做破坏性 / 远程变更操作(hard reset、批量删除、force-push),除非明确要求
- 工具链跟随仓库既有约定;greenfield 时 Python → uv,Node → bun
