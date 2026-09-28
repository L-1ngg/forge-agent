# SDK 接入

[English](sdk.en.md) · [中文 README](../README.zh-CN.md)

> 范围:仓库内 Bun SDK,入口 `@forge-agent/core/sdk`。未承诺 npm 发布、Node.js 兼容或进程隔离。

## 原生 TanStack 模型 adapter

SDK 接受 TanStack 原生 `AnyTextAdapter`，并导出等价的 `ModelAdapter` 类型。Forge 的 `Model` 只描述模型身份、协议、容量与定价；`adapter` 负责供应商请求和流。完整模型对象必须配套 adapter，catalog 字符串模型可省略 adapter 并使用内置认证和路由。

```ts
import { createAgent, type Model, type ModelAdapter } from "@forge-agent/core/sdk";

async function openAgent(model: Model, adapter: ModelAdapter) {
  return createAgent({ model, adapter, cwd: process.cwd(), systemPrompt: "Help with the task." });
}
```

宿主使用 TanStack 的 provider factory 创建 adapter，或实现 `chatStream(request): AsyncIterable<AdapterYieldChunk>`。`request` 使用 TanStack 的 `model`、`messages`、`systemPrompts`、`tools` 和 `modelOptions`；取消信号位于 `request.request.signal`。输出上限和推理设置由 `Model.api` 映射到供应商原生选项，例如 Responses 使用 `max_output_tokens` 与 `reasoning.effort`，Anthropic 使用 `max_tokens` 与 `thinking`。宿主应让 adapter 的模型、协议和声明的元数据一致；同时提供 `provider` 时必须与 `model.provider` 一致。

自定义 adapter 自行持有认证、endpoint 和 headers；Forge 将 `sessionId` 作为原生 `request.threadId` 传给任务与摘要请求。`apiKey` 与 `baseUrl` 不作为旧式 stream options 注入自定义 adapter。catalog 字符串模型也可提供 adapter，此时跳过内置认证检查。内置客户端关闭传输重试；自定义客户端也应关闭自己的重试，由 Forge 的有界会话重试统一管理请求计数和预算。

任务与压缩摘要使用同一个生效 adapter。摘要使用独立 system prompt、消息与输出预算，不包含任务工具；不要把 adapter 写成只能返回普通任务答案的函数。异步初始化可放在 `async *chatStream()` 中，并响应请求信号。正常结束需发出完整 `RUN_FINISHED`，`finishReason` 为 `stop`、`tool_calls` 或 `length`；请求失败发出 `RUN_ERROR`，取消使用 `code: "aborted"`。半截响应、未知 finish reason 和无效工具 JSON 都会失败，截断工具不执行。

自定义供应商确有延迟终态时，使用 `RUN_FINISHED`、`finishReason: "stop"` 以及 `metadata: { forge: { stopReason: "deferred" } }`。这是 Forge 的显式扩展；普通 TanStack interrupt 不代表供应商延迟响应。`deferred` 结束当前 invocation，不启动后台轮询。原生 `TokenUsage.cost` 为自定义 adapter 的报告费用；缺失的 usage/费用保持未知，不从声明价格伪造报告值。内置目录传输沿用 Forge 的价格计算。

`updateConfiguration({ model, adapter })` 在当前完整工具批次或摘要结束后一起切换，继续区分 accepted 与 applied。创建/更新会快照模型元数据，adapter 对象及其闭包由宿主管理。换模型时同时提供配置了相应模型的新 adapter。`adapter: null` 恢复内置传输，此时需使用 catalog 字符串模型；从对象模型切回时同时提供 provider/model。失败更新保留已生效配置，adapter 不写入会话历史。

本次接口迁移删除 `StreamFn`、`AssistantMessageEventStream` 和 Pi 模型事件类型，没有兼容包装。将 `{ model, streamFn }` 改为 `{ model, adapter }`，响应改为 TanStack 原生 chunks；旧 `streamFn` 参数在 JavaScript 调用中也明确拒绝。已有 JSONL、Markdown 记忆和 MCP 附件无需因本次迁移转换格式。

配置类型统一为 `CreateAgentOptions`，删除同义导出 `AgentOptions`。`SessionStore` 已实现 `SessionStorage`，将 `storage: store.asStorage()` 改为 `storage: store`。工具干预上下文使用 `SessionMessage`/`ToolCallBlock`；授权与执行共享最终参数值，宿主只能通过约定的参数和结果干预接口影响该批次。

运行离线示例：`bun examples/custom-adapter.ts`、`bun examples/turn-policy.ts`、`bun examples/context-transform.ts`。它们使用 [scripted-adapter.ts](../examples/scripted-adapter.ts) 的原生 adapter，无需凭据；完整调用示例见 [custom-adapter.ts](../examples/custom-adapter.ts)。

## 执行职责

`createAgent → AgentSession → TanStack chat() → TextAdapter` 是 SDK、CLI 与 TUI 共用的执行路径。`chat()` 负责模型与工具续轮，Forge 不再维护 Pi Agent/agent-loop。Forge 会话保留输入归属、配置 revision、权威终态、逐条持久化和证据型压缩；`onConfig` middleware 在请求边界准备投影和最终预算。

工具通过原生 `toolDefinition().server()` 接入；Forge 在审批前完成参数准备、严格校验和逐调用判权，只展示 `ask`，TanStack 负责 interrupt/resume 与串行执行。完整工具提案及最终参数先逐条保存，才允许工具副作用；Forge 在每项工具执行后保存结果，下一次模型请求读取已保存的历史。成功响应内容由 TanStack 当前 `ModelMessage` 聚合，Forge 审计原始协议、补足续轮签名并投影成 `SessionMessage`；无工具回答在 run 结束时提交一次，失败和取消保留已有部分内容。`SessionMessage` 继续承担历史与展示合同。TanStack 的工作消息和 middleware metadata 不作为第二份可恢复会话状态。当前审批合同见 [ADR-027](decisions/027-native-tool-approval-and-interruption.md)，响应边界见 [ADR-028](decisions/028-model-response-boundary.md)。

## 每轮停止策略（shouldStopAfterTurn）

在创建时设置 `shouldStopAfterTurn(context, signal)`，宿主可在完整批次结束后优雅停止，避免继续调用模型。它支持同步或异步 boolean 返回值；`true` 停止当前 invocation，`false` 允许继续。SDK 导出 `ShouldStopAfterTurn`、`ShouldStopAfterTurnContext` 与 `InvocationUsage`。可运行离线示例：[turn-policy.ts](../examples/turn-policy.ts)，命令 `bun examples/turn-policy.ts`。

