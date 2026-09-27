---
doc_kind: decision
created: 2026-09-27
---

# ADR-025: 以 TanStack chat 组织单 Agent 执行基座

> 状态:已批准(2026-09-27；内核设计仍适用，ai-skills/ai-memory 选型于 2026-09-28 被 [ADR-026](026-native-skills-and-markdown-memory.md) 取代)。替代 ADR-024 的 Forge 自有循环/StreamFn 决定，以及 ADR-015 的 Pi runtime 生产内核选择。

## 决策

采用已发布 `@tanstack/ai@0.61.0` 的 `chat()`、middleware 和 `toolDefinition()`。删除本地 Pi Agent/agent-loop、模型事件流兼容形状及多层生命周期包装。SDK 原生 `adapter` 同时接入任务和摘要；Forge 只维护会话输入/配置/持久化/终态、可取消的权限和工具批次策略、证据型上下文与宿主扩展。设计和全仓处置清单见[施工图](../phases/tanstack-foundation.md)。

## 取舍与证据

原生chat存在四处行为差异：工具串行、transformArgs之后不再校验、after hook只观察、无工具stop后的onShouldContinue不能强制继续。依据为发布源码 `activities/chat/tools/tool-calls.ts` 与 `activities/chat/index.ts`。合理重设计原型已证明通过工具阶段预调度和native execute等待结果，可以维持严格校验/授权、并行、结果干预及保存屏障。外层处理新的输入与有限失败恢复，不接管工具续轮。因此继续维护Forge工具循环的方案B没有更低长期复杂度；一次迁移成本不构成保留旧内核理由。

保留 `SessionMessage` 领域历史：它承载证据出处、分支、MCP资源快照、工具展示details和失败记录，不能用普通ModelMessage替代。TanStack canonical messages为当前run的工作材料，只有SessionStorage原文及检查点能恢复；请求投影与历史分离。

| 已发布候选 | 直接接入与重设计后的判断 |
|---|---|
| ai-compaction 0.1.9 | 可通过custom strategy改写providerMessages，但仍需完整证据算法、摘要/溢出恢复与最终预算；固定阈值及message estimator需额外桥接。直接onConfig集中投影更简单，不引入第二checkpoint缓存。 |
| ai-persistence 0.6.7 | 可接chat生命周期，但onStart/增量写入best-effort，onError/onAbort不保存新增历史；无逐工具durable append屏障。改写后仍须另一套原文提交门禁和分支模型，无法替代现有存储职责。 |
| ai-mcp 0.4.6 | 建立在MCP SDK v1封装及私有client，无本项目v2 completion/subscription/elicitation等宿主接缝；重设计需要第二SDK client。继续直接官方client 2.0.0。 |
| ai-skills 0.1.11 | skillDirectory未保留explicit-only等元数据与当前扫描规则；custom SkillSource仍保留读取实现；withSkills loaded Set在压缩后不能重新读正文，load缺取消。接入比删除的formatter/loader更多胶水。 |
| ai-memory 0.2.6 | 自动抽取/存储与当前Markdown版本、用户显式来源、worktree副本、写入权限不同；自定义store仍保留现有完整文件与证据实现。 |

这些判断以npm发布源码和隔离探针为准，不将main或package名称当作能力证明。锁定provider包也为当前latest，现有三个补丁覆盖的终态/推理与工具参数问题没有新的已发布修复，继续保留并跑协议回归。

## 后果

公开StreamFn不保留兼容壳，调用方迁到TanStack原生adapter；SDK、CLI、TUI、示例与测试同步迁移。已有JSONL/Markdown格式保留，在临时副本验证恢复，不自动写真实用户数据。保持Bun和当前精确版本锁定。软件离线验收不代表AC-7真实供应商、跨平台或长期质量通过，证据单列于[验收记录](../phases/tanstack-foundation-acceptance.md)。

## 摘要与结构化输出

摘要要求 JSON TaskCheckpoint，`parseCheckpoint` 还验证当前分支、原文出处、替代链与授权证据。已比较 native `outputSchema`：无工具摘要可走单请求 schema-only 路径，并非一定增加请求；但发布的 `ai-bedrock@0.3.15` 的 `structuredOutputStream` 在缺失 `messageStop` 时仍可因 JSON 可解析而合成成功。隔离探针复现了该情况，而当前通用 `chatStream` 的补丁/ResponseCollector 会拒绝缺失协议终态。

因此摘要继续使用同一个已严格验证的 native `chatStream` 接缝，再调用证据解析器。采用 schema-only 需要再维护一套 provider 终态、usage 与取消检查，不能替代证据验证，现阶段整体成本更高。模型输出结构校验不等于历史证据可信；没有据此承诺质量、费用或延迟改善。探针来源与结果见本次验收。
