# SDK 接入

[English](sdk.en.md) · [中文 README](../README.zh-CN.md)

> 范围:仓库内 Bun SDK,入口 `@forge-agent/core/sdk`。未承诺 npm 发布、Node.js 兼容或进程隔离。

## 自定义模型流（StreamFn）

SDK 直接复用 Pi Agent 内核的 `StreamFn` 类型，导出 `StreamFn` 和 `Model`。宿主提供完整模型元数据及流函数，即可使用内置 catalog 之外的模型。可运行的离线示例：[custom-stream.ts](../examples/custom-stream.ts)，命令 `bun examples/custom-stream.ts`。

```ts
import { createAgent, type Model, type StreamFn } from "@forge-agent/core/sdk";

async function openAgent(model: Model<string>, streamFn: StreamFn) {
  return createAgent({ model, streamFn, cwd: process.cwd(), systemPrompt: "Help with the task." });
}
```

`StreamFn(model, context, options)` 返回 `AssistantMessageEventStream` 或其 Promise，协议沿用当前锁定的 pi-ai。`context` 包含本次 systemPrompt、投影后的 messages 和 tools。完整模型对象必须配套 `streamFn`；宿主负责准确提供 provider、api、contextWindow、maxTokens 等元数据及认证。若同时传 `provider`，必须与 `model.provider` 一致；显式 `baseUrl` 覆盖模型的 baseUrl。

原有 `provider: string, model: string` 仍查内置 catalog。它也可以配套 `streamFn`，此时跳过内置认证检查；省略函数则沿用内置传输及认证。自定义函数收到显式 `apiKey`（如有）、`signal`、`sessionId`、输出上限和推理设置。函数须响应取消，将请求失败/取消编码为流中的 error 事件及最终 error/aborted AssistantMessage；不要用 throw/rejected Promise 表达正常的请求失败。不得把函数只写成固定返回任务答案：压缩摘要也使用同一生效配置的流函数，但有不同的上下文、输出预算及 `cacheRetention: "none"`。`maxRetries: 0` 保留会话层统一重试控制，传输应遵守此设置。

`updateConfiguration({ model, streamFn })` 支持在现有完整工具批次或摘要结束后一起切换，继续区分 accepted 与 applied。模型元数据在异步创建/准备前快照。传 `streamFn: null` 恢复内置传输，此时必须使用字符串模型；若从对象模型切回，需同时提供 catalog 的 provider/model。配置失败保留原生效配置；流函数及其闭包由宿主管理，不序列化到会话历史。

## 每轮停止策略（shouldStopAfterTurn）

在创建时设置 `shouldStopAfterTurn(context, signal)`，宿主可在完整批次结束后优雅停止，避免继续调用模型。它支持同步或异步 boolean 返回值；`true` 停止当前 invocation，`false` 允许继续。SDK 导出 `ShouldStopAfterTurn`、`ShouldStopAfterTurnContext` 与 `InvocationUsage`。可运行离线示例：[turn-policy.ts](../examples/turn-policy.ts)，命令 `bun examples/turn-policy.ts`。

```ts
const agent = await createAgent({
  model, streamFn, cwd: process.cwd(), systemPrompt: "Find the requested record.",
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

`usage` 是本次 invocation 的累计模型请求统计，覆盖任务请求、失败重试和自动摘要请求，不包含历史或独立手动压缩。它提供 `requests`、`tokens`（input/output/cacheRead/cacheWrite/totalTokens）、`costUsd`、`missingUsageRequests`、`missingCostRequests`。任何请求缺失有效 token usage 时 tokens 为 null；任何请求缺失 usage 或费用时 costUsd 为 null。Pi 的全零占位 usage 保守视为未知；正 token usage 附带明确零费用仍为 0。费用沿用传输返回的报告值或 pi-ai 定价计算结果，不推测未知定价。宿主自行决定未知时继续、停止或报错；示例以轮数上限兜底。判断发生在批次之后，是软限制，不能保证实际账单不超阈值。

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

执行顺序是既有压缩准备 → 宿主变换 → 按剩余软预算装配最终记忆 → 内置 convertToLlm → 最终预算检查 → streamFn。宿主内容超过软线时仍可能发送，但内置记忆额度可降至 0；不会为过大的宿主结果反复压缩或再次调用回调。前置压缩失败也不会交给宿主救援。

变换仅影响请求投影，不写回历史，不修改输入归属或 `processed` 回执。实际模型响应和工具结果正常保存；临时资料不会自动保存，恢复后由宿主重新提供。失败不返还已 processed 的输入，不重放工具。每次任务重试重新调用回调，检索缓存与外部副作用幂等性由宿主管理。

回调只在创建时设置，`updateConfiguration` 不接受它。抛错、异步拒绝、非法输出或预算拒绝结算为 `AgentTurn.result.status = "error"`，不套用供应商重试或压缩恢复；存储健康时实例可复用。取消优先于迟到结果，结算 `aborted`；存储提交失败继续停用实例。可取消等待不合作的 Promise，但不能停止其外部工作或同步阻塞。没有自动回调超时：宿主超时抛错为 error，invocation 被取消为 aborted。不要在回调内等待当前 result、waitForIdle 或依赖本轮完成的 configuration.applied。

最终检查对未设置回调和关闭自动压缩的任务请求也生效：

```text
soft inputBudget = contextWindow - max(reserveTokens,
  effectiveOutputTokens + max(1024, ceil(contextWindow * 0.02)))
