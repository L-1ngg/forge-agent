# 当前研究与实验依据

> 状态:生效(2026-09-30)。本目录保留仍被现行验收引用的研究方法和原始数据；选型已结束或实现已被替代的材料从[归档索引](../archive/README.md)按需进入。

| 材料 | 用途与边界 |
|---|---|
| [官方 MCP SDK 探针](mcp-client/README.md)、[凭据与验收样本](mcp-host-design.md) | [MCP 施工设计](../phases/mcp-client.md)的 Bun/协议/凭据可行性证据；不代替 Forge 集成、真实 OAuth/模型或 macOS 验收 |
| [恢复性能基准](resume-benchmark.md)、[结果](resume-benchmark-results.json) | [会话恢复体验](../phases/session-resume-experience.md)的性能证据，按记录版本与环境解释 |
| [会话/TUI 旧基准](session-reliability-baseline.json)、[新结果](session-reliability-results.json) | [Issue #44](../phases/session-reliability-issue-44.md)的同机冻结 fixture 冷/热布局、frame、流式和历史查询；不证明模型费用或其他平台性能 |
| [上下文压缩实验数据](context-compaction/)、[盲评记录](context-compaction/blinded-review.md) | [首次压缩验收](../phases/adaptive-context-compaction-acceptance.md)的原始依据；不证明[后续短投影](../phases/context-notes-search.md)的真实模型质量 |
| [近期选择实验](context-selection/README.md)、[v2 报告](context-selection/v2-holdout-report.json) | [近期选择评估](../phases/context-selection-evaluation.md)的 A/B 原始记录、失败的 v1 与通过的 v2；限单模型构造任务 |
| [Issue #37 持久记忆样例](persistent-memory/README.md)、[原始报告](persistent-memory/issue-37-samples.json) | 官方 deferred 接入当时的样例证据；不证明后续 [Issue #42](../phases/memory-organizer-issue-42.md) 的真实模型质量，旧 Issue #32 数据见[归档](../archive/research/persistent-memory/acceptance.md) |

历史数据不因文档整理改写或重跑。需要新质量结论时，先确定对应实现、实验方案和未使用保留集，再新增证据；不能将旧结果重新命名为新验收。当前有效设计从[文档导航](../README.md)进入。