```ts
const agent = await createAgent({
  model, adapter, cwd: process.cwd(), systemPrompt: "Find the requested record.",
  tools, permission,
  shouldStopAfterTurn: ({ toolResults, turnIndex, usage }) => {
    const found = toolResults.some(result => result.toolName === "lookup" && !result.isError);
    const budgetReached = usage.costUsd !== null && usage.costUsd >= 0.10;
    return found || budgetReached || turnIndex >= 5;
  },
});
```

回调在当前 assistant 响应、完整工具批次和必要持久化结束后执行，早于消费下一批 steering/follow-up。无工具的正常响应也会调用。`turnIndex` 从 1 开始，每次 `runTurn()` / `continue()` 独立计数；失败重试、摘要与 error/aborted/length/deferred 响应不算完成轮，不调用回调。

`message`、`toolResults` 使用 SessionMessage 协议，包含工具正文和 details；整个参数是隔离的深只读快照，不暴露可变 AgentContext。`model` 与 `configurationRevision` 属于刚完成的任务请求（初始 revision 为 0），即使 turn_end 已应用新配置也保留旧值。accepted/applied 时序不变。回调仅在创建时配置，`updateConfiguration` 不接受它；闭包仍由宿主管理，不序列化。

`usage` 是本次 invocation 的累计模型请求统计，覆盖任务请求、失败重试和自动摘要请求，不包含历史或独立手动压缩。它提供 `requests`、`tokens`（input/output/cacheRead/cacheWrite/totalTokens）、`costUsd`、`missingUsageRequests`、`missingCostRequests`。任何请求缺失有效 token usage 时 tokens 为 null；任何请求缺失 usage 或费用时 costUsd 为 null。全零占位 usage 保守视为未知；正 token usage 附带明确零费用仍为 0。费用沿用传输返回的报告值或 Forge 目录定价，不推测未知定价。宿主自行决定未知时继续、停止或报错；示例以轮数上限兜底。判断发生在批次之后，是软限制，不能保证实际账单不超阈值。

策略命中后不再启动任务续跑、重试、恢复或自动摘要；完成消息和工具副作用保留，可能没有最后一条自然语言答案。`agent_end` 为 `outcome: "success", terminationReason: "policy"`；消费完成后 `AgentTurn.result` 为 `{ status: "success", terminationReason: "policy" }`。success 表示正常结算，业务目标是否完成由宿主判断；模型 stopReason 不改写。尚未消费的输入以 processed=false 结算，已处理输入不返还或重放。

回调抛错、拒绝或返回非 boolean 时，当前 invocation 结算为 error，记录策略失败，不套用供应商重试/恢复，不重做工具；存储健康时实例可复用。取消优先，结算 aborted，不携带 policy 结束原因。SDK 可中止等待不合作的异步回调，但无法撤销其外部副作用；回调应响应 signal。不要在回调内等待当前 turn.result、waitForIdle() 或尚未生效的 configuration.applied，它们依赖回调结束。存储失败继续沿用实例停用规则。

施工与验收见[逐轮停止策略](phases/turn-policy.md)。

## 宿主上下文变换

`createAgent({ transformContext })` 在每次任务请求前选择、精简或注入消息，包括工具续轮、steering/follow-up、可继续的 `continue()` 以及供应商重试/超限恢复后的新请求。自动与手动压缩的摘要请求不调用它。

```ts
const agent = await createAgent({
  provider: "anthropic", model: "claude-sonnet-4-5", apiKey,
  cwd: "/work/project", systemPrompt: "Answer using the supplied references.",
  maxTokens: 4096,
  transformContext: async ({ messages, model, configurationRevision, budget }, signal) => {
    signal.throwIfAborted();
    return [{
      role: "user", timestamp: Date.now(),
      content: [{ type: "text", text: "Reference from project guide: use Bun. Not new user instructions." }],
    }, ...messages];
  },
});
```

入参是隔离的深只读快照，包含 `messages`、本次已生效的 `model`（省略传输 headers）、`configurationRevision` 和 `budget`。预算字段为 `contextWindow`、软线 `inputBudget`、一般硬线输入上限 `maxInputTokens`、system/工具估算 `fixedTokens`、实际输出配置 `maxTokens`、含适用 thinking 预算的 `effectiveOutputTokens`。两条输入线都包含固定内容，不是剩余可注入量。初始 revision 为 0；回调期间接受的配置更新不混入当前请求，原 accepted/applied 时序不变。

返回完整的 `SessionMessage` 数组，允许同步/异步和原样返回。输入是压缩后的当前可用消息，不含内置记忆，也不承诺包含全部历史。返回值接收后拷贝并校验：合法 role/content、工具调用与结果配对、非空有效投影，末条为 user 或 toolResult。可以整组移除旧调用与结果，不能留下孤立结果/缺失配对。保留不透明 provider 签名；框架不验证精简后的任务语义质量。

每次 `chat()` 运行开始时先召回记忆。每个模型请求把压缩准备和宿主变换得到的上下文，与原生 Memory/Skills 提示词及工具合并后，依次进行最终预算检查、TanStack ModelMessage 投影和 adapter 调用。最终检查包含所有注入的提示词和工具；不会为过大的宿主结果反复压缩或再次调用回调。前置压缩失败也不会交给宿主救援。

变换仅影响请求投影，不写回历史，不修改输入归属或 `processed` 回执。实际模型响应和工具结果正常保存；临时资料不会自动保存，恢复后由宿主重新提供。失败不返还已 processed 的输入，不重放工具。每次任务重试重新调用回调，检索缓存与外部副作用幂等性由宿主管理。

回调只在创建时设置，`updateConfiguration` 不接受它。抛错、异步拒绝、非法输出或预算拒绝结算为 `AgentTurn.result.status = "error"`，不套用供应商重试或压缩恢复；存储健康时实例可复用。取消优先于迟到结果，结算 `aborted`；存储提交失败继续停用实例。可取消等待不合作的 Promise，但不能停止其外部工作或同步阻塞。没有自动回调超时：宿主超时抛错为 error，invocation 被取消为 aborted。不要在回调内等待当前 result、waitForIdle 或依赖本轮完成的 configuration.applied。