hard maxInputTokens = contextWindow - effectiveOutputTokens - 1024
最终输入估算 > hard maxInputTokens → 拒绝，不自动下调 maxTokens
```

输入按最终 messages、system 与工具 schema 估算，历史 assistant usage 仅在发送副本中置零，历史及实际累计用量不变；工具 details 不计入模型输入。启用回调时不再用历史 provider usage 锚点估算新投影，`getUsage()` 在请求准备完成时显示最终估算（`contextEstimated: true`），消息或配置变化后回到历史准备视图。

内置 pi-ai 另有 4096 tokens 余量和自己的估算。Forge 在发送前检查其是否将缩减输出；会缩减就报 `request-budget (builtin-output-clamp)`，因此一般硬线通过不保证内置传输放行。自定义 streamFn 内部改写与限额由宿主负责。显式 `maxTokens > model.maxTokens` 在创建/配置更新时拒绝，失败更新保留旧配置。

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
  permission: { rules: [{ tool: "load_skill", argsPattern: "*", effect: "allow" }] },
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

`SkillsOptions.roots` 只包含 workspace/user/builtin 三层。缺层为空；缺失根仅在 `optional: true` 时为空。目录名按真实入口核对；根命中 `SKILL.md` 后停止递归；分组目录使用来源范围内的 ignore 规则并阻断 symlink 环路。`getSkills()` 返回 applied 状态的可修改副本，包含 enabled、revision、entries、diagnostics；每项包括来源/入口、状态、胜出入口、内容修订、自动调用标志，不含正文。

`load_skill` 只接受 `{ name }`，遵循 ToolHooks、参数重写、权限、取消及持久化；同名宿主工具在启用时被拒绝。返回完整 Markdown body、标准/扩展 metadata、name、layer、entry、baseDirectory、`sha256:` 修订。正文精确保留 UTF-8 文字与换行，最多 50 × 1024 字节；header 上限 64 KiB。变更、替换、删除或改换 symlink 目标要求刷新，不使用旧目录悄悄加载新正文。references 由已有宿主工具读取；SDK 不隐式增加 read/bash 或 allow。

`runTurn`、`steer`、`followUp` 均接受 `AgentInput = string | SkillInvocation`，原有 string 不变。显式调用允许 explicit-only，但仍经 PermissionContext/RequestBus；不运行需要 assistantMessage 的 ToolHooks 或模型参数重写。选择和原始 task 在消费点展开成一条 user message，不伪造模型工具调用。`AgentTurn.inputId` 和 accepted 回执的 `inputId` 关联拒绝事件；`skill_input` 包含 phase=`rejected`、name、code、message。失败先发事件、再以 processed=false 返还未处理输入；初始 turn 结果为 error，实例可复用。宿主保留原始输入用于恢复，不从错误文字反解析。取消/释放仍以既有 result/processed 结算为准。

错误 code 包含 `skills-disabled`、`unknown-skill`、`explicit-only`、`permission-denied`、`missing`、`changed`、`too-large`、`invalid-skill`、`read-failed`、`canceled`。权限规则及预算同样约束显式输入；关闭压缩也不允许超预算直发。

`refreshSkills()` 与 `updateConfiguration({ skills })` 共用串行提交：当前响应和整批工具保持旧快照，下一请求原子应用 prompt/catalog/tools，accepted 不等于 applied。`updateConfiguration({ skills: false })` 关闭功能；失败保留旧状态，dispose 取消未应用 receipt 并等待准备结束。仅模型或基础 prompt 更新复用目录，无隐式重扫。恢复时重新发现当前来源，历史中已经保存的正文/修订保持原样；上下文压缩只改变请求投影，仍可按需重读。目录与权限状态按实例隔离。

## 持久记忆

`createAgent` 的 `memory` 是显式宿主能力；省略时不读 CLI 目录、不创建记忆文件。核心导出 `LongTermMemory` 与 `MemoryOptions`，示例：

```ts
import { LongTermMemory, createAgent } from "@forge-agent/core/sdk";

