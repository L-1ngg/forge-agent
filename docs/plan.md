# 通用 Agent — 规划

> 状态:待交付审核与下一批设计(2026-09-06)。当前定位与职责边界见 [ADR-008](decisions/008-general-agent-positioning.md);既有交付与未测项见 [Phase 2.2](phases/phase-2.2.md)。本文件只维护后续路线与行动项。
> 设计论证与历史研究见 [design-rationale.md](design-rationale.md)、[cat-cafe.md](cat-cafe.md) 和 [research/](research/)。
> 已实现能力与依赖边界见 [README](../README.md#架构),内核与 SDK 的施工及证据分别见 [owned-core.md](phases/owned-core.md)、[sdk.md](phases/sdk.md)。

## 1. 当前行动项

- [ ] 审核已提交的内核、SDK 与 ADR-010 修复;提交不等于人工交付验收,未测边界以对应施工图为准。
- [ ] 对照内核施工图核定剩余真实任务验收,明确已记录的最小 SDK 烟测与完整多轮工具/session/取消验证的差别。
- [ ] 第二批交付审核后,制定第三批能力扩展施工图,明确选型、范围与验收,再开始实现。

## 2. 后续路线

以下按顺序推进,每批实施前另定施工图与验收。

### 第三批 — 能力扩展与调研场景

- 建立工具和 Skills 扩展路径,允许宿主与派生项目配置领域能力。
- 用资料获取、来源追踪、交叉核对和报告产出验证通用性;报告必须能追溯引用。
- 将调研方法与业务知识放在扩展层,不硬编码成内核专用执行流程。
- 搜索服务、文档解析、知识源和 MCP 接入按场景另行选型;不预建通用 RAG 平台。

### 第四批 — 长任务可靠性

- 围绕真实任务补齐上下文管理、恢复、执行约束和评估。
- 保留原始需求、上下文用量真相点、压缩余量与恢复载荷作用域的设计原则;具体参数由施工与验证确定。
- 会话恢复保留 provider continuation 信息;取消和权限策略须在真实任务中验证。
- 知识库按场景接入,不默认开启持久记忆或新增检索基础设施。

### 第五批 — 服务 API 与分发

- SDK 稳定后再设计远程 API、认证、事件传输、部署与发布方式。
- 远程适配复用单 Agent 契约,不另建执行内核。
- 明确版本兼容与 fork 同步策略;不承诺上游修复自动进入派生项目。

## 3. 暂缓事项与边界

- Phase 0/1 与 Phase 2 M1-M6 的历史施工见 [Phase 1](phases/phase-1.md)、[Phase 2](phases/phase-2.md);pixel parity 中止记录见 [Phase 2.1](phases/phase-2.1.md)。
- [Phase 2.2](phases/phase-2.2.md) 已由 operator 关闭,不因重新定位重开;旧验收不代表通用 agent 或对外 SDK 已验收。
- TUI 体验优化、5 天 dogfooding、真实 provider 多轮工具/session/取消验证和 AC-14 继续按后续要求安排,未测项不改写成通过。
- 旧 Phase 2.5 Team 与 Phase 4 内置子 Agent 编排不再作为本项目行动项;相关研究保留,不是外部项目的实现承诺。
- Node.js/Python 兼容、npm 发布与长期版本承诺另行评估;当前仓库内 Bun SDK 不构成这些承诺。
