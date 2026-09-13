---
doc_kind: plan
created: 2026-09-13
---

# 短检查点与分支历史搜索

> 状态:本地实现与软件验证完成(2026-09-13)。来源：operator 要求按照“短工作笔记”和“轻量历史搜索”两项方案优化 adaptive。

## 设计与边界

这是 ADR-017 的局部增强，保留其持久化证据、状态校验、权限和调用预算。默认策略仍为 pi。完整检查点继续保存 quote、状态 ID、替代关系；仅 adaptive 的模型上下文使用精简投影：active 状态的 kind/text/source IDs、摘要结论 kind/text/source IDs，以及既有实际执行 ledger。不截断状态文本，不删约束。降级 summary 继续保存原来的完整可读内容，避免 pi 缺少找回工具时失去证据。摘要生成仍产出完整来源，不能据此宣称摘要生成成本下降。

新增内核工具 search_context，沿用 read_context 权限/hooks/取消链。只扫描当前选中分支的已保存原始 message，不搜索 compaction 摘要，不读取文件或其他会话。输入 query（1–200 Unicode code points，大小写不敏感的字面词项，空白分词，最多 8 项），可选 role=user/assistant/toolResult 和 limit（默认 5，最大 10）。全部词项需命中同一消息；英文大小写不敏感，中文按字面子串，不宣称语义搜索或理解“最后一次纠正”。结果按历史从新到旧返回，附 entryId、role、isError、围绕首个命中位置的 offset/text（最多 256 code points），可用于 read_context 继续读取。最新记录的含义为分支顺序，不信任时间戳。限量结果附 hasMore，不承诺完整检索或稳定翻页游标。

搜索不会触发历史工具；工具搜索/读取产生的新消息仍属于正常历史，也计入预算，但搜索排除 read_context/search_context 的结果及包含这些调用的 assistant 消息，避免当前查询必然匹配自身和结果递归回显。这些记录仍可按 ID 读取。保留名冲突在创建、策略切换和配置更新时均拒绝，pi 可继续使用宿主同名工具。无索引、额外模型或新依赖；单次扫描成本随当前分支历史长度增长。

## 验证与交付

复用公开 SDK、本地 HTTP provider、MemorySessionStorage。先红后绿验证短投影在保存重开后仍保留约束和证据 ID、完整证据可读；再验证中文搜索、最新纠正、Unicode 命中偏移、限量、分支隔离、权限拒绝及保留名冲突。对查找结果只断言外部语义，不绑定内部排序函数。

用固定构造历史比较此前完整投影与新短投影的请求材料大小，包含新增工具 schema 的额外开销，标记字符估算而非实测 Token。短引用场景可能无法抵消 schema 开销，不能只呈现长引句有利样例。本次不复用已用过的 holdout 宣称真实模型质量/总费用提升；真实成本改进需要新冻结保留集另验。

完成定向测试、typecheck、最终 bun run check 与 examples/headless；两轴审查覆盖本次工作区差异。用户随后明确授权本次 commit 和 push；只提交本任务文件，push 后核对远端 SHA 和 CI。

## 初始变更隔离

起始 HEAD：911b5d8b531b3ff23e6af5e9633c4eb2dbc43b86，index 为空。既有用户改动为 docs/README.md、docs/phases/session-resume-experience.md、package.json、scripts/session-resume-benchmark.ts，另有未跟踪 docs/phases/testing-system.md、docs/research/resume-benchmark.md；起始哈希与前一施工图 Initial change record 相同。不得覆盖或纳入本次改动。


## 新鲜证据

- `bun run check`：572 pass / 0 fail，11771 次断言，75 文件（29.20 s）；包含核心与 automation typecheck。
- `bun run typecheck:examples`、`bun run test:headless`、`git diff --check` 通过。
- 定向 adaptive 文件 30 个测试实例通过（本次新增 11 个）；短投影与搜索各自先出现预期红测，再实现转绿。分支/无匹配测试还检出了当前查询匹配自身的问题，已排除检索调用及其结果。
- 在独立临时源码副本把 selectedBranch 改为所有 entries，`search preserves foreign` 测试失败，确认分支回归能检出该故障；副本已删除。
- code-review 的 Standards 与 Spec 两轴均未发现未解决问题；审查覆盖本次 tracked diff 与全部新增源码/脚本/文档，排除初始用户文件。

离线复现：`bun scripts/context-notes-benchmark.ts`。仅比较改变的笔记和工具定义；不包含未变的 system、近期消息及 provider 序列化封套。估算采用字符数/4，包含新增 search_context schema：

| 固定场景 | 原材料估算 Token | 新材料估算 Token | 差额 |
|---|---:|---:|---:|
| 一条短来源 | 236 | 360 | +124 |
| 一条长来源 | 1036 | 360 | -676 |
| 八条中等来源 | 1322 | 488 | -834 |

本地验收时 Not run：新投影的真实模型保留集、实测总 Token/费用/任务质量、其他操作系统 CI。Why：本次完成局部实现和软件合同验证；旧保留集已使用，不能调参后复用作独立质量证据，也未进行新的远端发布。Risk：短笔记让模型少看原文，可能增加检索或遗漏风险；摘要生成仍保留完整证据，之前主要的摘要阶段费用没有在本次得到实测降低。搜索 schema 对短任务有净增加开销。本次只能确认结构冗余减少和受限查找可用，不能宣称总费用或语义质量改善。

本地验收完成后，operator 已明确授权 commit/push；远端验证以对应提交的 GitHub CI 为准。不修改已关闭 #31 的历史验收结论，初始六个用户文件保持原样且不纳入提交。