const memory = {
  store: new LongTermMemory({ user: "/data/alice/memory", project: "/data/alice/project-a" }),
  autoUpdate: true,
  injection: true,
  maxOperations: 12,
  maxWrites: 4,
};
// 将 memory 放进现有 createAgent({ provider, model, cwd, systemPrompt, ... }) 选项。
```

目录必须为宿主明确授权的规范化绝对路径；模型只可选择已提供的 user/project 别名和相对 `.md` 路径，文件 frontmatter 不决定身份。SDK 不解析 Git；宿主需要副本时可调用 `initializeMemoryCopy(target, source?)`，仅复制 Markdown，最后记录初始化成功，失败重试保留已有文件。`MemoryFileSystem` 是可注入文件操作边界，正常使用无需提供。

`store.read(scope, path, offset?, limit?)` 返回正文页、版本、修改时间、来源和警告；offset 按零基 Unicode 字符，单页最多 4096 字符。`search(scope, query, limit?)` 使用不区分大小写的普通词项匹配（全部命中），最多 10 个 256 字符片段，覆盖未入索引文件。文件资源上限 256 KiB，扫描最多 1000 个目录项/8 MiB。缺少 frontmatter 不影响使用，损坏元数据不覆盖原文；来源只是未核验入口，可能无法读取其历史。

`store.write({ scope, path, content, expectedVersion, operationId }, source, signal?)` 使用读取的版本；`expectedVersion: null` 仅新建。`source` 为宿主实际掌握的 `{ kind: "management" | "session", timestamp, sessionId?, entryId?, location? }`，程序追加真实 scope/root 和操作身份。`delete(scope, path, expectedVersion, operationId, signal?)` 删除当前笔记；`pin(scope, path, enabled)` 与 `pinned(scope)` 管理固定入口。相同操作身份与同一正文的重试返回原提交结果，不重复提交；修改或删除后旧版本失效。收到 `replayed: true` 只确认原操作已提交，不保证文件随后未被人工修改。

单文件原子替换与本机 scope 锁保护受管理写入；没有跨文件事务、断电级持久性或任意外部编辑器竞态合并保证。正文与索引分别返回实际结果；正文成功不等于索引已维护。取消等待已开始的文件操作，发布前发现取消不替换正文。记忆工具失败作为工具错误反馈；JSONL 存储失败仍停用实例。笔记删除不删除 JSONL，也不能抹去仍在当前上下文中的原话。

死亡进程的完整锁记录可自动回收；若回收过程本身中断或锁记录不完整，会明确失败，需宿主检查后处理。`getMemoryBudget?.()` 提供当前共享注入预算；显式管理写入可将其作为 `indexBudgetTokens`（0–2000）传给 store。未知预算会提示无法确认自动装载范围，保存成功不代表整篇索引都会注入。

模型的 `read_memory/search_memory/write_memory/delete_memory` 沿用权限、hooks、取消及工具事件。SDK 没有隐式授权；由宿主照常提供 permission rules。`autoUpdate: false` 拒绝模型写工具，宿主显式 store 管理独立可用；`injection: false` 停止注入，但保留按需读取。两个布尔值可由宿主修改，下一个请求边界使用新注入/工具描述，实际写入同时检查开关。

CLI 默认将记忆工具作为内建允许项，仍受前置 hooks/rules 约束；`permissionMode: "deny-all"` 不添加记忆写入/删除允许项，保留既有只读策略。显式 `/memory` 管理不依赖模型授权。

`ContextAssembler` 将 scope/path/version 标记的记忆作为参考消息装配，未持久化为用户消息，不成为 system 指令。索引及固定笔记总注入不超过 `min(2000 tokens, 输入预算 5%, 当前剩余预算)`，沿用当前字符估算与上下文压缩窗口余量；详情工具结果、system、schema、当前消息仍计入统一 usage。新输入/steering 和受管理写入后刷新投影。固定正文放不下会明确报告，不静默截断。`memory` projection 事件返回 selected、tokens、truncated、warnings；工具结果与现有模型 usage 提供写入、调用和费用证据。首版没有额外整理模型、后台计时器或退出扫描。

每次请求边界检查固定清单、索引、固定文件及链接目标的磁盘 revision，变化后重读投影；同一轮中的外部编辑和删除也会刷新下一次请求。已发送的请求和当前历史原文不会被追溯修改。

## 装配与定制边界

`createAgent(options)` 始终装配生产会话，只接受一个 options 参数。定制模型使用 `model` + `streamFn`；定制数据库或会话持久化实现 `SessionStorage` 并通过 `storage` 传入；定制工具通过 `tools` 传入。SDK 和 CLI 均不提供替换整个执行实例的 factory。旧的第二参数在 TypeScript 中报错，在 JavaScript 中于任何装配和模型调用前抛出 `TypeError`。

创建会等待存储接入完成，包括默认内存存储。`setStorage` 属于内部装配过程，不在已创建 Agent 的宿主接口中。存储接入失败时，中止并等待已创建会话释放；内部创建的 RequestBus 会关闭，外部传入的总线不会由失败装配关闭。清理成功时原样抛出创建错误；清理也失败时抛出 `AggregateError`，其 `cause` 和 `errors[0]` 为原始错误。

SDK 集成测试用 `streamFn` 控制模型返回，存储故障和工具行为分别在 `storage`、`tools` 注入。局部 UI/headless 测试可以使用各自的小接口，底层单元测试可直接测试内部模块。设计及验证见[完整 Agent 装配契约](phases/agent-assembly.md)。

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

上下文压缩提供带证据短检查点、相关性选择、历史搜索/读取与请求预算，见 [ADR-018](decisions/018-adaptive-default.md)。旧 pi 策略及 `context.strategy` 已删除，传入该字段会报错；省略 `context` 或传 `{}` 即启用上下文压缩。

CLI 配置与 SDK 创建选项均支持 `context: { enabled, reserveTokens, keepRecentTokens, summaryReasoning }`，默认分别为 `true`、`16384`、`20000`、`"inherit"`。SDK 可在空闲时通过 `configureContext` 更新。搜索和读取仍需宿主权限允许，启用压缩不授予权限。

### 上下文压缩：状态与预算

上下文压缩保留未归档用户输入及最新完整交互单元，先尝试裁剪可找回的旧工具正文和选择相关材料；需要时由主模型提取独立、带原文引用的任务状态与摘要。替代状态必须引用更晚的用户证据，旧状态留在历史；assistant 的事实陈述保守归为推断。工具执行结果由原始记录提供，检查点不会改变宿主权限。结构/来源校验不能证明自然语言语义没有遗漏。

上下文压缩发送给任务模型的检查点采用短投影：状态/结论的类型、完整文本与去重的来源 entryId；完整 quote、状态 ID 和替代关系继续保存在本地检查点，降级 summary 也保留完整版本。执行结果 ledger 不省略。摘要生成仍提取完整证据，所以短投影不代表摘要生成费用下降。

上下文压缩在第 4 次增量更新、任务切换或无效检查点/无进展时尝试从原文重建；每次操作最多 2 次逻辑生成、4 次实际模型请求（包括临时重试）。超大摘要输入、保护状态放不下、引用无效或最终无进展均返回错误，不发布损坏检查点；自动路径阻止该次过预算任务请求，取消和存储失败继续遵循既有生命周期。

上下文压缩中，task `maxTokens` 未指定时显式取 `min(4096, model.maxTokens)`。预算包括 system、工具定义、状态、摘要与消息，预留 `max(reserveTokens, effectiveOutputTokens + max(1024, ceil(contextWindow * 0.02)))`；有效输出计入适用 provider 的额外 thinking 预算。启发式计数不保证供应商物理窗口一定足够。摘要输入也单独预检，输出最多 4096 tokens（还受模型和窗口限制）。

### 查找与读取历史

上下文压缩注册保留工具名 `read_context`。它经过现有权限和 tool hooks，只能读取当前分支已保存消息；宿主同名工具配置会被拒绝。输入 `entryId`、`offset`（默认 0）和 `limit`（默认/最大 4096）以 Unicode code point 为单位；正文最多 16 KiB，`nextOffset` 支持长单行续读。元数据也计入后续上下文。图片只报告占位，无法找回工具原先未保存的正文；不存在、越界或外分支引用明确报错。需要自动找回的宿主应通过已有 permission 配置允许该工具。

`search_context` 是另一个保留工具名，允许模型在不知道 entryId 时搜索当前分支历史。输入 `query`（1–200 Unicode code points，空白分词且最多 8 项，全部字面词项都需命中，大小写不敏感）、可选 `role`（user/assistant/toolResult）和 `limit`（默认 5、最大 10）。结果从新到旧，含 `entryId`、`role`、`isError`、Unicode `offset` 和最多 256 code points 的预览，另有 `hasMore`。用 `read_context` 加载完整原文；“最新”仅指分支顺序，不判断语义上的最新决定。为避免回显，搜索排除这两个检索工具的结果及包含其调用的 assistant 消息；仍可按 ID 读取这些记录。搜索不跨分支、会话或文件，不使用额外模型；同样需要 permission 允许且经过 tool hooks。新增 schema/找回会增加输入，不能保证每个场景净省 Token。

### 兼容与事件

v4 `compaction` 记录使用可选、版本化的 `checkpoint` 载荷，SDK 导出 `CompactionCheckpoint` 类型。重开时验证引用与状态替代关系。旧 v4 记录的 `adaptive` 字段在读取时转换为 `checkpoint`，不重写原始文件；新记录只写 `checkpoint`。同时出现两种字段会报错，不保留旧 SDK 类型别名。无检查点载荷的旧历史从原始分支消息恢复模型上下文，不沿用旧 pi 摘要，也不因预算或提取失败自动回退 pi。自动压缩关闭不移除原文工具，也不禁用手动压缩。

`compaction` 事件提供 `action`、`inputBudget`、`contextEstimated`、`modelCalls`、`generations`、`elapsedMs`、`stopReason` 和合计 `usage`，不再提供 `strategy`。这些字段为累计快照，统计时按 `operationId` 取最新值，不重复相加。

当前短投影的软件验证和费用估算边界见[后续验证记录](phases/context-notes-search.md)；不要将首次上下文压缩的旧保留集结果视为新投影的质量验收。

### 自动压缩与恢复

每次任务请求前，当前上下文超过输入预算时先压缩；压缩失败阻止该次请求。overflow 和可恢复 length 在连续失败链中共享一次恢复机会；保留失败记录，不重放已执行工具，不因 usage 报超限重新生成成功答案。`enabled: false` 关闭自动压缩及超限恢复，仍可手动压缩和读取历史。

摘要使用主任务模型与路由，隔离任务 system，不传工具定义或缓存保留。`summaryReasoning: "off"` 在模型支持时关闭推理，否则继承。临时重试与最多两次逻辑生成共享四次模型请求上限。Provider 错误在重试策略结束后直接停止，不触发检查点重建。

普通到达输出上限的 `length` 正文保留给后续请求，截断工具调用不执行也不投影。被分类为上下文恢复失败尝试的 `length` 保存 `contextExcluded` 标记，重开后同样只保留原记录。headless 在成功恢复后返回成功退出码；未恢复的 error/length 返回 1，取消返回 130。

### 共用 API 与计量

`contextWindow` 可覆盖本地容量声明，默认采用模型元数据；降低该值可测试触发流程，不证明供应商物理窗口超限。`maxTokens` 是普通任务的宿主输出配置，与压缩 reserve 分开，省略时使用上方的显式输出预留。`getUsage()` 的 `contextEstimated` 区分有效 usage 与估算。模型、system、tools、分支或投影改变后失效，摘要 usage 不作为任务锚点。

历史 user/toolResult 可携带 `{ type: "image", data: base64, mimeType }`，请求保留图片，启发式按每张 1024 tokens 估算，摘要仅序列化图片占位。`sessionId` 在任务与摘要的 pi-ai 调用间保持一致；默认每实例生成，宿主可传稳定 ID，CLI 使用会话 header ID。是否发送 HTTP affinity 字段由 provider 适配和缓存设置决定，`cacheRetention: "none"` 可能抑制这些字段。

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

提前 `break` 或关闭 iterator 会取消并等待清理。后台执行由宿主持续消费事件,界面可独立订阅宿主转发的内容。`abort()` 只停止当前调用,包括已获取但尚未 next 的 iterator,此时随后消费不会启动模型或提交;清理结束后实例可复用。`dispose()` 幂等,取消并等待清理或已开始的提交结算,之后不可复用;持有未完成 iterator 时也应 await dispose。

任意自定义工具必须配合 AbortSignal,不合作的工具可能让取消或 dispose 长期等待;SDK 不提供强制进程终止。

## 权限

默认未允许的工具调用需要授权。宿主可配置 `permission.rules`,或并行消费 `agent.requests`,通过 `agent.respond(response)` 答复。请求流应与执行流并行消费,不能等执行完成才处理授权。无答复默认 30 秒后拒绝,没有界面不等于自动放行。

每实例默认有独立权限记忆和请求总线。CLI 为兼容现有 TUI 显式传入独占 RequestBus,交互模式允许无限等待;SDK dispose 会关闭该总线,不得跨实例共享。请求观察、授权与释放不依赖 pi 类型。

## 验证边界

自动化验证使用本地 HTTP provider、模型流替身、工具与存储故障注入、受控交错及 PTY 交互，不代表公共 API 稳定承诺、完整真实供应商覆盖、长任务可靠性或文件系统崩溃一致性。当前证据见[内核迁移验收](phases/pi-core-migration-acceptance.md)、[StreamFn 合同](phases/stream-fn.md)和[逐轮停止策略](phases/turn-policy.md)。

## 本地执行内核接口升级

包名与 `createAgent` 不变。生产循环来自本地维护的固定 Agent 源码，Forge 会话层继续负责存储、权限、上下文与 usage。内部 `ExecutionCore`、`AgentRunner` 和旧权限适配工厂不再导出；宿主从 SDK 创建实例。

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

`turn.result` 在消费与必要保存结算后完成；`waitForIdle()` 等待当前已获取 iterator 或手动压缩清理，不表示模型成功。`agent_end.outcome` 标明会话级最终结果；重试中间的 error 不是整个任务失败。`deferred` 为终态，没有后台轮询。惰性流需消费或获取 iterator 后关闭，未消费的流不会启动工作。

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

`content` 只包含文本/图片并进入模型；`details` 独立保存供宿主展示，必须可 JSON 持久化且可快照。工具错误返回 `isError: true` 或抛错，终止提示为 `terminate: true`。进度使用同一结构，结算后迟到进度被忽略。`prepareArguments` 同步规范化输入；旧 `toolInputRewrites` 可异步改写。执行前按调用顺序完成 schema 校验、改写、before hook、最终校验和授权，然后默认并行执行；`executionMode: "sequential"` 可指定单工具串行，`toolHooks.toolExecution` 可指定整批策略。`beforeToolCall` 返回 block/reason/terminate，`afterToolCall` 可覆盖 content/details/isError/terminate。授权、实际执行和 after hook 观察同一份最终参数；准备失败不执行该工具。结果按模型调用顺序保存。

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

可更新 provider/model/apiKey/baseUrl/systemPrompt/thinkingLevel/tools/maxTokens/contextWindow。异步验证失败时更新拒绝，原配置保持。空闲时应用；响应或工具执行中接受更新后，整批沿用原配置完成，再于下一请求前应用。手动摘要完成后应用。没有下一请求时更新不会主动请求模型；释放或故障取消尚未应用的配置。运行中等待 `applied` 应在事件消费之外进行。工具 schema 在接受前快照；回调闭包仍由宿主管理。配置应用使当前 usage 锚点失效，历史最后调用计数保留。

源码基线、必要定制、验证与版本回退说明见[迁移验收](phases/pi-core-migration-acceptance.md)。
