# Claude Code 上下文管理调研

> 状态:官方资料核对完成，未做运行时复现(2026-09-07)。在线文档会更新，本文引用为本次访问时内容，不构成所有历史版本的保证。

## 范围与证据

本报告只采用 Claude Code 官方文档及官方 GitHub 仓库入口；不把第三方教程、反编译猜测或 Anthropic Messages API 的独立 compaction 功能当作 Claude Code 实现。

证据标记：`[官方明述]` 表示文档直接描述；`[推断]` 表示基于该行为的分析；`[建议]` 表示 Forge Agent 待讨论方案。未核对 Claude Code 私有实现，无法确认精确内部算法、所有默认常量和事务边界。

## 1. 决策不是只做摘要，而是分层管理

- [官方明述] 接近上下文限制时先清除旧工具输出，需要时再总结会话；用户请求和关键代码片段会保留，但早期详细指令可能丢失。[C1]
- [官方明述] `/compact` 支持指定摘要重点；CLAUDE.md 可以描述摘要应保留的信息。SDK 文档明确说摘要指令标题并非特殊配置 key，按指令意图理解。[C1][C7]
- [官方明述] skills 和 MCP schema 按需加载，子 Agent 隔离大规模读取。这些用于减缓增长，不等同于压缩已有历史。[C1][C7]
- [推断] 长任务可靠性来自控制输入增长、缩减旧内容、恢复关键状态三者共同作用，单个摘要函数无法覆盖大输出和固定提示过大的情况。

官方原句："It clears older tool outputs first, then summarizes the conversation if needed." [C1]

## 2. 预算、触发与恢复

- [官方明述] 模型上下文包括 system prompt、工具定义、消息、工具参数和结果；缓存降低重复输入成本，不减少上下文占用。[C7]
- [官方明述] 自动压缩窗口可通过 `/autocompact`、启动参数或环境变量配置，受模型实际窗口上限限制。默认阈值依模型、运行环境及网关配置变化，不能归纳成统一的“95%”。[C3]
- [官方明述] 同时存在主动压缩和收到 API 上下文超限错误后的恢复压缩。`PreCompact` 阻止前者时继续未压缩会话；阻止后者时当前请求失败并暴露底层错误。[C4]
- [官方明述] 网关若改写超限错误为不能识别的文本，恢复可能无法触发。官方记录了 Bedrock 与 gateway 错误形状的兼容修复。[C3][C6]
- [官方明述] 单次 exchange 没有更早的轮次可摘要时，不反复尝试压缩，而是解释请求可能主要由系统提示、工具定义或附件占用，并要求缩小输入。[C6]

[建议] Forge Agent 的预算必须针对完整请求；模型窗口和压缩窗口应区分。不要复制某个 Claude 模型的百分比，也不能只用 `messages` 字符估算当作全部输入用量。

## 3. 摘要保留与重注入

官方对压缩后内容的描述如下，具体数量属于当前文档所述版本行为，不是本项目推荐默认值。[C2]

| 内容 | 压缩后行为 |
|---|---|
| System prompt / output style | 不属于消息历史，保持不变 |
| 根 CLAUDE.md、无路径范围的规则、auto memory、plan | 从磁盘重新注入 |
| 路径规则、嵌套 CLAUDE.md | 读取相关文件时重新加载 |
| 读过或改过的文件 | 最多重读 5 个，优先最近修改；超过 5,000 tokens 的文件作为路径引用 |
| 已调用 skill 正文 | 每个最多 5,000 tokens，总计 25,000，超限先舍弃较旧项 |
| 早前 hook 注入内容 | 随普通会话摘要 |
| 匹配 `compact` 的 SessionStart hook | 运行并补充新上下文 |

- [官方明述] 官方演示描述摘要保留请求意图、关键技术概念、相关文件与代码、错误与修复、待办和当前工作；演示中的 token 数及压缩比例是示例，不是生产参数。[C2]
- [官方明述] SDK 描述为压缩旧历史、保留近期交流和关键决策；公开文档没有给出完整切分算法或近期消息数量保证。[C7]
- [建议] 本项目应明确哪些约束必须原文保留、哪些允许摘要，避免只依赖摘要模型“记得保留”。文件重读得到的是当前内容，不等于历史工具输出的精确副本。

## 4. 原文与可追溯性

- [官方明述] 会话消息、工具调用和结果保存在本地 JSONL transcript。[C1]
- [官方明述] 定向 Summarize 操作不改工作文件，原消息仍留在 session transcript，Claude 仍可参考细节。[C8]
- [官方明述] transcript 有保留期限，不能从“保留历史”推导出无限期归档承诺。[C11]
- [证据边界] 已确认历史与摘要后的上下文有区别；没有确认稳定的“按消息 ID 查原文”公共工具协议，也没有确认取消摘要时所有内存、磁盘变更的原子性。

官方原句："the original messages stay in the session transcript, so Claude can still reference the details." [C8]

## 5. 大输出与无进展保护