最终检查对未设置回调和关闭自动压缩的任务请求也生效：

```text
soft inputBudget = contextWindow - max(reserveTokens,
  effectiveOutputTokens + max(1024, ceil(contextWindow * 0.02)))
hard maxInputTokens = contextWindow - effectiveOutputTokens - 1024
最终输入估算 > hard maxInputTokens → 拒绝，不自动下调 maxTokens
```

输入按最终 messages、system 与工具 schema 估算，历史 assistant usage 不进入模型消息，历史及实际累计用量不变；工具 details 不计入模型输入。启用回调时不再用历史 provider usage 锚点估算新投影，`getUsage()` 在请求准备完成时显示最终估算（`contextEstimated: true`），消息或配置变化后回到历史准备视图。

受支持的内置 TanStack 传输统一使用 Forge 的一般硬线。自定义 adapter 内部改写与限额由宿主负责。显式 `maxTokens > model.maxTokens` 在创建/配置更新时拒绝，失败更新保留旧配置。

这些检查是启发式估算，1024 余量不是中文/图片误差上界，仍可能收到供应商 overflow。保留原有有界恢复，不承诺精确物理窗口、答案质量或费用节省。可运行离线示例见 [context-transform.ts](../examples/context-transform.ts)，设计和证据见[施工图](phases/context-transform.md)。

## Skills

SDK 省略 `skills` 时不扫描任何来源；配置对象默认启用，`enabled: false` 时不扫描。Core 不调用 home 目录探测；相对路径按 `cwd` 解析，不展开 `~`。

```ts
const agent = await createAgent({
  provider: "anthropic", model: "claude-sonnet-4-5", apiKey,
  cwd: "/work/project", systemPrompt: "Help with the task.",
  skills: { roots: {
    workspace: { path: "./skills" },
    user: { path: "/data/alice/skills", optional: true },
  } },
});
const snapshot = agent.getSkills();
const turn = agent.runTurn({ kind: "skill", name: "code-review", task: "Review this patch.\nKeep the API stable." });
for await (const event of turn) {
  if (event.type === "skill_input") console.error(event.inputId, event.code, event.message);
}
await turn.result;
const receipt = await agent.refreshSkills();
await receipt.applied;
```

`SkillsOptions.roots` 使用 workspace/user/builtin 顺序；CLI 对应项目、个人全局和当前为空的随附目录。缺层为空，缺失根仅在 `optional: true` 时为空。官方 `skillDirectory` 扫描和校验目录，`aggregate`/`dedupe` 以先到先得处理同名项。`getSkills()` 返回 applied 状态的副本，列出可用及遮蔽项、来源和显式调用标志，不含正文。`disable-model-invocation: true` 从自动目录隐藏，但仍可用 `/skill` 显式调用。

`withSkills` 在每次 `chat()` 建立官方目录快照、`load_skill` 和加载去重。`createResourceTool` 注册 `read_skill_resource`，只读取官方 Source 允许的 `references/` 或 `assets/` 路径。两者进入 Forge 公共工具批次、hooks、AbortSignal 和会话记录，以注册来源标记 internal/trusted，不弹交互授权；同名宿主工具在装配时拒绝。官方工具不执行脚本，脚本仍需普通 bash 工具及其权限。

`runTurn`、`steer`、`followUp` 均接受 `AgentInput = string | SkillInvocation`。显式选择经同一 Source 的 `load`，在消费点将技能正文和原始 task 展开成一条 user message，不伪造模型工具调用、不弹权限确认。`AgentTurn.inputId` 和 accepted 回执的 `inputId` 关联拒绝事件；`skill_input` 包含 phase=`rejected`、name、code、message。失败输入 processed=false，初始 turn 结果为 error，实例可复用。宿主应保留原始输入用于恢复草稿。

显式输入错误 code 包含 `skills-disabled`、`unknown-skill`、`too-large`、`invalid-skill`、`read-failed`、`canceled`。最终请求预算同时计算完整输入、官方目录提示词和工具定义；关闭压缩也不允许超预算直发。

`refreshSkills()` 与 `updateConfiguration({ skills })` 共用串行提交：当前 `chat()` 结束后才整体应用新来源，accepted 不等于 applied。`updateConfiguration({ skills: false })` 关闭功能；准备失败保留旧状态，dispose 取消未应用 receipt。新运行可在上下文压缩后重新加载技能；历史记录不因刷新被改写。

## 持久记忆

`createAgent` 的 `memory` 是显式宿主能力；省略时不读 CLI 目录、不创建记忆文件。核心导出 `LongTermMemory` 与 `MemoryOptions`，示例：

```ts
import { LongTermMemory, createAgent } from "@forge-agent/core/sdk";

const memory = {
  store: new LongTermMemory({ user: "/data/alice/memory", project: "/data/alice/project-a" }),
  autoUpdate: true,
  injection: true,
};
// 将 memory 放进现有 createAgent({ provider, model, cwd, systemPrompt, ... }) 选项。
```

目录必须为宿主明确授权的规范化绝对路径；模型只可选择已提供的 user/project 别名和相对 `.md` 路径，文件 frontmatter 不决定身份。SDK 不解析 Git；宿主需要副本时可调用 `initializeMemoryCopy(target, source?)`，仅复制 Markdown，最后记录初始化成功，失败重试保留已有文件。`MemoryFileSystem` 是可注入文件操作边界，正常使用无需提供。

`store.read(scope, path, offset?, limit?)` 返回正文页、修改时间、来源和警告；offset 按零基 Unicode 字符，单页最多 4096 字符。`search(scope, query, limit?)` 使用不区分大小写的普通词项匹配（全部命中），最多 10 个 256 字符片段，覆盖未入索引文件。文件资源上限 256 KiB，扫描最多 1000 个目录项/8 MiB。缺少 frontmatter 不影响使用，损坏元数据不覆盖原文；来源只是未核验入口，可能无法读取其历史。

`store.write({ scope, path, content }, source)` 写入普通 Markdown；`source` 为宿主实际掌握的 `{ kind: "management" | "session", timestamp, sessionId?, entryId?, location? }`，程序追加真实 scope/root。`delete(scope, path)` 删除笔记；`pin(scope, path, enabled)` 与 `pinned(scope)` 管理固定入口。写入完成后才返回 `saved: true`，没有版本、操作 ID 或幂等回执协议。

