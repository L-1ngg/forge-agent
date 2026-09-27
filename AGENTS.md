# AGENTS.md — AI 协作者入口

> 任何 AI 协作者(Grok / Claude / Codex / 未来的 harness 自身)先读本文件,再读它指向的文档。

## 项目是什么

通用单 Agent 项目(TypeScript + Bun)。TanStack AI `chat()` 是唯一的模型/工具续轮循环；Forge `AgentSession` 统一输入归属、配置快照、会话持久化、上下文策略与权威终态。原生 provider adapters 负责协议，Forge 保留目录/认证、严格工具授权与并发策略、证据压缩、Markdown 记忆、Skills 和官方 MCP SDK v2 接入。SDK 为 `@forge-agent/core/sdk`，模型接缝是 TanStack 原生 `adapter`；CLI/TUI 共用同一执行路径。Pi runtime 与 StreamFn 已删除，来源记录留在归档；保留的 Skills scanner 与目录来源分别见其本地来源声明。Team 编排归外部项目。定位见 [ADR-008](docs/decisions/008-general-agent-positioning.md)，执行架构见 [ADR-025](docs/decisions/025-tanstack-agent-foundation.md)，包边界见 [README](README.md#architecture)。

## 真相源层级

日常从[当前文档导航](docs/README.md)按任务读取；仅在追溯历史决策、回归来源或用户指定时进入 `docs/archive/`。归档按其记录版本解释，读取规则见[归档规范](docs/README.md#归档与读取规则)。验收结论沿用[证据边界](docs/README.md#验收边界)，归档不改变未测或豁免结论。

拿不准哪个文档说了算时按此表;文档与代码冲突时**先修文档,再对齐代码**:

| 问题 | 真相源 |
|---|---|
| 项目路线、优先级与当前阶段入口 | [docs/plan.md](docs/plan.md)(只放当前行动项与链接) |
| Issue 规格、任务验收与任务状态 | GitHub Issues;与施工图的分工见 [issue-tracker.md](docs/agents/issue-tracker.md) |
| 当前内核与 SDK 怎么施工、如何验收 | [TanStack 基座](docs/phases/tanstack-foundation.md)、[验收证据](docs/phases/tanstack-foundation-acceptance.md);后续能力按[当前文档导航](docs/README.md)进入 |
| 宿主如何接入、干预与释放实例 | [SDK 接入](docs/sdk.md);输入归属与提交边界见 [ADR-010](docs/decisions/010-input-ownership-and-interruption.md) |
| 为什么这样设计 | [架构决策](docs/decisions);早期论证仅在历史追溯时按[归档索引](docs/archive/README.md)读取 |
| 已定的架构决策 | [docs/decisions/](docs/decisions)(ADR) |
| 踩过的坑 | [docs/lessons.md](docs/lessons.md) |
| 怎么协作、怎么写文档 | [docs/SOP.md](docs/SOP.md)、[docs/README.md](docs/README.md) |

## 工作规则

详见 [docs/SOP.md](docs/SOP.md)。摘要:方向 > 速度;最小改动;证据说话(报告 Ran / Not run / Why / Risk);中/大走流程骨架(Entry → Design → Batches → Verify → Release → Rollback → Learn);保留能说「不」的环节,裁掉仪式;单一真相源,发现矛盾先指出;状态行同步。

## 写文档时

- 目录分工、命名规范、模板:[docs/README.md](docs/README.md)
- 新决策 → ADR(docs/decisions/);新教训 → docs/lessons.md;跨 session 本地交接 → review-notes/(Git 忽略)
- 文档用中文;标识符、路径、命令、配置 key 用英文,不翻译标识符。
- 对外 README、SDK 指南和贡献入口按 ADR-011 提供英文;README 与 SDK 的中文版一起维护,内部文档继续中文。

## 硬约束(来自 operator)

- 不覆盖、不回滚 operator 的改动
- 不做破坏性 / 远程变更操作(hard reset、批量删除、force-push),除非明确要求
- 工具链跟随仓库既有约定;greenfield 时 Python → uv,Node → bun

## Agent skills

### Issue tracker
任务与规格使用 GitHub Issues，仓库为 `L-1ngg/forge-agent`。操作约定见 [issue-tracker.md](docs/agents/issue-tracker.md)。

### Triage labels
使用五个默认 triage 标签。角色映射见 [triage-labels.md](docs/agents/triage-labels.md)。

### Domain docs
采用 single-context：根目录 `CONTEXT.md` 与现有 `docs/decisions/`。读取规则见 [domain.md](docs/agents/domain.md)。
