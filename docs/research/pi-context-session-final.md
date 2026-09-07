# Pi 会话存储与压缩入口补充核对

> 状态:调研完成(2026-09-07)。记录固定源码行为与 Forge 迁移建议；正式决策以 ADR 和施工图为准。

## 范围

固定 `earendil-works/pi` SHA [`9767ba275f3e9a5ee0f5c5342249b629ab1b2282`](https://github.com/earendil-works/pi/commit/9767ba275f3e9a5ee0f5c5342249b629ab1b2282)，只讨论 coding-agent 实际 `AgentSession`、`SessionManager` 与它使用的基础 Agent；不混用新增 AgentHarness。补充 [既有调研](pi-context-management.md) 的持久化、损坏文件、手动入口与配置事实。

## 行为对照

| 主题 | Pi 固定快照行为 | Forge 最小迁移合同建议 |
|---|---|---|
| 存储形态 | 带版本的 session header，加逐条 JSONL entry；entry 有 `id`、`parentId`、`timestamp` | 保留 Forge 自有版本，采用有序 entry 与稳定引用；无需与 Pi 文件互相导入 |
| 当前上下文 | 沿当前 leaf 的 parent 链取路径；最新 compaction 替代其之前已摘要材料 | 历史与请求投影分离；线性会话也可用该结构，不因此增加分支交互 |
| 首条 user | 全新且未 flush 会话先加入内存，首个 assistant 到来才把此前记录一起落盘 | 若本轮完整采用 Pi 缓冲时机，应明确首个 assistant 前尚无物理保存保证；`processed` 仍只表示已进入上下文 |
| assistant 保存 | `message_end` 保存，包括 error/aborted；不是逐 token 保存 | 保存已形成的终态与内容，后续请求过滤规则独立应用 |
| 并行工具结果 | 各工具 execution end 可先后到达；整批 settle 后按调用顺序发 toolResult message end | 沿用现有并行调度，批次 settle 后按调用顺序串行保存；不按公开进度事件到达顺序追加 |
| 取消 | abort 信号传播并等待 idle，已形成消息仍有保存路径；未形成记录不凭空补成真实结果 | 等待已开始工具/写入收尾，保存形成的记录；不执行旧调用补历史，不要求未启动工具产生真实结果 |
| JSON 损坏 | 跳过不能解析的行；不是只忽略截断尾行；header 仍需有效 | 对齐容错读取时应明示跳过，不宣称历史完整；不存在/错误引用不能当作成功执行或完整历史 |
| 旧版迁移 | v1→v2 建 parent 链，v2→v3 改旧角色名；迁移后重写原文件 | 只定义 Forge 自己的旧版升级；Pi 的版本号与迁移内容不是 Forge 合同 |
| 手动压缩 | `compact(customInstructions?)` 先 abort 当前任务并等 idle，再压缩；不会自动恢复该任务 | CLI `/compact` 与 SDK 手动入口复用自动摘要逻辑；明确打断且不自动续跑 |
| 自动压缩开关 | 默认启用；关闭也关闭 overflow/length 自动恢复，手动压缩仍可用 | 对齐同一开关语义；不开设含义不同而同名的恢复开关 |
| 摘要提示 | 内置结构化模板，历史摘要可附加 `Additional focus`；turn 前缀使用专门固定模板 | 参数化重点即可，不将其扩展成整个任意 prompt 配置系统 |
| 事件 | start/end、reason、result、aborted、willRetry、error 与摘要重试进度；另有 extension hooks | SDK/TUI 暴露相同可观察事实；无需复制整个扩展平台 |

表内来源按下文逐项给出。存储失败后的停用、usage 统一失效和显式 summary off 是 Forge 已明确保留的合同，不因上表对齐而撤销。

## 1. JSONL 与上下文重建

Pi 的 `CURRENT_SESSION_VERSION = 3`。header 包含 `type: session`、`version`、`id`、`timestamp`、`cwd` 和可选 `parentSession`；消息、模型切换、thinking 切换、compaction 等属于带 parent 的 entry。compaction 保存 `summary`、`firstKeptEntryId`、`tokensBefore`、可选 `details`、`usage`、`fromHook`。[类型定义](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L30-L92)

追加新 entry 时 parent 指向当前 leaf，再推进 leaf。压缩追加独立 compaction，不删除早期消息，也不把摘要伪装成普通 message entry。[追加方法](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L1058-L1132)

重建顺序是：

1. 从指定 leaf 沿 `parentId` 回溯再翻转，得到当前路径。
2. 找到该路径最新 compaction。
3. 输出该 compaction，然后输出 `firstKeptEntryId` 到 compaction 之前的保留条目，再输出 compaction 之后的新条目。
4. 转换为上下文消息；模型/thinking 设置另从整条路径恢复。

来源：[路径](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L334-L377)、[投影](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L383-L469)。这不是把 JSONL 最后若干行机械发给模型；非当前路径记录保留在历史但不进入该请求。

宿主可以 `getEntry(id)`、`getBranch(fromId)` 查看保留原文；这不意味着模型自动获得历史检索工具。[宿主读取](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L1217-L1291)

## 2. 保存顺序与取消

`AgentSession._handleAgentEvent` 在 user、assistant、toolResult 的 `message_end` 调用 `appendMessage`。该处理先通知扩展和公开 Session listeners，再追加存储，因此公开 message end 不能当作保存 ACK。[保存入口](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L643-L691)

这并非在无限前进的后台 consumer 中保存：基础 `Agent` 按顺序 `await listener(event, signal)`，`agent_end` listeners settle 后才结束 idle 生命周期。[等待约定](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent.ts#L244-L252)、[实际 emit](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent.ts#L538-L591)

首次落盘有独立优化：全新 session 没有 assistant 且尚未 flush 时，记录只留内存；首个 assistant 加入后用 `wx` 新建文件，写 header 与所有缓冲记录，之后逐条 append。此判断只看 role，不要求 assistant 成功，所以已形成的 error/aborted assistant 也会触发首批写盘。已加载并标记 flushed 的现有文件，即使尚无 assistant，也可以追加 user。[flush](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L1029-L1055)、[加载状态](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L898-L923)

输入 message end 在请求前；最终 assistant 先形成 message end，再判断 error/aborted 是否终止当前循环。中断时已经获得的 assistant 内容由流终态提供，Pi 不逐 token 持久化。[输入与终态](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent-loop.ts#L110-L117)、[错误终止](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent-loop.ts#L211-L219)、[流消息完成](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent-loop.ts#L361-L368)

并行工具先准备，`Promise.all` 等执行结果；`tool_execution_end` 可随各工具完成发出，而 toolResult message end 在整批返回后按原调用顺序发出。取消时尚未执行的已准备调用可以形成 `Operation aborted` 结果，准备阶段未纳入批次的调用不保证形成结果。顺序工具在当前结果发出后检测 aborted 并停止后续调用。[并行工具](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent-loop.ts#L487-L560)、[顺序工具](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent-loop.ts#L470-L478)

`AgentSession.abort()` 取消 retry、compaction、branch summary 和 agent，并等待 idle。它不回滚历史或工具副作用。[abort](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L1616-L1631)

Pi `_appendEntry` 先推进内存再执行同步写盘；写盘异常不证明内存/磁盘一致，也没有 fsync 保证。[写盘顺序](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L1029-L1063)。Forge 应保留已批准的写入失败停用实例和禁止盲目重试合同，而不是将该故障路径当作必须复制的产品行为。

## 3. 损坏文件与旧版迁移

Pi 实际 loader 按 1 MiB 块读入，逐行 JSON.parse，解析失败就跳过；最后未换行的内容也尝试解析。首条成功解析 entry 需是带 string id 的 session header，否则返回无有效记录。[loader](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L491-L556)

有效 header 下，若文件还有非空未换行尾段，loader 会追加一个换行符，即使该尾段是跳过的坏 JSON；此加载路径并非完全只读。它不是修复缺失数据，只是避免随后 append 与尾段粘连。非空但不能识别为 Pi session 的文件会报错且不初始化覆盖；空文件可初始化。[尾行与 header](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L548-L556)、[空/无效文件](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L898-L918)

它不做完整 schema/树完整性验证。源码明确提到未校验消息的 null/missing content 会在请求投影中补空数组；缺失 parent 时回溯自然停止，不能由容错加载推出“保留了完整祖先历史”。[内容兼容](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L383-L394)、[parent 回溯](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L352-L359)

版本缺省按 v1；v1→v2 给顺序历史加 id/parent，compaction index 转为 id；v2→v3 将 `hookMessage` 改名 `custom`。加载时迁移修改内存，随后 `_rewriteFile()` 原地重写；没有跨软件格式兼容含义，也不能推导为原子迁移保证。[迁移](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L230-L295)、[加载迁移与重写](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/session-manager.ts#L954-L1002)

Forge 建议采用可读历史优先的容错方向，同时使跳过行与引用缺口可诊断；不将不存在的引用当作完整历史，不自动重放工具。旧版迁移只针对 Forge 当前格式定义，保留旧文件可恢复性，不照搬 Pi 原地重写的故障窗口。此处是迁移建议，不是宣称 Pi 已具备这些更强保证。

## 4. 手动入口、开关、提示与事件

手动 `compact(customInstructions?)` 是 `/compact`、RPC、extensions 共用入口。它先 `await abort()`，之后生成摘要，成功追加 compaction 并重建；无材料或刚压缩完则抛出明确错误。手动压缩不会重试或继续刚打断的任务，摘要请求自身临时错误重试仍适用。[手动入口](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L1931-L1970)、[手动结果](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2031-L2093)

`compaction.enabled` 默认 true，`reserveTokens` 默认 16384，`keepRecentTokens` 默认 20000；有公开 auto-compaction setter/getter。关闭 enabled 时 `_checkCompaction` 直接返回，因此阈值与 overflow/length 自动恢复一起关闭；手动入口没有 enabled gate。[默认值](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/settings-manager.ts#L829-L855)、[setter](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2433-L2443)、[恢复开关](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2132-L2137)

历史摘要模板固定包含 Goal、Constraints & Preferences、Progress、Key Decisions、Next Steps、Critical Context。旧摘要使用更新模板；`customInstructions` 作为 `Additional focus` 追加，不替代整个模板。turn 前缀摘要有独立模板且未接收该 customInstructions；自动路径默认传 undefined。确定性文件列表追加在最终摘要并记入 details。[历史模板](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L467-L539)、[附加 focus](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L677-L693)、[turn 前缀与文件](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts#L950-L998)、[自动参数](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2273-L2280)

公开事件是 `compaction_start`、`compaction_end`，reason 为 manual/threshold/overflow；end 包含 result/aborted/willRetry/errorMessage，结果含摘要与 before/after estimate、usage/details；还有摘要 retry scheduled/attempt start/finished。extension 的 before hook 可取消或自供摘要，成功/失败另发 session hooks。[事件类型](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L145-L185)、[结果与恢复](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2356-L2426)、[手动 hooks](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L1972-L1993)

## 验证边界

- Ran:通过固定 SHA 的 GitHub raw 逐段读取上述源文件，核对 entry 类型、调用/保存顺序、loader/migration、手动/自动入口与事件；检查本文链接路径和格式。
- Not run:未安装上游、未执行上游测试，未做真实 provider 或文件故障注入；未修改 Forge 运行代码。
- Why:本项提供统一设计所需的可溯源行为，不是实现交付或可靠性验收。
- Risk:Pi 默认容错读取不代表严格历史完整性；首个 assistant 前的缓冲不提供落盘保证；具体 Forge schema、迁移和 SDK 实现需按其既有合同落地。
