---
doc_kind: decision
created: 2026-09-27
---

# ADR-026: 官方 Skills 与 Memory 生命周期，Markdown 本地存储

> 状态:已批准(2026-09-27，operator 确认按本 ADR 与施工图实施；2026-09-28 已完成本地实现与验收，外部未测边界见施工图)。Issue [#37](https://github.com/L-1ngg/forge-agent/issues/37) 是需求与验收真相源；施工与证据见 [Issue #37 施工图](../phases/tool-ecosystem-issue-37.md)。

## 决定

本地静态工具以 Zod Standard Schema 为参数唯一来源，动态 MCP / SDK JSON Schema 保持现有入口。`@tanstack/ai-skills` 的 `withSkills(skillDirectory(...))` 负责技能目录、`load_skill`、加载去重和 `createResourceTool`；项目目录排在个人全局目录之前，由官方 `aggregate`、`dedupe` 和 `filter` 组合。Forge 仅接线宿主目录、显式 `/skill` 输入和不可自动调用的可见性。Skills 脚本仍由普通执行工具及其权限策略处理。

`@tanstack/ai-memory` 的 `memoryMiddleware()` 在 chat 运行开始时 `recall`，在成功结束后经官方 `ctx.defer` 调用 `save`。每次运行绑定一个 Markdown `MemoryAdapter` 到宿主提供的 user/project 目录；adapter 保存短 `MEMORY.md` 索引与普通主题文件，并调用同一模型配置整理本轮内容。当前 session、分支原文、压缩检查点和 JSONL 仍由 `AgentSession` 管理。SDK 未配置记忆时不读取或建立默认目录。

Forge 的工具批次接收官方 middleware 注入的有效工具，以注册来源标记 Skills／Memory 为 internal/trusted；这些工具仍经过最终参数校验、统一 AbortSignal、并发调度、结果记录和存储屏障，省去交互授权。普通工具始终使用现有权限策略，不能通过同名或调用参数伪装成 internal。最终请求上限检查使用全部 middleware 注入后的 system prompts、工具与消息。

当前锁定的 `@tanstack/ai@0.61.0` 与发布的 `ai-skills@0.1.11`、`ai-memory@0.2.6` peer 范围兼容。2026-09-27 最新 `ai-skills@0.1.13`、`ai-memory@0.2.8` 均要求 `@tanstack/ai@^0.63.0`；本轮先在已验证的内核版本接入，避免把内核和所有 provider adapters 升级混入任务。实施时以最终 lockfile 和发布包源码再次核对 API。

## 替代与保留

本决定替代 [ADR-025](025-tanstack-agent-foundation.md) 中“不采用 ai-skills／ai-memory”的选型结论，以及 [ADR-019](019-persistent-memory.md) 中“仅会话内工具更新、无 deferred 整理”和旧写保护协议。ADR-019 的 Markdown 索引/主题、user/project 域及 worktree 独立副本继续适用；ADR-025 的 `chat()` 唯一循环、会话权威终态和普通工具批次合同继续适用。

官方 `SkillSource` 不表达 `disable-model-invocation`；Forge 只在配置准备时从官方 Source 读取该字段，用官方 `filter` 隐藏自动目录，显式 `/skill` 对完整 Source 加载。这个薄接线不保留 Pi scanner、formatter、loader、缓存或第二套工具注册。官方目录扫描、资源路径约束和加载去重以其实际行为为准，旧忽略文件、修订检查和同轮重新加载语义不作为兼容要求。

记忆存储保留 Markdown 文件布局、普通读写/搜索和 worktree 初始化重试；删除自动更新工具预算、CAS/回执、文件锁、原子替换、取消与恢复协议。显式管理与 deferred 整理共用相同文件入口，只有完成文件写入才报告成功。自动保存失败经官方回执/事件和 Forge 公开观测报告，不改写主对话结果；JSONL 提交失败仍停用实例。

## 后果

一次成功运行结束后才整理保存；本轮工具结果不会重新触发 init recall，下次运行从磁盘读取新索引。配置 `accepted` 后，Skills/Memory 在下一次 `chat()` 运行开始时整体生效，不修改已建立的官方 middleware 快照。上下文压缩不删除会话原文；技能正文可从后续运行再次加载。真实模型抽取质量、费用、供应商和跨平台结果必须独立记录，离线测试不替代这些证据。
