---
doc_kind: note
created: 2026-09-08
---

# Pi 内核固定快照：上游执行语义与复用边界

> 状态:历史调研记录(2026-09-09)。本文保留固定快照的上游语义证据；现行范围见 [ADR-015](../decisions/015-pi-core-source-migration.md)，施工与验收见[内核接入](../phases/pi-core-migration.md)。研究建议不作为当前施工授权。

## 结论

高保真目标必须选定具体装配。固定快照同时提供轻量 `Agent + agent-loop`、标准 coding-agent 的 `AgentSession`，以及独立的持久化 `AgentHarness`；它们不等价。标准 CLI/SDK 的实际路径仍然是 `AgentSession → Agent → runAgentLoop`；新 Harness 在 experimental worker 中装配。把所有层的特性合称“Pi 内核”会混淆默认值、持久化责任和迁移规模。[S1][S2][S3][S4]

若目标是还原标准 Pi 的执行内核，建议以 `Agent + agent-loop` 为行为基准，以 `AgentSession` 为宿主策略参考，明确列出 Forge 保留的外部 SDK 契约。新 Harness 的 durable operation、lane、storage、recovery 应另行决策，不能当成替换 loop 时自动获得的能力。[S1][S3][S4][S14]

## 基线与证据方法

- 唯一上游基线：`earendil-works/pi@9767ba275f3e9a5ee0f5c5342249b629ab1b2282`，与 Forge ADR-014 调研基线一致。源码 permalink 均固定此 SHA。
- 原 `/home/l1ngg/dev/pi-clone` 缺少目标 git 对象，未修改原 checkout；在独立临时目录 fetch 指定 SHA 后阅读源码。
- `packages/agent` 包为 `@earendil-works/pi-agent-core@0.85.1`；`pi-ai`、`pi-coding-agent` 同为 `0.85.1`。`pi-agent-core` 声明 Node `>=22.19.0`，ESM 入口为 `dist/index.js`；依赖 `pi-ai`、`chord`、`pi-telemetry` 的范围为 `^0.85.1`，还包含 `typebox` 等依赖。[S5]
- 2026-09-08 只读查询官方 npm registry，`pi-agent-core@0.85.1` 和 `pi-ai@0.85.1` 都存在，registry `gitHead` 都为 `d981de1229ef899957bbe968bc8dcda02a21f477`，不等于研究 SHA。进一步读取官方 tarball 的全部 `.js.map.sourcesContent`，按 sourcemap 源路径与研究快照逐一比较：agent **90/90**、ai **177/177** 完全相同，差异 **0**，路径未解析 **0**。[N1][N2]
- 上述比较证明所覆盖运行时源码的一致性，不证明整个 monorepo、非 sourcemap 资源、构建结果与全部传递依赖完全一致。安装精确版本并锁定依赖是可行候选；仍须复核 Forge 现有 `pi-ai@0.84.4` patch、API 类型变化及 Bun 运行兼容性，不能因版本存在直接宣布可无缝替换。
- 根许可证及包声明均为 MIT；复制或 vendor 实质代码须保留版权与许可文本。直接依赖与源码复用均有许可证依据。[S5][S6]

### Sourcemap 比较的复现方法

以下记录本次已执行算法，没有在收尾阶段重复联网或比较。输入是 [N1]/[N2] 的 `dist.tarball`，分别为 `https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.85.1.tgz` 和 `https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.85.1.tgz`，以及上述固定 SHA 的源码树。

1. 用 Python `urllib.request.urlopen` 读取 tarball bytes，使用 `tarfile.open(fileobj=io.BytesIO(bytes), mode="r:gz")` 在内存中读取，不需要将包安装到仓库。
2. 遍历归档中所有名称以 `.js.map` 结尾的成员，解析 JSON，逐对遍历 `zip(map.get("sources", []), map.get("sourcesContent", []))`。
3. 对每对 `(source, sourceContent)`，源文件路径按 `resolve(snapshotRoot / "packages" / packageFolder / Path(member.name).relative_to("package").parent / source)` 解析；`packageFolder` 分别是 `agent`、`ai`。这是本次使用的路径规则，没有额外拼接 `sourceRoot`。
4. 路径不存在计入 `unresolved`；存在则比较 `Path.read_text() == sourceContent`，相等计入 `identical`，否则计入 `different`。观测结果为 agent `identical=90, different=0, unresolved=0`，ai `identical=177, different=0, unresolved=0`。计数单位是配对后的源码记录；算法不检查没有 `sourcesContent` 的映射或未进入 sourcemap 的资源。