正文与索引分别直接写入，不提供跨文件事务、文件锁、并发编辑合并或崩溃恢复协议。记忆工具失败作为工具错误反馈；JSONL 存储失败仍停用实例。笔记删除不删除 JSONL，也不能抹去仍在当前上下文中的原话。

`memoryMiddleware` 在运行开始调用 Markdown adapter 的 `recall`，按预算注入标明 scope/路径的短索引和固定笔记；主题可通过工具按需读取。成功运行结束后官方 deferred `save` 使用当前模型配置额外调用一次结构化整理模型，读取索引指向的有界主题，按计划写入主题和必要索引。无价值内容不写盘；整理失败通过 `memory` 事件报告，不改写主任务成功结果。`calls` 和 provider 返回的 `usage` 由保存事件报告，不把本地文件存储说成全链路离线。

模型的 `read_memory/search_memory/write_memory/delete_memory` 使用 Zod schema、公共工具批次、hooks、取消与工具事件，作为 internal/trusted 工具不弹交互授权。`autoUpdate: false` 仅关闭 deferred 整理，显式管理工具和宿主 store 仍可用；`injection: false` 仅关闭运行开始的召回。宿主通过 `updateConfiguration({ memory })` 修改配置；已开始的 `chat()` 完成后 applied。

CLI 的 `/memory` 直接管理 Markdown，不依赖模型授权；`permissionMode: "deny-all"` 不改变内部记忆工具的静默执行，但普通文件和 shell 工具仍受策略约束。

召回材料是参考内容，不成为用户指令或授权。完整 system、消息及工具定义在 middleware 注入后接受最终请求上限检查。一次运行内的显式写入由工具结果提供最新信息；下次运行重新从磁盘召回。

## 装配与定制边界

`createAgent(options)` 始终装配生产会话，只接受一个 options 参数。定制模型使用 `model` + `adapter`；定制数据库或会话持久化实现 `SessionStorage` 并通过 `storage` 传入；定制工具通过 `tools` 传入。SDK 和 CLI 均不提供替换整个执行实例的 factory。旧的第二参数在 TypeScript 中报错，在 JavaScript 中于任何装配和模型调用前抛出 `TypeError`。

创建先调用一次 `storage.load()`，再把该状态交给唯一的 `AgentSession`，默认内存存储遵循同一流程；没有第二次装配加载或 `setStorage` 接口。加载失败时不请求模型、不写入存储，原样保留错误。后续装配失败会释放已创建的 MCP 资源；内部创建的 RequestBus 会关闭，外部总线不由失败装配关闭。清理也失败时抛出 `AggregateError`，其 `cause` 和 `errors[0]` 为原始错误。

SDK 集成测试用原生 TanStack adapter 控制模型返回，存储故障和工具行为分别在 `storage`、`tools` 注入。局部 UI/headless 测试可以使用各自的小接口，底层单元测试可直接测试内部模块。当前装配设计及验证见[基座施工图](phases/tanstack-foundation.md)和[验收记录](phases/tanstack-foundation-acceptance.md)。

## 创建实例

```ts
import { createAgent } from "@forge-agent/core/sdk";

const agent = await createAgent({
  provider: "xai",
  model: "grok-4.6",
  ...(process.env.FORGE_AGENT_API_KEY ? { apiKey: process.env.FORGE_AGENT_API_KEY } : {}),
  systemPrompt: "Answer the user's questions concisely.",
  cwd: process.cwd(),
});
try {
  for await (const event of agent.runTurn("Hello")) {
    console.log(event);
  }
} finally {
  await agent.dispose();
}
```

宿主显式选择配置来源。SDK 不加载 `.forge-agent/config.json`,也不展开 `$ENV_VAR` 或执行 `!command`;传入的 apiKey 是已解析凭据。未传 apiKey 时,模型适配层仍可能使用 provider 原生环境凭据。SDK 不装配 coding 工具或提示词,CLI 自行装配现有能力。

无文件副作用的自定义工具示例见 `examples/embedded-agent.ts`。根目录示例直接引用 SDK 入口文件,workspace 宿主需声明 `"@forge-agent/core": "workspace:*"` 后使用 `@forge-agent/core/sdk` 子路径:

```bash
FORGE_AGENT_PROVIDER=xai FORGE_AGENT_MODEL=grok-4.6 FORGE_AGENT_API_KEY=secret bun examples/embedded-agent.ts
```

代理地址由示例宿主读取 `FORGE_AGENT_BASE_URL` 后传入,不是 SDK 自动读取。

## 存储

默认每实例使用独立内存。CLI 的新建/恢复由 CLI 宿主管理，不改变 SDK 的 `storage` 和 `sessionId` 接入能力；CLI 不再提供 `--session` 或 `sessionPath`。宿主可传入 `storage`，记录类型由 `@forge-agent/core/sdk` 导出：

```ts
interface SessionStorage {
  load(): Promise<SessionState>;
  append(entry: SessionEntry): Promise<void>;
}
```

`SessionState` 包含完整 `entries` 和选中 `leafId`。v4 记录包含稳定 id、parentId、timestamp，以及原始 message 或独立 compaction。core 分配身份并串行追加：已消费 user 在模型请求前保存，assistant 终态在工具前保存，工具批次收尾后按调用顺序保存结果。取消保留已形成过程，不回滚整次 invocation；error/aborted 原始响应保留，但从后续请求过滤。

`append()` 成功必须可重载；开始后的写入必须等待结算。任何保存失败停止新调度并停用实例，不盲重试可能部分完成的写入。宿主检查实际状态后重建，同一会话不得有多个并发写实例。JSONL 不保证断电或部分写入事务性；工具外部副作用不会回滚。

`SessionStore.create(path, cwd, id?)` 同步准备新文件存储，首次 `append()` 才创建目录并以排他方式写入 header 和首条记录。`load()` 不触发落盘；`saved` 在成功创建或打开文件后为 `true`，不是实时文件存在性检查。`SessionStore.open(path, cwd)` 仍默认立即创建缺失文件；恢复时使用 `{ create: false }`。首次写入冲突或 I/O 失败后实例停用，不覆盖或自动重试。省略 `id` 时生成新身份；需要保留路由身份时，将 `store.header.id` 作为 `createAgent` 的 `sessionId` 传入。

