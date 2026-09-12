# SDK 接入

[English](sdk.en.md) · [中文 README](../README.zh-CN.md)

> 范围:仓库内 Bun SDK,入口 `@forge-agent/core/sdk`。未承诺 npm 发布、Node.js 兼容或进程隔离。

## 自定义执行实现

通常直接使用默认 `createAgent(options)`。若传入第二个参数 factory，它必须返回完整的 `AgentPort`（类型从 `@forge-agent/core` 导入），或返回该实例的 Promise。必需方法为 `runTurn`、`continue`、`steer`、`followUp`、`abort`、`dispose`、`getUsage`、`setStorage`、`compact`、`configureContext`、`updateConfiguration`。

TypeScript 检查完整类型；创建时还会检查每个方法是否为函数，缺失或非函数立即报 `TypeError`。通过后等待 `setStorage(storage)` 完成，才返回 Agent；省略 storage 时也会接入默认内存存储。`setStorage` 仅用于装配，不在已创建 Agent 的宿主接口中。检查不会执行模型或工具，也不保证自定义方法的语义正确：`getUsage()` 可以返回 `undefined`，配置更新可以拒绝不支持的配置。

factory 返回实例后，能力检查或存储接入失败会尝试 `abort()`，随后等待 `dispose()`；abort 报错也会继续释放。内部创建的 RequestBus 会先关闭，外部传入的总线不会由失败装配主动关闭（adapter 自身取消行为仍由其实现决定）。成功返回后的 dispose 总线归属规则不变。清理成功时原样抛出创建错误；清理也失败时抛出 `AggregateError`，其 `cause` 和 `errors[0]` 为原始错误，后续项为清理错误。factory 在返回实例前抛错时，应自行清理尚未交付的资源。

局部 UI/headless 测试可以继续使用各自的小接口；经过完整 SDK 创建路径的测试应使用生产会话配合可控模型。设计及验证见[完整 Agent 装配契约](phases/agent-assembly.md)。

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

创建选项支持 `context: { enabled, reserveTokens, keepRecentTokens, summaryReasoning }`，默认分别为 `true`、`16384`、`20000`、`"inherit"`。`agent.configureContext(partial)` 在空闲时更新这些设置。每次任务模型请求前，仅当当前估算严格超过 `contextWindow - reserveTokens` 时主动压缩；近期保留量用于选择合法切点，不是压缩后的硬上限。

`contextWindow` 可覆盖本地容量声明，默认采用模型元数据；降低该值可测试触发流程，不证明供应商物理窗口超限。`maxTokens` 是普通任务的宿主输出配置，与压缩 reserve 分开，默认沿用 provider 适配。`getUsage()` 的 `contextEstimated` 区分有效 usage 与估算。模型、system、tools、分支或投影改变后失效，摘要 usage 不作为任务锚点。

历史 user/toolResult 可携带 `{ type: "image", data: base64, mimeType }`，请求保留图片，启发式按每张 1024 tokens 估算，摘要仅序列化图片占位。`sessionId` 在任务与摘要的 pi-ai 调用间保持一致；默认每实例生成，宿主可传稳定 ID，CLI 使用会话 header ID。是否发送 HTTP affinity 字段由 provider 适配和缓存设置决定，`cacheRetention: "none"` 可能抑制这些字段。

`await agent.compact(instructions?, onEvent?)` 先取消当前执行并等待工具及保存收尾，再压缩一次，完成后保持空闲。返回 `{ status, operationId, beforeTokens, afterTokens?, error? }`；status 为 `complete`、`skipped` 或 `error`。存储故障仍抛错并停用实例。取消可以中止摘要与退避；已开始的写入仍需等待。instructions 只进入历史摘要的 Additional focus。

摘要使用主任务模型、认证和路由，关闭缓存保留与工具定义。最多顺序生成历史和 turn-prefix 两段摘要后直接拼接。默认继承主任务推理；`summaryReasoning: "off"` 在模型支持时关闭，否则继承并报告回退。顶层 `retry` 配置为 `{ enabled, maxRetries, baseDelayMs }`，默认 `true/3/2000`；摘要仅对分类为临时故障的响应重试当前失败段，默认等待 2/4/8 秒，没有底层叠加重试或累计摘要次数帽。

主动压缩失败保留旧视图并允许任务请求。overflow 与符合 Pi 条件的 length 共用连续失败链的一次压缩恢复，失败的部分输出保留在历史，恢复不重放工具。成功答案即使用量超窗也不重新生成。`enabled: false` 同时禁用自动压缩和自动恢复，手动压缩仍可用。

普通到达输出上限的 `length` 正文保留给后续请求，截断工具调用不执行也不投影。被分类为上下文恢复失败尝试的 `length` 保存 `contextExcluded` 标记，重开后同样只保留原记录。headless 在成功恢复后返回成功退出码；未恢复的 error/length 返回 1，取消返回 130。

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
