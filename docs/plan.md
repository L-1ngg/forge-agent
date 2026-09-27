# 通用 Agent — 规划

> 状态:后续路线(2026-09-28)。当前定位与职责边界见 [ADR-008](decisions/008-general-agent-positioning.md)。本文件只维护后续路线与行动项。
> 按[当前文档导航](README.md)读取合同与证据；历史路线仅在追溯时进入[归档索引](archive/README.md)。
> 已实现能力与依赖边界见 [README](../README.md#architecture),内核与 SDK 的施工及证据见 [TanStack 基座](phases/tanstack-foundation.md)、[基座验收](phases/tanstack-foundation-acceptance.md)。

## 1. 当前行动项

- [ ] 在明确凭据、目标及请求数/时间/费用预算后，按[原生 Adapter 合同](phases/model-adapter.md)完成真实供应商 AC-7：普通回答、工具续轮、摘要、恢复和取消。当前架构与本次离线软件证据见 [ADR-025](decisions/025-tanstack-agent-foundation.md)及[基座验收](phases/tanstack-foundation-acceptance.md)。
- [ ] 在具备真实账号、模型预算及平台环境后，按 [MCP 验收记录](phases/mcp-client-acceptance.md)验证仍未实测的边界；[Issue #36](https://github.com/L-1ngg/forge-agent/issues/36) 代码交付与任务关闭不将未测项改写为通过。
- [ ] 对照[基座验收的外部边界](phases/tanstack-foundation-acceptance.md#外部边界)安排真实任务与跨平台验证；Linux 离线结果不扩展为真实供应商或长期使用证据。
- [ ] 从 [Issue #37 的官方 Skills 接入](phases/tool-ecosystem-issue-37.md)继续明确第三批的调研场景及增量扩展范围；旧 [Skills 验收](archive/phases/skills-acceptance.md)只对应首轮实现。

## 2. 后续路线

以下按顺序推进,每批实施前另定施工图与验收。

### 第三批 — 能力扩展与调研场景

- 基于现有工具和 Skills 扩展路径，为宿主与派生项目补充经具体场景验证的领域能力。
- 用资料获取、来源追踪、交叉核对和报告产出验证通用性;报告必须能追溯引用。
- 将调研方法与业务知识放在扩展层,不硬编码成内核专用执行流程。
- MCP 已按 [Issue #36](https://github.com/L-1ngg/forge-agent/issues/36) 与[完整施工设计](phases/mcp-client.md)接入，外部验收边界见[验收记录](phases/mcp-client-acceptance.md)；搜索服务、文档解析和具体知识源仍按场景选型，不预建通用 RAG 平台。

### 第四批 — 长任务可靠性

- 围绕真实任务继续验证上下文管理、恢复、执行约束及质量/成本。
- 当前默认上下文压缩见 [ADR-018](decisions/018-adaptive-default.md)；已移除 pi 策略的历史设计见 [ADR-014](decisions/014-pi-aligned-context-management.md)；上下文压缩的状态/证据/预算见 [ADR-017](decisions/017-evidence-backed-context-compaction.md) 与 [GitHub #31](https://github.com/L-1ngg/forge-agent/issues/31)，当前短投影和搜索见[后续施工与证据](phases/context-notes-search.md)。后续工作以这些已有能力为起点，不重新规划一次基础压缩实现。
- 保留原始需求、上下文用量真相点、压缩余量与恢复载荷作用域的设计原则;具体参数由施工与验证确定。
- 会话恢复保留 provider continuation 信息;取消和权限策略须在真实任务中验证。
- 当前持久记忆按 [Issue #37](https://github.com/L-1ngg/forge-agent/issues/37) 使用官方 deferred 调度及 Markdown adapter，实施与验收见[施工图](phases/tool-ecosystem-issue-37.md)；[Issue #32 记录](archive/phases/persistent-memory.md)只证明旧会话内方案。知识库和额外检索基础设施仍按场景另行接入。

### 第五批 — 服务 API 与分发

- SDK 稳定后再设计远程 API、认证、事件传输、部署与发布方式。
- 远程适配复用单 Agent 契约,不另建执行内核。
- 明确版本兼容与 fork 同步策略;不承诺上游修复自动进入派生项目。

## 3. 暂缓事项与边界

- `onPayload/onResponse` 现阶段不做；`onResponse` 指 HTTP status/headers 观测，不是模型答案回调。不启动 Forge 统一传输观测或更换 Vercel AI SDK；有实际需求和可证明的适配器覆盖后再议。
- 保留 `AgentTurn.result`、输入归属/`processed` 回执及配置 `accepted/applied` 区别；扩展通过原生 adapter、tools、storage 和具体策略接口，不恢复完整执行 factory 或第二套循环。
- Phase 0/1 与 Phase 2 M1-M6 的历史施工见 [Phase 1](archive/phases/phase-1.md)、[Phase 2](archive/phases/phase-2.md);pixel parity 中止记录见 [Phase 2.1](archive/phases/phase-2.1.md)。
- [Phase 2.2](archive/phases/phase-2.2.md) 已由 operator 关闭,不因重新定位重开;旧验收不代表通用 agent 或对外 SDK 已验收。
- TUI 体验优化见 [主界面工作流设计](phases/tui-main-workflow.md);5 天 dogfooding、真实 provider 多轮工具/session/取消验证和 AC-14 继续按后续要求安排,未测项不改写成通过。
- 旧 Phase 2.5 Team 与 Phase 4 内置子 Agent 编排不再作为本项目行动项;相关研究保留,不是外部项目的实现承诺。
- Node.js/Python 兼容、npm 发布与长期版本承诺另行评估;当前仓库内 Bun SDK 不构成这些承诺。
