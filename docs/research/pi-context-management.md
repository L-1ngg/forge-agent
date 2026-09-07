# pi 上下文管理源码调研

> 状态:调研完成(2026-09-07)。这是上游机制与可迁移判断，不是 Forge Agent 已批准的实现规格。

## 快照与范围

- 仓库: `earendil-works/pi`，本次公开 HEAD 固定为 [`9767ba275f3e9a5ee0f5c5342249b629ab1b2282`](https://github.com/earendil-works/pi/commit/9767ba275f3e9a5ee0f5c5342249b629ab1b2282)，提交时间 `2026-09-06T00:30:17+02:00`，查询日期 `2026-09-07`。最初从 `badlogic/pi-mono` 克隆；现场 HTTP HEAD 验证旧地址 301 到 `earendil-works/pi`，后者 `git ls-remote HEAD` 与克隆 SHA 相同。引用统一使用当前规范地址，不将其当作两个独立 fork。
- 主要追踪 coding-agent 实际 `AgentSession` 路径；同时核对基础 `Agent`、新增 `AgentHarness` 和 `pi-ai` 的职责边界。
- 上游快照 `pi-ai` 包版本为 `0.85.1`；Forge 本地 `packages/core/package.json` 与 `bun.lock` 锁定 `0.84.4`，另有本地 patch。本文没有把上游 HEAD 当作 Forge 已安装行为。[上游包版本](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/package.json#L1-L4)。
- 证据类型:公开 TypeScript 源码。文中“建议”“推论”是对 Forge Agent 的设计判断；其余机制均附固定 SHA 链接。

## 核心结论

pi 的方案是三层组合:工具先限制单次输出，运行中按窗口预算触发摘要，供应商仍报告超限时压缩并重试一次。压缩不删除旧会话记录，而是追加摘要记录，再由它重建模型上下文。它并不承诺无限续跑，也没有用精确 tokenizer 证明下一请求一定能装下。[阈值与估算](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L125-L237)、[overflow 恢复](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2132-L2202)、[上下文投影](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L410-L469)。

## 1. 职责归属

| 层 | 本快照的职责 |
|---|---|
| 基础 `Agent` / `agent-loop.ts` | 在每次请求前调用可选 `transformContext`，再 `convertToLlm`，最后组装 system prompt、messages、tools。该基础循环不内置 coding-agent 的摘要策略。 |
| `coding-agent/AgentSession` | 选择触发时机、执行摘要、处理 hooks、持久化 compaction、更新 Agent 消息、决定是否继续。 |
| 新增 `packages/agent/src/harness/` | 已包含并导出 compaction 与持久化结构操作；因此“agent-core 包完全没有压缩能力”在本快照已不准确。它与基础 Agent、coding-agent 路径须分别讨论。 |
| `pi-ai` | 模型传输与供应商错误归一化，包括 `isContextOverflow`；不能仅因 Forge 使用 `pi-ai` 就获得上述会话策略。 |

证据:[基础循环请求组装](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent-loop.ts#L275-L310)、[coding-agent 预检安装](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L542-L582)、[新 harness 导出](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/index.ts#L41-L78)、[harness 阈值与单次 overflow preparation](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/runtime/drive/structural.ts#L1116-L1168)、[pi-ai overflow](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/utils/overflow.ts#L134-L177)。

## 2. 何时压缩、怎样估算

本快照 coding-agent 的装配仍明确执行 `new Agent(...)` 后 `new AgentSession(...)`，没有在该入口采用新 `AgentHarness`。后文默认值、摘要和恢复描述均属于这条实际路径。[Agent 装配](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/sdk.ts#L304-L314)、[Session 装配](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/sdk.ts#L388-L402)。

默认 `enabled: true`、`reserveTokens: 16384`、`keepRecentTokens: 20000`。触发式为 `contextTokens > contextWindow - reserveTokens`，是绝对 token 余量而非固定百分比；近期原文保留目标是约 20000 tokens，并非严格上限。[默认值与判定](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L125-L237)。

实际有多个时机:

1. 下一次 assistant response 之前，通过 `prepareNextTurnWithContext` 检查当前消息估算，必要时压缩，并替换传给模型的消息。这覆盖工具循环里的增长，不只检查用户下一次发言。
2. `_checkCompaction` 在执行结束或 prompt 提交前检查:有效 usage 超阈值，压缩但不重复已完成回答；成功回答已超过窗口，同样保留回答再压缩。
3. 超限错误或可恢复 `length` 终态走一次 compact-and-retry。不是所有 `length` 都当作输入超限。

证据:[请求前检查](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L542-L582)、[完整触发分类](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2111-L2235)。

估算优先使用最后一条有效 assistant 的 `usage.totalTokens`，否则求 `input + output + cacheRead + cacheWrite`；在它之后追加的消息单独估算。无有效 usage 时对全部消息估算。error、aborted、全零 usage 不作有效锚点。文本采用字符数除 4；图片使用固定 4800 字符等价值，即约 1200 tokens。[usage 与追加估算](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L142-L229)、[文本与图像估算](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L244-L309)。

限制与推论:纯消息估算路径没有单独计入 system prompt、工具 schema、供应商包装；最近一次真实 usage 可以提供历史请求的整体锚点，但动态改变工具或 prompt 后并不等于精确新请求预算。字符数除 4 也不能保证对中文、特殊文本、图像始终保守。因此 Forge 不应照搬源码注释中的“conservative”当作数学保证。

另有防重复机制:切换模型后不拿旧模型错误触发当前模型 overflow；压缩前旧 assistant 的 usage/error 不能再次触发压缩；错误或全零 usage 回退到有效历史 usage 或纯估算。[防陈旧数据](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2141-L2155)、[错误与全零回退](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2204-L2233)。

## 3. 保留边界与工具配对

从最新消息向前累计估算 tokens，到 `keepRecentTokens` 后选合法边界。边界可以在 user 或 assistant，不能从 tool result 开始；保留带 tool calls 的 assistant 时，随后的结果一起保留。因此 pi 允许压缩发生在一个用户 turn 内，并不是要求保留整个 invocation。[边界规则](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L345-L460)。

如果切在 turn 中间，找到启动该 turn 的 user 消息，将待摘要材料分成“此前历史”和“当前 turn 被省略的前缀”。分别摘要后合并为 history summary + `Turn Context (split turn)`，让近期保留片段仍能知道当前任务来源。[准备分区](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L750-L803)、[生成与合并](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L883-L947)。

迁移意义:若 Forge 坚持“只压缩完整用户 invocation”，一次超长工具任务仍可能无法缩短；至少需要定义可以切分的完整 assistant/tool-result 批次边界。合法边界保证协议结构，不自动保证压缩后小于预算。

## 4. 摘要如何生成与更新

摘要是额外模型调用。使用当前请求模型，并沿用 thinking level、stream function 和重试配置。先将对话序列化成文本并放入 `<conversation>`，而不是继续原工具对话；旧摘要放入 `<previous-summary>`。首次模板要求 Goal、Constraints & Preferences、Progress、Key Decisions、Next Steps、Critical Context；增量模板要求保留既有信息、更新状态，并允许删除不再相关信息。文件路径、函数名和错误要求精确保留。[模板](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L465-L539)、[摘要调用](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L655-L704)、[Session 参数](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L1899-L1923)。

历史摘要输出上限是 `min(floor(0.8 * reserveTokens), model.maxTokens)`；turn-prefix 上限是 `min(floor(0.5 * reserveTokens), model.maxTokens)`。两者可能各调用一次，因此不能把“一次 compaction”理解为必定只有一次模型请求，也不能把 reserve 当作二者合计硬预算。最终以确定性逻辑附加读过/修改过的文件列表，并保存至 details。[历史上限](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L671-L675)、[前缀上限](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L970-L998)、[文件与 usage 结果](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L924-L962)。

## 5. 原始历史与模型上下文分开

摘要自身也可能超限:默认生成路径直接把待摘要文本与旧摘要组成一次 standalone 请求，没有在这里分块后递归摘要、或遇到输入超限后逐级缩小材料的算法；失败交给上层。它去掉原工具 schema 与原 system prompt，只使用摘要 system prompt，可减少请求负担，但不是容量证明。此外请求显式 `cacheRetention: "none"`，缺少 sessionId 时生成新 routing ID，不能描述成复用原完整对话的 prompt cache。[standalone 结构](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L641-L652)、[组装及失败](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L683-L725)、[缓存选项](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L585-L598)。

会话是带 `id`、`parentId` 的记录树。压缩追加一条 `compaction`，保存 `summary`、`firstKeptEntryId`、`tokensBefore`、details、usage；原消息不被删除。构造上下文时选当前 leaf 的路径，用最新 compaction + 从 firstKeptEntryId 开始保留的旧消息 + compaction 之后的新消息。发给模型时摘要转换为带固定前后缀的 user 消息，system prompt 仍单独提供。[追加记录](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L1111-L1132)、[重建投影](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L410-L469)、[模型消息格式](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/messages.ts#L176-L183)。

重要边界:pi 在 `message_end` 就追加消息，持久化通常追加 JSONL，首个 assistant 前存在延迟 flush。它不是 Forge 现有“整个 invocation 成功才 appendTurn”的提交语义。原文仍在记录里，不等于模型已经有自动按引用查回任意旧消息的内置能力；本次路径证明的是存储保留与上下文投影。[消息持久化入口](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L670-L691)、[JSONL flush](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L1029-L1055)。

## 6. 超限、失败与取消

原文找回的实际接口存在于宿主侧 `SessionManager.getEntry(id)`、`getBranch(fromId)` 等；内置工具名单没有专用 session-recall 工具。要让模型按摘要引用自动找回旧对话，需要宿主/扩展提供能力，不能把“磁盘上还在”写成“模型能自动召回”。[宿主读取接口](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L1217-L1290)、[内置工具名单](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/index.ts#L90-L108)。

- overflow 或可恢复截断:从活动消息尾部移除失败 assistant，保留原历史记录，压缩后继续同一任务；若重建上下文又带回该错误，再移除一次。第二次同类失败停止恢复并报告错误。[单次恢复](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2161-L2201)、[重建后处理](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2387-L2402)。
- 摘要模型 error、摘要 length 截断不能成为有效 checkpoint；摘要临时网络错误可按 retry policy 重试，确定性错误和取消不继续重试。[失败分类](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L541-L598)。
- 有单独 AbortController；扩展 cancel 或 signal aborted 时发布失败/取消事件并返回，不追加成功 compaction。只有摘要完成且未取消才 appendCompaction、重建活动上下文；异常上报 compaction failure。[执行与取消](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2248-L2428)。
- 预请求阈值检查在自动压缩返回后仍继续交出当前消息，并非一个“压缩失败就硬阻止模型请求”的严格 admission gate。Forge 若需要“请求必须落在预算内”应明确另加后置检查。[预检返回行为](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L542-L558)。

## 7. 巨大工具结果先控量

内置文本工具通常使用 2000 行或 50 KiB，先达到哪项就截断。`read` 保留头部，通过 offset/limit 接着读；shell 工具保留尾部，完整输出保存在临时文件，并将路径放入模型可见结果。不是只在 TUI 折叠显示。[默认限制](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/truncate.ts#L1-L12)、[read](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/read.ts#L141-L174)、[shell 输出与引用](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L310-L334)。

限制:这是工具级策略，不能保证任意扩展工具、用户输入和多个并行结果的合计大小；临时文件也不等同于长期可用的归档。Forge 需要按其工具契约决定统一上限、引用生命周期和再次读取的规则。

## 8. 扩展点与迁移建议

`session_before_compact` 收到 preparation、完整 branch entries、reason、willRetry、signal，可取消或提供自定义摘要结果。完成后有 `session_compact`；失败有对应通知。另外每次请求的 `context` hook 可经 `transformContext` 调整模型消息，不需要持久化压缩才能使用。[压缩 hook](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2273-L2305)、[结果事件](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2362-L2385)、[请求 context hook](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/sdk.ts#L362-L365)。

建议迁移的决策:

1. 将原始会话记录与模型上下文投影分开，摘要带覆盖范围和保留边界；取消后的存储语义单独设计。
2. 每次模型调用前准备上下文，覆盖工具链内部增长；实际 usage 加新增消息估算可作基线，但计入固定 prompt、工具定义与安全余量。
3. 用合法消息边界切分，必要时允许同一用户任务内压缩，并显式保留该任务的请求与状态。
4. 大工具结果先控量，摘要作为第二道机制；超限识别后的恢复有次数上限，摘要失败不发布成功 checkpoint。
5. 暴露 start/end/failure、摘要 usage 与取消，不要求第一版复制整个扩展框架。

不能直接照搬:16384/20000 默认值、字符数除 4 的保守性假设、逐消息立即持久化、巨大 AgentSession 的结构、新 harness 的持久化 operation 状态机。尤其新增 harness 已含结构操作中断恢复，但用户本次选择只要求当前任务内自动续跑，不能据上游存在该能力就扩大到进程重启恢复。[harness 中断恢复机制](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/runtime/drive/structural.ts#L1075-L1113)。

## 验证与限制

- Ran:克隆公开仓库、固定 HEAD 与提交时间、逐段核对上述入口和实现源码。
- Not run:未安装上游依赖、未跑上游测试、未发起真实供应商摘要或 overflow 请求；这是设计调研，不是上游可靠性验收。
- Why:当前任务要调查上游决策，源码足以确认实现契约；实际误差、摘要保真与供应商失败形式需要后续针对 Forge 的实验。
- Risk:HEAD 不是指定 release；基础 Agent、新 AgentHarness 与 coding-agent 同时存在，结论已按路径区分。摘要可能遗漏信息，原文保留不自动补足召回；固定预算并不保证一次压缩足够。

## 后续核对：usage 的失效范围

> 核对日期:2026-09-07；同一固定 SHA。此节限定前文“防陈旧数据”的适用路径，避免将 `_checkCompaction` 的局部防护推广为所有请求统一失效。

结论：pi 有局部保护，没有覆盖压缩、切换模型、改变 system prompt / 工具定义的统一 usage 失效或重新计量机制。本节为源码核对与标明的路径推导，未运行复现。

| 变化 | 源码可确认的行为 | 未覆盖的范围 |
|---|---|---|
| 压缩 | `getContextUsage()` 在压缩后没有新成功 usage 时返回 tokens/percent 为 null；`_checkCompaction()` 忽略压缩前的 usage/error | 请求前 `_compactBeforeNextAssistantResponse()` 直接调用消息估算器，没有相同压缩边界检查；仍可能采用保留消息中的旧 usage |
| 切换模型 | `setModel()` 更新模型、thinking 和事件；`sameModel` 限制旧 overflow/recoverable-length 错误触发恢复 | 旧模型成功 usage 未统一失效，阈值分支也未检查 sameModel |
| 改 system prompt | `before_agent_start` 可改写提示，运行时可重建提示 | 没有看到 usage 失效或固定材料差量重新核算 |
| 改工具定义/启用工具 | `setActiveToolsByName()` 更新工具并重建提示；reload 更新工具注册 | 没有看到关联该变化的 usage 失效或重新计量 |

证据：

- [估算器 compaction.ts:151-229](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L151-L229)：`estimateContextTokens(messages)` 只接收消息，不知道当前 model/system/tools 或压缩版本；排除 error、aborted、missing/zero usage 后取最近有效值加增量。
- [显示用量 agent-session.ts:3383-3427](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L3383-L3427)：压缩后无新成功 usage 返回未知，而不是已重新精确计量。
- [局部压缩检查 agent-session.ts:2132-2234](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2132-L2234) 与 [请求前路径 :542-581](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L542-L581)：两个路径防护不同。后者直接 `shouldCompact(estimateContextTokens(context.messages).tokens, model.contextWindow, settings)`。
- [上下文重建 session-manager.ts:383-471](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L383-L471)：保留的 assistant 消息仍含原 usage。与请求前路径结合，可推导压缩前 usage 仍可能被采用，未做运行时复现。
- [setModel :1658-1677](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L1658-L1677) 与 [sameModel :2142-2162](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2142-L2162)：不应把旧模型错误过滤当作旧成功 usage 全部失效。
- [提示改写 :1276-1305](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L1276-L1305)、[工具选择 :964-985](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L964-L985)、[运行时重建 :2761-2841](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2761-L2841)：更新 prompt/tools 的实际路径；该 AgentSession 没有独立 setSystemPrompt 方法。

迁移判断：采用 usage 加增量的算法，不等于接受旧依据跨任意请求变化继续有效。Forge 明确要求的统一有效性检查属于补充设计，不能称为 pi 已完整具备的功能。

## 后续核对：未完成工具调用的请求转换

同一固定 SHA，Forge 在第 9 项确认逐步持久化后核对下一项所需事实；本节为源码调查，不是 Forge 已批准的配对规则。

- 原始会话可保留 assistant 的工具调用而缺少部分后续结果。SessionManager 重建当前分支消息，不在历史中补写结果。[重建路径](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L383-L469)
- pi-ai 的 transformMessages 在请求转换中追踪工具调用及已有结果；遇到后续 user/assistant 或消息末尾，为没有结果的调用补 toolResult，文本为 No result provided，isError 为 true。已有真实结果保留；合成消息不写回原始历史，不执行旧工具。[转换实现](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/api/transform-messages.ts#L158-L220)
- assistant 本身以 error/aborted 结束时，这个转换跳过整条 assistant 消息；这与正常生成工具调用、后来工具结果缺失的情况不同。不能把此过滤直接解释为回滚已执行动作。[中断 assistant 过滤](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/api/transform-messages.ts#L185-L206)
- 已核对 Anthropic、OpenAI Completions/Responses、Google shared、Bedrock、Mistral 的调用路径使用共享转换；不是会话层统一强制。pi-messages 客户端直接向后端传递 context，不调用这一转换，不能泛化为所有自定义后端都由客户端补齐。[Anthropic](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/api/anthropic-messages.ts#L1028)、[Responses](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/api/openai-responses-shared.ts#L172)、[pi-messages](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/api/pi-messages.ts#L1-L9)

迁移建议：原始历史保真，仅在请求视图补明确的结果缺失提示；不知道真实执行状态时不声称未执行、成功或回滚。这个结构修补不保证模型以后不会主动生成新的同类调用。未运行上游或真实供应商请求，也未据此确认 Forge 锁定的 0.84.4 所有路径行为。

后续第 10 项 operator 已确认上述缺失结果请求补齐方向，正式规格见 [ADR-013](../decisions/013-incremental-session-persistence.md#缺失工具结果)；assistant 自身 error/aborted 的过滤规则仍单独讨论。

第 11 项随后确认 error/aborted assistant 的已获得内容及状态保留为历史，后续任务请求整条跳过；不扩展为 length 或自动重试。正式边界见 [ADR-013 中断模型响应](../decisions/013-incremental-session-persistence.md#中断模型响应)。

## 后续核对：length 的恢复基准

同一固定 SHA，[AgentSession 的恢复调用](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2157-L2201) 将 model.maxTokens 传给 [isRecoverableLength](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/utils/overflow.ts#L164-L172)，条件为 length 且实际 output 小于该正数上限。没有使用上下文压低后的输出限额，也没有优先读取调用方单独设置的更低上限。由此可能在主动限制输出的情况下仍尝试压缩，不能将这条判断当作上下文不足的证明。

第 13 项 operator 确认原样采用模型上限基准，不采用此前提出的本次配置上限调整。该恢复与明确超限共享一次机会，正式规则见 ADR-012 与设计稿。已核对本地 pi-ai 0.84.4 的公开 helper 具有相同判断表达式；未发起真实截断恢复请求。

## 后续核对：主动压缩失败后的继续行为

同一固定 SHA，普通请求前的主动压缩与失败后的恢复调用共享自动压缩函数，但调用者对返回值的处理不同：

- [请求前路径](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L542-L559) 等待 `_runAutoCompaction("threshold", false)` 后直接返回当前消息，不因其返回 false 而拒绝任务请求。[无材料路径](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2253-L2269) 直接返回 false；摘要异常通常由自动压缩捕获并返回 false，因此普通请求可继续。
- [overflow/length 恢复](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2172-L2201) 先占用一次恢复机会，只有[成功的 willRetry 分支](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2387-L2426) 返回 true 才促成该次恢复续跑；失败或无材料不触发该次重试。上层仍有独立的排队输入处理，不能泛化为失败后永远不会有任何请求。
- [任务 abort](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L1619-L1624) 同时取消 compaction 与 agent，不代表取消任务后仍继续。错误事件/扩展监听器抛异常也可能使失败处理传播异常，不能表述为任何异常都被吞掉。
- Pi 的自动压缩 catch 同时覆盖保存异常；[SessionManager](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L1058-L1063) 先更新内存结构再写盘，因此不能承诺保存失败后内存与磁盘仍完全一致。

第 15 项 operator 确认采用主动压缩失败继续、恢复压缩失败不重试的方向；Forge 的有界摘要预算/分块失败按相同场景区分处理。用户取消及 ADR-013 的存储失败停用规则继续生效，后者是保留的 Forge 差异。本节为源码核对，未跑上游测试或真实供应商请求。

## 后续核对：压缩效果、重复触发与恢复链

同一固定 SHA，范围仍是 coding-agent 的 AgentSession 及其 compaction 模块，不泛化到新的 AgentHarness：

- [候选保存路径](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2339-L2385) 先 appendCompaction、重建上下文，随后计算 estimatedTokensAfter。没有要求 after 小于 before 才能发布。[底层 compact 返回值](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L949-L963) 也没有压缩后大小判定。
- [请求前检查](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L542-L559) 只尝试一次，不循环压缩至低于阈值。没有连续三次快速再触发即停止的 context_thrashing 机制；后续新请求/响应可以再次触发。
- [prepareCompaction](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L750-L807) 在分支末条已是 compaction 时直接返回空；没有新增记录时避免原地重复压缩。[响应后检查](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2148-L2155) 另有旧压缩边界过滤，不能将其推广成请求前 usage 已全面失效，范围见前文。
- `_overflowRecoveryAttempted` 限制连续失败链的一次恢复，并非每个 invocation 永远一次。[新 user 的 message_start](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L646-L647) 和[非 error/length 的 assistant message_end](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L693-L700) 都会重置它。摘要成功不是该任务响应重置条件。

第 16 项 operator 在了解上述流程后确认采用 Pi 方案。Forge 删除摘要必须变小及频繁压缩终止提案，保留已批准的摘要有效性、存储故障停用和有界摘要调用预算；预算是 Forge 补充，不能据此声称 Pi 也有相同次数上限。源码事实已核对，未执行上游测试或供应商请求。

## 后续核对：摘要的临时错误重试

同一固定 SHA，摘要重试位于 coding-agent 调用包装层，不能由 provider 默认零重试推导为摘要不重试：

- [AgentSession](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L1899-L1923) 将 settings.retry 传入 compact；历史与 turn 前缀各自通过 [completeSummarization](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L572-L598) 调用 retryAssistantCall。
- [默认配置](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/settings-manager.ts#L869-L887) 为 enabled = true、maxRetries = 3、baseDelayMs = 2000。[重试循环](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/utils/retry.ts#L163-L212) 默认首次加最多三次，等待 2/4/8 秒，只重试当前失败的摘要调用，不重跑此前已成功的摘要。
- [错误分类](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/utils/retry.ts#L7-L90) 根据 error 文本判断网络、timeout、429、部分服务端错误等临时故障；quota/billing 等永久额度错误排除。aborted、length 不进入临时错误重试；length 后续被摘要校验拒绝。helper 直接 await produce，没有 catch 任意 Promise rejection，因此自定义 stream 直接抛错不保证自动重试。
- [provider 公共重试默认值](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/utils/provider-retry.ts#L97-L123) 为零，已核对的内置 SDK 也关闭自带重试；显式配置或自定义 stream 可改变行为。[completeSimple](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/compat.ts#L291-L297) 本身只是等待流结果，不能将三次重试归到该函数内部。

第 17 项 operator 确认摘要继承主任务配置及 Pi 默认退避；Forge 保留内核统一计数、provider 重试显式关闭、摘要总预算和取消边界。所有尝试均占用额度，总预算可以先耗尽；该预算是 Forge 补充，初稿 6/32 次尚未定案。最终失败按第 15 项处理，不增加任务超限恢复次数。

已只读核对 Forge 锁定 pi-ai 0.84.4 也有策略驱动的 retryAssistantCall 和 provider 默认零重试；库具备 helper 不代表 Forge 已接入摘要重试。本轮未修改运行代码，也未执行真实 API 故障重试。

## 后续核对：累计调用额度与固定摘要流程

同一固定 SHA，在 coding-agent AgentSession 到默认 compact/completeSummarization 的路径中，未发现每次压缩或每个 user turn 的累计摘要调用额度；这个结论不涵盖新 AgentHarness、第三方扩展或自定义 stream。

- [默认 compact 流程](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L887-L946) 依次生成可选的历史摘要与 turn 前缀摘要，最多两个逻辑摘要请求。最后按文本结构拼接，没有第三次模型合并，也没有通用局部摘要分块。
- [completeSummarization](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L579-L598) 为每个请求建立独立重试循环。[retryAssistantCall](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/utils/retry.ts#L163-L196) 的 attempt 为局部变量；默认每个请求首次加最多三次重试，两个摘要都执行时最多八次 produce 入口调用。八次是默认结构推导，不是单独的累计额度配置。
- [CompactionSettings](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/settings-manager.ts#L13-L17) 只包含 enabled、reserveTokens、keepRecentTokens。[摘要重试回调](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2859-L2905) 转发进度，不维护跨摘要累计额度；任务恢复标志也不是摘要总次数预算。后续压缩重新建立单请求重试循环。

第 18 项 operator 指令“都采用Pi的方式”替代此前第 6 项分块方案及第 17 项仍保留的累计额度：Forge 取消通用分块/模型合并、每次压缩 6 次及 invocation 32 次限制，采用固定摘要流程与单请求有限重试。保留累计次数/usage 观察、取消、摘要输出上限、失败续跑及其他独立的工具/存储边界。前文记录的分块或总预算保留意见属于当时选择，最新决策以 ADR-012 为准。未修改运行代码，未执行真实 API 调用。

## 最终整理：摘要材料与方案入口

operator 随后要求剩余上下文工程直接对齐 Pi 并整理方案。最新统一决策为 [ADR-014](../decisions/014-pi-aligned-context-management.md)，[施工方案](../phases/context-management.md) 替代旧提案集合；前文各阶段选择保留作历史记录，不再将 ADR-012 当当前规格入口。

本轮直接核对同一 SHA 的 compaction.ts 与 compaction/utils.ts，补充此前未展开的事实：

- [摘要序列化](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/utils.ts) 的 TOOL_RESULT_MAX_CHARS 为2000，按JS length/slice保留工具结果文本开头并追加省略字符数；user/assistant文字、thinking和调用参数采用文字表示。图片不是原样作为视觉附件送进这个文本摘要请求。工具结果截断仅用于摘要输入，不改会话记录，不是core普通请求统一结果限额。
- 同文件从read/write/edit调用提取路径，继承之前compaction.details，生成read-files/modified-files列表；没有验证这些调用实际成功，不将文件列表当作独立执行证明。
- [generateSummaryWithUsage](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L655-L724) 序列化后直接构造独立请求，没有另算摘要输入硬预算或通用容量分块。正的model.maxTokens才限制按reserveTokens算出的输出上限；非正值不作为零输出限制。
- [completeSummarization](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L579-L598) 设置cacheRetention=none，已有sessionId沿用，没有则生成新的路由ID；不能宣称摘要使用主任务对话缓存。
- [findCutPoint](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L397-L460) 从后向前累计后选择合法切点，keepRecentTokens不是严格至少保留值；不得将旧稿“向更早边界扩展”当作精确照搬。

工具及会话剩余事实见[工具核对](pi-context-tools-final.md)与[会话核对](pi-context-session-final.md)。本轮是源码调查和文档整理，未运行模型、迁移文件或修改运行时。