本次 registry metadata 记录的 `dist.integrity` 如下；这是 registry 声明值，**本次没有独立重算 tarball digest**。[N1][N2]

| 包 | `dist.integrity` |
|---|---|
| `@earendil-works/pi-agent-core@0.85.1` | `sha512-hIXIP3eAWueAYiAl8aMvWCvvZ8Q5gT3Dip5bE5uJyIGh4+YlWRjtMLI4BaeoXoSs93zndjue61u1B/vhefLnuA==` |
| `@earendil-works/pi-ai@0.85.1` | `sha512-+VgVIJDkDO2efYJKEEqvPTH4zmnIaXdAppGbO+vKFA9qy5PdhFiAenuFAkU+oiCSfOC4dMHDyrjdQeL4ZoC5CQ==` |

## 三种装配的实际差别

| 范围 | 状态与责任 | 默认与边界 | 证据 |
|---|---|---|---|
| `Agent + agent-loop` | 内存 transcript、流状态、工具运行、steering/follow-up；宿主注入 stream、转换、hooks | parallel；两个队列均 one-at-a-time；无自有 session storage、无应用级 retry 循环、无 deferred 轮询 | [S1][S7][S8] |
| 标准 `createAgentSession` | 构造 Agent，订阅其事件；SessionManager 持久化、extensions、model runtime、自动压缩、retry 归 AgentSession | SDK 未覆盖 toolExecution，因此仍为 parallel；队列默认 one-at-a-time；retry 默认 enabled/3 retries/2000ms base | [S2][S3][S9] |
| 新 `AgentHarness` | Session/Branch/Lane 分离；操作 admission/drive/recovery、事务提交、usage ledger、持久队列、工具效果状态 | parallel；两个队列默认 all；retry 默认 enabled/3 retries/1000ms base；支持 deferred suspend/poll | [S4][S10][S11][S14] |

标准 coding-agent tools 通过 wrapper 转发工具的 `executionMode`；自定义工具可让 batch 降为 sequential。不要把“默认 parallel”理解成每次一定并发，也不要照搬旧版本“工具之间消费 steering”的描述。[S12][S7]

## Agent 状态、turn 与事件契约

1. `prompt()` 在 busy 时拒绝；输入可为 string、单消息、消息数组。默认 model 是 `unknown` 占位值，thinking 为 `off`，system prompt 为空，transport 为 `auto`；真实模型必须由宿主提供。赋值 `state.messages/tools` 只复制顶层数组，不是深不可变存储。[S1]
2. run 开始先置 `isStreaming=true`；普通 prompt 的事件为 `agent_start → turn_start → 用户 message_start/end → assistant message_start/update/end → 工具事件和工具 message_start/end → turn_end`。还有工具或 steering 时开启下一 turn；无继续工作且无 follow-up 后 `agent_end`。[S7]
3. 一次 turn 对应一次 assistant response 及它的全部工具结果，不等于完整用户请求。`agent_end.messages` 是本次 run 的新消息，不是整个历史。assistant `message_end` 在工具运行前发生。[S7]
4. `processEvents` **先 reduce 内部状态，再按订阅顺序 await listener**；`message_end` 把消息加入 Agent transcript；`tool_execution_start/end` 修改 pending ID 集合。订阅者可观察到已经变化的状态。[S1]
5. `agent_end` 发出时 Agent 仍 busy；所有该事件的 listener settle 后 `finishRun()` 才清 streaming/pending、resolve `waitForIdle()`。不能收到 agent_end 就立即重入 prompt；宿主要等待 run promise 或 idle。[S1] 上游已有 async subscriber/idle 测试，但本次未运行。[T1]
6. `continue()` 拒绝空历史。若尾消息为 assistant，优先 drain steering，再 drain follow-up，均空才拒绝；steering 路径跳过首次额外 drain，以保持 one-at-a-time。否则从当前上下文继续，不添加新用户 prompt。低层 `runAgentLoopContinue` 没有队列特判，直接拒绝 assistant tail；非 assistant 自定义消息仍须由 converter 变成 provider 可接受消息。[S1][S7][T1]
7. 下一 turn 才调用 `prepareNextTurn`；可以替换 context/model/thinking。`shouldStopAfterTurn` 在 `turn_end` 后、下一次 steering drain 和 prepare 前执行。准备期间新到 steering 只有此前 poll 为空时再 drain，避免 one-at-a-time 一轮消费两条。[S7][S8]
8. 每次 provider call 前顺序为 `transformContext → convertToLlm → getApiKey → streamFunction`。`Agent` 在 run 起始复制上下文与工具数组；运行中改 state 不等于已修改当前 loop snapshot。标准 AgentSession 在 prepare hook 刷新 systemPrompt/tools/model/thinking 并衔接压缩。[S1][S2][S3][S7]

