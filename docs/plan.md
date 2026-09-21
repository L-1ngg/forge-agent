# 通用 Agent — 规划

> 状态:后续路线(2026-09-21)。当前定位与职责边界见 [ADR-008](decisions/008-general-agent-positioning.md)。本文件只维护后续路线与行动项。
> 按[当前文档导航](README.md)读取合同与证据；历史路线仅在追溯时进入[归档索引](archive/README.md)。
> 已实现能力与依赖边界见 [README](../README.md#architecture),内核与 SDK 的施工及证据见 [内核接入](phases/pi-core-migration.md)、[迁移验收](phases/pi-core-migration-acceptance.md)。

## 1. 当前行动项

- [ ] 在具备真实账号、模型预算及平台环境后，按 [MCP 验收记录](phases/mcp-client-acceptance.md)验证仍未实测的边界；[Issue #36](https://github.com/L-1ngg/forge-agent/issues/36) 代码交付与任务关闭不将未测项改写为通过。
- [ ] 对照[迁移验收的未测边界](phases/pi-core-migration-acceptance.md#回退与交付边界)安排剩余真实任务验证；WSL 验收不扩展为真实供应商多轮工具/session/取消矩阵或长期使用覆盖。
- [ ] 为[短检查点与历史搜索](phases/context-notes-search.md)冻结新的真实模型保留集，验证任务质量、额外找回及总费用；不复用首次上下文压缩的已用保留集宣称新投影有效。
- [ ] 从现有 [Skills 设计](phases/skills.md)与[验收](phases/skills-acceptance.md)继续明确第三批的调研场景及增量扩展范围，不重新安排首轮接入。

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
- 持久记忆规格见 [Issue #32](https://github.com/L-1ngg/forge-agent/issues/32)，当前实现、默认行为与发布证据见[施工图](phases/persistent-memory.md)；知识库和额外检索基础设施仍按场景另行接入。

### 第五批 — 服务 API 与分发

- SDK 稳定后再设计远程 API、认证、事件传输、部署与发布方式。
- 远程适配复用单 Agent 契约,不另建执行内核。
- 明确版本兼容与 fork 同步策略;不承诺上游修复自动进入派生项目。

## 3. 暂缓事项与边界

- `onPayload/onResponse` 现阶段不做；`onResponse` 指 HTTP status/headers 观测，不是模型答案回调。不启动 Forge 统一传输观测或更换 Vercel AI SDK；有实际需求和可证明的适配器覆盖后再议。
- 保留 `AgentTurn.result`、输入归属/`processed` 回执及配置 `accepted/applied` 时序；不暴露整个 `RuntimeOptions`，不恢复 `portFactory`，不升级 Pi。`transformContext` 异常注释已澄清，不重复修改。
- Phase 0/1 与 Phase 2 M1-M6 的历史施工见 [Phase 1](archive/phases/phase-1.md)、[Phase 2](archive/phases/phase-2.md);pixel parity 中止记录见 [Phase 2.1](archive/phases/phase-2.1.md)。
- [Phase 2.2](archive/phases/phase-2.2.md) 已由 operator 关闭,不因重新定位重开;旧验收不代表通用 agent 或对外 SDK 已验收。
- TUI 体验优化见 [主界面工作流设计](phases/tui-main-workflow.md);5 天 dogfooding、真实 provider 多轮工具/session/取消验证和 AC-14 继续按后续要求安排,未测项不改写成通过。
- 旧 Phase 2.5 Team 与 Phase 4 内置子 Agent 编排不再作为本项目行动项;相关研究保留,不是外部项目的实现承诺。
- Node.js/Python 兼容、npm 发布与长期版本承诺另行评估;当前仓库内 Bun SDK 不构成这些承诺。
