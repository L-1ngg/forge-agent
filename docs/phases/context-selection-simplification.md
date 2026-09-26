---
doc_kind: plan
created: 2026-09-26
---

# 压缩材料选择简化

> 状态:已完成(2026-09-26)。软件交付的决策见 [ADR-023](../decisions/023-deterministic-context-selection.md)；后续真实模型质量与费用证据见[新评估](context-selection-evaluation.md)，不回写本次软件验收结论。

新质量评估的预注册任务、评分与证据见[近期历史选择评估](context-selection-evaluation.md)。

## Entry / Design

operator 已确认简化现有上下文压缩的选择规则。初始工作区存在 `AGENTS.md`、`README.md`、`README.zh-CN.md`、`docs/decisions/007-no-compile-grok-reference.md` 的用户改动，不纳入本任务。

只修改 `context/compact.ts` 的可选原文选择：保留现有保护层、旧工具正文裁剪、摘要与重建、原文搜索/读取、调用帽及最终请求预算。可选层改为从新到旧的连续交互单元；删除词项相关性、来源优先和重复正文去重。请求投影仍按历史顺序装配。旧保留集和旧验收记录保持历史含义。

## Acceptance / Verify

- [x] AC-1: 近期连续单元优先于更早的状态来源；遇到超出近期额度的单元后不再选择其前面的可选单元。
- [x] AC-2: 未归档用户输入、最新用户消息、最新完整工具交互和可找回旧工具正文仍遵守原有保护/裁剪合同；需要省略未归档内容时先生成检查点。
- [x] AC-3: 原始会话、检查点格式、权限、请求预算及失败不发布行为保持兼容；公开 SDK 场景和全量检查通过。
- [x] AC-4: SDK 中英文说明及当前文档入口与新规则一致；明确标注本次没有新的真实模型质量/总费用结论。

软件验证使用定向 SDK 测试、`bun run check`、examples typecheck 和文档链接/差异检查。反向验证临时允许跳过超额单元，使 AC-1 测试失败；不保留故障注入。真实模型质量、费用与跨 provider 表现另需新的冻结任务集，本次不作为软件交付通过条件。

## 验收证据

Ran：`bun test packages/core/test/context-compaction.test.ts` 为 38 pass / 0 fail；`bun run check`、`bun run typecheck:examples`、`git diff --check` 通过。检查本次涉及的 9 份文档的本地链接目标，全部存在。反向验证临时把“超额即停止”改为“跳过继续”后，新 SDK 测试按预期失败，随后恢复规则；全量检查在恢复后运行。旧去重测试已改为验证两个同文 assistant 记录都保留，未继续要求零摘要调用。

Not run：新冻结真实模型任务集、实测总 Token/费用与其他 provider/OS 的行为比较。Why：本次先完成材料选择的软件合同与文档对齐，尚未建立新的独立任务集；旧保留集已用于此前设计，不能当作新实现的独立质量证据。Risk：更早但高度相关的原文不再被直接放进请求，模型可能需要额外检索或遗漏细节；去重移除也可能增加近期消息占用和摘要调用。结构与生命周期测试不能证明任务质量或总费用改善。

## Rollback

本次不变更持久化格式。恢复旧版本代码即可撤销新的选择行为；会话原始记录和检查点不应由回退过程重写。
