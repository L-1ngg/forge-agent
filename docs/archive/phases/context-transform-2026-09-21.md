---
doc_kind: plan
created: 2026-09-21
---

# 宿主上下文变换与最终请求预算

> 状态:已归档(2026-09-27)。执行基座与模型接缝已由 [TanStack 基座](../../phases/tanstack-foundation.md) 替代；当前合同与本次证据从该入口读取。下文按记录版本解释，未测和豁免保持原含义。

> 历史状态:核心合同已实现并通过本地验收；pi-ai 内置输出预检已在 2026-09-26 的 TanStack 传输迁移中撤下，尚未发布。Owner: operator / Codex。
> 决策与取舍见 [ADR-021](../../decisions/021-host-context-transform-and-request-budget.md)。本文件记录施工合同与验收证据，公共接入见 [SDK](../../sdk.md#宿主上下文变换)。

## Why / Entry

通用宿主需要在每次任务模型调用前筛选、精简或注入消息，并让变换后的请求参与最终预算；现有 streamFn 定制发生得过晚。沿用固定 Pi 的两阶段消息处理，由 Forge 会话组合，保持执行与持久化合同。

编写基线：`master` / `83550f545a1377c558e86d4f5920413691431875`，设计开始时工作区干净；实施开始时保留已有五份设计文档改动。Issue 尚未创建，本轮无远端写入；后续获授权建立 Issue 时按[约定](../../agents/issue-tracker.md)链接本施工图及 AC 编号，不复制另一套验收标准。

| # | 检查 | 通过标准 | 不通过怎么办 |
|---|---|---|---|
| E1 | 基线与用户改动 | 实施前重新核对 Git 状态、AGENTS.md 和依赖版本 | 保留用户改动，按新基线重核设计 |
| E2 | 施工范围 | operator 审阅本施工方案并授权代码施工 | 保持文档草稿，不把讨论当作实现授权 |
| E3 | 输出与实际传输 | 已核对锁定 Pi 调用点及缩减反例，实施中按 AC-CTX-06 补 HTTP 接线证据 | 修正设计，不把 helper 结果当作 HTTP 接线已验收 |
| E4 | 验收工具链 | 使用现有 Bun、离线 runner、Scenario/HTTP fixture | 报告实际限制，不将缺失平台/真实模型证据改为通过 |

## Design / 已确认与派生细节

operator 已确认：通用消息变换、请求投影、不干预摘要、软硬线分离、按实际有效输出上限检查且不自动下调、取消/异常结算与阻断供应商重试、既有组合顺序。

以下是本轮为施工补齐的具体方案：固定 1024 硬线余量、创建时回调、公开快照类型、任务重试重新评估、结构校验、Pi 内置输出缩减预检、错误分类与内部模块划分。已随本次实施授权确认，均由下列 AC 约束。

### 1. 公共接口

在 `createAgent` 与同一生产装配使用的 AgentOptions 中加入可选 `transformContext`，由 SDK 导出关联类型。以下为已实现接口摘要，`Snapshot<T>` 表示递归只读类型：

```ts
interface TransformContextContext {
  readonly messages: readonly Snapshot<SessionMessage>[];
  readonly model: Snapshot<Model<string>>;
  readonly configurationRevision: number;
  readonly budget: {
    readonly contextWindow: number;
    readonly inputBudget: number;        // 软线，包含 system/tools
    readonly maxInputTokens: number;     // 一般硬线的输入上限，包含 system/tools
    readonly fixedTokens: number;        // 当前 system/tools 的估算占用
    readonly maxTokens: number;          // 本次传给 streamFn 的输出配置
    readonly effectiveOutputTokens: number;
  };
}

type TransformContext = (
  context: TransformContextContext,
  signal: AbortSignal,
) => readonly Snapshot<SessionMessage>[]
   | Promise<readonly Snapshot<SessionMessage>[]>;
```

- messages 是经内置历史投影规范化、压缩后当前可用的消息，不含内置记忆投影；可能含检查点，不能依此取得全部原始历史。
- 宿主可返回原快照、新数组或新增参考消息；返回值是完整的本次消息投影，不是差量。外部注入应说明来源，不被框架视为新增用户授权。
- 输入深拷贝并冻结；接收返回值后同步深拷贝、校验，再交给内部流程。修改返回对象或迟到 Promise 不影响已准备请求或之后 invocation。
- 仅提供模型元数据、已生效 revision 与预算摘要，不提供 credentials、可变 runtime/context、工具执行对象或完整 RuntimeOptions。maxInputTokens 不是宿主剩余可注入量，也不是 Pi 内置传输一定放行的保证。
- 回调只在创建时配置；不纳入 ConfigurationPatch。TypeScript 拒绝动态字段，JavaScript 的更新也显式拒绝。闭包由宿主管理，不持久化、不自动恢复。
- 创建时非函数值直接失败；无回调时跳过变换，仍执行最终预算检查。

### 2. 消息结构与归属

复用 SessionMessage 与现有投影，不引入新消息协议或任意自定义 role。入参先清理已有失败响应与历史配对问题；宿主返回值按合法结构校验，避免把新引入的残缺配对静默修成工具成功。

校验覆盖数组/role/content、有效字段、tool_call 参数可序列化、toolCallId 配对、重复/孤立结果、调用与结果的顺序；允许整组删除历史调用与结果。拒绝不支持的内容、空的有效消息投影和不能构成任务续跑的终端结构。复用已有验证能力，缺口在本模块内补齐，不建立通用协议校验平台。最终 convertToLlm 仍负责现有转换，校验失败不退回原消息继续发送。

不对“内容是否足够完成任务”做语义验证；宿主负责保留任务所需的目标、约束与证据，不应改写 provider 的不透明 reasoning/text/tool 签名。框架保证结构与隔离，不证明宿主精简后的模型质量。

transformContext 返回值不写入 SessionStorage，也不赋值回 runtime.state.messages。实际模型响应和后续工具结果正常持久化；它们可能引用临时资料，恢复时不保证该资料可重新获得。失败记录沿用已有 runtime 生命周期保存，不伪装为用户输入或供应商响应成功。

processed 继续表示输入已经在原消费点进入执行上下文，不表示一定发送给模型或得到回答。回调失败或筛选消息不回滚已完成回执，不重放输入、Skills 展开或工具副作用。未消费队列仍以 processed=false 返还。

### 3. 请求准备顺序

1. 应用到期配置，按现有消费点处理用户输入/Skills；锁定本次 model、system、tools、thinking、输出限制和 configurationRevision。
2. 按现有软线完成压缩准备。保留原有压缩前记忆估算作为内部准备，压缩仍只操作持久历史；不得引入尚未生成的宿主资料或上一请求的临时资料。前置估算不作为本次最终 memory projection 事件发布。
3. 将压缩后的规范化消息快照传给宿主，最多调用一次；返回后校验、拷贝。
4. 以变换后的消息重新计算剩余软预算并装配最终记忆；即使内部记忆内容缓存命中，也要按新额度重新选择。只发布最终 memory projection 的 selected/tokens/warnings。
5. 合并内置记忆与宿主投影，经过内置 convertToLlm。生成最终 system/tools/messages 和本次输出选项。
6. 最终检查一般硬线；使用内置传输时再检查 Pi 是否会缩减输出。拒绝则不调用任务 streamFn，不记作实际任务模型请求。
7. 检查取消后，以同一份请求和输出选项调用 streamFn。开始已有任务请求用量统计；后续运行及 shouldStopAfterTurn 保持现有合同。

软线已被宿主内容占满时，内置记忆额度可为 0；固定笔记放不下沿既有明确警告处理，不挤占宿主投影或偷用输出空间。getMemoryBudget 与最终记忆装配使用一致的消息依据；配置、输入或投影变化后不能复用旧剩余额度。

压缩不会因宿主后来缩短消息而撤销；宿主超硬线不会启动第二轮压缩/回调循环。自动压缩失败发生在宿主之前，也不会让宿主回调接管救援。这些是首版组合顺序的明确限制。

### 4. 分层预算与计数

令 W 为配置的 contextWindow（缺省使用模型元数据），O 为与本次输出选项对应的 effectiveOutputTokens：

```text
softMargin = max(1024, ceil(W * 0.02))
inputBudget = W - max(reserveTokens, O + softMargin)

hardMargin = 1024
maxInputTokens = W - O - hardMargin

最终输入估算 I > maxInputTokens  → 拒绝
I == maxInputTokens             → 一般硬线通过
```

I 由最终 convertToLlm 输出的消息、最终 system 与工具 schema 计算；不能把预算摘要里的 fixedTokens 重复相加。图片、thinking、工具参数与转换新产生的补充消息都计入；工具 details 不进入模型时不计入。禁止沿用宿主返回消息里的 usage 或旧 provider usage 作为此次最终输入量。

输出配置不因剩余窗口变化而缩减。复用并集中现有 provider thinking 规则，按实际适配路径推导 O；配置不合法或不能确定有效输出时显式失败，不能把未知输出当零。显式 maxTokens 超过 model.maxTokens 时在创建/更新验证阶段拒绝，更新失败保留旧配置；不靠截小预算数字掩盖传给流函数的更大值。模型既有的 thinking 分配/能力上限规则与“因剩余上下文缩减输出”分开说明。

最终拒绝分类为 `request-budget (general)`，报告估算输入、有效输出、余量、窗口与 revision，不包含请求正文或凭据。不新增公共 TurnResult 状态或传输观测事件；继续用既有错误记录与 result.status=error。

一般硬线对所有任务请求生效，包括关闭自动压缩或未设置回调的实例。摘要继续使用独立输入/输出预检与调用次数限制，不调用宿主变换；若复用内部输出预检 helper，不改变摘要材料、压缩算法或错误返回形式。

### 5. 输出预检的迁移状态

2026-09-21 的原施工曾为 pi-ai 内置传输调用 `clampMaxTokensToContext`，以检测它独立的 4096 tokens 余量和静默输出缩减。2026-09-26 受支持的内置传输改用 TanStack AI 后，这项 pi-ai 专属预检已删除；Forge 的一般硬线保留，并在真实 HTTP 适配器边界回归。原探针与验收是历史证据，不代表当前请求还会触发 `builtin-output-clamp`。

最终任务请求中的历史 assistant usage 仍只在隔离的请求副本中清零，防止旧锚点影响本次估算；SessionStorage、runtime 历史、累计用量和 provider continuation 不变。自定义 `streamFn` 的内部二次改写与限额由宿主负责。

### 6. Usage、配置与取消

保留内置压缩准备的历史 usage 与最终请求投影计数两个用途；不以临时 RAG 资料污染下一次历史压缩。启用宿主回调时，首版保守地每次对最终投影重估，即使原样返回也不复用历史 usage 锚点；仍累计实际模型返回的 tokens/cost。

getUsage 在准备完成时反映最终投影估算并标记 contextEstimated=true。投影失效后先清理该快照，再回到当前历史准备视图；不得在消息/配置变更后展示旧临时资料的计数。没有回调的既有有效 usage 展示可保留，但最终硬线仍对实际请求独立计数。

回调期间接受的新配置不混入当前请求；按原提交时机在完整响应/工具批次后、下一请求前应用。初始化配置 revision=0。失败路径也须验证已 accepted receipt 能按原时序 applied/canceled，不能新增悬挂或提前生效。

回调每次任务请求评估：初次请求、工具续轮、消费 steering/follow-up 后的请求、continue、供应商重试和超限恢复后的新任务请求。重试不复用上一次临时资料，宿主需要自管检索缓存与幂等性；同一次准备不会因预算失败重复调用。

同步抛错、异步拒绝、非法返回、结构失败与预算失败设置 invocation 局部准备失败标志。会话必须先检查此标志，再执行供应商错误分类、重试或压缩恢复；不靠错误文字判断。沿现有错误消息持久化与 agent_end/result 结算，存储健康时实例可复用。

AbortSignal 可中止等待不合作的异步回调，取消优先于迟到返回/异常，迟到拒绝被消费但不能影响新 invocation。abort/dispose/提前关闭 iterator 沿原合同执行；没有强制终止宿主外部工作、阻断事件循环中同步死循环或撤销副作用的保证。沿用存储提交失败停用实例的优先级。

首版不新增自动超时配置：宿主检索自行超时并抛错，结果为 error；宿主/调用方取消 invocation 则为 aborted。仅抛出名称为 AbortError/TimeoutError 的异常而 signal 未取消，不伪造 aborted。回调内不得等待当前 turn.result、waitForIdle 或依赖本轮结束的 configuration.applied。

## Batches / 改动位置

| 批次 | 文件与工作 | 完成判据 |
|---|---|---|
| B1 | 新增 `packages/core/src/context/request-budget.ts` 集中最终估算/输出预检；由 session-configuration 集中有效输出规则并维持既有 Pi 依赖边界；更新 AgentSession 和 usage 的请求快照/失败分类 | 无回调时最终硬线端到端生效；输出不缩减；摘要独立合同保持 |
| B2 | 新增 `packages/core/src/context/transform.ts` 管理回调快照/校验/取消；agent、session-port、sdk 接线；AgentSession 为现有 assembler/coordinator 提供组合顺序与最终消息依据 | 任务调用覆盖、最终记忆额度、usage 失效与失败阻断通过 |
| B3 | SDK 集成与本地 HTTP 验证；双语 sdk/README、离线示例与当前入口 | 全部 AC 与必要检查完成，提供实际证据 |

B1/B2 不改移植 runtime 主循环；使用现有 transformContext/convertToLlm/streamFn 位置组合。已从停止策略抽取 `host-callback.ts` 的冻结与可取消等待 helper，复用原语义，不建立统一 hook 框架。新测试须接入现有离线测试分类清单，不能以文件存在替代 runner 执行证据。

## Acceptance Criteria

- [x] AC-CTX-01：公共 SDK 创建时接受同步/异步回调、原样返回与新增/选择/精简消息；类型及 JavaScript 动态配置均拒绝覆盖回调，非法创建值在任何模型调用前失败。
- [x] AC-CTX-02：捕获实际 streamFn 请求，证明变换前后差异、system/工具/Skills 生效配置、压缩→变换→最终记忆→转换→检查顺序；内置摘要不调用宿主。
- [x] AC-CTX-03：返回值修改不污染原始历史、runtime、后续请求或配置；存储重开不包含临时注入；工具配对破坏/非法返回失败且不调用模型。保留 provider 签名回放字段。
- [x] AC-CTX-04：覆盖 I=硬线、I=硬线+1、软线以上硬线以下的注入；大 system、schema、图片、thinking 和转换产物均计入；不重复计数固定内容，输出参数不因剩余空间缩减。
- [x] AC-CTX-05：无回调/自动压缩关闭时仍拒绝超硬线；大于模型声明输出能力的配置在创建/更新时拒绝，更新失败保留旧配置；硬线拒绝没有任务请求计数或 retry/recovery 事件。先前确实发生的摘要请求照常计费。
- [x] AC-CTX-06：Pi 内置 HTTP fixture 检查实际发送输出字段与输入；先构造 helper 将缩减的压力请求，确认发送前拒绝，再用可容纳对照确认发送值。覆盖普通输出和适用 thinking 路径、contextWindow 覆盖与内置/自定义切换。
- [x] AC-CTX-07：投影变大/变小、保留旧 usage 的历史、原样返回及无回调对照验证锚点；最终请求清理 usage 不改变历史与累计费用。最终 memory 事件和 getMemoryBudget/usage 与实际投影一致。
- [x] AC-CTX-08：回调抛出包含 429/overflow 等文字的错误、拒绝、非法值及预算失败，都正确结算 error，供应商重试/摘要恢复均不发生，实例可复用且工具不重做。
- [x] AC-CTX-09：不合作 Promise、迟到 resolve/reject、abort、dispose 与 iterator 关闭验证取消；processed 已处理/未处理恰好结算，存储失败继续停用实例，不因取消改写存储失败合同。
- [x] AC-CTX-10：阻塞回调期间更新 model/system/tools/Skills，证明 snapshot/revision/输出配置一致且 accepted 不等于 applied；失败后 receipt 正确结算，无回调内等待造成的隐藏死锁。
- [x] AC-CTX-11：初始、工具续轮、steering/follow-up、continue、正常供应商重试与 overflow 恢复各有回调次数证据；shouldStopAfterTurn 命中后不再调用回调/任务/摘要。
- [x] AC-CTX-12：完整 check、示例类型检查、离线示例及必要反向验证通过；双语接入文档描述估算边界、内置预检差异、回调生命周期和默认行为变化。

## Test plan / Verify

| 层 | 验证内容 | 入口 |
|---|---|---|
| 局部合同 | 临界值、结构校验、输出 helper 与回调取消 | 新增 context-transform/request-budget 测试，按现有 runner 分类 |
| SDK 集成 | 真实 AgentSession/storage/tools/configuration 与请求捕获 | 新增 `packages/core/test/context-transform.test.ts`；回归 runtime-configuration、runtime-turn-policy、sdk-skills、memory-session、usage |
| 本地 HTTP | 锁定 Pi 内置请求字段、thinking 及超限前拒绝 | 扩展 `packages/core/test/context-http.test.ts` 的现有 fixture |
| 全仓与示例 | 类型、依赖、离线测试与公共接入 | `bun run check`、`bun run typecheck:examples`、`bun examples/context-transform.ts` |

已完成四项反向验证：将硬线替换为软线，应使“软线上方可发送”变红；移除准备失败阻断，应使错误不重试用例变红；绕过 Pi 输出缩减预检，应使实际输出字段/调用次数用例变红。另移除请求副本 usage 清理，旧锚点 HTTP 用例变红。四项临时变异均已恢复，最终完整检查通过。

## Release / Rollback / 明确不做

出口为全部 AC 完成、SDK 与 agent_end/result 一致、所有默认回归通过。本轮 AC-CTX-01 至 AC-CTX-12 已完成本地验收；按 operator 后续指示提交本地 commit，push、Issue 创建/评论和发布不在本轮范围。

真实模型质量/费用改善、多供应商真实调用、macOS/Windows 与人工长期使用不由离线证据证明；未运行时逐项保留原因，不把其列为已经通过。此功能不引入 UI 交互，CLI/TUI 默认路径仍需现有回归。

回退按 B3→B2→B1 逆序撤销对应代码/文档，无历史格式迁移。只移除回调可停用宿主变换但不会关闭最终硬线；不提供吞掉回调异常/忽略预算错误的降级开关。回退前保留用户新增改动与所有已持久化记录。

不恢复 portFactory，不暴露 RuntimeOptions，不升级/修改 Pi，不建设传输观测层或 Vercel 桥接，不重做 Skills/停止策略，不新增 tokenizer 服务、回调超时配置、通用 RAG/检索缓存或自动输出缩减。

## Risk / Learn

- 固定 1024 余量不是中文或多模态估算误差上界；真实 overflow 仍由既有有界恢复处理。
- Pi 内置预检比一般硬线更严格；它自己的估算/4096 余量限制部分可用空间，SDK 需明确解释错误原因。锁定版本变化时重新验证。
- 隔离/校验不能证明宿主保留了全部任务语义，临时资料不会自动进入证据历史；不宣称答案质量改善或历史完全可重放。
- 不能强制停止任意宿主代码；取消仅释放框架等待并隔离迟到结果，外部副作用由宿主管理。
- 新统一检查属于默认行为变化；不能只测启用回调的成功示例。
- 只在出现实际可复发故障且有执行性防护时向 lessons.md 记录，不因设计风险预写教训。

## 本轮实施与验收证据

证据绑定 `83550f5` 基线上的本次功能变更，执行日期为 2026-09-21。

- Ran：`bun run check` 退出 0；依赖边界、工作区类型、自动化脚本检查和离线测试通过。合计 **752 pass / 0 fail**：contract 518 项、integration 221 项、CLI/PTY 13 项。环境为 Linux x64、Bun 1.3.12，离线 runner 使用 network namespace 隔离。
- Ran：[SDK 集成测试](../../../packages/core/test/context-transform.test.ts)新增 32 项，覆盖不可变投影与持久化隔离、软硬边界、system/schema/图片/thinking、记忆额度、异常与取消、输入回执、配置/Skills 时序、工具续轮、重试/恢复、停止策略及存储失败。
- Ran：[输出预算测试](../../../packages/core/test/request-budget.test.ts)新增 5 项，覆盖有效输出规则及 Bedrock inference profile/adaptive 名称映射；[本地 HTTP 测试](../../../packages/core/test/context-http.test.ts)新增 4 项，覆盖 Pi 缩减前拒绝及实际普通/thinking 输出字段、自定义与内置传输切换、旧 usage 清理和本地窗口覆盖。HTTP 对照分别保持 1024 输出及包含 8192 thinking 预算的 9216 输出。
- Ran：四项反向验证均检出故障。硬线误用软线、移除准备失败重试阻断、绕过内置输出缩减预检各触发 2 项失败；移除旧 usage 清理触发 1 项失败。恢复后执行上述完整检查，无临时变异遗留。
- Ran：`bun run typecheck:examples` 与 `bun examples/context-transform.ts` 退出 0。离线示例返回 success，仅一次模型请求，临时参考资料未持久化。
- Ran：双语 SDK/README、领域术语、ADR、施工图与当前入口同步；153 个本地链接/锚点及差异空白检查通过（含新增文件）。
- Not run / Why：未调用真实模型服务；本轮以隔离的合同测试和本地 HTTP 证明接线，没有安排质量/费用实验。当前仅 Linux 环境，未运行 macOS/Windows；没有远端推送，因此未运行远端 CI 或发布。
- Risk：1024 余量与启发式估算不是物理窗口保证，仍保留供应商 overflow 恢复；Pi 的 4096 余量可能更早拒绝。HTTP 结果不代表供应商全矩阵，Bedrock 当前为输出映射单元证据。自定义 streamFn 内部的二次改写/限额及宿主精简后的任务质量由宿主负责。