完整历史调用缺结果时，仅在请求中补“执行及副作用未知”的错误提示，不改历史、不重放工具。CLI 使用 v4 `SessionStore` 实例作为存储。旧格式必须转换为独立副本，不能直接覆盖源文件。`processed` 和 `message_end` 都不是持久化确认，正常迭代结束才保证必要写入已完成。

## 上下文管理

上下文压缩提供带证据短检查点、确定性的近期历史选择、历史搜索/读取与请求预算，见 [ADR-018](decisions/018-adaptive-default.md) 和 [ADR-023](decisions/023-deterministic-context-selection.md)。旧 pi 策略及 `context.strategy` 已删除，传入该字段会报错；省略 `context` 或传 `{}` 即启用上下文压缩。

CLI 配置与 SDK 创建选项均支持 `context: { enabled, reserveTokens, keepRecentTokens, summaryReasoning }`，默认分别为 `true`、`16384`、`20000`、`"inherit"`。SDK 可在空闲时通过 `configureContext` 更新。搜索和读取仍需宿主权限允许，启用压缩不授予权限。

### 上下文压缩：状态与预算

上下文压缩保留未归档用户输入、最新用户消息及最后一个完整交互单元。先尝试裁剪可找回的旧工具正文；若仅靠裁剪就能让全部历史符合预算并缩小投影，则保留全部交互单元，否则从最新单元向前连续保留可选原文，遇到首个超出 `keepRecentTokens` 额度或输入预算的单元即停止。不按词项、检查点来源或重复正文重新挑选更旧的消息。需要省略未归档内容时，由主模型提取独立、带原文引用的任务状态与摘要。替代状态必须引用更晚的用户证据，旧状态留在历史；assistant 的事实陈述保守归为推断。工具执行结果由原始记录提供，检查点不会改变宿主权限。结构/来源校验不能证明自然语言语义没有遗漏。

上下文压缩发送给任务模型的检查点采用短投影：状态/结论的类型、完整文本与去重的来源 entryId；完整 quote、状态 ID 和替代关系继续保存在本地检查点，降级 summary 也保留完整版本。执行结果 ledger 不省略。摘要生成仍提取完整证据，所以短投影不代表摘要生成费用下降。

上下文压缩在第 4 次增量更新、任务切换或无效检查点/无进展时尝试从原文重建；每次操作最多 2 次逻辑生成、4 次实际模型请求（包括临时重试）。超大摘要输入、保护状态放不下、引用无效或最终无进展均返回错误，不发布损坏检查点；自动路径阻止该次过预算任务请求，取消和存储失败继续遵循既有生命周期。

上下文压缩中，task `maxTokens` 未指定时显式取 `min(4096, model.maxTokens)`。预算包括 system、工具定义、状态、摘要与消息，预留 `max(reserveTokens, effectiveOutputTokens + max(1024, ceil(contextWindow * 0.02)))`；有效输出计入适用 provider 的额外 thinking 预算。启发式计数不保证供应商物理窗口一定足够。摘要输入也单独预检，输出最多 4096 tokens（还受模型和窗口限制）。

### 查找与读取历史

上下文压缩注册保留工具名 `read_context`。它经过现有权限和 tool hooks，只能读取当前分支已保存消息；宿主同名工具配置会被拒绝。输入 `entryId`、`offset`（默认 0）和 `limit`（默认/最大 4096）以 Unicode code point 为单位；正文最多 16 KiB，`nextOffset` 支持长单行续读。元数据也计入后续上下文。图片只报告占位，无法找回工具原先未保存的正文；不存在、越界或外分支引用明确报错。需要自动找回的宿主应通过已有 permission 配置允许该工具。

`search_context` 是另一个保留工具名，允许模型在不知道 entryId 时搜索当前分支历史。输入 `query`（1–200 Unicode code points，空白分词且最多 8 项，全部字面词项都需命中，大小写不敏感）、可选 `role`（user/assistant/toolResult）和 `limit`（默认 5、最大 10）。结果从新到旧，含 `entryId`、`role`、`isError`、Unicode `offset` 和最多 256 code points 的预览，另有 `hasMore`。用 `read_context` 加载完整原文；“最新”仅指分支顺序，不判断语义上的最新决定。为避免回显，搜索排除这两个检索工具的结果及包含其调用的 assistant 消息；仍可按 ID 读取这些记录。搜索不跨分支、会话或文件，不使用额外模型；同样需要 permission 允许且经过 tool hooks。新增 schema/找回会增加输入，不能保证每个场景净省 Token。

### 兼容与事件

v4 `compaction` 记录使用可选、版本化的 `checkpoint` 载荷，SDK 导出 `CompactionCheckpoint` 类型。重开时验证引用与状态替代关系。旧 v4 记录的 `adaptive` 字段在读取时转换为 `checkpoint`，不重写原始文件；新记录只写 `checkpoint`。同时出现两种字段会报错，不保留旧 SDK 类型别名。无检查点载荷的旧历史从原始分支消息恢复模型上下文，不沿用旧 pi 摘要，也不因预算或提取失败自动回退 pi。自动压缩关闭不移除原文工具，也不禁用手动压缩。

`compaction` 事件提供 `action`、`inputBudget`、`contextEstimated`、`modelCalls`、`generations`、`elapsedMs`、`stopReason` 和合计 `usage`，不再提供 `strategy`。这些字段为累计快照，统计时按 `operationId` 取最新值，不重复相加。

短投影的软件验证和费用估算边界见[后续验证记录](phases/context-notes-search.md)；近期选择的软件验证见[施工与验收](phases/context-selection-simplification.md)，限定的真实模型 A/B 结果见[质量评估](phases/context-selection-evaluation.md)。首次上下文压缩的旧保留集结果不证明短投影或近期选择的真实模型质量。

### 自动压缩与恢复

每次任务请求前，当前上下文超过输入预算时先压缩；压缩失败阻止该次请求。overflow 和可恢复 length 在连续失败链中共享一次恢复机会；保留失败记录，不重放已执行工具，不因 usage 报超限重新生成成功答案。`enabled: false` 关闭自动压缩及超限恢复，仍可手动压缩和读取历史。

摘要使用主任务模型与路由，隔离任务 system，不传任务工具定义；内置摘要请求不添加任务缓存提示。`summaryReasoning: "off"` 在模型支持时关闭推理，否则继承。临时重试与最多两次逻辑生成共享四次模型请求上限。Provider 错误在重试策略结束后直接停止，不触发检查点重建。

