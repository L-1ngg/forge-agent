# SDK 接入

[English](sdk.en.md) · [中文 README](../README.zh-CN.md)

> 范围:仓库内 Bun SDK,入口 `@forge-agent/core/sdk`。未承诺 npm 发布、Node.js 兼容或进程隔离。

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

默认每实例使用独立内存。宿主可传入 `storage`，记录类型由 `@forge-agent/core/sdk` 导出：

```ts
interface SessionStorage {
  load(): Promise<SessionState>;
  append(entry: SessionEntry): Promise<void>;
}
```

`SessionState` 包含完整 `entries` 和选中 `leafId`。v4 记录包含稳定 id、parentId、timestamp，以及原始 message 或独立 compaction。core 分配身份并串行追加：已消费 user 在模型请求前保存，assistant 终态在工具前保存，工具批次收尾后按调用顺序保存结果。取消保留已形成过程，不回滚整次 invocation；error/aborted 原始响应保留，但从后续请求过滤。

`append()` 成功必须可重载；开始后的写入必须等待结算。任何保存失败停止新调度并停用实例，不盲重试可能部分完成的写入。宿主检查实际状态后重建，同一会话不得有多个并发写实例。JSONL 不保证断电或部分写入事务性；工具外部副作用不会回滚。

完整历史调用缺结果时，仅在请求中补“执行及副作用未知”的错误提示，不改历史、不重放工具。CLI 通过 `SessionStore.asStorage()` 使用 v4。旧格式必须转换为独立副本，不能直接覆盖源文件。`processed` 和 `message_end` 都不是持久化确认，正常迭代结束才保证必要写入已完成。

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

旧 v3 数据通过 `SessionStore.convertCopy(source, target, cwd, options?)` 显式转成 v4 副本，目标存在即失败；损坏或无换行文件要继续追加也使用此入口。open 的 onDiagnostic 回调报告坏 JSON 行，leafId 可选择分支；不可解释的选中父链或摘要边界拒绝加载。回退使用保留的旧文件及匹配旧二进制，关闭自动压缩不会使 v4 变回旧格式。

受控真实 provider 验收示例：`bun examples/context-acceptance.ts`，显式读取宿主配置、限制实验请求和时间，并清理本次临时会话。

## 事件与生命周期

`runTurn` 返回带只读 `id: symbol` 的单消费者异步事件流。同实例并发执行拒绝,不是自动排队。`steer(input, turn.id)` 与 `followUp(input, turn.id)` 只进入对应活动执行的两条 FIFO 队列,返回 `InputAcceptance`;未启动、已结束、取消或 id 过期时返回 `{ accepted: false }`,宿主应保留输入。已停用或已释放实例仍抛错。

接受结果为 `{ accepted: true, processed: Promise<boolean> }`:输入已进入模型上下文时解析为 `true`,结束时尚未处理则为 `false`。宿主保留原文,恢复未处理输入;`true` 不保证模型完成或持久化成功,不应自动重发以免重复工具副作用。干预结果需在并行消费事件时处理,不能在消费循环中等待未来输入处理而阻塞迭代收尾。

跨 invocation 队列属于宿主。TUI 在等待期间持续接受输入,显示 FIFO,空输入框 Up 取回队尾编辑;Esc 停止续发并恢复草稿,Ctrl+Enter 仅在旧任务成功收尾后发送指定输入,其余待发原文恢复草稿。提交失败暂停队列,检查存储并重建实例后由宿主明确恢复。`agent_end` 仅表示执行终止,整个异步迭代正常完成才表示会话提交完成。

提前 `break` 或关闭 iterator 会取消并等待清理。后台执行由宿主持续消费事件,界面可独立订阅宿主转发的内容。`abort()` 只停止当前调用,包括已获取但尚未 next 的 iterator,此时随后消费不会启动模型或提交;清理结束后实例可复用。`dispose()` 幂等,取消并等待清理或已开始的提交结算,之后不可复用;持有未完成 iterator 时也应 await dispose。

任意自定义工具必须配合 AbortSignal,不合作的工具可能让取消或 dispose 长期等待;SDK 不提供强制进程终止。

## 权限

默认未允许的工具调用需要授权。宿主可配置 `permission.rules`,或并行消费 `agent.requests`,通过 `agent.respond(response)` 答复。请求流应与执行流并行消费,不能等执行完成才处理授权。无答复默认 30 秒后拒绝,没有界面不等于自动放行。

每实例默认有独立权限记忆和请求总线。CLI 为兼容现有 TUI 显式传入独占 RequestBus,交互模式允许无限等待;SDK dispose 会关闭该总线,不得跨实例共享。请求观察、授权与释放不依赖 pi 类型。