## 工具批次、hooks 与结果

| 行为 | 固定快照语义 | 证据 |
|---|---|---|
| 并行默认 | 各调用先按源码顺序 emit start、prepare/validate/before hook；整个 prepare 阶段结束，allowed execute 才并发；end 按完成顺序，toolResult 消息按 assistant 源码顺序 | [S7][S8][T2] |
| 串行覆盖 | 全局 sequential，或 batch 中任一已解析工具 executionMode=sequential，整个 batch 串行；每个工具 prepare→execute→after→end→message 完成后再处理下一个 | [S7][T2] |
| 参数处理 | 工具可先 prepareArguments；pi-ai validateToolArguments clone 原参数，处理可选 null 和类型转换，再校验；不能用“严格原值 JSON Schema 校验”代替 | [S7][S13] |
| before hook | 在有效工具与校验通过之后；可 block/reason/terminate，不提供 Harness 那种 args 替换契约；异常也变 immediate error result | [S7][S8] |
| after hook | 只对实际进入 execute 的调用（包括 execute 抛错）执行；unknown/validation/blocked 路径不执行；逐字段替换 content/details/usage/terminate/isError，无深 merge；异常转 error result | [S7][S8] |
| 普通工具错误 | 未找到工具、参数错误、tool throw、after hook throw 均转 isError toolResult；通常继续问模型修正，不直接判整次 run 失败 | [S7] |
| terminate | 仅非空 finalized batch 的每个 result 都 terminate=true 才停止自动工具续轮；并不独立否决已排队 steering/follow-up。全 run 的硬停点可用 shouldStopAfterTurn | [S7][S8][T2] |
| length + tools | 无论参数是否可解析/校验，全部不执行并生成 error toolResult，提示模型重发完整参数；随后可再次问模型。length 无工具则按普通无工具结束，宿主可另做 overflow recovery | [S7][T2] |
| 进度更新 | 工具执行 settle 后拒收迟到 update；已接纳 update 的 emit promises 在完成前 await。parallel 各工具进度可交错 | [S7][T1] |
| 输出 | raw content 缺省归一为 []；details/usage/addedToolNames 可进入 toolResult；terminate 是 loop 控制信号，不是 toolResult transcript 字段 | [S7] |

Steering 只在初始 poll 和整个 turn 后消费，**不会中断当前 batch 中余下工具**，即使串行。follow-up 仅在当前内层无工具/steering 继续工作、原本要停止时消费。宿主要立即取消效果应调用 abort，不应把 steer 当 hard interrupt。[S7][T2]

## Abort、错误、retry 与持久化接缝