普通到达输出上限的 `length` 正文保留给后续请求，截断工具调用不执行也不投影。被分类为上下文恢复失败尝试的 `length` 保存 `contextExcluded` 标记，重开后同样只保留原记录。headless 在成功恢复后返回成功退出码；未恢复的 error/length 返回 1，取消返回 130。

### 共用 API 与计量

`contextWindow` 可覆盖本地容量声明，默认采用模型元数据；降低该值可测试触发流程，不证明供应商物理窗口超限。`maxTokens` 是普通任务的宿主输出配置，与压缩 reserve 分开，省略时使用上方的显式输出预留。`getUsage()` 的 `contextEstimated` 区分有效 usage 与估算。模型、system、tools、分支或投影改变后失效，摘要 usage 不作为任务锚点。

历史 user/toolResult 可携带 `{ type: "image", data: base64, mimeType }`，请求保留图片，启发式按每张 1024 tokens 估算，摘要仅序列化图片占位。`sessionId` 默认每实例生成，宿主可传稳定 ID，CLI 使用会话 header ID。自定义 adapter 从任务与摘要的 `request.threadId` 读取同一标识；跨实例重开时由宿主再次传入稳定 `sessionId`。内置 TanStack 传输重放完整历史；Responses 请求设置 `store: false`，不以 `sessionId` 续接服务端响应。需要 `mistral-conversations` 或 `openai-codex-responses` 的模型不在内置目录中；宿主可为完整模型对象提供支持该协议的原生 adapter。

`await agent.compact(instructions?, onEvent?)` 先取消当前执行并等待工具及保存收尾，再压缩一次，完成后保持空闲。返回 `{ status, operationId, beforeTokens, afterTokens?, error? }`；status 为 `complete`、`skipped` 或 `error`。存储故障仍抛错并停用实例。取消可以中止摘要与退避；已开始的写入仍需等待。instructions 只进入历史摘要的 Additional focus。

任务流与手动 onEvent 回调提供 `compaction` 事件（start、attempt、retry、end、error、skipped）和 `recovery` 事件。包含操作身份、原因、估算、尝试及 usage；attempt 报告生效推理及回退原因。TUI 命令为 `/compact [instructions]`。

## 文件与命令输出

Read 使用从 1 开始的 `offset` 与可选行数 `limit`，正文默认最多 2000 行/50 KiB，附带 nextOffset 或超长行细读提示；实现仍会读取完整文件后切片。Bash 合并 stdout/stderr 的采集顺序，显示最多 2000 行/50 KiB 的尾部。越过阈值才懒写完整系统临时日志，返回 logPath，普通 Read 可补查；失败、超时和取消保留可用输出，日志 I/O 失败明确标注不完整并停止命令。

临时日志没有配额、TTL、退出删除或自动扫描，生命周期由系统或用户管理；文件消失不妨碍会话加载。自定义工具负责自己的截断与续读，内核不重新分配整批结果额度。正文限额不包含额外状态和路径说明。

旧 v3 数据通过 `SessionStore.convertCopy(source, target, cwd, options?)` 显式转成 v4 副本，目标存在即失败；损坏或无换行文件要继续追加也使用此入口。open 的 onDiagnostic 回调报告坏 JSON 行，leafId 可选择分支；`create: false` 禁止在文件缺失时创建，适合只读发现和恢复验证；`store.appendable` 表示文件是否允许原地追加，false 时必须使用已验证副本；不可解释的选中父链或摘要边界拒绝加载。回退使用保留的旧文件及匹配旧二进制，关闭自动压缩不会使 v4 变回旧格式。

受控真实 provider 验收示例：`bun examples/context-acceptance.ts`，显式读取宿主配置、限制实验请求和时间，并清理本次临时会话。

## 事件与生命周期

`runTurn` 返回带只读 `id: symbol` 的单消费者异步事件流。同实例并发执行拒绝,不是自动排队。`steer(input, turn.id)` 与 `followUp(input, turn.id)` 只进入对应活动执行的两条 FIFO 队列,返回 `InputAcceptance`;未启动、已结束、取消或 id 过期时返回 `{ accepted: false }`,宿主应保留输入。已停用或已释放实例仍抛错。

创建选项 `steeringMode` 与 `followUpMode` 分别选择 `"all"` 或 `"one-at-a-time"`，默认后者。`all` 在对应消费点一次取出该队列全部输入，`one-at-a-time` 每次取一个；steering 优先于 follow-up。

接受结果为 `{ accepted: true, processed: Promise<boolean> }`:输入已进入模型上下文时解析为 `true`,结束时尚未处理则为 `false`。宿主保留原文,恢复未处理输入;`true` 不保证模型完成或持久化成功,不应自动重发以免重复工具副作用。干预结果需在并行消费事件时处理,不能在消费循环中等待未来输入处理而阻塞迭代收尾。

跨 invocation 队列属于宿主。TUI 在等待期间持续接受输入,显示 FIFO,空输入框 Up 取回队尾编辑;Esc 停止续发并恢复草稿,Ctrl+Enter 仅在旧任务成功收尾后发送指定输入,其余待发原文恢复草稿。提交失败暂停队列,检查存储并重建实例后由宿主明确恢复。`agent_end` 仅表示执行终止,整个异步迭代正常完成才表示会话提交完成。

执行仍在进行时，提前 `break` 或关闭 iterator 会取消并等待清理。执行已结算后再关闭或 `dispose()`，保留实际结果及 policy 结束原因，不把成功或失败改写成取消；宿主在 `agent_end` 处抛出的展示错误也不改变执行结果。后台执行由宿主持续消费事件,界面可独立订阅宿主转发的内容。`abort()` 只停止当前调用,包括已获取但尚未 next 的 iterator,此时随后消费不会启动模型或提交;清理结束后实例可复用。`dispose()` 幂等,取消并等待清理或已开始的提交结算,之后不可复用;持有未完成 iterator 时也应 await dispose。

任意自定义工具必须配合 AbortSignal,不合作的工具可能让取消或 dispose 长期等待;SDK 不提供强制进程终止。

## 权限

