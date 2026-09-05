# SDK 接入

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

无文件副作用的自定义工具示例见 `examples/embedded-agent.ts`。根目录示例直接引用 SDK 入口文件,workspace 宿主使用 `@forge-agent/core/sdk` 子路径:

```bash
FORGE_AGENT_PROVIDER=xai FORGE_AGENT_MODEL=grok-4.6 FORGE_AGENT_API_KEY=secret bun examples/embedded-agent.ts
```

代理地址由示例宿主读取 `FORGE_AGENT_BASE_URL` 后传入,不是 SDK 自动读取。

## 存储

默认每实例使用独立内存。宿主可传入 `storage`:

```ts
interface SessionStorage {
  load(): Promise<SessionMessage[]>;
  appendTurn(messages: readonly SessionMessage[]): Promise<void>;
}
```

创建时加载历史;正常消费完成后提交一次完整 invocation,包括工具续轮与已处理干预。提交开始前的错误、取消或提前关闭不提交。`appendTurn()` 已开始后,取消和释放必须等待提交结算,不能撤销任意宿主存储写入。历史需保留完整 SessionMessage,包括 provider continuation 签名。CLI 通过 `SessionStore.asStorage()` 保留 JSONL v3。

存储适配器负责事务、重试与故障恢复,同一会话不得同时由多个实例写入。最终提交抛错时调用向宿主抛错,实例拒绝新任务与入队;宿主应先检查存储实际提交状态,再重新创建实例。SDK 不假定抛错意味着底层完全没写入。现有 JSONL append 不提供断电或部分写失败的事务保证,损坏文件可能需要宿主修复后才能加载。工具外部副作用不会回滚。

## 事件与生命周期

`runTurn` 返回带只读 `id: symbol` 的单消费者异步事件流。同实例并发执行拒绝,不是自动排队。`steer(input, turn.id)` 与 `followUp(input, turn.id)` 只进入对应活动执行的两条 FIFO 队列,返回 `InputAcceptance`;未启动、已结束、取消或 id 过期时返回 `{ accepted: false }`,宿主应保留输入。已停用或已释放实例仍抛错。

接受结果为 `{ accepted: true, processed: Promise<boolean> }`:输入已进入模型上下文时解析为 `true`,结束时尚未处理则为 `false`。宿主保留原文,恢复未处理输入;`true` 不保证模型完成或持久化成功,不应自动重发以免重复工具副作用。干预结果需在并行消费事件时处理,不能在消费循环中等待未来输入处理而阻塞迭代收尾。

跨 invocation 队列属于宿主。TUI 在等待期间持续接受输入,显示 FIFO,空输入框 Up 取回队尾编辑;Esc 停止续发并恢复草稿,Ctrl+Enter 仅在旧任务成功收尾后发送指定输入,其余待发原文恢复草稿。提交失败暂停队列,检查存储并重建实例后由宿主明确恢复。`agent_end` 仅表示执行终止,整个异步迭代正常完成才表示会话提交完成。

提前 `break` 或关闭 iterator 会取消并等待清理。后台执行由宿主持续消费事件,界面可独立订阅宿主转发的内容。`abort()` 只停止当前调用,包括已获取但尚未 next 的 iterator,此时随后消费不会启动模型或提交;清理结束后实例可复用。`dispose()` 幂等,取消并等待清理或已开始的提交结算,之后不可复用;持有未完成 iterator 时也应 await dispose。

任意自定义工具必须配合 AbortSignal,不合作的工具可能让取消或 dispose 长期等待;SDK 不提供强制进程终止。

## 权限

默认未允许的工具调用需要授权。宿主可配置 `permission.rules`,或并行消费 `agent.requests`,通过 `agent.respond(response)` 答复。请求流应与执行流并行消费,不能等执行完成才处理授权。无答复默认 30 秒后拒绝,没有界面不等于自动放行。

每实例默认有独立权限记忆和请求总线。CLI 为兼容现有 TUI 显式传入独占 RequestBus,交互模式允许无限等待;SDK dispose 会关闭该总线,不得跨实例共享。请求观察、授权与释放不依赖 pi 类型。