- `abort()` 只 abort 当前 controller；工具、provider、listener 共用信号，Agent 会等待它们 settle。它不是 forcibly terminate，也不自动清空两个队列。串行 batch 在当前 finalized result 后看到 abort 就 break，未处理的剩余调用不会由该路径自动补全结果；并行已经启动的 effects 仍须合作式取消。[S1][S7]
- provider 返回 `stopReason=error/aborted`：仍发 assistant message_end、turn_end、agent_end，不运行消息中的工具，也不再 drain 队列。loop 本身不重试。[S7]
- Agent 捕获 executor 抛出的异常，构造零 usage 的 assistant error/aborted 消息并发完整收尾事件；因此不能仅以 `await agent.prompt()` resolve 判断业务成功。若 listener 自己持续抛错，失败事件再次经过它可能再抛；源码没有 listener 隔离机制。[S1]
- 标准 AgentSession 在 Agent run 完成后做 `_handlePostAgentRun`：retryable error 排除 context overflow，先删除**内存**最后 error assistant，持久历史仍保留，再可取消地等待指数退避并 `continue()`。压缩/overflow recovery 属另一策略；不要把 provider HTTP 重试、session assistant 重试与压缩重试合成一个预算。[S2][S3][S9]
- `Agent` 没有名为 `onMessageEnd` 的独立 option；等效接缝是 `agent.subscribe(async event => …)` 或低层 `runAgentLoop` 的 awaited sink。可在 assistant/tool/user message_end await Forge 持久化，让下一步 effect 等待落盘。这是可行性推断，基于明确 await 次序。[S1][S7]
- 该持久化接缝**不提供内存与数据库原子提交**：Agent transcript 已先改变；persist throw 后失败事件会再发出。若 Forge 要求落盘失败不能继续效果/重复落盘/内存回滚，适配层须单独定义错误归属和幂等策略并验证，不能把 await 等同事务。[S1]
- 标准 `AgentSession.subscribe` 的 `_emit` 是同步调用且不 await consumer promise；不能把它与 Agent.subscribe 的耐久栅栏能力混为一谈。AgentSession 自己在底层 awaited handler 中调用 SessionManager append。[S3]
- `Agent + loop` 没有 deferred suspend/poll 分支；即使底层类型可表示 deferred，也不意味着此装配会轮询。新 Harness 才显式验证 handle、提交 suspended 状态并 drive/poll，含 restart recovery 和使用量记账。直接复用 Agent 时，deferred 应标未支持或明确设计宿主适配。[S7][S14]

## 新 Harness 应单独验收的部分

新 Harness 不是 Agent 的别名或内部重构：`AgentHarness.create` 调用独立 `createAgentHarness`，对外有 lane、accept、drive、watch、abort、resume；工具 execute 收到 invocation/context，支持稳定 invocation ID、memo 和 replay 策略；storage 与 operation state 负责效果不确定时的恢复。标准 CLI 与 experimental worker 的装配点证明两条路径并存。[S4][S10][S14][S15]

若 operator 选择对齐这一层，需要额外调研并设计 Session/Branch/Lane、入队 admission 与 commit、取消归还输入、tool replay、事务边界、watch snapshot 一致性与 partial durability。本文只确认范围及关键源码入口，**没有完成整个 Harness 恢复状态空间审计**。上下文工程现有对齐不能自动证明这些能力已对齐。

## 建议高保真验收集

下列是施工时应跑的契约案例，不是本次已通过测试；每项都可以用 scripted stream 和 deferred promise gate，无需真实模型。