- [官方明述] Read 对超限整文件读取返回第一页与 `PARTIAL view` 提示；显式范围仍超限时返回错误并要求缩小范围。[C9]
- [官方明述] Bash 正常结果超过 inline 上限时提供文件路径和预览，可继续读取或搜索。失败结果的 excerpt 路径不同，不能说所有输出都完整可找回。当前文档还描述了工作输出和保存文件的大小上限。[C9]
- [官方明述] 自动摘要成功后，若同一类大文件或工具输出连续立即重新填满窗口，停止重试，报 `Autocompact is thrashing`。官方只说多次，不公开固定重试次数。[C5]
- [官方明述] 自动摘要因认证或模型不可用失败时，超限错误会附带摘要失败的真实原因，避免让用户不断重复 `/compact`。[C6]

[建议] 同时设计单条输出和整批并行工具结果的预算。重试必须检查释放空间及任务进展；超限恢复只重新请求模型，不应重放已完成的写文件、执行命令等工具。

## 6. 摘要自身的成本与请求形状

- [官方明述] Claude Code 使用单独摘要请求，复用会话的 system prompt、tools、history，在末尾追加摘要指令。缓存仍热时可复用旧前缀。[C10]
- [官方明述] 压缩替换消息历史会使会话缓存前缀失效，但 system prompt 层可复用；重读的项目上下文只有未变化时命中缓存。长时间后恢复会话再压缩，需要重新处理未缓存的原历史。[C10]
- [证据边界] 以上说明常规摘要请求形状，不证明已超出物理窗口时仍原样发送全部历史。公开资料没有充分披露摘要请求自身超限时的切片、重试或模型切换细节。

[建议] 成本评估不能只比较摘要模型单价；还要比较旧前缀缓存复用、摘要请求窗口和摘要后重建成本。本次不预先决定使用主模型或廉价模型。

## 7. 生命周期与扩展

- [官方明述] SDK 输出 `system` / `compact_boundary`，宿主可观察压缩边界。[C7]
- [官方明述] `PreCompact` 接收 manual/auto 触发来源和自定义指令，可阻止压缩；`PostCompact` 接收生成的 summary，但不能改变压缩结果。[C4]
- [证据边界] 未确认压缩期间 steer/follow-up 的精确消费顺序、取消等待边界、存储失败处理、压缩费用的独立上限。不能把已有 Forge Agent ADR-010 替换为猜测的 Claude Code 行为。

## 对 Forge Agent 的迁移判断

优先借鉴分层缩减、持久指令重注入、完整请求预算、主动与被动超限处理、可观察事件以及无进展停止。文件/原输出引用要与用户已批准的“能找回原文”目标对齐。

不直接移植 Claude Code 的模型窗口参数、专用文件/skill 重加载规则、多 Agent 编排和 transcript 落盘时机。它们依赖产品约定或会改变本项目当前契约。

仍待讨论：不可摘要的原始约束、摘要模型、压缩目标、并行工具批次预算、原文引用生命周期、取消和提交的一致性。

## 来源

所有来源于 2026-09-07 通过官方 `.md` 页面读取；下列链接指向同一页面的可读版本。官方文档未提供固定 commit，可能变化。

- [C1](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up): How Claude Code works；会话存储、清旧工具输出、摘要与限制。
- [C2](https://code.claude.com/docs/en/context-window#what-survives-compaction): Explore the context window；压缩后的内容恢复表，演示数据注明 representative。
- [C3](https://code.claude.com/docs/en/model-config#set-the-auto-compact-window): Model configuration；配置、默认阈值与 gateway 识别。
- [C4](https://code.claude.com/docs/en/hooks#precompact): Hooks；PreCompact、PostCompact 及主动/恢复路径。
- [C5](https://code.claude.com/docs/en/troubleshooting#auto-compaction-stops-with-a-thrashing-error): Troubleshooting；反复填满后的停止行为。
- [C6](https://code.claude.com/docs/en/errors#prompt-is-too-long): Errors；单次 exchange、底层摘要错误、供应商错误识别。
- [C7](https://code.claude.com/docs/en/agent-sdk/agent-loop#automatic-compaction): Agent SDK loop；上下文构成、摘要、事件及自定义指令。
- [C8](https://code.claude.com/docs/en/checkpointing#guide-a-summary): Checkpointing；定向摘要、原始 transcript 保留。
- [C9](https://code.claude.com/docs/en/tools-reference#output-limits): Tools reference；Bash 输出限制及同页 Read 行为。
- [C10](https://code.claude.com/docs/en/prompt-caching#compacting-the-conversation): Prompt caching；摘要请求形状与缓存成本。
- [C11](https://code.claude.com/docs/en/memory#how-it-works): Memory；transcript retention 与持久记忆的区别。

## 验证

- Ran:官方文档索引、上述正文与相关段落交叉核对；检查官方 GitHub 仓库公开目录，未以其为私有循环源码证据。
- Not run:真实 Claude Code 的超限/取消/磁盘失败注入，付费模型摘要，私有实现审计。
- Why:本轮研究产品决策与可迁移原则，不调用用户凭证或修改运行环境。
- Risk:在线文档随版本变化；文档不同页面粒度不一，具体阈值与恢复协议仍需要对目标版本实测。
