---
doc_kind: note
created: 2026-09-01
---

# earendil-works/pi 深度调研

> 状态:已调研(2026-09-01)
> 快照:[`earendil-works/pi@853a80d`](https://github.com/earendil-works/pi/tree/853a80d26c90a14c1886f0ebb8ffaae133ca2185),本文涉及的 package 均为 `0.84.4`。本项目当前 exact 安装 `@earendil-works/pi-ai@0.84.4`、`@earendil-works/pi-agent-core@0.84.4`、`@earendil-works/pi-tui@0.84.4`。

## 1. 一句话结论

pi 不是一个应整体采用的 coding harness,而是一组成熟度不同的层:

| 层 | 可直接依赖 | 本项目结论 |
|---|---|---|
| `pi-ai` | 是 | 供应商、认证、模型与流事件层,永久依赖候选 |
| `Agent` / `agentLoop` | 是 | Phase 1 用 `Agent`,team 假设冲突时可降到 loop |
| `pi-tui` | 是 | TUI 原语足够,二维分栏已验证 |
| `harness/*` 积木 | 按需 | session/tools/compaction 可逐个评估 |
| `AgentHarness` facade | 否 | 当前仍是公开签名完整、核心方法未实现的 scaffold |
| `protocol/client/server` | 暂不依赖 | 设计可参考,Phase 2.5 单进程不需要 server |
| subagent extension | 不作为 runtime | 是 disposable subprocess delegation 示例,不是 persistent teammate |

最稳妥的边界仍是:用 `pi-ai` 和 loop/TUI 原语,把 session truth、permission、peer-team scheduler、board、delivery 与 product UX 留在本项目。

## 2. 调研方法

本报告没有只读 README 或 `.d.ts`,而是交叉检查:

- package source 与 exports。
- `Agent` / `agentLoop` 的运行路径。
- `AgentHarness` 每个 facade 方法的实际 body。
- `HStack/VStack/ScrollView/TuiAltScreen` 与上游交互测试。
- `protocol/client/server` 的 framing、snapshot 和 lease 行为。
- `coding-agent` 的 subagent extension 实现。
- 本项目已安装 npm 包的实际 import/render 探针。

结论只对固定 commit 与 `0.84.4` 成立。pi 发布频率高,升级时必须重新跑 narrow contract suite,不能仅凭 semver 或类型通过判断行为未变。

## 3. 包拓扑与职责

### 3.1 `@earendil-works/pi-ai`

这一包拥有最难且最不值得本项目重写的部分:

- provider/model catalog。
- provider-specific wire adapter。
- API key、OAuth 与 credential resolution。
- 消息、tool call、usage、stop reason 类型。
- 统一的 `AssistantMessageEventStream`。

源码不是单一 OpenAI-compatible wrapper。`packages/ai/src/api/` 内有 Anthropic Messages、OpenAI Responses/Completions/Codex Responses、Google、Vertex、Bedrock、Mistral、Pi Messages 等独立 adapter;provider catalog 还包含更多兼容 endpoint。统一 event stream 在 [`utils/event-stream.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/utils/event-stream.ts#L69-L87),各 adapter 构造同一类型。

OAuth loader 不是文档占位。Bun 入口实际注册 Anthropic、OpenAI Codex、GitHub Copilot、OpenRouter、Kimi Coding、xAI 与 Radius:[`bun-oauth.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/bun-oauth.ts#L8-L20)。

对本项目的意义:

1. `core` 只依赖自己的 `ModelRef/StreamEvent/Usage` 窄接口。
2. provider-specific options 留在 pi adapter 边界,不要扩散到 protocol/TUI。
3. session 持久化应存稳定 model/provider id 与必要 options,不直接序列化 pi class。
4. auth UI 仍应走本项目 request bus;不要让 OAuth adapter 直接拥有 TUI。

### 3.2 `@earendil-works/pi-agent-core`

这里有两条真正可用的执行入口:

- `Agent`:持有 message state、queue 与 active run 的便利 facade。
- `agentLoop()` / `agentLoopContinue()`:更低层的 turn/tool orchestration。

`Agent` 默认 tool execution 是 parallel,subscriber 可以是 async,并提供 active run abort、steering queue 和 follow-up queue。关键源码:

- 默认 `toolExecution = "parallel"`、async subscriber、abort:[`agent.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/agent/src/agent.ts#L237-L320)
- steering/follow-up drain 接到 loop:[`agent.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/agent/src/agent.ts#L465-L484)
- loop 在 turn 内多次检查 steering,turn 后读取 follow-up:[`agent-loop.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/agent/src/agent-loop.ts#L160-L268)
- sequential/parallel tool 分支:[`agent-loop.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/agent/src/agent-loop.ts#L410-L430)
- `AgentEvent` 生命周期 union 与 awaited subscriber 语义:[`types.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/agent/src/types.ts#L422-L444)

#### 事件不是 provider stream event

需要区分两层:

- `AssistantMessageEvent`:供应商流中 text/thinking/tool call/usage 等 delta。
- `AgentEvent`:agent/turn/message/tool execution 的编排生命周期。

TUI 与 session store 不应直接订阅 provider-specific delta。建议 `pi-port` 把两层归一化成项目 protocol 的 block/run events;否则未来换 loop 时整个 UI 都会被 pi 类型绑住。

#### steering 与 follow-up 的时点

`getSteeringMessages` 会在生成和 tool execution 间的多个边界被读取;`getFollowUpMessages` 在当前 turn 完成后读取。这能覆盖单 agent 的:

- 运行中纠偏。
- 当前 turn 后排队。
- abort 当前 request。

它不能自动定义 team 的:

- 哪个 teammate 是 target。
- peer message 是否已 admission/exposed/handled。
- board owner 和 review gate。
- crash 后 exact invocation 如何收敛。

因此 team scheduler 应在 loop 之上,而不是塞进 `getSteeringMessages` 回调里。

#### tool parallel 的真实边界

parallel 不是“所有事情并行”。loop 先顺序完成 preflight/prepare,只有允许并行的 execute 部分并发;任一 tool 标注 sequential 时会走顺序分支。本项目的 permission 与 argument rewrite 必须在 execute 并发之前完成。

### 3.3 `harness/*` 积木与 `AgentHarness`

这里最容易被类型表面误导。

`harness/session`、`harness/tools`、`harness/compaction`、reducer/events 等目录有真实实现和测试,可以逐个复用。但顶层 `AgentHarness` 仍不是可用 orchestrator:

- 恢复已有 record 直接抛 `HarnessNotImplemented("create.restore")`。
- `prompt`、`steer`、`followUp`、`abort`、`resume`、`compact`、`watch`、`lane(s)` 等都进入 `unavailable()`。
- `RunOutcome`、lane、deferred、hook 等类型很完整,但类型完整不等于行为完成。

直接证据:[`AgentHarness.create/unavailable/prompt`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/agent/src/harness/agent-harness.ts#L347-L389),[`watch/lanes`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/agent/src/harness/agent-harness.ts#L440-L451)。

这给出一条升级纪律:

```text
type exported
    != source has non-placeholder body
    != behavior covered by tests
    != suitable for our ownership model
```

每次想引入 `harness/*` 新模块时,先 grep `NotImplemented/unavailable`,再读真实 source/test,最后用本项目契约测试验证。

### 3.4 `@earendil-works/pi-tui`

此前规划把它描述成“行导向,二维能力未知”;对 `0.84.4` 已不成立。

#### 布局原语

`HStack` 与 `VStack` 共用 flex-like allocator:

```ts
interface StackEntryOptions {
  basis?: number | "auto"
  grow?: number
  shrink?: number
  minSize?: number
  maxSize?: number
  visible?: (viewport: LayoutViewport) => boolean
}
```

源码:[`stack.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/stack.ts#L4-L21)。allocator 会在约束内 grow/shrink:[`allocateStackSizes`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/stack.ts#L89-L153)。

`HStack.render()` 计算 child width 后按 x offset 合成 ANSI 行,所以底层仍返回 `string[]`,但布局模型已经是二维 rect tree:[`h-stack.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/h-stack.ts#L12-L42)。

#### 多滚动区域

每个 `ScrollView` 自持:

- `scrollTop` 与 viewport/content height。
- `follow: none|end`。
- `overscroll: chain|contain`。
- hidden/auto/always scrollbar。
- `primary` 标记。

源码:[`scroll-view.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/scroll-view.ts#L4-L53),[scroll state update](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/scroll-view.ts#L119-L193)。

最关键的上游测试构造 20x4 terminal、左右各 10 列的 `HStack`,在右栏坐标发送 wheel event;结果左 `scrollTop` 保持 3,右从 3 变 2,viewport 同时渲染左右不同区间:[`tui-alt-screen.test.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/test/tui-alt-screen.test.ts#L153-L179)。这已经证明 pointer hit testing 能按 layout rect 找到目标 scroll view。

#### overlay 与 host

`TuiMainScreen` 与 `TuiAltScreen` 共享 Component 形状,但能力/代价不同:

| host | 优点 | 代价 |
|---|---|---|
| `TuiMainScreen` | 保留 terminal scrollback,复制自然 | 缺少固定 viewport 与多 pane 完整控制 |
| `TuiAltScreen` | 应用拥有 viewport、mouse、scroll、overlay | 必须自己处理滚动、selection、复制、resize |

`TuiAltScreen` 支持 explicit layout root、primary/fallback scroll view、pointer layout hit testing、overlay 与 selection。能力存在不等于真实终端验收完成;tmux/WSL 的 mouse mode、OSC 52 与 terminal behavior 仍需 Phase 2 门禁。

#### 本项目探针

本项目安装的 `0.84.4` 已实际 import:

```text
exports: HStack, VStack, ScrollView
HStack at width 40: left/right three-line content rendered in the same rows
```

这把“能否二维分栏”从风险改成已验证能力。剩余风险是完整 dashboard 的 interaction contract,不是 layout primitive 是否存在。

### 3.5 实验 `protocol/client/server`

这组三包比 README 的“实验性”标签更完整,但仍不应提前进入 Phase 2.5 dependency graph。

#### wire

protocol 使用 4-byte big-endian length prefix;decoder 有 max frame length、分块累积、截断检测:[`framing.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/protocol/src/framing.ts#L45-L163)。payload 使用 CBOR schema,不是 newline JSON。

#### state

client contract 明确:

- request 以 id 关联。
- server snapshot 与成功 response snapshot 是 authoritative。
- progress event 不做 optimistic snapshot mutation。
- revision 较旧的 snapshot 被丢弃。

来源:[client README](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/client/README.md#L21-L34),[`state.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/client/src/state.ts#L89-L112)。

#### ownership

session acquisition 显式分为:

- `exclusive`:生命周期或 mutation coordinator。
- `shared`:多个低层消费者有意共享。

exclusive 与任何现有 lease 冲突,shared 与 exclusive 冲突;最后一个 lease 释放后才 detach。实现:[`client.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/client/src/client.ts#L373-L405)。

可迁移的思想:

- authoritative snapshot + monotonic revision。
- request correlation。
- mutation owner 与 observer 分开。
- lease release failure 要 reconciliation。

当前不迁移的代码:

- Unix socket server。
- CBOR framing。
- remote session acquisition。

本项目 Phase 2.5 是单进程;先把 protocol event/reducer 写对,未来真有第二客户端时再决定是否采用这些包。

### 3.6 subagent extension

pi 的 subagent 示例是一个 coding-agent extension,它没有复用同进程 `Agent`:

```text
parent pi process
  -> spawn("pi", ["--mode", "json", "-p", "--no-session", ...])
  -> collect child JSON stream
  -> truncate model-visible result
  -> return one tool result to parent
```

实现固定:

- `single`、`parallel`、`chain` 三种模式。
- parallel 最多 8 tasks,concurrency 4。
- 每 task 给模型的 output cap 是 50 KiB。
- abort 先 `SIGTERM`,5 秒后仍未退则 `SIGKILL`。
- child 使用 `--no-session`,天然 disposable。
- project-scoped agents 需要显式 scope/trust,避免无声执行 repo-controlled instructions。

证据:[常量](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/examples/extensions/subagent/index.ts#L29-L38),[child args](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/examples/extensions/subagent/index.ts#L292-L307),[终止](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/examples/extensions/subagent/index.ts#L404-L419),[project trust](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/examples/extensions/subagent/index.ts#L527-L545)。

可借:

- 硬 fan-out/concurrency/output cap。
- abort escalation。
- project agent trust gate。
- single/parallel/chain 作为 disposable delegation UX。

不能借来实现 teammate:

- `--no-session` 没有持久身份/上下文。
- child 只向 parent 返回 tool result,没有 peer routing。
- process exit 被当作执行终局,没有 durable delivery/custody。
- subprocess 复制 auth/config/startup 成本。

## 4. 对本项目的采用矩阵

| 能力 | 决策 | 边界 |
|---|---|---|
| provider + model + auth | 依赖 `pi-ai` | 包在 `core/pi-port`,不漏类型 |
| `Agent` | Phase 1 依赖 | 自有 session store 镜像 truth |
| `agentLoop` | 逃生口 | team 调度假设冲突时降层 |
| tool execution | 依赖 loop | permission/rewrite 在外层完成 |
| `HStack/VStack/ScrollView` | 依赖 | 自写 dashboard/focus/blocks |
| `TuiAltScreen` | Phase 2 门禁后启用 | 保留 `main` host 逃生口 |
| `AgentHarness` | 不采用 | 等实现成熟也要重新评估 owner 边界 |
| harness tools/session | 单件评估 | 不因同目录就批量引入 |
| protocol/client/server | 只借思想 | 出现真实第二客户端再评估 |
| subagent extension | 只借 limits/UX | Phase 4 disposable subagent 候选 |

## 5. 建议的 pi adapter

adapter 应窄到可以用 fake loop 做契约测试:

```ts
interface AgentEngine {
  run(input: EngineInput, signal: AbortSignal): AsyncIterable<EngineEvent>
  enqueue(message: EngineMessage): void
  steer(message: EngineMessage): void
  abort(reason: AbortReason): void
}

type EngineEvent =
  | { type: "run_started"; runId: string }
  | { type: "message_delta"; block: NormalizedBlockDelta }
  | { type: "tool_started"; call: NormalizedToolCall }
  | { type: "tool_finished"; result: NormalizedToolResult }
  | { type: "run_finished"; outcome: NormalizedOutcome }
```

这不是建议现在再造一层通用 framework。它只隔离三种已知 churn:

1. pi event/type 变化。
2. `Agent` 与 `agentLoop` 切换。
3. TUI/headless 共同消费项目 protocol。

session truth、team delivery 与 request bus 不能放进 adapter;它们属于项目 core。

## 6. 升级与契约测试

每次升级 pi exact version 前至少锁住:

### Agent loop

- [ ] abort 后每个已发 tool call 有唯一 terminal result 或明确 cancelled result。
- [ ] steering 插入后 context 最后一条仍满足 provider 可转换约束。
- [ ] parallel tools 中一个 throw 不丢其他已完成 result。
- [ ] sequential tool 能阻止同 batch 并行。
- [ ] `agent_end` 后 awaited subscribers 已完成,session flush 不早退。
- [ ] stop reason 各分支映射到稳定项目 outcome。

### TUI

- [ ] `HStack` 在 40/80/120 列的 width allocation 与 min/max 符合预期。
- [ ] `visible(viewport)` 能切换 wide/medium/narrow 结构。
- [ ] 两个 scroll view 独立 wheel hit testing。
- [ ] primary/fallback scroll behavior 在无 pointer 情况可解释。
- [ ] overlay 打开/关闭后 focus owner 与 selection 恢复。
- [ ] `TuiMainScreen` / `TuiAltScreen` 渲染同一 component tree。

### Package surface

- [ ] 实际 ESM import,不只检查 `.d.ts`。
- [ ] grep 新引入模块的 `NotImplemented/unavailable/TODO throw`。
- [ ] exports map 与 deep import 路径没有漂移。
- [ ] source package version 与 lockfile exact version 一致。

## 7. 风险与尚未验证项

| 风险 | 当前证据 | 处置 |
|---|---|---|
| 发布 churn | 0.84.x 高频同步发布 | exact pin + upgrade contract suite |
| `AgentHarness` 假成熟 | 签名完整但 facade 核心全 unavailable | 禁止只按类型选层 |
| team 与 future lanes 重叠 | harness types 已出现 lane/deferred | team owner 保持项目内,观察而不提前 rebase |
| alt-screen 复制/鼠标 | 上游 virtual terminal 测试通过 | WSL2/tmux/OSC 52 真实验收仍阻断切默认 |
| 多 pane 键盘 focus | layout/mouse 已有,产品 focus 尚未写 | Phase 2.5 单一 focus router |
| line-oriented renderer 极限 | 现在已有 rect layout,但最终仍合成 string[] | 先用真实 dashboard 验证,不要凭抽象担忧改技术栈 |
| experimental client/server | contract 不薄,但版本少 | 没有第二客户端前不加依赖 |
| subagent 被误作 teammate | 示例刻意 `--no-session` | 文档与类型中分开命名 |

仍需实际终端验证:

- WSL2 + 常用 terminal 的 mouse wheel。
- tmux 下 button-motion 与多 pane 命中。
- OSC 52 copy、selection persistence、truecolor。
- dashboard streaming 时 resize 的闪烁和 layout stability。
- 多 `Agent` 实例同时产出时 event dispatch 是否造成明显 input latency。

## 8. 最终判断

pi 已经回答了两个技术可行性问题:

1. 本项目无需自研 provider wire 与基础 agent loop。
2. `pi-tui@0.84.4` 足以表达二维、响应式、多滚动区 command center。

它没有回答产品最关键的问题:peer identity、消息责任、task owner、admission、terminal 与 recovery。那部分必须由本项目 core 定义,具体契约见 [peer-agent-team-tui.md](./peer-agent-team-tui.md)。