每个普通模型工具调用按最终参数经过现有权限策略。`allow` 自动批准、`deny` 自动拒绝,只有 `ask` 经 TanStack 原生 `needsApproval` interrupt 交给宿主;同批所有待审批项收齐后才恢复,获批工具串行执行。拒绝原因进入模型上下文,模型可调整方案;停止整个 Invocation 则使待批次及旧答复失效。宿主可配置 `permission.rules`,或并行消费 `agent.requests`,通过 `agent.respond(response)` 答复。请求流应与执行流并行消费,不能等执行完成才处理授权。无答复默认 30 秒后拒绝,没有界面不等于自动放行。

`agent.respond({ type: "response", id: request.id, result: { decision: "allow_once", editedArgs: { ... } } })` 可提交一次性修改参数;SDK 会严格重新校验和判权,非法或被策略拒绝的修改不会执行。展示、权限判断与执行使用最终参数,工具结果的 `toolArguments` 保存实际参数。`allow_always` 仅在请求允许记住且 scope 匹配时有效。审批仅支持进程内续接,恢复会话不会重放未完成工具;TUI 可停放权限卡、按 `c` 输入草稿或排队,按 Tab 或 `i` 返回权限卡。headless 自动拒绝需要人工审批的调用。

每实例默认有独立权限记忆和请求总线。CLI 为兼容现有 TUI 显式传入独占 RequestBus,交互模式允许无限等待;SDK dispose 会关闭该总线,不得跨实例共享。请求观察、授权与释放不依赖 pi 类型。

## 验证边界

自动化验证使用本地 HTTP provider、原生 adapter 夹具、工具与存储故障注入、受控交错及 PTY 交互，不代表公共 API 稳定承诺、完整真实供应商覆盖、长任务可靠性或文件系统崩溃一致性。本次重构的实际 Ran / Not run / Why / Risk 见[验收记录](phases/tanstack-foundation-acceptance.md)；旧实现的历史验收不自动成为新执行链的验收结论。

## 执行结果与配置

包名与 `createAgent` 不变。`AgentSession` 直接实现 SDK，TanStack `chat()` 执行模型与工具循环；原 `HostedAgent`、`AgentPort`、`session-port` 和本地 Pi runtime 已删除。宿主继续使用 SDK 的输入、工具、存储和配置接口。

```ts
const turn = agent.runTurn("完成任务");
for await (const event of turn) {
  // 在这里展示或转发事件；不要等待尚未完成的 turn.result。
}
const result = await turn.result;
await agent.waitForIdle();
// result.status: success | error | aborted | length | deferred

const continuation = agent.continue(); // 使用已有上下文，不添加 user 消息
for await (const event of continuation) { /* 展示事件 */ }
```

`turn.result` 在消费与必要保存结算后完成；`waitForIdle()` 等待当前已获取 iterator 及手动压缩清理，不表示模型成功。手动压缩替换当前执行时，等待范围包含整个压缩操作，不在旧 iterator 关闭时提前结束。`agent_end.outcome` 标明会话级最终结果；重试中间的 error 不是整个任务失败。`deferred` 为终态，没有后台轮询。惰性流需消费或获取 iterator 后关闭，未消费的流不会启动工作。

自定义工具改用一套结构化返回值，旧 `{ ok, value, error }` 不再是工具 execute 协议：

```ts
import type { HarnessTool } from "@forge-agent/core/sdk";

const lookup: HarnessTool<{ key: string }, { source: string }> = {
  name: "lookup", label: "Lookup", description: "Look up a key",
  parameters: {
    type: "object", properties: { key: { type: "string" } },
    required: ["key"], additionalProperties: false,
  },
  async execute({ key }, context) {
    context.signal?.throwIfAborted();
    context.onUpdate?.({ content: [{ type: "text", text: "Looking up" }], details: undefined });
    return { content: [{ type: "text", text: key }], details: { source: "local" } };
  },
};
```

`content` 只包含文本/图片并进入模型；`details` 独立保存供宿主展示，必须可 JSON 持久化且可快照。工具错误返回 `isError: true` 或抛错,模型仍可继续;停止任务使用 `abort()`。进度使用同一结果形状,结算后迟到进度被忽略。`prepareArguments` 可同步规范化模型输入；`toolInputRewrites` 可异步改写。`parameters` 的 JSON Schema 严格校验类型、必填及额外字段,不把数值字符串转换为数字；宿主 `validateArguments` 在 JSON Schema 初检后执行,其返回对象也必须符合 schema。每个工具提案在审批前按调用顺序完成初检、改写、before hook、最终校验和判权；待审批项收齐后 TanStack 原生串行执行,每项保存后才开始下一项。`beforeToolCall` 返回 block/reason,`afterToolCall` 可覆盖 content/details/isError。hooks 的 assistantMessage/context.messages 使用 `SessionMessage`,toolCall 使用 `ToolCallBlock`（`type: "tool_call"`）。授权、实际执行和 after hook 观察同一份最终参数；准备失败不执行该工具。原 `wrapTool` 已移除；参数改写请使用 `toolInputRewrites`,授权请使用 SDK 权限配置。

普通任务和摘要共用 `retry` 配置，但计数独立。任务仅对临时故障重试，默认三次、2/4/8 秒；原错误响应保存在历史并从重试请求排除。已消费输入和完成工具结果复用，不重复用户输入、不重放工具。overflow 使用独立的一次上下文恢复，不能套入普通 retry。`retry` 事件提供 scheduled/attempt/end，取消会中止等待。

```ts
const receipt = await agent.updateConfiguration({
  systemPrompt: "更新后的指令",
  thinkingLevel: "low",
  tools: [lookup],
});
// receipt.accepted === true；不等于新配置已用于当前响应。
const application = await receipt.applied;
// application.status: applied | canceled，revision 与 receipt 一致。
```

可更新 provider/model/adapter/apiKey/baseUrl/systemPrompt/thinkingLevel/tools/maxTokens/contextWindow/skills/mcp。异步验证失败时更新拒绝，原配置保持。空闲时应用；响应、审批等待或工具执行中接受更新后，整批沿用提案时配置完成，再于下一请求前应用。手动摘要完成后应用。没有下一请求时更新不会主动请求模型；释放或故障取消尚未应用的配置。运行中等待 `applied` 应在事件消费之外进行。工具 schema 在接受前快照；回调闭包仍由宿主管理。配置应用使当前 usage 锚点失效，历史最后调用计数保留。

职责替代、完整迁移与版本回退说明见[基座施工图](phases/tanstack-foundation.md)，实际验证见[验收记录](phases/tanstack-foundation-acceptance.md)。

