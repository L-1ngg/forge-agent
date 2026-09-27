# 历史文档归档

> 状态:生效(2026-09-21)。本目录保留已被替代的设计、施工记录及选型研究，继续由 Git 管理。当前任务从[文档导航](../README.md)开始。

仅在追溯旧版本行为、设计来源或用户指定时读取。正文中的“当前”“待实现”“下一步”属于记录当时的语境，不产生新实施授权。归档不会将历史未测、豁免、中止或失败改为通过。原始实验数据及仍被现行合同依赖的验收记录保留在当前目录，见[证据导航](../research/README.md)。

2026-09-21 起按适用性归档，不按年龄或任务是否完成批量归档。ADR 保持原编号与路径，按其状态和替代指针解释。维护规范见[归档与读取规则](../README.md#归档与读取规则)。

## 旧阶段与交付

| 历史文档 | 当前入口或适用边界 |
|---|---|
| [Phase 1](phases/phase-1.md) | [当前路线](../plan.md)；早期调查与人工验收豁免保留 |
| [Phase 2](phases/phase-2.md) | [TUI 工作流](../phases/tui-main-workflow.md)；E1–E3 豁免不作通过 |
| [Phase 2.1](phases/phase-2.1.md) | [ADR-005](../decisions/005-tui-own-compositor.md)；旧 pixel parity 路线中止 |
| [Phase 2.2](phases/phase-2.2.md) | [TUI 工作流](../phases/tui-main-workflow.md)、[验收边界](../README.md#验收边界)；关闭不表示全部人工验证完成 |
| [自研内核施工](phases/owned-core.md) | [Pi 内核接入](phases/pi-core-migration.md)及[迁移验收](phases/pi-core-migration-acceptance.md) |
| [旧 SDK 施工](phases/sdk.md) | [SDK 接入](../sdk.md)；旧接口和旧批次只作历史证据 |
| [旧上下文管理施工](phases/context-management.md) | [默认压缩决策](../decisions/018-adaptive-default.md)、[当前投影与搜索](../phases/context-notes-search.md) |
| [旧上下文管理验收](phases/context-management-acceptance.md) | [当前压缩基线证据](../phases/adaptive-context-compaction-acceptance.md)；旧双策略复现需用历史版本 |
| [GitHub 首次交付](phases/github-delivery.md) | [发布操作](../release.md)；首次发布证据不证明后续版本 |

## 内核与上下文研究

| 历史文档 | 当前入口或用途 |
|---|---|
| [早期设计论证](design-rationale.md) | [项目定位](../decisions/008-general-agent-positioning.md)、[内核迁移决策](../decisions/015-pi-core-source-migration.md) |
| [Pi 初始调研](research/pi.md) | [Pi 内核接入](phases/pi-core-migration.md)；旧包版本和自研 ExecutionCore 描述按历史解释 |
| [Pi 内核对齐方案](research/pi-core-alignment-plan.md) | [Pi 内核接入](phases/pi-core-migration.md)；保留选型时的候选与差异 |
| [Pi 上游执行语义](research/pi-core-upstream-semantics.md) | [迁移验收](phases/pi-core-migration-acceptance.md)；需要追溯固定源码语义时读取 |
| [Pi 内核来源与许可](research/pi-runtime-provenance/README.md) | [TanStack 基座](../phases/tanstack-foundation.md)；已撤下内核的固定源码 SHA、MIT 许可及历史接入差异 |
| [Pi 工具与宿主接入面](research/pi-core-integration-surface.md) | [会话装配](../phases/agent-assembly.md)、[SDK](../sdk.md) |
| [Pi 上下文调研](research/pi-context-management.md) | [当前投影与搜索](../phases/context-notes-search.md)；保留固定快照 |
| [Pi 会话补充核对](research/pi-context-session-final.md) | [会话管理](../phases/session-management.md)、[首次写入](../phases/session-first-write.md) |
| [Pi 工具输出补充核对](research/pi-context-tools-final.md) | [SDK](../sdk.md)、[当前投影与搜索](../phases/context-notes-search.md) |
| [Pi Bash 输出归档调研](research/pi-bash-output-archive.md) | [SDK](../sdk.md)；不恢复已放弃的长期日志承诺 |
| [Claude Code 上下文调研](research/claude-code-context-management.md) | [压缩设计](../phases/adaptive-context-compaction.md)；官方资料为当时访问快照 |
| [Pi 与 Claude Code 比较](research/context-management-comparison.md) | [当前投影与搜索](../phases/context-notes-search.md)；旧建议不覆盖后续决策 |

## TUI、编排与 Skills 选型

| 历史文档 | 当前入口或用途 |
|---|---|
| [grok-build 架构调研](research/grok-build.md) | [项目定位](../decisions/008-general-agent-positioning.md)、[TUI 工作流](../phases/tui-main-workflow.md) |
| [grok-build TUI 差距](research/grok-build-tui-gap.md) | [ADR-007](../decisions/007-no-compile-grok-reference.md)、[TUI 工作流](../phases/tui-main-workflow.md)；不编译 grok-build |
| [同行 Agent/Team TUI](research/peer-agent-team-tui.md) | [项目定位](../decisions/008-general-agent-positioning.md)；Team 编排归外部项目 |
| [终端 Markdown 与公式研究](research/terminal-markdown-math.md) | [Markdown 渲染](../phases/markdown-rendering.md)；未采用公式路线不构成待实施任务 |
| [Skills 接入选型](research/skills-integration-options.md) | [首轮 Skills 设计](phases/skills.md)与[验收](phases/skills-acceptance.md)；当前接入见 [Issue #37](../phases/tool-ecosystem-issue-37.md) |
| [Skills 社区比较](research/skills-community-options.md) | [首轮 Skills 设计](phases/skills.md)；需要重新评估选型时核对最新上游，不能直接沿用旧版本比较 |

## Issue #37 替代的旧施工与验收（2026-09-28）

| 历史文档 | 当前入口或适用边界 |
|---|---|
| [Skills 首轮施工](phases/skills.md)、[验收](phases/skills-acceptance.md) | [Issue #37 施工与验收](../phases/tool-ecosystem-issue-37.md)；旧 Pi scanner、loader 与首轮证据不证明官方接入 |
| [Issue #32 记忆施工与验收](phases/persistent-memory.md) | [ADR-019](../decisions/019-persistent-memory.md) 保留 Markdown/worktree 决定；当前 deferred 调度和质量边界见 [Issue #37](../phases/tool-ecosystem-issue-37.md) |

## 显式查阅

默认 `rg` 跳过本目录。需要历史材料时限定范围：

```sh
rg --no-ignore --files docs/archive
rg --no-ignore '关键词' docs/archive/research
```

直接打开明确路径也可读取；`.ignore` 是默认搜索约定，不是访问控制。跨 session 的本地 `review-notes/` 不属于本目录，不能用本地交接替代项目共享合同与证据。

## TanStack 基座替代的执行合同（2026-09-27）

当前入口为 [TanStack 基座](../phases/tanstack-foundation.md)与[验收](../phases/tanstack-foundation-acceptance.md)。以下只用于追溯，真实供应商、人工与跨平台未测项继续保留：

- [pi-core-migration](phases/pi-core-migration.md)
- [pi-core-migration-acceptance](phases/pi-core-migration-acceptance.md)
- [stream-fn](phases/stream-fn.md)
- [openai-tanstack-transport](phases/openai-tanstack-transport.md)
- [tanstack-provider-transport-migration](phases/tanstack-provider-transport-migration.md)
- [context-transform-2026-09-21](phases/context-transform-2026-09-21.md)
- [turn-policy-2026-09-20](phases/turn-policy-2026-09-20.md)
- [tool-argument-validation-2026-09-26](phases/tool-argument-validation-2026-09-26.md)
- [agent-assembly-2026-09-20](phases/agent-assembly-2026-09-20.md)