| 案例 | 必须断言 | 上游证据 |
|---|---|---|
| P01 lifecycle | user/assistant/tool 完整事件序；newMessages 与 full transcript 区别 | [S7] |
| P02 parallel batch | before hooks 顺序、所有准备结束后才执行、end 完成序、message 源码序 | [T2] |
| P03 sequential override | 只一个 tool 标记 sequential 即整批串行 | [T2] |
| P04 steering boundary | 第一工具进行时 steer，第二工具仍执行；之后才注入；队列 all/one-at-a-time 分别校验 | [T2][T1] |
| P05 continue | assistant tail + steering/follow-up；steering 优先且不双 drain；空历史拒绝 | [T1][S7] |
| P06 hook errors | unknown/invalid/blocked 无 execute/after；execute throw 有 after；hook patch 精确字段语义 | [S7][S8] |
| P07 length | 可解析完整形状的 args 也不得执行；每个 call 一个 error result；恢复模型续轮 | [T2] |
| P08 abort | provider、prepare、execute、update、agent_end listener 各位置取消；剩余调用和保留队列与基准一致 | [S1][S7] |
| P09 settlement | 暂停 message_end listener 时不能启动下一 effect；暂停 agent_end 时 busy/idle 维持；迟到 update 丢弃 | [T1] |
| P10 persistence failure | 存储拒绝时不误报成功、无后续工具副作用、无重复提交；记录与 Pi 原生的有意差异 | [S1][S7] |
| P11 stop policy | 所有/部分 terminate 与 queued steering、shouldStopAfterTurn 的组合 | [T2][S7] |
| P12 request boundary | prepare 更新模型/工具后下一轮生效；transform→convert→auth→stream 次序 | [S1][S7] |
| P13 retry | error 留持久历史而从请求上下文移除；指数退避可取消；overflow 独立分类 | [S3][S9] |
| P14 deferred scope | Agent 不声称 deferred support；若选 Harness 则另测 suspend/poll/reopen/usage | [S14] |

应固定同一输入脚本，对上游与 Forge 比较 provider payload、effect log、规范化事件与历史，归一化 timestamp/运行 ID，避免用两套各自自洽的测试冒充高保真。持久化与公共 SDK 的有意保留契约应独立列出，不悄悄改变 Oracle。

## 本次验证与局限

- Ran：固定 SHA 独立 fetch/checkout；逐项阅读源码及上游测试；官方 npm metadata/tarball 查询；agent 90 与 ai 177 个 sourcemap 源逐项比较，全部一致。
- Not run：上游 Vitest、Forge 测试、真实 provider、Bun 安装和兼容探针、新 Harness 故障恢复矩阵。
- Why：任务是调研和待确认方案；未修改产品代码、依赖、现有 ADR 或远端。上游测试作为语义证据阅读，不标记为本次通过。
- Risk：API 复用仍需 Forge patch 与宿主持久化/输入所有权契约适配；选择 Harness 将显著扩大状态和存储迁移面。上游具体现实边界（如合作式取消与 listener 错误传播）也须纳入高保真定义。

## 固定源码证据

[S1]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent.ts "Agent 状态/生命周期/监听/continue"
[S2]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/sdk.ts#L306-L405 "标准 SDK Agent 装配"
[S3]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts "AgentSession hooks/持久化/消费与 retry"
[S4]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/experimental/session-worker.ts#L805-L875 "experimental worker Harness 装配"
[S5]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/package.json "agent package manifest"
[S6]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/LICENSE "MIT License"
[S7]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent-loop.ts "agent-loop 完整行为"
[S8]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/types.ts "Agent 工具与 hook 类型契约"
[S9]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/settings-manager.ts#L745-L909 "标准 settings retry 与队列默认"
[S10]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/agent-harness.ts "Harness 公共接口"
[S11]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/runtime/harness.ts#L49-L75 "Harness 默认配置"
[S12]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/tool-definition-wrapper.ts "工具 wrapper 转发 executionMode"
[S13]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/utils/validation.ts#L310-L350 "pi-ai 工具参数处理"
[S14]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/runtime/drive/response.ts "Harness 响应分类/事务结算/deferred/retry"
[S15]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/runtime/drive/tools.ts "Harness 工具准备/执行/replay 与恢复"
[T1]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/test/agent.test.ts "Agent 生命周期/async listener/continue 测试"
[T2]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/test/agent-loop.test.ts "loop length/并行/steering/hook/terminate 测试"
[N1]: https://registry.npmjs.org/@earendil-works/pi-agent-core/0.85.1 "官方 npm pi-agent-core 0.85.1 metadata 与 dist.tarball"
[N2]: https://registry.npmjs.org/@earendil-works/pi-ai/0.85.1 "官方 npm pi-ai 0.85.1 metadata 与 dist.tarball"