## MCP

`createAgent({ mcp })` 显式装配 MCP；SDK 不读取宿主配置文件。`mcp: false` 禁止连接。每个 Agent 独立拥有连接、目录、交互和取消范围，外部服务通过官方 `@modelcontextprotocol/client@2.0.0` 接入。可执行示例：

```sh
bun examples/mcp-client.ts bun packages/core/test/helpers/mcp-server.ts
```

示例只读取 fixture 目录/资源，不请求模型。宿主配置示例：

```ts
const agent = await createAgent({
  provider, model, apiKey, cwd,
  mcp: {
    servers: {
      local: { transport: "stdio", command: "your-mcp-server", args: [] },
      remote: {
        transport: "http", url: "https://example.com/mcp",
        auth: { type: "oauth", scopes: ["read"] },
      },
    },
    // credentials, artifacts, interaction 可注入宿主 adapter。
  },
});
try {
  console.log(agent.mcp.snapshot());
  const receipt = await agent.mcp.refresh();
  await receipt.applied; // 在 turn 事件消费循环之外等待。
} finally { await agent.dispose(); }
```

server 定义支持 `stdio` 的 command/args/cwd/env、`http`/`sse` 的 url/headers、`enabled`、`protocol`（stdio/SSE 默认 `legacy`、HTTP 默认 `auto`，可固定 `2026-07-28`）、`auth`、`tools.include/exclude` 和 `timeouts`。env/headers 值支持 `$VAR` 或 `${VAR}`，不执行 shell；缺失变量只使对应 server 失败。OAuth 与 Authorization header 互斥。SDK cwd 相对宿主 cwd；CLI 配置里的 cwd 相对来源文件。默认 connect/request 15 秒、tool 60 秒、total/interaction 300 秒、cleanup 5 秒；total 不得小于 tool。无能力或部分启动失败可在 snapshot 诊断，其他服务继续使用。

`agent.mcp` 提供 snapshot/subscribe、refresh/reconnect/setEnabled、login/logout、listResources/listResourceTemplates/listPrompts/complete、readResource/getPrompt、subscribeResource/unsubscribeResource/readArtifact。目录与配置更新返回 `ConfigurationReceipt`，在当前模型响应及整批工具之后应用；`updateConfiguration({ mcp })` 替换纯配置，不接受新的 adapter。工具捕获原定义及 outputSchema，通知不会改变在途校验；断线/超时不重放业务调用。恢复只供后续请求使用。订阅通知只发事件，不修改历史；同身份且 URI 仍有效时 reconnect 恢复订阅，取消订阅后忽略迟到通知。

读资源、取 Prompt、订阅、附件与工具调用均需现有权限检查；服务 annotations 不授予权限。`mcp_list_resources` 同时返回 resources 和 templates，`mcp_read_resource` 支持已发现 URI 模板及参数，`mcp_read_artifact` 分段读取附件。MCP JSON Schema 保留本地引用、组合和额外属性规则，参数不强制转换类型；供应商拒绝某 schema 时请求失败，不默默删字段。

显式输入可为 `{ kind: "mcp_prompt", serverId, name, arguments, task }` 或 `{ kind: "mcp_resource", serverId, uri, task }`，同样用于 runTurn/steer/followUp。准备成功后保存一条带 `inputContext` 的 user 封套；模型请求按原角色展开并保留 task 原文。外部 assistant 内容不表示现场执行成功。恢复不重新取远端模板；准备失败不消费输入、不请求模型。预算和压缩使用展开视图，原封套保留作证据。

内容上限为整个结果 16 MiB、单附件 8 MiB、模型正文 64 KiB，截断有显式标记和附件引用。图片仅在模型支持时作为图片输入；音频保留 bytes，不声称已转写；链接不会自动抓取。`readArtifact` 读取原附件，缺失时报 `artifact-missing`，不重新请求服务器。SDK 默认 `MemoryMcpArtifactStore` 随实例释放；持久历史的宿主应注入持久 artifact store。自定义 store 若不实现可选 `delete`，失败准备阶段的附件清理由宿主负责。

SDK 默认 `MemoryMcpCredentialStore` 仅在当前实例保留凭据；共享 store 必须由宿主显式注入。`McpCredentialStore.withLock` 必须覆盖整个读取、refresh、写回或 logout 交易；原生操作若忽略取消，仍须持锁到真实结算，不能用 Promise.race 提前解锁。取消返回 `credential-outcome-unknown` 不证明回滚；logout 只删除本地 grant，不保证远端撤销。CLI 复用系统凭据库和跨进程文件锁，Linux 默认 Secret Service；显式 `linux-keyutils` 不承诺系统重启持久化。

浏览器登录只由 `login` 发起。注入 `McpInteraction.beginAuthorization` 返回 `{ redirectUri, authorize(url), close() }`，authorize 返回 callback 的 URLSearchParams。Core 校验 state、官方 SDK 校验 issuer/code/PKCE，成功保存且连接可用后才报告 authenticated；Continue 不是成功凭据。正常业务无 grant 或 scope 不足报告 auth-required，显式 login 才执行授权。宿主应响应 signal 并关闭自己创建的 callback listener；Core 在 adapter 返回后保证调用 close。

`agent.requests` 的 `mcp_elicitation` 包含 form/url、来源及 operationId。response 使用 `{ decision: "accept", content }`、`{ decision: "decline" }` 或 `{ decision: "cancel" }`；content 保留 typed number/boolean/array，官方 SDK 校验表单。迟到或重复响应不复活请求。

CLI/TUI 命令：status、tools/resources/templates/prompts、enable/disable/refresh/reconnect、login/logout、read、subscribe/unsubscribe、prompt/use-prompt/use-resource、artifact。`--args '<JSON>'` 仅接受字符串值对象，`--` 后 task 保留原文。`artifact <id> --output <path>` 使用独占创建，拒绝覆盖；不带 output 返回 base64。TUI 表单 Tab 切字段、Esc cancel，Ctrl+P park 保留字段草稿；管理期间 composer 可编辑。standalone `--mcp` 管理无需模型配置；普通终端读操作明确请求权限，`--json` 不等待交互：OAuth 24、Elicitation 25、参数错误 2、其他失败 1。SDK/CLI 生命周期测试和未完成的真实服务/平台验收见[证据](phases/mcp-client-acceptance.md)。
